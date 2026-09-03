const KEY_ROOT = "leaf-collaboration";
import {
  COLLABORATION_PERSISTENCE_STORE_NAMES as STORE_NAMES,
  COLLABORATION_PERSISTENCE_VERSION,
  CollaborationPersistenceBackendError,
  CollaborationPersistenceDataError,
  type CollaborationAcknowledgedSequence,
  type CollaborationCacheIdentity,
  type CollaborationCommittedGeneration,
  type CollaborationCursorMetadata,
  type CollaborationPendingTransaction,
  type CollaborationPermanentWriteFence,
  type CollaborationPersistenceBackend,
  type CollaborationPersistenceBackendTransaction,
  type CollaborationPersistenceFailureReason,
  type CollaborationPersistenceSnapshot,
  type CollaborationPersistenceStoreName,
} from "./collaboration-persistence-contracts";

type NamespaceRecord<HistoryMetadata = unknown> = {
  persistenceVersion: typeof COLLABORATION_PERSISTENCE_VERSION;
  identity: CollaborationCacheIdentity;
  activeGenerationId: string | null;
  acceptedClientSequences?: Record<string, number>;
  history?: HistoryMetadata | null;
  permanentWriteFence?: CollaborationPermanentWriteFence | null;
};

type StoredGeneration<ConfirmedPayload, HistoryMetadata> = {
  namespaceKey: string;
  generation: CollaborationCommittedGeneration<ConfirmedPayload, HistoryMetadata>;
};

type StoredPendingTransaction<PendingPayload> = {
  namespaceKey: string;
  pending: CollaborationPendingTransaction<PendingPayload>;
};

/**
 * Typed persistence facade. Generation publication and own-acknowledgement are
 * each one backend transaction, so a crash exposes either the old or new state.
 */
export class CollaborationPersistence<
  ConfirmedPayload = unknown,
  PendingPayload = unknown,
  HistoryMetadata = unknown,
