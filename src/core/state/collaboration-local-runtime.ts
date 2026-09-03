import {
  createLeafFileWithMainBranch,
  LEAF_RECORD_SCHEMA_VERSION,
  isLeafFileDto,
  leafSnapshotToPersistedDocument,
  persistedDocumentToLeafSnapshot,
  type LeafBranchDto,
  type LeafFileDto,
  type LeafRecordSnapshot,
} from "../shared/collaboration";
import { createCollaborationEditorSession } from "./collaboration-session";
import type { CollaborationRestoredPendingTransaction } from "./collaboration-controller";
import {
  commitLocalAuthorityOperation,
  createLocalAuthorityChannel,
  readLocalAuthority,
  type LocalAuthorityOperation,
  type LocalAuthorityOperationInput,
} from "./collaboration-local-authority";
import type {
  CollaborationApplicationRuntime,
  CollaborationApplicationSession,
  CreateCollaborationApplicationRuntimeOptions,
  NormalizedEditorSession,
} from "./collaboration-app-runtime";
import type { CollaborationPresenceBinding } from "./collaboration-presence-binding";
import type {
  CollaborationPresencePeer,
  CollaborationPresenceStatus,
} from "./collaboration-presence";
import type { NetworkCollaborationPersistence } from "./collaboration-network-session";
import type {
  CollaborationCacheIdentity,
  CollaborationPermanentWriteFenceKind,
} from "./collaboration-persistence";
import { createStarterDocument } from "./starter-document";

export const LOCAL_DIRECTORY_KEY_PREFIX = "leaf-collaboration-local-directory-v1";

