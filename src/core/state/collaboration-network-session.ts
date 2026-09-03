import { leafSnapshotToPersistedDocument, type LeafRecordSnapshot } from "../shared/collaboration";
import { createCollaborationEditorSession } from "./collaboration-session";
import {
  CollaborationTransport,
  type CollaborationTransportPendingTransaction,
  type CollaborationTransportOptions,
  type CollaborationTransportStatus,
} from "./collaboration-transport";
import { type CollaborationHistoryMetadata } from "./collaboration-controller";
import {
  collaborationAcceptedSequenceKey,
  type CollaborationCacheIdentity,
  type CollaborationPermanentWriteFence,
  type CollaborationPermanentWriteFenceKind,
  type CollaborationPendingTransaction,
  type CollaborationPersistence,
} from "./collaboration-persistence";
import type { PersistedEditorDocument } from "./document";

export type CachedCollaborationDocument = {
  document: PersistedEditorDocument;
  snapshot: LeafRecordSnapshot;
  cursor: { streamEpoch: string; revision: number };
};

type CollaborationCommittedCache = LeafRecordSnapshot;
type CollaborationPendingCache = CollaborationTransportPendingTransaction;

export type NetworkCollaborationPersistence = CollaborationPersistence<
  CollaborationCommittedCache,
  CollaborationPendingCache,
  CollaborationHistoryMetadata
>;

export type NetworkCollaborationSession = ReturnType<typeof createCollaborationEditorSession> & {
  clearCachedData: () => Promise<void>;
  dispose: () => Promise<void>;
  disposeForLogout: () => Promise<void>;
  fenceBranchWrites: (kind: CollaborationPermanentWriteFenceKind) => Promise<void>;
  flushPersistence: () => Promise<void>;
  getCurrentSession: () => ReturnType<typeof createCollaborationEditorSession>;
  readonly permanentWriteFence: CollaborationPermanentWriteFence | null;
  transport: CollaborationTransport;
};

export type OpenNetworkCollaborationSessionOptions = Omit<
  CollaborationTransportOptions,
  | "initialCursor"
  | "initialAcceptedClientSequence"
  | "initialPermanentWriteFence"
  | "initialPendingTransactions"
  | "acknowledgePendingTransaction"
  | "onCommit"
  | "onPersistenceError"
  | "onPermanentWriteFence"
  | "onReject"
  | "onSnapshot"
  | "onSnapshotAcknowledgement"
  | "persistPendingTransaction"
  | "persistPermanentWriteFence"
  | "removePendingTransaction"
  | "removePendingTransactions"
> & {
  /** Omit to honor cached state; pass null only after authoritative metadata restores writes. */
  branchWriteFence?: CollaborationPermanentWriteFenceKind | null;
  cached?: CachedCollaborationDocument;
  cacheIdentity?: CollaborationCacheIdentity;
  /**
   * Hold the first connection until this settles. The cached document opens
   * and accepts edits meanwhile (a freshly created file whose registry row is
   * still being written); a rejection reports the session as errored.
   */
  connectAfter?: Promise<unknown>;
  /**
   * Abandons the open: the transport closes, persistence flushes, and the
   * returned promise rejects with an `AbortError` if it has not settled yet.
   * A cache warm that is still waiting on the network is abandoned this way
   * when the runtime closes or the account signs out.
   */
  signal?: AbortSignal;
  /**
   * Trailing delay before a committed-cache generation install, and the upper
   * bound one keeps being deferred under a steady commit stream. The server
   * owns confirmed state and an online cold open replays the journal from the
   * cached cursor; for offline cold opens, acknowledged own transactions stay
   * durable as stamped pending rows until an install covers them, so a
   * coalesced (or crash-lost) install never loses data. Tests pass 0 to keep
   * install timing immediate.
   */
  generationCoalesceMs?: number;
  generationCoalesceMaxWaitMs?: number;
  onBranchWriteFence?: (fence: CollaborationPermanentWriteFence) => void;
  onPersistenceError?: (error: Error) => void;
  onSessionReplaced?: (session: ReturnType<typeof createCollaborationEditorSession>) => void;
  persistence?: NetworkCollaborationPersistence;
};