> {
  constructor(readonly backend: CollaborationPersistenceBackend) {}

  async load(
    identity: CollaborationCacheIdentity,
  ): Promise<CollaborationPersistenceSnapshot<ConfirmedPayload, PendingPayload, HistoryMetadata>> {
    validateIdentity(identity);
    const namespaceKey = collaborationCachePartitionKey(identity);
    return await this.runBackend(
      "load",
      ["namespaces", "generations", "pending"],
      "readonly",
      async (transaction) => {
        const namespace = await transaction.get<NamespaceRecord<HistoryMetadata>>(
          "namespaces",
          namespaceKey,
        );
        const activeGeneration = namespace?.activeGenerationId
          ? await this.readActiveGeneration(transaction, namespaceKey, namespace)
          : null;
        const pendingTransactions = await this.readPendingTransactions(transaction, namespaceKey);
        return {
          identity: cloneValue(identity),
          activeGeneration,
          acceptedClientSequences: cloneValue(namespace?.acceptedClientSequences ?? {}),
          permanentWriteFence: cloneValue(namespace?.permanentWriteFence ?? null),
          pendingTransactions,
        };
      },
    );
  }

  /**
   * Whether a committed generation exists, reading only the namespace row:
   * open paths ask this before deciding whether to wait on the network, so it
   * must stay cheaper than `load` for large documents.
   */
  async hasCommittedGeneration(identity: CollaborationCacheIdentity): Promise<boolean> {
    validateIdentity(identity);
    const namespaceKey = collaborationCachePartitionKey(identity);
    return await this.runBackend(
      "probe committed generation",
      ["namespaces"],
      "readonly",
      async (transaction) => {
        const namespace = await transaction.get<NamespaceRecord<HistoryMetadata>>(
          "namespaces",
          namespaceKey,
        );
        return Boolean(namespace?.activeGenerationId);
      },
    );
  }

  async installCommittedGeneration(
    identity: CollaborationCacheIdentity,
    generation: CollaborationCommittedGeneration<ConfirmedPayload, HistoryMetadata>,
  ): Promise<void> {
    validateIdentity(identity);
    validateGeneration(generation);
    const namespaceKey = collaborationCachePartitionKey(identity);
    await this.runBackend(
      "install committed generation",
      ["generations", "namespaces", "pending"],
      "readwrite",
      async (transaction) => {
        const existingNamespace = await transaction.get<NamespaceRecord<HistoryMetadata>>(
          "namespaces",
          namespaceKey,
        );
        const existingGeneration = existingNamespace?.activeGenerationId
          ? await this.readActiveGeneration(transaction, namespaceKey, existingNamespace)
          : null;
        if (
          existingGeneration?.cursor.streamEpoch === generation.cursor.streamEpoch &&
          existingGeneration.cursor.revision >= generation.cursor.revision
        ) {
          return;
        }
        await transaction.put<StoredGeneration<ConfirmedPayload, HistoryMetadata>>(
          "generations",
          generationKey(namespaceKey, generation.generationId),
          { namespaceKey, generation: cloneValue(generation) },
        );
        await transaction.put<NamespaceRecord<HistoryMetadata>>("namespaces", namespaceKey, {
          persistenceVersion: COLLABORATION_PERSISTENCE_VERSION,
          identity: cloneValue(identity),
          activeGenerationId: generation.generationId,
          acceptedClientSequences: cloneValue(existingNamespace?.acceptedClientSequences ?? {}),
          history: cloneValue(generation.history),
          permanentWriteFence: cloneValue(existingNamespace?.permanentWriteFence ?? null),
        });
        if (
          existingNamespace?.activeGenerationId &&
          existingNamespace.activeGenerationId !== generation.generationId
        ) {
          await transaction.delete(
            "generations",
            generationKey(namespaceKey, existingNamespace.activeGenerationId),
          );
        }
        await this.removeCoveredAcknowledgedPending(transaction, namespaceKey, generation.cursor);
      },
    );
  }

  /**
   * Delete acknowledged pending rows the newly installed generation now
   * covers — in the same backend transaction as the install, so a crash never
   * exposes a generation that contains a commit alongside a replayable row for
   * it, nor a removed row whose commit the active generation lacks.
   */
  private async removeCoveredAcknowledgedPending(
    transaction: CollaborationPersistenceBackendTransaction,
    namespaceKey: string,
    cursor: CollaborationCursorMetadata,
  ) {
    const entries = await transaction.entries<StoredPendingTransaction<PendingPayload>>(
      "pending",
      pendingKeyPrefix(namespaceKey),
    );
    for (const entry of entries) {
      if (entry.value.namespaceKey !== namespaceKey) continue;
      const acknowledged = entry.value.pending.acknowledged;
      if (!acknowledged) continue;
      // A row acknowledged in another stream epoch is superseded by any
      // authoritative install: a new epoch's snapshot embodies all previously
      // committed server state.
      if (
        acknowledged.streamEpoch !== cursor.streamEpoch ||
        acknowledged.revision <= cursor.revision
      ) {
        await transaction.delete("pending", entry.key);
      }
    }
  }

  async persistPendingTransaction(
    identity: CollaborationCacheIdentity,
    pending: CollaborationPendingTransaction<PendingPayload>,
  ): Promise<void> {
    validateIdentity(identity);
    validatePendingTransaction(pending);
    const namespaceKey = collaborationCachePartitionKey(identity);
    await this.runBackend(
      "persist pending transaction",
      ["pending", "namespaces"],
      "readwrite",
      async (tx) => {
        const namespace = await tx.get<NamespaceRecord<HistoryMetadata>>(
          "namespaces",
          namespaceKey,
        );
        if (namespace?.permanentWriteFence) {
          throw new CollaborationPersistenceDataError(
            `Pending work is permanently fenced (${namespace.permanentWriteFence.kind}).`,
          );
        }
        await tx.put<StoredPendingTransaction<PendingPayload>>(
          "pending",
          pendingKey(namespaceKey, pending.clientTxId),
          { namespaceKey, pending: cloneValue(pending) },
        );
        if (!namespace) {
          await tx.put<NamespaceRecord<HistoryMetadata>>("namespaces", namespaceKey, {
            persistenceVersion: COLLABORATION_PERSISTENCE_VERSION,
            identity: cloneValue(identity),
            activeGenerationId: null,
            acceptedClientSequences: {},
            history: null,
            permanentWriteFence: null,
          });
        }
      },
    );
  }

  async removePendingTransaction(
    identity: CollaborationCacheIdentity,
    clientTxId: string,
  ): Promise<void> {
    validateIdentity(identity);
    validateId(clientTxId, "Client transaction id");
    const namespaceKey = collaborationCachePartitionKey(identity);
    await this.runBackend("remove pending transaction", ["pending"], "readwrite", async (tx) => {
      await tx.delete("pending", pendingKey(namespaceKey, clientTxId));
    });
  }

  async removePendingTransactions(
    identity: CollaborationCacheIdentity,
    clientTxIds: readonly string[],
  ): Promise<void> {
    validateIdentity(identity);
    const uniqueIds = [...new Set(clientTxIds)];
    for (const clientTxId of uniqueIds) validateId(clientTxId, "Client transaction id");
    const namespaceKey = collaborationCachePartitionKey(identity);
    await this.runBackend("remove pending transactions", ["pending"], "readwrite", async (tx) => {
      for (const clientTxId of uniqueIds) {
        await tx.delete("pending", pendingKey(namespaceKey, clientTxId));
      }
    });
  }

  /**
   * Atomically records a permanent branch fence and purges every pending queue
   * row in the cache partition. A crash exposes either the complete old queue or
   * the fenced partition with no pending rows.
   */
  async permanentlyFenceWrites(
    identity: CollaborationCacheIdentity,
    fence: CollaborationPermanentWriteFence,
  ): Promise<{ fence: CollaborationPermanentWriteFence; purgedClientTxIds: string[] }> {
    validateIdentity(identity);
    validatePermanentWriteFence(fence);
    const namespaceKey = collaborationCachePartitionKey(identity);
    return await this.runBackend(
      "permanently fence writes",
      ["namespaces", "pending"],
      "readwrite",
      async (transaction) => {
        const namespace = await transaction.get<NamespaceRecord<HistoryMetadata>>(
          "namespaces",
          namespaceKey,
        );
        const effectiveFence = selectPermanentWriteFence(
          namespace?.permanentWriteFence ?? null,
          fence,
        );
        await transaction.put<NamespaceRecord<HistoryMetadata>>("namespaces", namespaceKey, {
          persistenceVersion: COLLABORATION_PERSISTENCE_VERSION,
          identity: cloneValue(identity),
          activeGenerationId: namespace?.activeGenerationId ?? null,
          acceptedClientSequences: cloneValue(namespace?.acceptedClientSequences ?? {}),
          history: cloneValue(namespace?.history ?? null),
          permanentWriteFence: cloneValue(effectiveFence),
        });
        const purgedClientTxIds: string[] = [];
        const entries = await transaction.entries<StoredPendingTransaction<PendingPayload>>(
          "pending",
          pendingKeyPrefix(namespaceKey),
        );
        for (const entry of entries) {
          if (entry.value.namespaceKey !== namespaceKey) continue;
          purgedClientTxIds.push(entry.value.pending.clientTxId);
          await transaction.delete("pending", entry.key);
        }
        purgedClientTxIds.sort();
        return { fence: cloneValue(effectiveFence), purgedClientTxIds };
      },
    );
  }

  /** Clears a previously persisted fence after fresh branch metadata authorizes writes again. */
  async clearPermanentWriteFence(identity: CollaborationCacheIdentity): Promise<void> {
    validateIdentity(identity);
    const namespaceKey = collaborationCachePartitionKey(identity);
    await this.runBackend(
      "clear permanent write fence",
      ["namespaces"],
      "readwrite",
      async (tx) => {
        const namespace = await tx.get<NamespaceRecord<HistoryMetadata>>(
          "namespaces",
          namespaceKey,
        );
        if (!namespace?.permanentWriteFence) return;
        await tx.put<NamespaceRecord<HistoryMetadata>>("namespaces", namespaceKey, {
          ...namespace,
          permanentWriteFence: null,
        });
      },
    );
  }

  /** Updates small reload-safe history metadata without rewriting confirmed records. */
  async updateHistoryMetadata(
    identity: CollaborationCacheIdentity,
    history: HistoryMetadata | null,
  ): Promise<void> {
    validateIdentity(identity);
    const namespaceKey = collaborationCachePartitionKey(identity);
    await this.runBackend("update history metadata", ["namespaces"], "readwrite", async (tx) => {
      const namespace = await tx.get<NamespaceRecord<HistoryMetadata>>("namespaces", namespaceKey);
      if (!namespace) {
        throw new CollaborationPersistenceDataError(
          "Cannot persist history without an active committed generation.",
        );
      }
      await tx.put<NamespaceRecord<HistoryMetadata>>("namespaces", namespaceKey, {
        ...namespace,
        history: cloneValue(history),
      });
    });
  }

  /**
   * Atomically records an own-commit acknowledgement: watermark, history, and
   * optionally a confirmed generation. The acknowledged pending row is removed
   * only when the resulting active generation covers the acknowledged commit;
   * otherwise the row is stamped with its commit cursor and retained so a cold
   * offline reload can replay the acknowledged work over the older generation,
   * and a later covering install removes it atomically. Repeating an
   * already-completed acknowledgement is idempotent.
   */
  async commitOwnAcknowledgementMetadata(
    identity: CollaborationCacheIdentity,
    clientTxId: string,
    history: HistoryMetadata | null,
    acknowledged: CollaborationAcknowledgedSequence,
    generation?: CollaborationCommittedGeneration<ConfirmedPayload, HistoryMetadata>,
  ): Promise<"applied" | "already-applied"> {
    validateIdentity(identity);
    validateId(clientTxId, "Client transaction id");
    validateAcknowledgedSequence(acknowledged);
    if (generation) {
      validateGeneration(generation);
      if (generation.cursor.streamEpoch !== acknowledged.streamEpoch) {
        throw new CollaborationPersistenceDataError(
          "Acknowledged generation belongs to another stream epoch.",
        );
      }
    }
    const namespaceKey = collaborationCachePartitionKey(identity);
    return await this.runBackend(
      "commit own acknowledgement metadata",
      ["generations", "pending", "namespaces"],
      "readwrite",
      async (transaction) => {
        const namespace = await transaction.get<NamespaceRecord<HistoryMetadata>>(
          "namespaces",
          namespaceKey,
        );
        if (!namespace?.activeGenerationId) {
          throw new CollaborationPersistenceDataError(
            "Cannot acknowledge pending work without an active committed generation.",
          );
        }
        const pending = await transaction.get<StoredPendingTransaction<PendingPayload>>(
          "pending",
          pendingKey(namespaceKey, clientTxId),
        );
        const acceptedSequence =
          namespace.acceptedClientSequences?.[clientSequenceKey(acknowledged)] ?? 0;
        if (!pending && acceptedSequence >= acknowledged.clientSequence) {
          return "already-applied";
        }
        if (!pending) {
          throw new CollaborationPersistenceDataError(
            `Pending transaction ${clientTxId} is not persisted.`,
          );
        }
        const existingGeneration = await this.readActiveGeneration(
          transaction,
          namespaceKey,
          namespace,
        );
        const shouldInstallGeneration =
          !!generation &&
          (existingGeneration.cursor.streamEpoch !== generation.cursor.streamEpoch ||
            existingGeneration.cursor.revision < generation.cursor.revision);
        if (generation && shouldInstallGeneration) {
          await transaction.put<StoredGeneration<ConfirmedPayload, HistoryMetadata>>(
            "generations",
            generationKey(namespaceKey, generation.generationId),
            { namespaceKey, generation: cloneValue(generation) },
          );
        }
        await transaction.put<NamespaceRecord<HistoryMetadata>>("namespaces", namespaceKey, {
          ...namespace,
          activeGenerationId:
            generation && shouldInstallGeneration
              ? generation.generationId
              : namespace.activeGenerationId,
          acceptedClientSequences: {
            ...namespace.acceptedClientSequences,
            [clientSequenceKey(acknowledged)]: Math.max(
              acceptedSequence,
              acknowledged.clientSequence,
            ),
          },
          history: cloneValue(history),
        });
        if (
          generation &&
          shouldInstallGeneration &&
          namespace.activeGenerationId !== generation.generationId
        ) {
          await transaction.delete(
            "generations",
            generationKey(namespaceKey, namespace.activeGenerationId),
          );
        }
        const effectiveCursor =
          generation && shouldInstallGeneration ? generation.cursor : existingGeneration.cursor;
        const generationCoversCommit =
          effectiveCursor.streamEpoch === acknowledged.streamEpoch &&
          effectiveCursor.revision >= acknowledged.revision;
        if (generationCoversCommit) {
          // Earlier same-instance rows were acknowledged at lower revisions,
          // so a generation covering this commit covers them too.
          const entries = await transaction.entries<StoredPendingTransaction<PendingPayload>>(
            "pending",
            pendingKeyPrefix(namespaceKey),
          );
          for (const entry of entries) {
            if (
              entry.value.namespaceKey === namespaceKey &&
              entry.value.pending.clientInstanceId === acknowledged.clientInstanceId &&
              entry.value.pending.clientSequence <= acknowledged.clientSequence
            ) {
              await transaction.delete("pending", entry.key);
            }
          }
        } else {
          // The active generation predates the acknowledged commit (installs
          // coalesce). Keep the row as the crash-safe replay source, stamped
          // with the commit that acknowledged it so the covering install can
          // remove exactly the rows it contains.
          await transaction.put<StoredPendingTransaction<PendingPayload>>(
            "pending",
            pendingKey(namespaceKey, clientTxId),
            {
              namespaceKey,
              pending: {
                ...cloneValue(pending.pending),
                acknowledged: {
                  streamEpoch: acknowledged.streamEpoch,
                  revision: acknowledged.revision,
                },
              },
            },
          );
        }
        return "applied";
      },
    );
  }

  async clearAccount(accountId: string): Promise<void> {
    validateId(accountId, "Account id");
    const prefix = accountPartitionPrefix(accountId);
    await this.runBackend("clear account", STORE_NAMES, "readwrite", async (transaction) => {
      for (const storeName of STORE_NAMES) {
        const entries = await transaction.entries(storeName);
        for (const entry of entries) {
          if (entry.key.startsWith(prefix)) await transaction.delete(storeName, entry.key);
        }
      }
    });
  }

  async clearCache(identity: CollaborationCacheIdentity): Promise<void> {
    validateIdentity(identity);
    const namespaceKey = collaborationCachePartitionKey(identity);
    const childPrefix = `${namespaceKey}|`;
    await this.runBackend("clear collaboration cache", STORE_NAMES, "readwrite", async (tx) => {
      for (const storeName of STORE_NAMES) {
        const entries = await tx.entries(storeName);
        for (const entry of entries) {
          if (entry.key === namespaceKey || entry.key.startsWith(childPrefix)) {
            await tx.delete(storeName, entry.key);
          }
        }
      }
    });
  }

  private async readActiveGeneration(
    transaction: CollaborationPersistenceBackendTransaction,
    namespaceKey: string,
    namespace: NamespaceRecord<HistoryMetadata>,
  ) {
    if (
      namespace.persistenceVersion !== COLLABORATION_PERSISTENCE_VERSION ||
      collaborationCachePartitionKey(namespace.identity) !== namespaceKey
    ) {
      throw new CollaborationPersistenceDataError("Committed cache namespace is invalid.");
    }
    if (!namespace.activeGenerationId) {
      throw new CollaborationPersistenceDataError("Committed cache namespace has no generation.");
    }
    const stored = await transaction.get<StoredGeneration<ConfirmedPayload, HistoryMetadata>>(
      "generations",
      generationKey(namespaceKey, namespace.activeGenerationId),
    );
    if (!stored || stored.namespaceKey !== namespaceKey) {
      throw new CollaborationPersistenceDataError(
        `Active committed generation ${namespace.activeGenerationId} is missing.`,
      );
    }
    const generation = cloneValue(stored.generation);
    if ("history" in namespace) generation.history = cloneValue(namespace.history ?? null);
    return generation;
  }

  private async readPendingTransactions(
    transaction: CollaborationPersistenceBackendTransaction,
    namespaceKey: string,
  ) {
    const entries = await transaction.entries<StoredPendingTransaction<PendingPayload>>(
      "pending",
      pendingKeyPrefix(namespaceKey),
    );
    return entries
      .filter((entry) => entry.value.namespaceKey === namespaceKey)
      .map((entry) => cloneValue(entry.value.pending))
      .sort(
        (left, right) =>
          left.clientSequence - right.clientSequence ||
          left.clientTxId.localeCompare(right.clientTxId),
      );
  }

  private async runBackend<T>(
    operation: string,
    storeNames: readonly CollaborationPersistenceStoreName[],
    mode: "readonly" | "readwrite",
    callback: (transaction: CollaborationPersistenceBackendTransaction) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.backend.transaction(storeNames, mode, callback);
    } catch (error) {
      if (error instanceof CollaborationPersistenceDataError) throw error;
      const reason = classifyBackendFailure(error);
      const wrapped =
        error instanceof CollaborationPersistenceBackendError
          ? error
          : new CollaborationPersistenceBackendError(reason, operation, { cause: error });
      throw wrapped;
    }
  }
}

