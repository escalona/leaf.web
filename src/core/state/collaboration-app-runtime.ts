import {
  LEAF_RECORD_SCHEMA_VERSION,
  createLeafFileWithMainBranch,
  isLeafFileDto,
  persistedDocumentToLeafSnapshot,
  type LeafBranchDto,
  type LeafBranchSessionDto,
  type LeafCheckpointBootstrapResponse,
  type LeafFileDto,
  type LeafRecordSnapshot,
} from "../shared/collaboration";
import { createCollaborationEditorSession } from "./collaboration-session";
import { CollaborationCheckpointClient } from "./collaboration-checkpoint";
import type { CollaborationHistoryMetadata } from "./collaboration-controller";
import type {
  CollaborationPresencePeer,
  CollaborationPresenceStatus,
} from "./collaboration-presence";
import {
  defaultPresenceBindingFactory,
  type CollaborationPresenceBinding,
  type CollaborationPresenceBindingFactory,
} from "./collaboration-presence-binding";
import {
  openNetworkCollaborationSession,
  type NetworkCollaborationPersistence,
  type NetworkCollaborationSession,
} from "./collaboration-network-session";
import {
  createBrowserCollaborationPersistence,
  type CollaborationCacheIdentity,
  type CollaborationPermanentWriteFenceKind,
} from "./collaboration-persistence";
import {
  CollaborationRegistryClient,
  CollaborationRegistryIdMismatchError,
  CollaborationRegistryRequestError,
  isRetryableCollaborationRegistryError,
} from "./collaboration-registry-client";
import { CollaborationSyncServerUrlRefusedError } from "./collaboration-transport";
import type { CollaborationTransportStatus } from "./collaboration-transport";
import type { CollaborationTransportPendingTransaction } from "./collaboration-transport";
import { createStarterDocument } from "./starter-document";
import { createLocalRuntime } from "./collaboration-local-runtime";

const CLIENT_INSTANCE_ID_KEY = "leaf-collaboration-client-instance-id-v1";
const INITIALIZED_CLIENT_INSTANCE_STORAGES = new WeakSet<Storage>();
const NETWORK_DIRECTORY_KEY_PREFIX = "leaf-collaboration-network-directory-v1";
const NETWORK_WORKSPACE_KEY_PREFIX = "leaf-collaboration-network-workspace-v1";
const STARTER_INITIALIZATION_ATTEMPTS = 3;
const OUTAGE_RECONNECT_DELAY_MS = 250;
const OFFLINE_SYNC_SERVER_URL = "wss://offline.invalid/sync";

export type NormalizedEditorSession = ReturnType<typeof createCollaborationEditorSession>;

export type CollaborationApplicationMode = "network" | "local";

export type { CollaborationPresenceBinding, CollaborationPresenceBindingFactory };

export interface CollaborationApplicationSession {
  readonly branch: LeafBranchDto;
  readonly file: LeafFileDto;
  readonly generation: number;
  readonly presencePeers: CollaborationPresencePeer[];
  readonly presenceStatus: CollaborationPresenceStatus;
  readonly status: CollaborationTransportStatus | "local";
  dispose(): Promise<void>;
  disposeForLogout(): Promise<void>;
  fenceWrites(kind: CollaborationPermanentWriteFenceKind): Promise<void>;
  flushPersistence(): Promise<void>;
  /**
   * Quiesce the session for a consistency-sensitive operation (e.g. a native
   * document close): waits for pending transactions to flush, then blocks new
   * writes until the returned release runs.
   */
  acquireWriteBarrier(): Promise<() => void>;
  getCurrentSession(): NormalizedEditorSession;
  setOnline(online: boolean): void;
}