export function createLocalRuntime(
  options: CreateCollaborationApplicationRuntimeOptions & {
    clientInstanceId: string;
    persistence: NetworkCollaborationPersistence;
  },
): CollaborationApplicationRuntime {
  const directory = new LocalCollaborationDirectory(
    options.accountId,
    options.localStorage === undefined
      ? typeof localStorage === "undefined"
        ? null
        : localStorage
      : options.localStorage,
  );
  const sessions = new Set<CollaborationApplicationSession>();
  const pendingOpenInitializations = new Set<Promise<void>>();
  const retainedOperationErrors = new Set<unknown>();
  let closed = false;
  let closePromise: Promise<void> | null = null;

  const runtime: CollaborationApplicationRuntime = {
    mode: "local",
    accountId: options.accountId,
    clientInstanceId: options.clientInstanceId,
    async listFiles() {
      assertRuntimeOpen(closed);
      return directory.listFiles();
    },
    async createFile(name) {
      assertRuntimeOpen(closed);
      const file = directory.createFile(name);
      const main = file.branches[0]!;
      await installLocalStarter(options.persistence, options.accountId, file, main);
      return file;
    },
    async renameFile(fileId, name) {
      assertRuntimeOpen(closed);
      return directory.renameFile(fileId, name);
    },
    async openSession(file, branch, callbacks = {}) {
      assertRuntimeOpen(closed);
      let finishOpenInitialization!: () => void;
      const openInitialization = new Promise<void>((resolve) => {
        finishOpenInitialization = resolve;
      });
      pendingOpenInitializations.add(openInitialization);
      try {
        assertBranchBelongsToFile(file, branch);
        const identity = cacheIdentity(options.accountId, file, branch);
        const fence = branchWriteFence(branch);
        if (fence) {
          await options.persistence.permanentlyFenceWrites(identity, {
            kind: fence,
            fencedAtMs: Date.now(),
          });
        } else {
          await options.persistence.clearPermanentWriteFence(identity);
        }
        let persisted = await options.persistence.load(identity);
        if (!persisted.activeGeneration) {
          await installLocalStarter(options.persistence, options.accountId, file, branch);
          persisted = await options.persistence.load(identity);
        }
        const generation = persisted.activeGeneration;
        if (!generation) throw new Error("The local collaboration cache did not initialize");
        let editor = createCollaborationEditorSession(
          leafSnapshotToPersistedDocument(generation.confirmed),
          generation.confirmed,
        );
        if (generation.history) editor.controller.restoreHistoryMetadata(generation.history);
        let disposed = false;
        let disposePromise: Promise<void> | null = null;
        let revision = generation.cursor.revision;
        let sessionGeneration = 1;
        let operationQueue = Promise.resolve();
        let synchronizationQueue = Promise.resolve();
        let lastOperationError: unknown = null;
        let writeBarrierCount = 0;
        let writesPermanentlyFenced = !!fence;
        let presence: CollaborationPresenceBinding | null = null;
        let presencePeers: CollaborationPresencePeer[] = [];
        let presenceStatus: CollaborationPresenceStatus = "idle";
        const recordOperationError = (error: unknown) => {
          if (lastOperationError !== null) return;
          lastOperationError = error;
          retainedOperationErrors.add(error);
        };
        const throwLastOperationError = () => {
          if (lastOperationError !== null) throw lastOperationError;
        };
        const emitPresence = () =>
          callbacks.onPresenceChange?.(structuredClone(presencePeers), presenceStatus);
        const rejectWrites = () => {
          throw new Error("This branch is read-only");
        };
        const pendingRequests = new Map<
          string,
          CollaborationRestoredPendingTransaction & { baseRevision: number }
        >();

        const synchronizeNow = async () => {
          if (disposed) return;
          const latest = await options.persistence.load(identity);
          const active = latest.activeGeneration;
          if (!active || active.cursor.revision <= revision) return;
          const authority = readLocalAuthority(active.history, active.cursor.revision);
          const commits = authority.commits
            .filter((commit) => commit.revision > revision)
            .sort((left, right) => left.revision - right.revision);
          const isContiguous =
            commits[0]?.revision === revision + 1 &&
            commits.at(-1)?.revision === active.cursor.revision;

          if (isContiguous) {
            for (const commit of commits) {
              editor.controller.receiveAuthoritativeCommit(commit);
              revision = commit.revision;
              pendingRequests.delete(commit.clientTxId);
            }
            return;
          }

          const committedIds = new Set(authority.commits.map((commit) => commit.clientTxId));
          for (const clientTxId of committedIds) pendingRequests.delete(clientTxId);
          const replacement = createCollaborationEditorSession(
            leafSnapshotToPersistedDocument(active.confirmed),
            active.confirmed,
          );
          if (active.history) replacement.controller.restoreHistoryMetadata(active.history);
          const remainingPending = [...pendingRequests.values()].map(
            ({ baseRevision: _, ...entry }) => structuredClone(entry),
          );
          if (remainingPending.length) {
            replacement.controller.restorePendingTransactions(remainingPending);
          }
          editor.controller.dispose();
          editor = replacement;
          revision = active.cursor.revision;
          sessionGeneration += 1;
          attachDispatcher();
          presence?.replaceSession?.(replacement);
          callbacks.onSessionReplaced?.(replacement, sessionGeneration);
        };

        const synchronize = () => {
          const next = synchronizationQueue.then(synchronizeNow);
          synchronizationQueue = next.catch((error) => {
            recordOperationError(error);
          });
          return next;
        };

        const enqueueOperation = (operation: LocalAuthorityOperationInput) => {
          if (disposed) throw new Error("The local collaboration session is closed");
          if (writesPermanentlyFenced) return rejectWrites();
          if (writeBarrierCount > 0) {
            throw new Error("Wait for the pending session operation to finish before editing");
          }
          throwLastOperationError();
          const clientTxId = crypto.randomUUID();
          const pending = {
            ...structuredClone(operation),
            baseRevision: revision,
            clientTxId,
          } as LocalAuthorityOperation;
          pendingRequests.set(clientTxId, {
            clientTxId,
            historyGroupId: operation.historyGroupId,
            kind: operation.kind,
            ...(operation.kind === "user" ? { commands: structuredClone(operation.commands) } : {}),
            baseRevision: revision,
          });
          const run = operationQueue.then(async () => {
            const result = await commitLocalAuthorityOperation({
              accountId: options.accountId,
              identity,
              operation: pending,
              persistence: options.persistence,
            });
            await synchronize();
            channel.publish(result.commit.revision);
            directory.touchFileBestEffort(file.fileId, branch.branchId);
          });
          operationQueue = run.catch((error) => {
            pendingRequests.delete(clientTxId);
            editor.controller.rejectAuthoritativeTransaction(clientTxId);
            recordOperationError(error);
          });
          return clientTxId;
        };

        const attachDispatcher = () => {
          editor.controller.attachTransactionDispatcher(
            (commands, historyGroupId) =>
              enqueueOperation({ kind: "user", commands, historyGroupId }),
            (kind, historyGroupId) => enqueueOperation({ kind, historyGroupId }),
          );
        };

        const channel = createLocalAuthorityChannel(identity, () => {
          void synchronize().catch(() => undefined);
        });
        attachDispatcher();

        const handle: CollaborationApplicationSession = {
          file: structuredClone(file),
          branch: structuredClone(branch),
          get generation() {
            return sessionGeneration;
          },
          get presencePeers() {
            return structuredClone(presencePeers);
          },
          get presenceStatus() {
            return presenceStatus;
          },
          status: "local",
          getCurrentSession: () => editor,
          setOnline: () => undefined,
          async fenceWrites(kind) {
            writesPermanentlyFenced = true;
            await operationQueue;
            await synchronizationQueue;
            throwLastOperationError();
            await options.persistence.permanentlyFenceWrites(identity, {
              kind,
              fencedAtMs: Date.now(),
            });
            editor.controller.rejectAllPendingTransactions();
            presence?.fence?.(kind);
            callbacks.onWriteFence?.(kind);
          },
          async flushPersistence() {
            await operationQueue;
            await synchronizationQueue;
            throwLastOperationError();
          },
          async acquireWriteBarrier() {
            writeBarrierCount += 1;
            let released = false;
            const release = () => {
              if (released) return;
              released = true;
              writeBarrierCount -= 1;
            };
            try {
              if (disposed) throw new Error("The source collaboration session was closed");
              await operationQueue;
              await synchronizationQueue;
              throwLastOperationError();
              if (writesPermanentlyFenced) {
                throw new Error("A read-only session cannot acquire a write barrier");
              }
              return release;
            } catch (error) {
              release();
              throw error;
            }
          },
          dispose() {
            if (disposePromise) return disposePromise;
            disposed = true;
            disposePromise = (async () => {
              await operationQueue;
              await synchronizationQueue;
              const operationError = lastOperationError;
              let presenceError: unknown = null;
              try {
                await presence?.dispose();
              } catch (error) {
                presenceError = error;
              } finally {
                presence = null;
                channel.dispose();
                editor.controller.dispose();
                sessions.delete(handle);
              }
              if (operationError && presenceError) {
                throw new AggregateError(
                  [operationError, presenceError],
                  "The session failed to persist and dispose its presence binding.",
                );
              }
              if (operationError) throw operationError;
              if (presenceError) throw presenceError;
            })();
            return disposePromise;
          },
          async disposeForLogout() {
            await handle.dispose();
          },
        };
        try {
          await synchronize();
          presence =
            (await options.presenceBindingFactory?.create({
              branch: structuredClone(branch),
              descriptor: null,
              file: structuredClone(file),
              getCurrentSession: () => editor,
              onPeersChange: (peers) => {
                presencePeers = structuredClone(peers);
                emitPresence();
              },
              onStatusChange: (nextStatus) => {
                presenceStatus = nextStatus;
                emitPresence();
              },
            })) ?? null;
          assertRuntimeOpen(closed);
          sessions.add(handle);
          callbacks.onStatusChange?.("local");
          assertRuntimeOpen(closed);
          return handle;
        } catch (error) {
          try {
            await handle.dispose();
          } catch (cleanupError) {
            if (cleanupError !== error) {
              throw new AggregateError(
                [error, cleanupError],
                "The local collaboration session failed to initialize and clean up.",
              );
            }
          }
          throw error;
        }
      } finally {
        pendingOpenInitializations.delete(openInitialization);
        finishOpenInitialization();
      }
    },
    async disposeForLogout() {
      const disposeErrors = await disposeLocalSessions(sessions);
      throwLocalCleanupErrors(
        disposeErrors,
        "One or more local collaboration sessions failed to close for logout.",
      );
      await options.persistence.clearAccount(options.accountId);
      directory.clear();
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        await Promise.all(pendingOpenInitializations);
        const cleanupErrors = await disposeLocalSessions(sessions);
        for (const error of retainedOperationErrors) {
          if (!cleanupErrors.includes(error)) cleanupErrors.push(error);
        }
        try {
          await options.persistence.backend.close?.();
        } catch (error) {
          cleanupErrors.push(error);
        }
        throwLocalCleanupErrors(
          cleanupErrors,
          "The local collaboration runtime encountered errors while closing.",
        );
      })();
      return closePromise;
    },
  };
  return runtime;
}