/** Stable cache partition key including persistence and record-schema versions. */
export function collaborationCachePartitionKey(identity: CollaborationCacheIdentity) {
  validateIdentity(identity);
  return [
    KEY_ROOT,
    encodeSegment(identity.accountId),
    `v${COLLABORATION_PERSISTENCE_VERSION}`,
    encodeSegment(identity.workspaceId),
    encodeSegment(identity.fileId),
    encodeSegment(identity.branchId),
    `schema-${identity.schemaVersion}`,
  ].join("|");
}

function accountPartitionPrefix(accountId: string) {
  return [KEY_ROOT, encodeSegment(accountId), ""].join("|");
}

function generationKey(namespaceKey: string, generationId: string) {
  return `${namespaceKey}|generation|${encodeSegment(generationId)}`;
}

function pendingKey(namespaceKey: string, clientTxId: string) {
  return `${namespaceKey}|pending|${encodeSegment(clientTxId)}`;
}

/** Key prefix selecting one namespace's pending rows without a full-store scan. */
function pendingKeyPrefix(namespaceKey: string) {
  return `${namespaceKey}|pending|`;
}

function encodeSegment(value: string) {
  return encodeURIComponent(value);
}

function validateIdentity(identity: CollaborationCacheIdentity) {
  validateId(identity.accountId, "Account id");
  validateId(identity.workspaceId, "Workspace id");
  validateId(identity.fileId, "File id");
  validateId(identity.branchId, "Branch id");
  if (!Number.isSafeInteger(identity.schemaVersion) || identity.schemaVersion < 1) {
    throw new CollaborationPersistenceDataError(
      "Collaboration cache schema version must be a positive safe integer.",
    );
  }
}