export interface CollaborationApplicationRuntime {
  readonly accountId?: string;
  /** The organization the account's session was signed in to, if any. */
  readonly organizationId?: string | null;
  readonly clientInstanceId: string;
  readonly documentKind?: "native";
  readonly mode: CollaborationApplicationMode;
  close(): Promise<void>;
  /**
   * Create a file that is immediately listable and openable. A network
   * runtime confirms it with the registry in the background; use
   * `awaitFileCreation` to learn whether that confirmation succeeded.
   */
  createFile(name: string): Promise<LeafFileDto>;
  /** Resolves once a created file is confirmed remotely; rejects if that failed. */
  awaitFileCreation?(fileId: string): Promise<void>;
  disposeForLogout(): Promise<void>;
  listFiles(): Promise<LeafFileDto[]>;
  /**
   * The directory as last seen, without touching the network: what the shell
   * paints at launch while `listFiles` refreshes behind it. Null when this
   * device has never listed the account's files.
   */
  readCachedFiles?(): LeafFileDto[] | null;
  /**
   * Populate the local cache for a branch that has none, so a later open can
   * render before the network answers. Resolves false when nothing was needed.
   */
  warmBranchCache?(file: LeafFileDto, branch: LeafBranchDto): Promise<boolean>;
  openSession(
    file: LeafFileDto,
    branch: LeafBranchDto,
    callbacks?: {
      onSessionReplaced?: (session: NormalizedEditorSession, generation: number) => void;
      onPresenceChange?: (
        peers: CollaborationPresencePeer[],
        status: CollaborationPresenceStatus,
      ) => void;
      onStatusChange?: (status: CollaborationTransportStatus | "local") => void;
      onWriteFence?: (kind: CollaborationPermanentWriteFenceKind) => void;
    },
  ): Promise<CollaborationApplicationSession>;
  renameFile?(fileId: string, name: string): Promise<LeafFileDto>;
  /**
   * Record an uploaded dashboard thumbnail against a file (null clears it).
   * Absent on runtimes without a shared registry (local/offline), where
   * captures are skipped.
   */
  setFileThumbnail?(fileId: string, thumbnailAssetId: string | null): Promise<LeafFileDto>;
}

export interface LeafCollaborationWindowContext {
  readonly clientInstanceId: string;
  readonly currentBranch: LeafBranchDto | null;
  readonly currentFile: LeafFileDto | null;
  readonly mode: CollaborationApplicationMode;
  readonly presencePeers: CollaborationPresencePeer[];
  readonly presenceStatus: CollaborationPresenceStatus;
  readonly sessionGeneration: number;
  getCurrentSession(): NormalizedEditorSession | null;
}

declare global {
  interface Window {
    leafCollaboration?: LeafCollaborationWindowContext;
  }
}

export type CollaborationRegistry = Pick<
  CollaborationRegistryClient,
  | "createFile"
  | "createSyncUrlProvider"
  | "getFile"
  | "initializeBranch"
  | "issueBranchSession"
  | "listFiles"
  | "renameFile"
  | "setFileThumbnail"
> & {
  /** Reported by the registry with a listing; lets an empty directory create locally. */
  readonly lastKnownWorkspaceId?: string | null;
};

export type CreateCollaborationApplicationRuntimeOptions = {
  accountId: string;
  clientInstanceId?: string;
  clientInstanceStorage?: Storage | null;
  /** Transport for registry calls; the desktop app routes them through its main process. */
  fetcher?: typeof fetch;
  getAccessToken?: () => Promise<string>;
  /**
   * The name presence peers see for this account. Bound into each branch
   * session token, so the Worker can label this client's cursor without a
   * WorkOS profile lookup of its own.
   */
  getDisplayName?: () => string | null;
  localStorage?: Storage | null;
  mode: CollaborationApplicationMode;
  /**
   * The organization the session was signed in to. The same user signed in
   * personally and through an organization sees different workspaces, so the
   * device-local caches of one context must not paint for the other.
   */
  organizationId?: string | null;
  persistence?: NetworkCollaborationPersistence;
  presenceBindingFactory?: CollaborationPresenceBindingFactory;
  registry?: CollaborationRegistry;
  workerBaseUrl?: string;
};