async function disposeLocalSessions(sessions: Set<CollaborationApplicationSession>) {
  const errors: unknown[] = [];
  for (const session of sessions) {
    try {
      await session.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function throwLocalCleanupErrors(errors: unknown[], message: string) {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}

class LocalCollaborationDirectory {
  private readonly key: string;

  constructor(
    private readonly accountId: string,
    private readonly storage: Storage | null,
  ) {
    this.key = `${LOCAL_DIRECTORY_KEY_PREFIX}:${encodeURIComponent(accountId)}`;
  }

  listFiles(): LeafFileDto[] {
    const value = this.storage?.getItem(this.key);
    if (!value) return [];
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!Array.isArray(parsed) || !parsed.every(isLeafFileDto)) {
        throw new Error("The local file directory is invalid");
      }
      return structuredClone(parsed);
    } catch (error) {
      throw new Error("The local file directory could not be read", { cause: error });
    }
  }

  createFile(name: string) {
    const normalizedName = name.trim();
    if (!normalizedName) throw new Error("A file name is required");
    const files = this.listFiles();
    const fileId = crypto.randomUUID();
    const branchId = crypto.randomUUID();
    const now = new Date().toISOString();
    const file = createLeafFileWithMainBranch({
      branchId,
      fileId,
      name: normalizedName,
      now,
      workspaceId: `local:${this.accountId}`,
    });
    files.push(file);
    this.write(files);
    return structuredClone(file);
  }

  /**
   * Editing recency is an ancillary directory projection. The normalized
   * authority commit is already durable when this runs, so a missing entry or
   * storage failure must not reject that semantic edit or poison its session.
   */
  touchFileBestEffort(fileId: string, branchId: string) {
    try {
      const files = this.listFiles();
      const file = files.find((candidate) => candidate.fileId === fileId);
      const branch = file?.branches.find((candidate) => candidate.branchId === branchId);
      if (!file || !branch) return;
      const now = nextIsoTimestamp(branch.updatedAt, file.updatedAt);
      branch.updatedAt = now;
      file.updatedAt = now;
      this.write(files);
    } catch {
      // Best-effort by contract: authority and live-session state remain valid.
    }
  }

  renameFile(fileId: string, name: string) {
    const normalizedName = name.trim();
    if (!normalizedName) throw new Error("A file name is required");
    const files = this.listFiles();
    const file = files.find((candidate) => candidate.fileId === fileId);
    if (!file) throw new Error("The file was not found");
    file.name = normalizedName;
    file.updatedAt = nextIsoTimestamp(file.updatedAt);
    this.write(files);
    return structuredClone(file);
  }

  clear() {
    this.storage?.removeItem(this.key);
  }

  private write(files: LeafFileDto[]) {
    if (!this.storage) throw new Error("Local collaboration storage is unavailable");
    this.storage.setItem(this.key, JSON.stringify(files));
  }
}

function nextIsoTimestamp(...previous: string[]) {
  const previousMs = Math.max(...previous.map((value) => Date.parse(value)));
  return new Date(Math.max(Date.now(), previousMs + 1)).toISOString();
}

async function installLocalStarter(
  persistence: NetworkCollaborationPersistence,
  accountId: string,
  file: LeafFileDto,
  branch: LeafBranchDto,
) {
  await installLocalGeneration(
    persistence,
    cacheIdentity(accountId, file, branch),
    persistedDocumentToLeafSnapshot(createStarterDocument()),
    null,
    0,
  );
}

async function installLocalGeneration(
  persistence: NetworkCollaborationPersistence,
  identity: CollaborationCacheIdentity,
  snapshot: LeafRecordSnapshot,
  history: NormalizedEditorSession["controller"]["historyMetadata"] | null,
  revision: number,
) {
  await persistence.installCommittedGeneration(identity, {
    generationId: `local:${identity.branchId}:${revision}`,
    installedAtMs: Date.now(),
    cursor: { streamEpoch: `local:${identity.branchId}`, revision },
    checkpoint: null,
    confirmed: snapshot,
    history,
  });
}

function cacheIdentity(
  accountId: string,
  file: LeafFileDto,
  branch: LeafBranchDto,
): CollaborationCacheIdentity {
  return {
    accountId,
    workspaceId: file.workspaceId,
    fileId: file.fileId,
    branchId: branch.branchId,
    schemaVersion: LEAF_RECORD_SCHEMA_VERSION,
  };
}

function branchWriteFence(branch: LeafBranchDto): CollaborationPermanentWriteFenceKind | null {
  if (branch.writeMode === "archived" || branch.status === "archived") return "archived";
  if (branch.writeMode === "read_only" || branch.status !== "active") return "read-only";
  return null;
}

function assertBranchBelongsToFile(file: LeafFileDto, branch: LeafBranchDto) {
  if (
    file.fileId !== branch.fileId ||
    !file.branches.some((candidate) => candidate.branchId === branch.branchId)
  ) {
    throw new Error("The branch does not belong to the selected file");
  }
}

function assertRuntimeOpen(closed: boolean) {
  if (closed) throw new Error("The collaboration application runtime is closed");
}