function validateGeneration<ConfirmedPayload, HistoryMetadata>(
  generation: CollaborationCommittedGeneration<ConfirmedPayload, HistoryMetadata>,
) {
  validateId(generation.generationId, "Generation id");
  validateTimestamp(generation.installedAtMs, "Generation installation time");
  validateCursor(generation.cursor, "Generation cursor");
  if (generation.checkpoint) {
    validateId(generation.checkpoint.checkpointId, "Checkpoint id");
    validateId(generation.checkpoint.manifestHash, "Checkpoint manifest hash");
    validateCursor(generation.checkpoint, "Checkpoint cursor");
    if (
      generation.checkpoint.streamEpoch !== generation.cursor.streamEpoch ||
      generation.checkpoint.revision > generation.cursor.revision
    ) {
      throw new CollaborationPersistenceDataError(
        "Checkpoint cursor must belong to and precede the committed generation cursor.",
      );
    }
  }
}

function validatePendingTransaction<PendingPayload>(
  pending: CollaborationPendingTransaction<PendingPayload>,
) {
  validateId(pending.clientInstanceId, "Pending client instance id");
  validateId(pending.clientTxId, "Client transaction id");
  if (!Number.isSafeInteger(pending.clientSequence) || pending.clientSequence < 1) {
    throw new CollaborationPersistenceDataError(
      "Pending client sequence must be a positive safe integer.",
    );
  }
  validateTimestamp(pending.createdAtMs, "Pending transaction creation time");
  if (pending.dependsOnClientTxId !== undefined) {
    validateId(pending.dependsOnClientTxId, "Pending dependency transaction id");
  }
}