export function createDurableCollaborationClientInstanceId(
  storage: Storage | null = typeof sessionStorage === "undefined" ? null : sessionStorage,
  navigationType = readNavigationType(),
) {
  try {
    const stored = storage?.getItem(CLIENT_INSTANCE_ID_KEY);
    const storageAlreadyInitialized =
      !!storage && INITIALIZED_CLIENT_INSTANCE_STORAGES.has(storage);
    const isSameTabNavigation = navigationType === "reload" || navigationType === "back_forward";
    if (stored && isStableId(stored) && (storageAlreadyInitialized || isSameTabNavigation)) {
      return stored;
    }
    const created = crypto.randomUUID();
    storage?.setItem(CLIENT_INSTANCE_ID_KEY, created);
    if (storage) INITIALIZED_CLIENT_INSTANCE_STORAGES.add(storage);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

function readNavigationType() {
  const navigation = performance.getEntriesByType?.("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  return navigation?.type ?? "navigate";
}

export function collaborationSelectionKey(fileId: string, branchId: string) {
  if (!isStableId(fileId) || !isStableId(branchId)) {
    throw new Error("The collaboration selection is invalid");
  }
  return `leaf/${encodeURIComponent(fileId)}/branch/${encodeURIComponent(branchId)}`;
}

export function parseCollaborationSelection(value: string) {
  const match = /^leaf\/([^/]+)\/branch\/([^/]+)$/.exec(value);
  if (!match) return null;
  try {
    const fileId = decodeURIComponent(match[1]!);
    const branchId = decodeURIComponent(match[2]!);
    return isStableId(fileId) && isStableId(branchId) ? { fileId, branchId } : null;
  } catch {
    return null;
  }
}

/**
 * The scope device-local caches are keyed by: the account, and the
 * organization its session was signed in to. Document caches carry the
 * workspace id in their identity already; the directory listing, the
 * remembered workspace id, and the persisted tab set do not, and would
 * otherwise be shared across contexts.
 */
export function collaborationAccountScope(accountId: string, organizationId?: string | null) {
  return organizationId ? `${accountId}@${organizationId}` : accountId;
}

export function getMainCollaborationBranch(file: LeafFileDto) {
  return file.branches.find((branch) => branch.status !== "deleted") ?? null;
}

export function createCollaborationApplicationRuntime(
  options: CreateCollaborationApplicationRuntimeOptions,
): CollaborationApplicationRuntime {
  if (!isStableId(options.accountId)) throw new Error("A stable account id is required");
  const clientInstanceId =
    options.clientInstanceId ??
    createDurableCollaborationClientInstanceId(
      options.clientInstanceStorage === undefined
        ? typeof sessionStorage === "undefined"
          ? null
          : sessionStorage
        : options.clientInstanceStorage,
    );
  if (!isStableId(clientInstanceId)) throw new Error("The client instance id is invalid");
  const persistence =
    options.persistence ??
    createBrowserCollaborationPersistence<
      LeafRecordSnapshot,
      CollaborationTransportPendingTransaction,
      CollaborationHistoryMetadata
    >();

  if (options.mode === "local") {
    return createLocalRuntime({ ...options, clientInstanceId, persistence });
  }
  if (!options.workerBaseUrl || !options.getAccessToken) {
    throw new Error("Network collaboration requires a Worker URL and access-token provider");
  }
  const registry =
    options.registry ??
    new CollaborationRegistryClient({
      fetcher: options.fetcher,
      getAccessToken: options.getAccessToken,
      getDisplayName: options.getDisplayName,
      workerBaseUrl: options.workerBaseUrl,
    });
  return createNetworkRuntime({ ...options, clientInstanceId, persistence, registry });
}

function createNetworkRuntime(
  options: CreateCollaborationApplicationRuntimeOptions & {
    clientInstanceId: string;
    persistence: NetworkCollaborationPersistence;
    registry: CollaborationRegistry;
  },
): CollaborationApplicationRuntime {
  const checkpointClient = new CollaborationCheckpointClient({
    getAccessToken: options.getAccessToken!,
    workerBaseUrl: options.workerBaseUrl!,
  });
  const sessions = new Set<CollaborationApplicationSession>();
  const accountScope = collaborationAccountScope(options.accountId, options.organizationId);
  const directoryCache = new NetworkCollaborationDirectoryCache(
    accountScope,
    options.localStorage === undefined
      ? typeof localStorage === "undefined"
        ? null
        : localStorage
      : options.localStorage,
  );
  const starterSnapshot = persistedDocumentToLeafSnapshot(createStarterDocument());
  // Files the registry has not confirmed yet. They are already listed, cached,
  // and editable locally; the initialization promise gates their session's
  // first connection and reports a failed create to the shell.
  const pendingCreations = new Map<string, PendingFileCreation>();
  let inFlightCreations = 0;
  // Cache warms whose open has not settled: close() and a logout abandon
  // them, since a warm waits on the network and would otherwise outlive the
  // runtime, or the account, it was warming for.
  const pendingWarms = new Set<{ abort: AbortController; settled: Promise<void> }>();
  const workspaceIdCache = new NetworkWorkspaceIdCache(accountScope, directoryCache.storage);
  let knownWorkspaceId = directoryCache.read()?.[0]?.workspaceId ?? workspaceIdCache.read();
  // Cleared when the registry ignores client-chosen ids (a Worker deployment
  // that predates them); creates then take the registry round trip first.
  let clientIdsAccepted = true;
  let closed = false;

  const abandonPendingWarms = async () => {
    const warms = [...pendingWarms];
    for (const warm of warms) warm.abort.abort();
    await Promise.all(warms.map((warm) => warm.settled));
  };

  const learnWorkspaceId = (workspaceId: string | null | undefined) => {
    if (!workspaceId || workspaceId === knownWorkspaceId) return;
    knownWorkspaceId = workspaceId;
    workspaceIdCache.write(workspaceId);
  };

  const inFlightCreation = (fileId: string) => {
    const creation = pendingCreations.get(fileId);
    return creation && !creation.settled ? creation : null;
  };

  const mergePendingCreations = (files: LeafFileDto[]) => {
    if (inFlightCreations === 0) return files;
    // The local projection outranks the registry's while a create is in
    // flight: the row may still read "creating" there, but this client is
    // already editing the branch.
    const merged = files.map((file) => inFlightCreation(file.fileId)?.file ?? file);
    const listed = new Set(files.map((file) => file.fileId));
    for (const creation of pendingCreations.values()) {
      if (!creation.settled && !listed.has(creation.file.fileId)) merged.push(creation.file);
    }
    return structuredClone(merged);
  };

  const registerCreatedFile = async (file: LeafFileDto, branchId: string) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await options.registry.createFile(file.name, {
          branchId,
          fileId: file.fileId,
          workspaceId: file.workspaceId,
        });
        return;
      } catch (error) {
        if (error instanceof CollaborationRegistryIdMismatchError) {
          // This Worker ignores client-chosen ids and created the file under
          // its own. The open session cannot adopt them, so this create is
          // reported as failed; the file the registry did create is finished
          // (its main branch initialized) rather than left as a stuck row,
          // and later creates take the registry round trip first.
          clientIdsAccepted = false;
          const created = getMainCollaborationBranch(error.file);
          if (created) {
            await initializeStarterWithRetry(
              options.registry,
              error.file.fileId,
              created.branchId,
              starterSnapshot,
              created.branchId,
              starterStreamEpoch(created.branchId),
              false,
            ).catch(() => undefined);
          }
          throw error;
        }
        if (!(error instanceof CollaborationRegistryRequestError)) throw error;
        if (error.status === 409 && error.code === "workspace_mismatch") {
          // The remembered workspace no longer matches the token's context.
          // Nothing was created; forget the stale id so the next create takes
          // the registry round trip and seeds its cache under the right one.
          knownWorkspaceId = null;
          workspaceIdCache.clear();
          throw error;
        }
        if (error.status === 409) {
          // A retried request whose first attempt landed: the row already
          // exists under the ids this client chose, so initialization can
          // proceed.
          const existing = await options.registry.getFile(file.fileId);
          if (getMainCollaborationBranch(existing)?.branchId !== branchId) throw error;
          return;
        }
        // A timeout or outage may have landed the row anyway. Retrying meets
        // the 409 above instead of leaving behind a file the shell reported
        // as failed and the next listing would resurrect.
        if (!error.retryable || attempt + 1 >= STARTER_INITIALIZATION_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
      }
    }
  };

  /**
   * Make a file usable before the registry confirms it. The starter snapshot
   * becomes the cache generation at the stream epoch the room will start on,
   * so edits made in the meantime replay as an ordinary pending queue instead
   * of being discarded as work from an older epoch.
   */
  const beginFileCreation = async (file: LeafFileDto, registerFirst: boolean) => {
    const main = getMainCollaborationBranch(file);
    if (!main) throw new Error("The created file has no main branch");
    const epoch = starterStreamEpoch(main.branchId);
    const activeFile: LeafFileDto = {
      ...structuredClone(file),
      branches: file.branches.map((branch) =>
        branch.branchId === main.branchId ? { ...branch, status: "active" as const } : branch,
      ),
    };
    await options.persistence.installCommittedGeneration(
      cacheIdentity(options.accountId, file, main),
      {
        generationId: `${epoch}:0`,
        installedAtMs: Date.now(),
        cursor: { streamEpoch: epoch, revision: 0 },
        checkpoint: null,
        confirmed: starterSnapshot,
        history: null,
      },
    );
    directoryCache.upsert(activeFile);
    const initialization = (async () => {
      if (registerFirst) await registerCreatedFile(file, main.branchId);
      await initializeStarterWithRetry(
        options.registry,
        file.fileId,
        main.branchId,
        starterSnapshot,
        main.branchId,
        epoch,
        true,
      );
    })();
    // The entry outlives settlement until the shell has asked for the outcome
    // once (see awaitFileCreation); only in-flight entries shape the
    // directory and gate connections.
    const creation: PendingFileCreation = {
      awaited: false,
      file: activeFile,
      initialization,
      settled: false,
    };
    pendingCreations.set(file.fileId, creation);
    inFlightCreations += 1;
    const settle = () => {
      creation.settled = true;
      inFlightCreations -= 1;
      if (creation.awaited && pendingCreations.get(file.fileId) === creation) {
        pendingCreations.delete(file.fileId);
      }
    };
    initialization.then(settle, () => {
      settle();
      directoryCache.remove(file.fileId);
    });
    return structuredClone(activeFile);
  };

  const runtime: CollaborationApplicationRuntime = {
    mode: "network",
    accountId: options.accountId,
    organizationId: options.organizationId ?? null,
    clientInstanceId: options.clientInstanceId,
    readCachedFiles() {
      assertRuntimeOpen(closed);
      const cached = directoryCache.read();
      return cached ? mergePendingCreations(cached) : null;
    },
    async listFiles() {
      assertRuntimeOpen(closed);
      try {
        let files = await options.registry.listFiles();
        learnWorkspaceId(files[0]?.workspaceId ?? options.registry.lastKnownWorkspaceId);
        const creatingBranches = files.flatMap((file) => {
          if (inFlightCreation(file.fileId)) return [];
          return file.branches
            .filter((branch) => branch.status === "creating")
            .map((branch) => ({ file, branch }));
        });
        if (creatingBranches.length) {
          await Promise.all(
            creatingBranches.map(async ({ file, branch }) => {
              await initializeStarterWithRetry(
                options.registry,
                file.fileId,
                branch.branchId,
                starterSnapshot,
                branch.branchId,
                starterStreamEpoch(branch.branchId),
                false,
              );
            }),
          );
          files = await options.registry.listFiles();
        }
        files = mergePendingCreations(files);
        directoryCache.write(files);
        return files;
      } catch (error) {
        const cached = directoryCache.read();
        if (cached && isRetryableCollaborationRegistryError(error)) {
          return mergePendingCreations(cached);
        }
        throw error;
      }
    },
    async createFile(name) {
      assertRuntimeOpen(closed);
      const normalizedName = name.trim();
      if (!normalizedName) throw new Error("A file name is required");
      if (!knownWorkspaceId || !clientIdsAccepted) {
        // Reachable when no listing has ever reached this device (an offline
        // first launch), so nothing local can supply the workspace id a cache
        // identity needs, or when the registry does not accept client ids:
        // this create takes the registry round trip before it opens.
        const created = await options.registry.createFile(normalizedName);
        learnWorkspaceId(created.workspaceId);
        return await beginFileCreation(created, false);
      }
      return await beginFileCreation(
        createLeafFileWithMainBranch({
          branchId: crypto.randomUUID(),
          fileId: crypto.randomUUID(),
          name: normalizedName,
          now: new Date().toISOString(),
          workspaceId: knownWorkspaceId,
        }),
        true,
      );
    },
    awaitFileCreation(fileId) {
      const creation = pendingCreations.get(fileId);
      if (!creation) return Promise.resolve();
      // The first asker learns the outcome even after the fact; the entry is
      // released once it has, rather than kept for the runtime's lifetime.
      creation.awaited = true;
      if (creation.settled) pendingCreations.delete(fileId);
      return creation.initialization;
    },
    async warmBranchCache(file, branch) {
      assertRuntimeOpen(closed);
      assertBranchBelongsToFile(file, branch);
      if (branch.status !== "active" || inFlightCreation(file.fileId)) return false;
      const identity = cacheIdentity(options.accountId, file, branch);
      if (await options.persistence.hasCommittedGeneration(identity)) return false;
      // A read-only session with no presence: it exists only to run one
      // bootstrap through the ordinary install path, then leaves. A refused
      // descriptor ends it (the transport treats the refusal as terminal)
      // instead of leaving it reconnecting forever, and close() or a logout
      // abandons it while it is still waiting on the network.
      const abort = new AbortController();
      const opening = openNetworkCollaborationSession({
        branchWriteFence: branchWriteFence(branch),
        cacheIdentity: identity,
        clientInstanceId: options.clientInstanceId,
        fetcher: options.fetcher,
        loadCheckpoint: async (bootstrap, signal) =>
          await loadVerifiedCheckpoint(checkpointClient, file, branch, bootstrap, signal),
        online: true,
        persistence: options.persistence,
        refreshSyncServerUrlOnInitialConnect: true,
        refreshSyncServerUrl: async () => {
          try {
            return (await options.registry.issueBranchSession(file.fileId, branch.branchId))
              .syncServerUrl;
          } catch (error) {
            throw asSyncServerUrlError(error);
          }
        },
        signal: abort.signal,
        syncServerUrl: OFFLINE_SYNC_SERVER_URL,
        writeAllowed: false,
      });
      const warm = {
        abort,
        settled: opening.then(
          () => undefined,
          () => undefined,
        ),
      };
      pendingWarms.add(warm);
      let session: NetworkCollaborationSession;
      try {
        session = await opening;
      } finally {
        pendingWarms.delete(warm);
      }
      await session.dispose();
      return true;
    },
    async renameFile(fileId, name) {
      assertRuntimeOpen(closed);
      const renamed = await options.registry.renameFile(fileId, name);
      directoryCache.upsert(renamed);
      return renamed;
    },
    async setFileThumbnail(fileId, thumbnailAssetId) {
      assertRuntimeOpen(closed);
      const updated = await options.registry.setFileThumbnail(fileId, thumbnailAssetId);
      directoryCache.upsert(updated);
      return updated;
    },
    async openSession(file, branch, callbacks = {}) {
      assertRuntimeOpen(closed);
      assertBranchBelongsToFile(file, branch);
      if (branch.status === "archived" || branch.status === "deleted") {
        throw new Error("This branch is archived and cannot open a live editing session");
      }
      const identity = cacheIdentity(options.accountId, file, branch);
      // Only a create still in flight gates the connection; a settled one,
      // confirmed or withdrawn, must not decide every later open of the file.
      const pendingCreation = inFlightCreation(file.fileId);
      const initiallyOnline = typeof navigator === "undefined" ? true : navigator.onLine;
      const hasCommittedCache = await options.persistence
        .hasCommittedGeneration(identity)
        .catch(() => false);
      let descriptor: LeafBranchSessionDto | null = null;
      let retryAfterOutage = false;
      // An open that renders from cache, or a create the registry is still
      // confirming, must not wait on a descriptor: the transport fetches one
      // when it connects. Only an uncached open pays for it up front, where a
      // non-retryable auth failure belongs to the open itself rather than to a
      // background reconnect loop.
      if (initiallyOnline && !hasCommittedCache && !pendingCreation) {
        try {
          descriptor = await options.registry.issueBranchSession(file.fileId, branch.branchId);
        } catch (error) {
          if (!isRetryableCollaborationRegistryError(error)) throw error;
          retryAfterOutage = true;
        }
      }
      if (descriptor && descriptor.workspaceId !== file.workspaceId) {
        throw new Error("The collaboration session belongs to another workspace");
      }
      let generation = 1;
      let status: CollaborationTransportStatus = "idle";
      let disposed = false;
      let presence: CollaborationPresenceBinding | null = null;
      let presenceCreation: Promise<void> | null = null;
      let presencePeers: CollaborationPresencePeer[] = [];
      let presenceStatus: CollaborationPresenceStatus = "idle";
      let networkSession: NetworkCollaborationSession | null = null;
      // presencePeers is already a runtime-owned clone (see onPeersChange);
      // re-cloning per emit doubled the per-packet cost on the cursor fast lane.
      const emitPresence = () => callbacks.onPresenceChange?.(presencePeers, presenceStatus);
      const presenceFactory = options.presenceBindingFactory ?? defaultPresenceBindingFactory;
      const ensurePresence = async (nextDescriptor: NonNullable<typeof descriptor>) => {
        if (presence) {
          await presence.replaceDescriptor?.(nextDescriptor);
          return;
        }
        // The descriptor can arrive from the transport's initial connect and
        // from the post-open check at the same time; one binding must win.
        if (!presenceCreation) {
          presenceCreation = (async () => {
            presence =
              (await presenceFactory.create({
                branch: structuredClone(branch),
                descriptor: structuredClone(nextDescriptor),
                file: structuredClone(file),
                getCurrentSession: () => networkSession?.getCurrentSession() ?? null,
                onPeersChange: (peers) => {
                  presencePeers = structuredClone(peers);
                  emitPresence();
                },
                onStatusChange: (nextStatus) => {
                  presenceStatus = nextStatus;
                  emitPresence();
                },
              })) ?? null;
          })();
        }
        await presenceCreation;
      };

      const handle: CollaborationApplicationSession = {
        file: structuredClone(file),
        branch: structuredClone(branch),
        get generation() {
          return generation;
        },
        get presencePeers() {
          return structuredClone(presencePeers);
        },
        get presenceStatus() {
          return presenceStatus;
        },
        get status() {
          return status;
        },
        getCurrentSession() {
          if (!networkSession) throw new Error("The collaboration session is not ready");
          return networkSession.getCurrentSession();
        },
        setOnline(online) {
          networkSession?.transport.setOnline(online);
        },
        async fenceWrites(kind) {
          await networkSession?.fenceBranchWrites(kind);
          presence?.fence?.(kind);
        },
        async flushPersistence() {
          await networkSession?.flushPersistence();
        },
        async acquireWriteBarrier() {
          while (networkSession?.getCurrentSession().controller.pendingTransactionCount) {
            if (disposed) throw new Error("The source collaboration session was closed");
            if (status !== "live") {
              throw new Error("Wait for the session to finish syncing before continuing");
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          await networkSession?.flushPersistence();
          const transport = networkSession?.transport;
          const restoreWrites = transport?.isTemporaryWriteAllowed ?? false;
          transport?.setWriteAllowed(false);
          return () => {
            if (restoreWrites) transport?.setWriteAllowed(true);
          };
        },
        async dispose() {
          if (disposed) return;
          disposed = true;
          sessions.delete(handle);
          await presence?.dispose();
          presence = null;
          await networkSession?.dispose();
        },
        async disposeForLogout() {
          if (disposed) return;
          disposed = true;
          sessions.delete(handle);
          await presence?.dispose();
          presence = null;
          await networkSession?.disposeForLogout();
        },
      };

      networkSession = await openNetworkCollaborationSession({
        branchWriteFence: branchWriteFence(branch),
        cacheIdentity: identity,
        clientInstanceId: options.clientInstanceId,
        connectAfter: pendingCreation?.initialization,
        fetcher: options.fetcher,
        loadCheckpoint: async (bootstrap, signal) =>
          await loadVerifiedCheckpoint(checkpointClient, file, branch, bootstrap, signal),
        onBranchWriteFence: (fence) => {
          presence?.fence?.(fence.kind);
          callbacks.onWriteFence?.(fence.kind);
        },
        onSessionReplaced: (replacement) => {
          generation += 1;
          presence?.replaceSession?.(replacement);
          callbacks.onSessionReplaced?.(replacement, generation);
        },
        onStatusChange: (nextStatus) => {
          status = nextStatus;
          callbacks.onStatusChange?.(nextStatus);
        },
        online:
          initiallyOnline && (descriptor !== null || hasCommittedCache || pendingCreation !== null),
        persistence: options.persistence,
        refreshSyncServerUrlOnInitialConnect: descriptor === null,
        refreshSyncServerUrl: async () => {
          try {
            descriptor = await options.registry.issueBranchSession(file.fileId, branch.branchId);
          } catch (error) {
            // A refusal (access revoked, branch gone) is not an outage. A
            // cached open must not keep retrying the registry behind a
            // usable-looking editor: the transport stops and reports the
            // refusal the way an uncached open would have thrown. Edits made
            // meanwhile stay in the durable pending queue for a later open
            // that is admitted; a refusal is not a reason to discard them.
            throw asSyncServerUrlError(error);
          }
          if (networkSession && !disposed) await ensurePresence(descriptor);
          return descriptor.syncServerUrl;
        },
        syncServerUrl: descriptor?.syncServerUrl ?? OFFLINE_SYNC_SERVER_URL,
      });
      if (disposed) {
        await networkSession.dispose();
        throw new Error("The collaboration session closed while opening");
      }
      if (descriptor) await ensurePresence(descriptor);
      sessions.add(handle);
      if (retryAfterOutage) {
        setTimeout(() => {
          if (!disposed) networkSession?.transport.setOnline(true);
        }, OUTAGE_RECONNECT_DELAY_MS);
      }
      return handle;
    },
    async disposeForLogout() {
      // Warms first: one mid-bootstrap would otherwise install the signed-out
      // account's document after the cache below is cleared.
      await abandonPendingWarms();
      for (const session of sessions) await session.disposeForLogout();
      await options.persistence.clearAccount(options.accountId);
      directoryCache.clear();
      workspaceIdCache.clear();
    },
    async close() {
      if (closed) return;
      closed = true;
      await abandonPendingWarms();
      for (const session of sessions) await session.dispose();
      await options.persistence.backend.close?.();
    },
  };
  return runtime;
}

type PendingFileCreation = {
  /** Whether the shell has asked for the outcome yet (see awaitFileCreation). */
  awaited: boolean;
  file: LeafFileDto;
  initialization: Promise<void>;
  settled: boolean;
};

/**
 * A registry refusal of a branch session, as the transport needs to hear it:
 * terminal, so it stops instead of reconnecting. Outages pass through and
 * keep the transport's ordinary retry behavior.
 */
function asSyncServerUrlError(error: unknown) {
  if (isRetryableCollaborationRegistryError(error)) return error;
  return new CollaborationSyncServerUrlRefusedError(
    error instanceof Error
      ? error.message
      : "The collaboration service refused this branch session",
    { cause: error },
  );
}

/**
 * The stream epoch a main branch starts on. Deriving it from the branch id
 * lets a client seed its cache before the registry answers, and lets an
 * initialization resumed after a crash land on the very same epoch.
 */
function starterStreamEpoch(branchId: string) {
  return branchId;
}

/**
 * The account's workspace id, remembered across launches so an empty
 * directory (a brand-new account, or one whose files were all created
 * elsewhere) can still create a file locally before the registry answers.
 */
class NetworkWorkspaceIdCache {
  private readonly key: string;

  constructor(
    accountId: string,
    private readonly storage: Storage | null,
  ) {
    this.key = `${NETWORK_WORKSPACE_KEY_PREFIX}:${encodeURIComponent(accountId)}`;
  }

  read(): string | null {
    const value = this.storage?.getItem(this.key)?.trim();
    return value ? value : null;
  }

  write(workspaceId: string) {
    this.storage?.setItem(this.key, workspaceId);
  }

  clear() {
    this.storage?.removeItem(this.key);
  }
}

class NetworkCollaborationDirectoryCache {
  private readonly key: string;

  constructor(
    accountId: string,
    readonly storage: Storage | null,
  ) {
    this.key = `${NETWORK_DIRECTORY_KEY_PREFIX}:${encodeURIComponent(accountId)}`;
  }

  read(): LeafFileDto[] | null {
    const value = this.storage?.getItem(this.key);
    if (!value) return null;
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) && parsed.every(isLeafFileDto) ? structuredClone(parsed) : null;
    } catch {
      return null;
    }
  }

  write(files: LeafFileDto[]) {
    this.storage?.setItem(this.key, JSON.stringify(files));
  }

  upsert(file: LeafFileDto) {
    const files = this.read() ?? [];
    this.write([...files.filter(({ fileId }) => fileId !== file.fileId), structuredClone(file)]);
  }

  remove(fileId: string) {
    const files = this.read();
    if (files) this.write(files.filter((file) => file.fileId !== fileId));
  }

  clear() {
    this.storage?.removeItem(this.key);
  }
}

/**
 * `requireEpoch` is set by the create path, whose seeded cache is only valid
 * on the requested epoch. A resumed initialization of a room that already
 * exists keeps whatever epoch it has.
 */
async function initializeStarterWithRetry(
  registry: CollaborationRegistry,
  fileId: string,
  branchId: string,
  snapshot: LeafRecordSnapshot,
  initializationId: string,
  streamEpoch: string,
  requireEpoch: boolean,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < STARTER_INITIALIZATION_ATTEMPTS; attempt += 1) {
    try {
      const initialized = await registry.initializeBranch(
        fileId,
        branchId,
        snapshot,
        initializationId,
        streamEpoch,
      );
      if (requireEpoch && initialized.streamEpoch !== streamEpoch) {
        throw new Error("The collaboration room started on an unexpected stream epoch");
      }
      return;
    } catch (error) {
      lastError = error;
      if (!(error instanceof CollaborationRegistryRequestError) || !error.retryable) throw error;
      if (attempt + 1 < STARTER_INITIALIZATION_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
      }
    }
  }
  throw lastError;
}