/** Opens a normalized editor only after its snapshot/tail barrier is contiguous. */
export async function openNetworkCollaborationSession(
  options: OpenNetworkCollaborationSessionOptions,
) {
  if (options.persistence && !options.cacheIdentity) {
    throw new Error("A collaboration cache identity is required with persistence");
  }
  const now = options.now ?? (() => Date.now());
  const activePersistence = options.persistence ?? null;
  let permanentWriteFence: CollaborationPermanentWriteFence | null = options.branchWriteFence
    ? { kind: options.branchWriteFence, fencedAtMs: now() }
    : null;
  if (activePersistence && options.cacheIdentity && options.branchWriteFence !== undefined) {
    try {
      if (permanentWriteFence) {
        permanentWriteFence = (
          await activePersistence.permanentlyFenceWrites(options.cacheIdentity, permanentWriteFence)
        ).fence;
      } else {
        await activePersistence.clearPermanentWriteFence(options.cacheIdentity);
      }
    } catch (error) {
      options.onPersistenceError?.(asError(error));
      throw error;
    }
  }
  let cached = options.cached;
  let restoredHistory: CollaborationHistoryMetadata | null = null;
  let restoredPending: CollaborationTransportPendingTransaction[] = [];
  let restoredAcceptedClientSequence = 0;
  let activeCheckpoint: NonNullable<
    Awaited<ReturnType<NetworkCollaborationPersistence["load"]>>["activeGeneration"]
  >["checkpoint"] = null;
  if (activePersistence && options.cacheIdentity) {
    try {
      const persisted = await activePersistence.load(options.cacheIdentity);
      permanentWriteFence = selectPermanentWriteFence(
        permanentWriteFence,
        persisted.permanentWriteFence,
      );
      if (permanentWriteFence && persisted.pendingTransactions.length) {
        permanentWriteFence = (
          await activePersistence.permanentlyFenceWrites(options.cacheIdentity, permanentWriteFence)
        ).fence;
      }
      if (persisted.activeGeneration) {
        activeCheckpoint = persisted.activeGeneration.checkpoint;
        cached ??= {
          document: leafSnapshotToPersistedDocument(persisted.activeGeneration.confirmed),
          snapshot: persisted.activeGeneration.confirmed,
          cursor: persisted.activeGeneration.cursor,
        };
        restoredHistory = persisted.activeGeneration.history;
        if (!permanentWriteFence) {
          const generationCursor = persisted.activeGeneration.cursor;
          restoredPending = persisted.pendingTransactions
            .filter((pending) => pending.clientInstanceId === options.clientInstanceId)
            // An acknowledged row is replayable only while the restored
            // generation provably predates its commit in the same epoch;
            // anything else is already represented by authoritative state.
            .filter(
              (pending) =>
                !pending.acknowledged ||
                (pending.acknowledged.streamEpoch === generationCursor.streamEpoch &&
                  pending.acknowledged.revision > generationCursor.revision),
            )
            .map(readPersistedPending);
        }
        restoredAcceptedClientSequence =
          persisted.acceptedClientSequences[
            collaborationAcceptedSequenceKey(
              persisted.activeGeneration.cursor.streamEpoch,
              options.clientInstanceId,
            )
          ] ?? 0;
      } else if (persisted.pendingTransactions.length) {
        throw new Error("Persisted collaboration work has no committed cache generation");
      }
    } catch (error) {
      options.onPersistenceError?.(asError(error));
      throw error;
    }
  }

  let session = cached ? createCollaborationEditorSession(cached.document, cached.snapshot) : null;
  if (session && restoredHistory) session.controller.restoreHistoryMetadata(restoredHistory);
  if (session && restoredPending.length) {
    session.controller.restorePendingTransactions(restoredPending);
  }
  let transport!: CollaborationTransport;
  let settled = false;
  let disposed = false;
  let dispatcherController:
    | ReturnType<typeof createCollaborationEditorSession>["controller"]
    | null = null;
  let unsubscribeHistoryPersistence: (() => void) | null = null;
  let lastScheduledHistory = restoredHistory ? JSON.stringify(restoredHistory) : null;
  let historyPersistenceQueue = Promise.resolve();
  // Committed-generation installs coalesce: each install serializes, clones,
  // and writes the whole confirmed document plus history metadata, which is
  // the dominant per-commit cost on the renderer main thread. Only the latest
  // commit cursor is recorded here; the snapshot itself is read from the live
  // controller once at flush time, so a burst of commits pays for one
  // full-document persistence pass instead of one per commit.
  const generationCoalesceMs = options.generationCoalesceMs ?? 1_000;
  const generationCoalesceMaxWaitMs = options.generationCoalesceMaxWaitMs ?? 5_000;
  let deferredGenerationCursor: { streamEpoch: string; revision: number } | null = null;
  let generationFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let generationFirstDeferredAtMs: number | null = null;
  let disposePromise: Promise<void> | null = null;
  const callerWriteAllowed = options.writeAllowed ?? true;

  const ready = new Promise<NetworkCollaborationSession>((resolve, reject) => {
    const attachDispatcher = () => {
      if (!session) return;
      if (dispatcherController === session.controller) return;
      session.controller.attachTransactionDispatcher(
        (commands, historyGroupId) => transport.enqueue(commands, historyGroupId),
        (kind, historyGroupId) => transport.enqueueHistory(kind, historyGroupId),
      );
      dispatcherController = session.controller;
    };
    let requestHistoryFlush: (() => void) | null = null;
    const attachHistoryPersistence = () => {
      unsubscribeHistoryPersistence?.();
      unsubscribeHistoryPersistence = null;
      requestHistoryFlush = null;
      if (!session || !activePersistence || !options.cacheIdentity) return;
      const controller = session.controller;
      // Serializing the whole history (twice — once for the metadata, once
      // for the dedupe check) on every controller notification grows with
      // session length. Coalesce with the same window as generation installs,
      // anchored to the first change so staleness stays bounded; detach
      // (dispose or a snapshot replacing the session) flushes immediately.
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const flushHistory = () => {
        if (flushTimer !== null) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        const metadata = controller.historyMetadata;
        const serialized = JSON.stringify(metadata);
        if (serialized === lastScheduledHistory) return;
        lastScheduledHistory = serialized;
        historyPersistenceQueue = historyPersistenceQueue.then(async () => {
          const persistence = activePersistence;
          if (!persistence || !options.cacheIdentity) return;
          try {
            await persistence.updateHistoryMetadata(options.cacheIdentity, metadata);
          } catch (error) {
            options.onPersistenceError?.(asError(error));
          }
        });
      };
      const unsubscribe = controller.subscribe(() => {
        if (generationCoalesceMs <= 0) {
          flushHistory();
          return;
        }
        flushTimer ??= setTimeout(flushHistory, generationCoalesceMs);
      });
      requestHistoryFlush = flushHistory;
      unsubscribeHistoryPersistence = () => {
        unsubscribe();
        requestHistoryFlush = null;
        flushHistory();
      };
    };

    const clearDeferredGeneration = () => {
      if (generationFlushTimer !== null) {
        clearTimeout(generationFlushTimer);
        generationFlushTimer = null;
      }
      deferredGenerationCursor = null;
      generationFirstDeferredAtMs = null;
    };

    const flushDeferredGeneration = () => {
      const cursor = deferredGenerationCursor;
      clearDeferredGeneration();
      if (!cursor || !session || !activePersistence || !options.cacheIdentity) return;
      // The confirmed document only advances through authoritative commits, so
      // reading it at flush time always yields exactly the state at the last
      // recorded commit cursor.
      const generation = {
        generationId: `${cursor.streamEpoch}:${cursor.revision}`,
        installedAtMs: now(),
        cursor,
        checkpoint: activeCheckpoint,
        confirmed: session.controller.confirmedSnapshot,
        history: session.controller.historyMetadata,
      } satisfies Parameters<NetworkCollaborationPersistence["installCommittedGeneration"]>[1];
      const persistence = activePersistence;
      const identity = options.cacheIdentity;
      historyPersistenceQueue = historyPersistenceQueue.then(async () => {
        try {
          await persistence.installCommittedGeneration(identity, generation);
        } catch (error) {
          options.onPersistenceError?.(asError(error));
          throw error;
        }
      });
    };

    let generationMicrotaskFlushScheduled = false;
    const scheduleDeferredGeneration = (cursor: { streamEpoch: string; revision: number }) => {
      if (!activePersistence || !options.cacheIdentity) return;
      deferredGenerationCursor = cursor;
      const nowMs = now();
      generationFirstDeferredAtMs ??= nowMs;
      if (generationFlushTimer !== null) clearTimeout(generationFlushTimer);
      const remainingMaxWait = Math.max(
        0,
        generationCoalesceMaxWaitMs - (nowMs - generationFirstDeferredAtMs),
      );
      // Timers in a hidden window are throttled to seconds-or-minutes
      // granularity, so the coalescing bounds would not actually hold in the
      // background-agent scenario; install immediately instead — main-thread
      // cost is invisible while the window is hidden.
      const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      const delayMs = hidden ? 0 : Math.min(generationCoalesceMs, remainingMaxWait);
      if (delayMs <= 0) {
        // Immediate installs still flush on a microtask, never synchronously:
        // this runs inside onCommit, and an own commit's acknowledgement is
        // enqueued later in the same applyCommit call. The install of the
        // covering generation must land in the persistence queue after that
        // acknowledgement, or a crash between the two backend transactions
        // exposes a covering generation beside an unstamped pending row —
        // which a cold offline open would replay twice.
        if (!generationMicrotaskFlushScheduled) {
          generationMicrotaskFlushScheduled = true;
          queueMicrotask(() => {
            generationMicrotaskFlushScheduled = false;
            flushDeferredGeneration();
          });
        }
        return;
      }
      generationFlushTimer = setTimeout(flushDeferredGeneration, delayMs);
    };

    const flushPersistence = async () => {
      while (true) {
        flushDeferredGeneration();
        const historyBoundary = historyPersistenceQueue;
        await Promise.all([historyBoundary, transport.flushPersistence()]);
        // A commit arriving during the await defers a new generation without
        // touching the queue, so the identity check alone would report
        // durability with an install still pending.
        if (historyBoundary === historyPersistenceQueue && deferredGenerationCursor === null) {
          return;
        }
      }
    };

    const disposeSession = () => {
      if (disposePromise) return disposePromise;
      disposed = true;
      removeVisibilityFlush?.();
      removeVisibilityFlush = null;
      transport.close();
      unsubscribeHistoryPersistence?.();
      unsubscribeHistoryPersistence = null;
      session?.controller.dispose();
      disposePromise = flushPersistence();
      return disposePromise;
    };

    const fenceBranchWrites = async (kind: CollaborationPermanentWriteFenceKind) => {
      const fence = { kind, fencedAtMs: now() } satisfies CollaborationPermanentWriteFence;
      transport.setWriteAllowed(false);
      await transport.permanentlyFenceWrites(fence);
    };

    attachHistoryPersistence();

    // Remote commits have no stamped replay row — the coalesced install is
    // their only offline durability — and a hidden window throttles timers
    // far past the coalescing bounds. Drain both coalescers the moment the
    // window hides, while the page can still run.
    let removeVisibilityFlush: (() => void) | null = null;
    if (typeof document !== "undefined") {
      const flushWhileHidden = () => {
        if (document.visibilityState !== "hidden") return;
        flushDeferredGeneration();
        requestHistoryFlush?.();
      };
      document.addEventListener("visibilitychange", flushWhileHidden);
      removeVisibilityFlush = () => {
        document.removeEventListener("visibilitychange", flushWhileHidden);
      };
    }

    const handleStatusChange = (status: CollaborationTransportStatus) => {
      options.onStatusChange?.(status);
      if (status === "error" && !settled) {
        settled = true;
        reject(new Error("The collaboration session could not establish a contiguous stream"));
        return;
      }
      if ((status !== "live" && status !== "read-only" && status !== "offline") || settled) {
        return;
      }
      if (!session) {
        settled = true;
        reject(
          new Error(
            status === "offline"
              ? "The collaboration session is offline and has no committed cache"
              : "The collaboration room did not provide a document snapshot",
          ),
        );
        return;
      }
      resolveWithSession();
    };

    const resolveWithSession = () => {
      if (settled || !session) return;
      attachDispatcher();
      settled = true;
      const activeSession = session;
      const resolvedSession = {
        clearCachedData: async () => {
          await disposeSession();
          if (activePersistence && options.cacheIdentity) {
            await activePersistence.clearCache(options.cacheIdentity);
          }
        },
        get store() {
          return (session ?? activeSession).store;
        },
        get controller() {
          return (session ?? activeSession).controller;
        },
        transport,
        get permanentWriteFence() {
          return transport.currentPermanentWriteFence;
        },
        getCurrentSession: () => session ?? activeSession,
        fenceBranchWrites,
        flushPersistence,
        dispose: disposeSession,
        disposeForLogout: async () => {
          await disposeSession();
          if (activePersistence && options.cacheIdentity) {
            await activePersistence.clearAccount(options.cacheIdentity.accountId);
          }
        },
      } satisfies NetworkCollaborationSession;
      resolve(resolvedSession);
    };

    transport = new CollaborationTransport({
      ...options,
      initialCursor: cached?.cursor,
      initialAcceptedClientSequence: restoredAcceptedClientSequence,
      initialPermanentWriteFence: permanentWriteFence,
      initialPendingTransactions: restoredPending,
      writeAllowed: callerWriteAllowed,
      persistPendingTransaction: activePersistence
        ? async (pending) => {
            const persistence = activePersistence;
            if (!persistence || !options.cacheIdentity) return;
            await persistence.persistPendingTransaction(options.cacheIdentity, {
              clientInstanceId: options.clientInstanceId,
              clientTxId: pending.clientTxId,
              clientSequence: pending.clientSequence,
              createdAtMs: now(),
              payload: pending,
            });
          }
        : undefined,
      acknowledgePendingTransaction: activePersistence
        ? async (pending, commit) => {
            if (!session || !options.cacheIdentity) {
              throw new Error("Cannot persist an acknowledgement without an active session");
            }
            const history = session.controller.historyMetadata;
            const acknowledgement = historyPersistenceQueue.then(async () => {
              // The acknowledged document state itself arrives through the
              // coalesced generation install. Until that install covers this
              // commit, persistence keeps the pending row (stamped with the
              // commit cursor) so a crash inside the coalescing window still
              // replays the acknowledged work on a cold offline reload.
              const acknowledge = () =>
                activePersistence.commitOwnAcknowledgementMetadata(
                  options.cacheIdentity!,
                  pending.clientTxId,
                  history,
                  {
                    clientInstanceId: options.clientInstanceId,
                    clientSequence: pending.clientSequence,
                    streamEpoch: commit.streamEpoch,
                    revision: commit.revision,
                  },
                );
              try {
                await acknowledge();
              } catch (firstError) {
                try {
                  // The write is idempotent; one retry absorbs a transient
                  // backend hiccup.
                  await acknowledge();
                } catch {
                  // An unstamped row must not outlive its failed
                  // acknowledgement: a later covering install cannot
                  // recognize it, and a cold offline open would replay a
                  // commit the generation already contains. Dropping the row
                  // costs only offline visibility of this one commit — the
                  // server owns it — never correctness.
                  await activePersistence
                    .removePendingTransaction(options.cacheIdentity!, pending.clientTxId)
                    .catch(() => undefined);
                  throw firstError;
                }
              }
            });
            historyPersistenceQueue = acknowledgement.catch(() => undefined);
            await acknowledgement;
          }
        : undefined,
      removePendingTransaction: activePersistence
        ? async (clientTxId) => {
            const persistence = activePersistence;
            if (!persistence || !options.cacheIdentity) return;
            await persistence.removePendingTransaction(options.cacheIdentity, clientTxId);
          }
        : undefined,
      removePendingTransactions: activePersistence
        ? async (clientTxIds) => {
            if (!options.cacheIdentity) {
              throw new Error("Cannot remove pending work without a cache identity");
            }
            await activePersistence.removePendingTransactions(options.cacheIdentity, clientTxIds);
          }
        : undefined,
      persistPermanentWriteFence: activePersistence
        ? async (fence) => {
            if (!options.cacheIdentity) {
              throw new Error("Cannot persist a branch fence without a cache identity");
            }
            const result = await activePersistence.permanentlyFenceWrites(
              options.cacheIdentity,
              fence,
            );
            permanentWriteFence = result.fence;
            return result.fence;
          }
        : undefined,
      onPersistenceError: (error) => options.onPersistenceError?.(error),
      onPermanentWriteFence: (fence) => {
        permanentWriteFence = selectPermanentWriteFence(permanentWriteFence, fence);
        session?.controller.rejectAllPendingTransactions();
        options.onBranchWriteFence?.(permanentWriteFence ?? fence);
      },
      onSnapshot: async (snapshot, cursor, checkpoint) => {
        unsubscribeHistoryPersistence?.();
        unsubscribeHistoryPersistence = null;
        // The authoritative snapshot supersedes any commit-driven deferral,
        // and the immediate install below re-establishes the active
        // generation acknowledgements depend on.
        clearDeferredGeneration();
        await historyPersistenceQueue;
        if (disposed) return;
        const previousCursor = transport.currentCursor;
        const previousHistory = session?.controller.historyMetadata ?? restoredHistory;
        const currentPending = transport.pendingTransactions;
        session?.controller.dispose();
        const document = leafSnapshotToPersistedDocument(snapshot);
        session = createCollaborationEditorSession(document, snapshot);
        const preservesCachedEpoch = previousCursor?.streamEpoch === cursor.streamEpoch;
        if (preservesCachedEpoch && previousHistory) {
          session.controller.restoreHistoryMetadata(previousHistory);
        }
        if (preservesCachedEpoch && currentPending.length) {
          session.controller.restorePendingTransactions(currentPending);
        }
        attachDispatcher();
        if (activePersistence && options.cacheIdentity) {
          try {
            await activePersistence.installCommittedGeneration(options.cacheIdentity, {
              generationId: `${cursor.streamEpoch}:${cursor.revision}`,
              installedAtMs: now(),
              cursor,
              checkpoint: checkpoint
                ? {
                    checkpointId: checkpoint.checkpointId,
                    manifestHash: checkpoint.manifestSha256,
                    streamEpoch: checkpoint.streamEpoch,
                    revision: checkpoint.revision,
                  }
                : null,
              confirmed: snapshot,
              history: session.controller.historyMetadata,
            });
            activeCheckpoint = checkpoint
              ? {
                  checkpointId: checkpoint.checkpointId,
                  manifestHash: checkpoint.manifestSha256,
                  streamEpoch: checkpoint.streamEpoch,
                  revision: checkpoint.revision,
                }
              : null;
          } catch (error) {
            options.onPersistenceError?.(asError(error));
            throw error;
          }
        }
        if (disposed) return;
        cached = { document, snapshot, cursor };
        restoredHistory = session.controller.historyMetadata;
        restoredPending = currentPending;
        lastScheduledHistory = JSON.stringify(session.controller.historyMetadata);
        attachHistoryPersistence();
        if (settled) {
          options.onSessionReplaced?.(session);
        }
      },
      onCommit: (commit) => {
        if (!session) throw new Error("A collaboration commit arrived before its snapshot");
        session.controller.receiveAuthoritativeCommit(commit);
        // Building and persisting a generation per commit (full snapshot,
        // history serialization, deep clone, IndexedDB write) was the
        // dominant per-mutation cost; defer to the coalescer for own and
        // remote commits alike. Own-acknowledgement metadata still lands
        // per-ack below — it is small and replay dedupe depends on it.
        scheduleDeferredGeneration({ streamEpoch: commit.streamEpoch, revision: commit.revision });
      },
      onSnapshotAcknowledgement: (commit) => {
        if (!session) throw new Error("A collaboration receipt arrived before its snapshot");
        session.controller.acknowledgeAuthoritativeSnapshotCommit(commit);
      },
      onReject: (rejection) => {
        if (!session) return [];
        let rejected: string[];
        if (rejection.type === "resync") {
          rejected = session.controller.rejectAllPendingTransactions();
        } else if (!rejection.clientTxId) {
          rejected = [];
        } else {
          rejected = session.controller.rejectAuthoritativeTransaction(rejection.clientTxId);
        }
        return rejected;
      },
      onStatusChange: handleStatusChange,
    });
    attachDispatcher();

    if (options.signal) {
      const abortOpen = () => {
        if (!settled) {
          settled = true;
          reject(new DOMException("The collaboration session open was aborted.", "AbortError"));
        }
        void disposeSession().catch(() => undefined);
      };
      if (options.signal.aborted) {
        abortOpen();
        return;
      }
      options.signal.addEventListener("abort", abortOpen, { once: true });
    }

    if (options.online === false) {
      handleStatusChange("offline");
      if (!session) {
        transport.close();
        return;
      }
    }

    // A committed cache generation is the same authoritative state a live
    // bootstrap would replay from, so the editor opens on it immediately and
    // the transport reconciles behind it: a hot tail lands as ordinary remote
    // commits, an epoch rotation arrives through onSessionReplaced, and local
    // edits queue exactly as they do offline. Only an uncached open still
    // waits for the network.
    resolveWithSession();

    if (options.connectAfter) {
      void options.connectAfter.then(
        () => {
          if (!disposed) transport.connect();
        },
        () => {
          if (disposed) return;
          transport.close();
          options.onStatusChange?.("error");
        },
      );
      return;
    }
    transport.connect();
  });

  return ready;
}

function readPersistedPending(
  pending: CollaborationPendingTransaction<CollaborationPendingCache>,
): CollaborationTransportPendingTransaction {
  if (
    pending.clientTxId !== pending.payload.clientTxId ||
    pending.clientSequence !== pending.payload.clientSequence
  ) {
    throw new Error("Persisted collaboration queue metadata does not match its payload");
  }
  return structuredClone(pending.payload);
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function selectPermanentWriteFence(
  existing: CollaborationPermanentWriteFence | null,
  incoming: CollaborationPermanentWriteFence | null,
) {
  if (!incoming) return existing;
  if (!existing) return incoming;
  if (existing.kind === "archived" || incoming.kind === "read-only") return existing;
  return incoming;
}