function validateAcknowledgedSequence(acknowledged: CollaborationAcknowledgedSequence) {
  validateId(acknowledged.clientInstanceId, "Acknowledged client instance id");
  validateId(acknowledged.streamEpoch, "Acknowledged stream epoch");
  if (!Number.isSafeInteger(acknowledged.clientSequence) || acknowledged.clientSequence < 1) {
    throw new CollaborationPersistenceDataError(
      "Acknowledged client sequence must be a positive safe integer.",
    );
  }
  if (!Number.isSafeInteger(acknowledged.revision) || acknowledged.revision < 0) {
    throw new CollaborationPersistenceDataError(
      "Acknowledged commit revision must be non-negative.",
    );
  }
}

function validatePermanentWriteFence(fence: CollaborationPermanentWriteFence) {
  if (fence.kind !== "read-only" && fence.kind !== "archived") {
    throw new CollaborationPersistenceDataError("Permanent write fence kind is invalid.");
  }
  validateTimestamp(fence.fencedAtMs, "Permanent write fence time");
}

function selectPermanentWriteFence(
  existing: CollaborationPermanentWriteFence | null,
  requested: CollaborationPermanentWriteFence,
) {
  if (!existing) return requested;
  if (existing.kind === "archived" || requested.kind === "read-only") return existing;
  return requested;
}