async function loadVerifiedCheckpoint(
  client: CollaborationCheckpointClient,
  file: LeafFileDto,
  branch: LeafBranchDto,
  bootstrap: LeafCheckpointBootstrapResponse,
  signal: AbortSignal,
) {
  if (
    bootstrap.workspaceId !== file.workspaceId ||
    bootstrap.fileId !== file.fileId ||
    bootstrap.branchId !== branch.branchId ||
    bootstrap.checkpoint.streamEpoch !== bootstrap.streamEpoch ||
    bootstrap.checkpoint.revision > bootstrap.throughRevision
  ) {
    throw new Error("The checkpoint bootstrap does not match the active branch");
  }
  const loaded = await client.loadSnapshot(
    {
      workspaceId: file.workspaceId,
      fileId: file.fileId,
      branchId: branch.branchId,
    },
    bootstrap.checkpoint,
    signal,
  );
  if (
    loaded.manifest.streamEpoch !== bootstrap.checkpoint.streamEpoch ||
    loaded.manifest.revision !== bootstrap.checkpoint.revision ||
    loaded.manifest.checkpointId !== bootstrap.checkpoint.checkpointId
  ) {
    throw new Error("The loaded checkpoint does not match its bootstrap reference");
  }
  return loaded.snapshot;
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

function isStableId(value: string) {
  return value.trim().length > 0 && value.length <= 256 && !value.includes("/");
}