export function collaborationAcceptedSequenceKey(streamEpoch: string, clientInstanceId: string) {
  validateId(streamEpoch, "Accepted sequence stream epoch");
  validateId(clientInstanceId, "Accepted sequence client instance id");
  return clientSequenceKey({ streamEpoch, clientInstanceId });
}

function clientSequenceKey(
  value: Pick<CollaborationAcknowledgedSequence, "clientInstanceId" | "streamEpoch">,
) {
  return `${encodeSegment(value.streamEpoch)}|${encodeSegment(value.clientInstanceId)}`;
}

function validateCursor(cursor: CollaborationCursorMetadata, label: string) {
  validateId(cursor.streamEpoch, `${label} stream epoch`);
  if (!Number.isSafeInteger(cursor.revision) || cursor.revision < 0) {
    throw new CollaborationPersistenceDataError(`${label} revision must be non-negative.`);
  }
}

function validateTimestamp(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CollaborationPersistenceDataError(`${label} must be a non-negative safe integer.`);
  }
}

function validateId(value: string, label: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new CollaborationPersistenceDataError(`${label} must not be empty.`);
  }
}

function classifyBackendFailure(error: unknown): CollaborationPersistenceFailureReason {
  if (error instanceof CollaborationPersistenceBackendError) return error.reason;
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (getErrorName(current) === "QuotaExceededError") return "quota";
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : null;
  }
  return "unavailable";
}

function getErrorName(error: unknown) {
  if (typeof error !== "object" || !error || !("name" in error)) return "Error";
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" ? name : "Error";
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}
