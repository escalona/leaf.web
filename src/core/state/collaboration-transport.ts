import {
  LEAF_COLLABORATION_PROTOCOL_VERSION,
  LEAF_RECORD_SCHEMA_VERSION,
  LEAF_WORKER_ROUTES,
  parseLeafBootstrapResponse,
  parseLeafServerMessage,
  type LeafBootstrapResponse,
  type LeafCheckpointBootstrapResponse,
  type LeafCheckpointReference,
  type LeafCommitMessage,
  type LeafRecordSnapshot,
  type LeafSemanticCommand,
  type LeafServerMessage,
  type LeafTransactionMessage,
} from "../shared/collaboration";
import {
  CollaborationPersistenceBackendError,
  type CollaborationPermanentWriteFence,
} from "./collaboration-persistence";
import { fetchWithGlobalReceiver } from "./global-fetch";

const DEFAULT_RECONNECT_BASE_DELAY_MS = 250;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 10_000;
const DEFAULT_RECONNECT_JITTER_RATIO = 0.2;
const DEFAULT_CONNECTION_OPEN_TIMEOUT_MS = 15_000;
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 30_000;
// Worker tokens live for five minutes. Rotate one minute early so timer jitter,
// background-tab throttling, and bootstrap time cannot cross token expiry.
const DEFAULT_SYNC_SERVER_URL_MAX_AGE_MS = 4 * 60 * 1_000;
const WEBSOCKET_OPEN = 1;

/**
 * Thrown by a `refreshSyncServerUrl` provider when the registry refused the
 * branch session outright (access revoked, branch gone). The transport treats
 * it as terminal: it stops with status `error` instead of scheduling another
 * attempt, and leaves the durable pending queue intact for a later open that
 * is admitted.
 */
export class CollaborationSyncServerUrlRefusedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CollaborationSyncServerUrlRefusedError";
  }
}

export type CollaborationTransportStatus =
  | "idle"
  | "offline"
  | "connecting"
  | "bootstrapping"
  | "live"
  | "read-only"
  | "reconnecting"
  | "closed"
  | "error";

type TransportCursor = { streamEpoch: string; revision: number };
type TransportTimer = number | ReturnType<typeof globalThis.setTimeout>;
type SyncServerUrlProvider = () => string | null | Promise<string | null>;
type TransportSocketEvent = Event | MessageEvent | CloseEvent;

type TransportSocket = {
  readonly readyState: number;
  send(value: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "close" | "error" | "message" | "open",
    listener: (event: TransportSocketEvent) => void,
  ): void;
};

export type CollaborationTransportOptions = {
  syncServerUrl: string;
  clientInstanceId: string;
  initialCursor?: TransportCursor;
  initialAcceptedClientSequence?: number;
  initialPermanentWriteFence?: CollaborationPermanentWriteFence | null;
  createSocket?: (url: string) => TransportSocket;
  fetcher?: typeof fetch;
  loadCheckpoint?: (
    bootstrap: LeafCheckpointBootstrapResponse,
    signal: AbortSignal,
  ) => Promise<LeafRecordSnapshot>;
  createId?: () => string;
  refreshSyncServerUrl?: SyncServerUrlProvider;
  refreshSyncServerUrlOnInitialConnect?: boolean;
  online?: boolean;
  writeAllowed?: boolean;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectJitterRatio?: number;
  connectionOpenTimeoutMs?: number;
  bootstrapTimeoutMs?: number;
  syncServerUrlMaxAgeMs?: number;
  now?: () => number;
  random?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => TransportTimer;
  clearTimeout?: (timer: TransportTimer) => void;
  initialPendingTransactions?: readonly CollaborationTransportPendingTransaction[];
  persistPendingTransaction?: (pending: CollaborationTransportPendingTransaction) => Promise<void>;
  removePendingTransaction?: (clientTxId: string) => Promise<void>;
  removePendingTransactions?: (clientTxIds: readonly string[]) => Promise<void>;
  persistPermanentWriteFence?: (
    fence: CollaborationPermanentWriteFence,
  ) => Promise<CollaborationPermanentWriteFence>;
  acknowledgePendingTransaction?: (
    pending: CollaborationTransportPendingTransaction,
    commit: LeafCommitMessage,
  ) => Promise<void>;
  onPersistenceError?: (error: Error, operation: "persist" | "remove") => void;
  onSnapshot: (
    snapshot: LeafRecordSnapshot,
    cursor: TransportCursor,
    checkpoint?: LeafCheckpointReference,
  ) => void | Promise<void>;
  onCommit: (commit: LeafCommitMessage) => void;
  onSnapshotAcknowledgement?: (commit: LeafCommitMessage) => void;
  onPermanentWriteFence?: (fence: CollaborationPermanentWriteFence) => void;
  onReject?: (
    rejection: Extract<LeafServerMessage, { type: "reject" | "resync" }>,
  ) => readonly string[] | void;
  onStatusChange?: (status: CollaborationTransportStatus) => void;
};

export type CollaborationTransportPendingTransaction = {
  clientTxId: string;
  clientSequence: number;
  historyGroupId: string;
  kind: "user" | "undo" | "redo";
  commands?: LeafSemanticCommand[];
};

type PendingTransaction = CollaborationTransportPendingTransaction & {
  durable: boolean;
  sent: boolean;
  wireMessage: LeafTransactionMessage | null;
};

/**
 * Gap-free WebSocket/bootstrap transport for the normalized collaboration room.
 *
 * The class deliberately owns no React or MobX state. It establishes the hello
 * barrier, installs either a snapshot or a contiguous hot tail, queues live
 * commits during bootstrap, and sends one causal transaction head at a time.
 * Transient connection failures are retried with bounded backoff; every async
 * callback is fenced to the socket generation that created it.
 */
export class CollaborationTransport {
  private readonly createSocket: (url: string) => TransportSocket;
  private readonly fetcher: typeof fetch;
  private readonly createId: () => string;
  private readonly refreshSyncServerUrl: SyncServerUrlProvider | null;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly scheduleTimeout: (callback: () => void, delayMs: number) => TransportTimer;
  private readonly cancelTimeout: (timer: TransportTimer) => void;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly reconnectJitterRatio: number;
  private readonly connectionOpenTimeoutMs: number;
  private readonly bootstrapTimeoutMs: number;
  private readonly syncServerUrlMaxAgeMs: number;
  private socket: TransportSocket | null = null;
  private cursor: TransportCursor | null;
  private status: CollaborationTransportStatus;
  private liveQueue: LeafCommitMessage[] = [];
  private pending: PendingTransaction[] = [];
  private nextClientSequence = 1;
  private disposed = false;
  private online: boolean;
  /** Temporary sender/owner gate. Permanent branch access is tracked separately. */
  private writeAllowed: boolean;
  private permanentWriteFence: CollaborationPermanentWriteFence | null;
  private permanentFenceQueue = Promise.resolve();
  private persistenceOperations = new Set<Promise<unknown>>();
  private hasStartedConnection = false;
  private connectionGeneration = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: TransportTimer | null = null;
  private refreshTimer: TransportTimer | null = null;
  private attemptTimer: TransportTimer | null = null;
  private bootstrapAbortController: AbortController | null = null;
  private currentSyncServerUrl: string;
  private syncServerUrlResolvedAt: number;
  private refreshSyncServerUrlOnInitialConnect: boolean;

  constructor(private readonly options: CollaborationTransportOptions) {
    this.cursor = options.initialCursor ?? null;
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url) as TransportSocket);
    this.fetcher = options.fetcher ?? fetchWithGlobalReceiver;
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.refreshSyncServerUrl = options.refreshSyncServerUrl ?? null;
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? (() => Math.random());
    this.scheduleTimeout =
      options.setTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.cancelTimeout = options.clearTimeout ?? ((timer) => globalThis.clearTimeout(timer));
    this.reconnectBaseDelayMs = Math.max(
      0,
      options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS,
    );
    this.reconnectMaxDelayMs = Math.max(
      this.reconnectBaseDelayMs,
      options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS,
    );
    this.reconnectJitterRatio = Math.min(
      1,
      Math.max(0, options.reconnectJitterRatio ?? DEFAULT_RECONNECT_JITTER_RATIO),
    );
    this.connectionOpenTimeoutMs = Math.max(
      1,
      options.connectionOpenTimeoutMs ?? DEFAULT_CONNECTION_OPEN_TIMEOUT_MS,
    );
    this.bootstrapTimeoutMs = Math.max(
      1,
      options.bootstrapTimeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS,
    );
    this.syncServerUrlMaxAgeMs = Math.max(
      1,
      options.syncServerUrlMaxAgeMs ?? DEFAULT_SYNC_SERVER_URL_MAX_AGE_MS,
    );
    this.online = options.online ?? true;
    this.writeAllowed = options.writeAllowed ?? true;
    this.permanentWriteFence = clonePermanentWriteFence(options.initialPermanentWriteFence ?? null);
    this.status = this.online ? "idle" : "offline";
    this.currentSyncServerUrl = options.syncServerUrl;
    this.syncServerUrlResolvedAt = this.now();
    this.refreshSyncServerUrlOnInitialConnect =
      options.refreshSyncServerUrlOnInitialConnect ?? false;
    this.pending = this.permanentWriteFence
      ? []
      : restorePendingTransactions(options.initialPendingTransactions ?? []);
    const acceptedSequence = options.initialAcceptedClientSequence ?? 0;
    if (!Number.isSafeInteger(acceptedSequence) || acceptedSequence < 0) {
      throw new Error("The accepted client sequence watermark is invalid");
    }
    this.nextClientSequence =
      Math.max(acceptedSequence, this.pending.at(-1)?.clientSequence ?? 0) + 1;
  }

  get connectionStatus() {
    return this.status;
  }

  get currentCursor() {
    return this.cursor ? { ...this.cursor } : null;
  }

  get pendingCount() {
    return this.pending.length;
  }

  get pendingTransactions(): CollaborationTransportPendingTransaction[] {
    return this.pending.map(toPublicPendingTransaction);
  }

  get isOnline() {
    return this.online;
  }

  get isWriteAllowed() {
    return this.writeAllowed && !this.permanentWriteFence;
  }

  get isTemporaryWriteAllowed() {
    return this.writeAllowed;
  }

  get currentPermanentWriteFence() {
    return clonePermanentWriteFence(this.permanentWriteFence);
  }

  get writeGate(): "writable" | "standby" | "read-only" | "archived" {
    if (this.permanentWriteFence) return this.permanentWriteFence.kind;
    return this.writeAllowed ? "writable" : "standby";
  }

  get canSendWrites() {
    return this.online && this.isWriteAllowed && this.status === "live";
  }

  connect() {
    if (this.disposed) throw new Error("Collaboration transport is disposed");
    if (!this.online) {
      this.setStatus("offline");
      return;
    }
    if (
      this.status === "connecting" ||
      this.status === "bootstrapping" ||
      this.status === "live" ||
      this.status === "read-only"
    ) {
      return;
    }
    this.clearReconnectTimer();
    this.startConnection(this.hasStartedConnection);
  }

  setOnline(online: boolean) {
    if (this.disposed || this.online === online) return;
    this.online = online;
    if (!online) {
      this.clearReconnectTimer();
      this.retireActiveSocket(1000, "Document sync paused while offline");
      this.setStatus("offline");
      return;
    }
    this.startConnection(this.hasStartedConnection);
  }

  setWriteAllowed(writeAllowed: boolean) {
    if (this.disposed) return;
    if (this.writeAllowed === writeAllowed) return;
    const wasAllowed = this.isWriteAllowed;
    this.writeAllowed = writeAllowed;
    const isAllowed = this.isWriteAllowed;
    if (this.status === "live" && wasAllowed && !isAllowed) {
      this.setStatus("read-only");
      return;
    }
    if (this.status === "read-only" && !wasAllowed && isAllowed) {
      this.setStatus("live");
      this.sendQueueHead();
    }
  }

  /**
   * Permanently fences this branch session, rolls back its optimistic overlay,
   * and waits until the durable queue partition is fenced and purged.
   */
  async permanentlyFenceWrites(fence: CollaborationPermanentWriteFence): Promise<void> {
    validatePermanentWriteFence(fence);
    if (this.disposed) throw new Error("Collaboration transport is disposed");
    const effectiveFence = selectPermanentWriteFence(this.permanentWriteFence, fence);
    const changed = !samePermanentWriteFence(this.permanentWriteFence, effectiveFence);
    this.permanentWriteFence = clonePermanentWriteFence(effectiveFence);
    if (this.status === "live") this.setStatus("read-only");

    if (changed || this.pending.length) {
      try {
        this.options.onPermanentWriteFence?.(effectiveFence);
      } catch (error) {
        this.fail(asError(error));
        throw error;
      }
      this.pending = [];
    }

    const persist = this.options.persistPermanentWriteFence;
    if (!persist) return;
    const persistFence = this.permanentFenceQueue.then(async () => {
      const storedFence = await persist(effectiveFence);
      validatePermanentWriteFence(storedFence);
      this.permanentWriteFence = clonePermanentWriteFence(
        selectPermanentWriteFence(this.permanentWriteFence, storedFence),
      );
    });
    this.permanentFenceQueue = persistFence.catch(() => undefined);
    try {
      await this.trackPersistenceOperation(persistFence);
    } catch (error) {
      try {
        this.options.onPersistenceError?.(asError(error), "remove");
      } finally {
        this.fail(asError(error));
      }
      throw error;
    }
  }

  /** Replaces a standby transport's in-memory queue with the durable owner handoff. */
  replacePendingTransactions(
    pending: readonly CollaborationTransportPendingTransaction[],
    acceptedClientSequence: number,
  ) {
    if (this.disposed) throw new Error("Collaboration transport is disposed");
    if (this.isWriteAllowed) {
      throw new Error("Pending queue handoff requires a temporarily write-gated transport");
    }
    if (this.permanentWriteFence) {
      if (pending.length)
        throw new Error("A permanently fenced transport cannot adopt pending work");
      return;
    }
    if (!Number.isSafeInteger(acceptedClientSequence) || acceptedClientSequence < 0) {
      throw new Error("The accepted client sequence watermark is invalid");
    }
    this.pending = restorePendingTransactions(pending);
    this.nextClientSequence =
      Math.max(acceptedClientSequence, this.pending.at(-1)?.clientSequence ?? 0) + 1;
  }

  async flushPersistence() {
    while (this.persistenceOperations.size) {
      await Promise.allSettled(this.persistenceOperations);
    }
  }

  close() {
    if (this.disposed) return;
    this.disposed = true;
    this.clearReconnectTimer();
    this.clearRefreshTimer();
    this.clearAttemptTimer();
    this.connectionGeneration += 1;
    this.bootstrapAbortController?.abort();
    this.bootstrapAbortController = null;
    const socket = this.socket;
    this.socket = null;
    if (this.pending[0]) this.pending[0].sent = false;
    this.liveQueue = [];
    try {
      socket?.close(1000, "Collaboration transport closed");
    } catch {
      // A socket may already be closing; disposal is still complete.
    }
    this.setStatus("closed");
  }

  enqueue(commands: LeafSemanticCommand[], historyGroupId = this.createId()) {
    if (this.disposed) throw new Error("Collaboration transport is disposed");
    this.assertWritesAccepted();
    if (commands.length === 0) throw new Error("A collaboration transaction requires commands");
    const pending: PendingTransaction = {
      clientTxId: this.createId(),
      clientSequence: this.nextClientSequence++,
      historyGroupId,
      kind: "user",
      commands: structuredClone(commands),
      durable: !this.options.persistPendingTransaction,
      sent: false,
      wireMessage: null,
    };
    this.pending.push(pending);
    this.makePendingDurable(pending);
    return pending.clientTxId;
  }

  enqueueHistory(kind: "undo" | "redo", historyGroupId: string) {
    if (this.disposed) throw new Error("Collaboration transport is disposed");
    this.assertWritesAccepted();
    if (!historyGroupId) throw new Error("A history transaction requires a history group");
    const pending: PendingTransaction = {
      clientTxId: this.createId(),
      clientSequence: this.nextClientSequence++,
      historyGroupId,
      kind,
      durable: !this.options.persistPendingTransaction,
      sent: false,
      wireMessage: null,
    };
    this.pending.push(pending);
    this.makePendingDurable(pending);
    return pending.clientTxId;
  }

  private startConnection(isReconnect: boolean) {
    if (this.disposed || !this.online) return;
    this.clearReconnectTimer();
    this.clearRefreshTimer();
    this.clearAttemptTimer();
    this.bootstrapAbortController?.abort();
    this.bootstrapAbortController = null;
    this.liveQueue = [];
    this.hasStartedConnection = true;
    const generation = ++this.connectionGeneration;
    this.setStatus("connecting");
    this.armConnectionAttemptTimeout(generation);

    const shouldRefresh =
      !!this.refreshSyncServerUrl &&
      (this.refreshSyncServerUrlOnInitialConnect ||
        isReconnect ||
        this.now() - this.syncServerUrlResolvedAt >= this.syncServerUrlMaxAgeMs);
    if (!shouldRefresh) {
      this.openSocket(this.currentSyncServerUrl, generation);
      return;
    }

    let refreshed: ReturnType<SyncServerUrlProvider>;
    try {
      refreshed = this.refreshSyncServerUrl!();
    } catch (error) {
      this.handleUrlRefreshFailure(error, generation);
      return;
    }
    if (typeof refreshed !== "string" && refreshed !== null) {
      void Promise.resolve(refreshed).then(
        (url) => this.finishUrlRefresh(url, generation),
        (error: unknown) => this.handleUrlRefreshFailure(error, generation),
      );
      return;
    }
    this.finishUrlRefresh(refreshed, generation);
  }

  private finishUrlRefresh(url: string | null, generation: number) {
    if (!this.isConnectionAttemptCurrent(generation)) return;
    if (!url) {
      this.handleConnectionAttemptFailure(generation);
      return;
    }
    this.currentSyncServerUrl = url;
    this.refreshSyncServerUrlOnInitialConnect = false;
    this.syncServerUrlResolvedAt = this.now();
    this.openSocket(url, generation);
  }

  private openSocket(url: string, generation: number) {
    if (!this.isConnectionAttemptCurrent(generation)) return;
    let socket: TransportSocket;
    try {
      socket = this.createSocket(url);
    } catch {
      this.handleConnectionAttemptFailure(generation);
      return;
    }
    if (!this.isConnectionAttemptCurrent(generation)) {
      try {
        socket.close(1000, "Stale collaboration connection");
      } catch {
        // The stale attempt is already fenced.
      }
      return;
    }

    this.socket = socket;
    this.armAttemptTimeout(socket, generation, this.connectionOpenTimeoutMs);
    socket.addEventListener("open", () => this.sendHello(socket, generation));
    socket.addEventListener("message", (event) =>
      this.handleMessage(socket, generation, url, event),
    );
    socket.addEventListener("error", () =>
      this.handleUnexpectedDisconnect(socket, generation, true),
    );
    socket.addEventListener("close", () =>
      this.handleUnexpectedDisconnect(socket, generation, false),
    );
  }

  private sendHello(socket: TransportSocket, generation: number) {
    if (!this.isSocketCurrent(socket, generation)) return;
    this.armAttemptTimeout(socket, generation, this.bootstrapTimeoutMs);
    try {
      socket.send(
        JSON.stringify({
          type: "hello",
          protocolVersion: LEAF_COLLABORATION_PROTOCOL_VERSION,
          schemaVersion: LEAF_RECORD_SCHEMA_VERSION,
          clientInstanceId: this.options.clientInstanceId,
          writeIntent: this.isWriteAllowed,
          ...(this.cursor
            ? { streamEpoch: this.cursor.streamEpoch, seenRevision: this.cursor.revision }
            : {}),
        }),
      );
    } catch {
      this.handleUnexpectedDisconnect(socket, generation, true);
    }
  }

  private handleMessage(
    socket: TransportSocket,
    generation: number,
    socketUrl: string,
    event: TransportSocketEvent,
  ) {
    if (!this.isSocketCurrent(socket, generation)) return;
    let message: LeafServerMessage;
    try {
      const data = (event as MessageEvent).data;
      const text = typeof data === "string" ? data : new TextDecoder().decode(data);
      message = parseLeafServerMessage(JSON.parse(text));
    } catch {
      this.fail(new Error("Document sync sent an invalid message"), socket, generation);
      return;
    }

    if (message.type === "hello") {
      if (this.status !== "connecting") return;
      this.setStatus("bootstrapping");
      this.armAttemptTimeout(socket, generation, this.bootstrapTimeoutMs);
      const abortController = new AbortController();
      this.bootstrapAbortController = abortController;
      void this.bootstrap(socket, generation, socketUrl, message, abortController.signal).catch(
        (error) => {
          if (this.isSocketCurrent(socket, generation)) {
            if (error instanceof SnapshotInstallError) {
              this.fail(error, socket, generation);
            } else {
              this.handleUnexpectedDisconnect(socket, generation, true);
            }
          }
        },
      );
      return;
    }
    if (message.type === "commit" || message.type === "rebase") {
      if (this.status === "bootstrapping") {
        this.liveQueue.push(message);
      } else if (this.status === "live" || this.status === "read-only") {
        // A deterministic apply failure (a poison commit the document model
        // rejects) is terminal on the live path for the same reason it is in
        // installTail: reconnecting replays the identical commit forever.
        try {
          this.applyContiguousCommit(message);
        } catch (error) {
          this.fail(asError(error), socket, generation);
        }
      }
      return;
    }
    if (message.type !== "reject" && message.type !== "resync") return;

    let additionallyRejectedIds: readonly string[] = [];
    try {
      additionallyRejectedIds = this.options.onReject?.(message) ?? [];
    } catch (error) {
      this.fail(asError(error), socket, generation);
      return;
    }

    if (message.type === "resync") {
      const rejectedIds = new Set(additionallyRejectedIds);
      if (message.clientTxId) rejectedIds.add(message.clientTxId);
      if (rejectedIds.size) {
        this.pending = this.pending.filter((entry) => !rejectedIds.has(entry.clientTxId));
        this.removePersistedPending(rejectedIds);
      }
      this.nextClientSequence = this.pending.length + 1;
      this.resequencePending(1);
      this.handleUnexpectedDisconnect(socket, generation, true, true);
      return;
    }

    if (message.clientTxId && this.pending[0]?.clientTxId === message.clientTxId) {
      const [rejected] = this.pending.splice(0, 1);
      const additionallyRejected = new Set(additionallyRejectedIds);
      if (additionallyRejected.size) {
        this.pending = this.pending.filter((entry) => !additionallyRejected.has(entry.clientTxId));
      }
      this.removePersistedPending(new Set([rejected.clientTxId, ...additionallyRejected]));
      this.resequencePending(rejected.clientSequence);
      if (message.code !== "read_only") this.sendQueueHead();
    }
    if (message.code === "read_only") {
      void this.permanentlyFenceWrites({ kind: "read-only", fencedAtMs: this.now() }).catch(
        () => undefined,
      );
    }
  }

  private async bootstrap(
    socket: TransportSocket,
    generation: number,
    socketUrl: string,
    hello: Extract<LeafServerMessage, { type: "hello" }>,
    signal: AbortSignal,
  ) {
    const canResume =
      this.cursor?.streamEpoch === hello.streamEpoch &&
      this.cursor.revision >= hello.retainedFromRevision &&
      this.cursor.revision <= hello.barrierRevision;
    let afterRevision = canResume ? this.cursor!.revision : undefined;
    let installedSnapshot = false;
    let installedCheckpoint = false;

    const installSnapshot = async (
      snapshot: LeafRecordSnapshot,
      cursor: TransportCursor,
      checkpoint?: LeafCheckpointReference,
    ) => {
      const previousEpoch = this.cursor?.streamEpoch;
      if (previousEpoch && previousEpoch !== cursor.streamEpoch) {
        if (this.pending.length) {
          const discardedIds = new Set(this.pending.map((pending) => pending.clientTxId));
          for (const pending of this.pending) {
            this.options.onReject?.({
              type: "resync",
              clientTxId: pending.clientTxId,
              requiredEpoch: cursor.streamEpoch,
              reason: "Pending work belongs to an older document epoch",
            });
          }
          this.pending = [];
          await this.removePersistedPendingNow(discardedIds);
        }
        this.nextClientSequence = 1;
      }
      try {
        await this.options.onSnapshot(snapshot, cursor, checkpoint);
      } catch (error) {
        // A persistence-backend outage (IndexedDB quota pressure, a
        // private-mode flake) is a transient environment failure that the
        // next attempt can survive — only deterministic install failures are
        // terminal.
        if (error instanceof CollaborationPersistenceBackendError) throw error;
        throw new SnapshotInstallError(asError(error));
      }
      if (!this.isSocketCurrent(socket, generation)) return false;
      this.cursor = { ...cursor };
      installedSnapshot = true;
      return true;
    };

    while (true) {
      const response = await this.fetchBootstrap(
        socketUrl,
        {
          ...(afterRevision === undefined ? {} : { streamEpoch: hello.streamEpoch, afterRevision }),
          throughRevision: hello.barrierRevision,
        },
        signal,
      );
      if (!this.isSocketCurrent(socket, generation)) return;
      if (response.type === "snapshot") {
        if (
          !(await installSnapshot(response.snapshot, {
            streamEpoch: response.streamEpoch,
            revision: response.revision,
          }))
        ) {
          return;
        }
        break;
      }
      if (response.type === "checkpoint") {
        if (!this.options.loadCheckpoint) {
          throw new SnapshotInstallError(
            new Error("Document bootstrap requires a checkpoint loader"),
          );
        }
        if (
          response.streamEpoch !== hello.streamEpoch ||
          response.checkpoint.streamEpoch !== hello.streamEpoch
        ) {
          // The stream epoch rotated between the hello and this fetch; the
          // next reconnect's hello carries the new epoch, so retry.
          throw new Error("Document checkpoint bootstrap cursor is invalid");
        }
        if (response.checkpoint.revision > response.throughRevision) {
          // A checkpoint claiming a revision past its own tail is persisted
          // corruption the server returns identically on every retry.
          throw new SnapshotInstallError(
            new Error("Document checkpoint bootstrap cursor is invalid"),
          );
        }
        let snapshot: LeafRecordSnapshot;
        try {
          snapshot = await this.options.loadCheckpoint(response, signal);
        } catch (error) {
          throw new SnapshotInstallError(asError(error));
        }
        if (!this.isSocketCurrent(socket, generation)) return;
        if (
          !(await installSnapshot(
            snapshot,
            {
              streamEpoch: response.checkpoint.streamEpoch,
              revision: response.checkpoint.revision,
            },
            response.checkpoint,
          ))
        ) {
          return;
        }
        installedCheckpoint = true;
        this.installTail(response, response.checkpoint.revision);
        if (!this.isSocketCurrent(socket, generation)) return;
        if (response.nextRevision === null) break;
        afterRevision = response.nextRevision;
        continue;
      }
      this.installTail(response, afterRevision ?? 0);
      if (!this.isSocketCurrent(socket, generation)) return;
      if (response.nextRevision === null) break;
      afterRevision = response.nextRevision;
    }

    if (
      (!installedSnapshot || installedCheckpoint) &&
      this.cursor?.revision !== hello.barrierRevision
    ) {
      // The room advertised barrierRevision in the same strongly consistent
      // Durable Object that answered this bootstrap, so stopping short is a
      // deterministic inconsistency, not a race a retry can win.
      throw new SnapshotInstallError(
        new Error(
          `Bootstrap stopped at revision ${this.cursor?.revision ?? -1}, expected ${hello.barrierRevision}`,
        ),
      );
    }
    if (!this.isSocketCurrent(socket, generation)) return;
    this.drainLiveQueue();
    if (!this.isSocketCurrent(socket, generation) || this.status === "error") return;
    this.bootstrapAbortController = null;
    this.clearAttemptTimer();
    this.reconnectAttempt = 0;
    this.setStatus(this.isWriteAllowed ? "live" : "read-only");
    this.armSyncUrlRefresh();
    this.sendQueueHead();
  }

  private async fetchBootstrap(
    syncServerUrl: string,
    cursor: {
      streamEpoch?: string;
      afterRevision?: number;
      throughRevision: number;
    },
    signal: AbortSignal,
  ) {
    const url = new URL(syncServerUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = `${url.pathname.replace(/\/$/, "")}/bootstrap`;
    if (cursor.streamEpoch) url.searchParams.set("streamEpoch", cursor.streamEpoch);
    if (cursor.afterRevision !== undefined) {
      url.searchParams.set("afterRevision", String(cursor.afterRevision));
    }
    url.searchParams.set("throughRevision", String(cursor.throughRevision));
    const response = await this.fetcher(url, {
      method: LEAF_WORKER_ROUTES.branchBootstrap.method,
      signal,
    });
    if (!response.ok) throw new Error(`Document bootstrap failed (${response.status})`);
    const decoded = await response.json();
    try {
      return parseLeafBootstrapResponse(decoded);
    } catch (error) {
      // Terminal only when the body is recognizably a bootstrap payload whose
      // contents fail validation — a deterministic incompatibility from the
      // real Worker. A JSON body without a bootstrap shape (a gateway or
      // proxy error page, a mid-deploy intermediary) is transient output and
      // stays retryable, exactly like syntactically malformed JSON.
      if (isRecognizableBootstrapPayload(decoded)) {
        throw new SnapshotInstallError(asError(error));
      }
      throw asError(error);
    }
  }

  private installTail(
    response: Extract<LeafBootstrapResponse, { type: "tail" | "checkpoint" }>,
    after: number,
  ) {
    if (response.streamEpoch !== this.cursor?.streamEpoch) {
      throw new Error("Document bootstrap epoch changed");
    }
    let expected = after + 1;
    for (const commit of response.commits) {
      if (commit.revision !== expected) throw new Error(`Document bootstrap gap at ${expected}`);
      try {
        this.applyCommit(commit);
      } catch (error) {
        throw new SnapshotInstallError(asError(error));
      }
      expected += 1;
    }
  }

  private drainLiveQueue() {
    this.liveQueue.sort((left, right) => left.revision - right.revision);
    for (const commit of this.liveQueue) {
      if (
        commit.streamEpoch === this.cursor?.streamEpoch &&
        commit.revision <= this.cursor.revision
      ) {
        continue;
      }
      try {
        this.applyContiguousCommit(commit);
      } catch (error) {
        throw new SnapshotInstallError(asError(error));
      }
    }
    this.liveQueue = [];
  }

  private applyContiguousCommit(commit: LeafCommitMessage) {
    if (!this.cursor || commit.streamEpoch !== this.cursor.streamEpoch) {
      this.restartAfterStreamFailure();
      return;
    }
    if (commit.revision <= this.cursor.revision) {
      // A reconnect may resend a transaction whose durable receipt is already
      // represented by the installed snapshot/tail. Treat the stored outcome as
      // an acknowledgement without applying its patches a second time.
      if (this.pending[0]?.clientTxId === commit.clientTxId) {
        this.options.onSnapshotAcknowledgement?.(commit);
      }
      this.acknowledgeQueueHead(commit);
      return;
    }
    if (commit.revision !== this.cursor.revision + 1) {
      this.restartAfterStreamFailure();
      return;
    }
    this.applyCommit(commit);
  }

  private applyCommit(commit: LeafCommitMessage) {
    this.options.onCommit(commit);
    this.cursor = { streamEpoch: commit.streamEpoch, revision: commit.revision };
    this.acknowledgeQueueHead(commit);
  }

  private acknowledgeQueueHead(commit: LeafCommitMessage) {
    if (this.pending[0]?.clientTxId !== commit.clientTxId) return;
    const acknowledged = this.pending.shift()!;
    this.persistAcknowledgement(acknowledged, commit);
    this.sendQueueHead();
  }

  private sendQueueHead() {
    if (
      this.status !== "live" ||
      !this.online ||
      !this.isWriteAllowed ||
      !this.cursor ||
      !this.socket ||
      this.socket.readyState !== WEBSOCKET_OPEN ||
      this.pending.length === 0
    ) {
      return;
    }
    const head = this.pending[0];
    if (head.sent || !head.durable) return;
    const envelope = {
      type: "transaction",
      protocolVersion: LEAF_COLLABORATION_PROTOCOL_VERSION,
      schemaVersion: LEAF_RECORD_SCHEMA_VERSION,
      streamEpoch: this.cursor.streamEpoch,
      baseRevision: this.cursor.revision,
      clientTxId: head.clientTxId,
      clientInstanceId: this.options.clientInstanceId,
      clientSequence: head.clientSequence,
      historyGroupId: head.historyGroupId,
    } as const;
    head.wireMessage ??=
      head.kind === "user"
        ? { ...envelope, kind: "user", commands: head.commands! }
        : { ...envelope, kind: head.kind };
    try {
      this.socket.send(JSON.stringify(head.wireMessage));
      head.sent = true;
    } catch {
      head.sent = false;
      this.handleUnexpectedDisconnect(this.socket, this.connectionGeneration, true);
    }
  }

  private resequencePending(firstSequence: number) {
    let sequence = firstSequence;
    for (const pending of this.pending) {
      const nextSequence = sequence++;
      const changed = pending.clientSequence !== nextSequence;
      pending.clientSequence = nextSequence;
      pending.sent = false;
      pending.wireMessage = null;
      if (changed && this.options.persistPendingTransaction) {
        pending.durable = false;
        this.makePendingDurable(pending);
      }
    }
    this.nextClientSequence = sequence;
  }

  private makePendingDurable(pending: PendingTransaction) {
    const persist = this.options.persistPendingTransaction;
    if (!persist) {
      this.sendQueueHead();
      return;
    }
    const durablePayload = toPublicPendingTransaction(pending);
    const operation = persist(durablePayload).then(
      () => {
        const current = this.pending.find((entry) => entry.clientTxId === pending.clientTxId);
        if (!current || this.disposed) return;
        current.durable = true;
        this.sendQueueHead();
      },
      (error) => this.handlePendingPersistenceFailure(pending.clientTxId, asError(error)),
    );
    void this.trackPersistenceOperation(operation);
  }

  private handlePendingPersistenceFailure(clientTxId: string, error: Error) {
    if (this.disposed) return;
    const index = this.pending.findIndex((entry) => entry.clientTxId === clientTxId);
    if (index < 0) return;
    const failed = this.pending.splice(index);
    const failedIds = new Set(failed.map((entry) => entry.clientTxId));
    this.nextClientSequence = failed[0].clientSequence;
    try {
      for (const entry of failed) {
        this.options.onReject?.({
          type: "reject",
          clientTxId: entry.clientTxId,
          code: "pending_not_durable",
          message: "The local transaction could not be stored durably.",
        });
      }
      this.options.onPersistenceError?.(error, "persist");
    } catch (callbackError) {
      this.fail(asError(callbackError));
      return;
    }
    this.removePersistedPending(failedIds);
    this.fail(error);
  }

  private persistAcknowledgement(pending: PendingTransaction, commit: LeafCommitMessage) {
    const acknowledge = this.options.acknowledgePendingTransaction;
    if (!acknowledge) {
      this.removePersistedPending(new Set([pending.clientTxId]));
      return;
    }
    const operation = acknowledge(toPublicPendingTransaction(pending), commit).catch((error) => {
      try {
        this.options.onPersistenceError?.(asError(error), "remove");
      } catch {
        // The server receipt remains authoritative and a reload can retry it.
      }
    });
    void this.trackPersistenceOperation(operation);
  }

  private removePersistedPending(clientTxIds: ReadonlySet<string>) {
    const operation = this.removePersistedPendingNow(clientTxIds).catch(() => undefined);
    void this.trackPersistenceOperation(operation);
  }

  private async removePersistedPendingNow(clientTxIds: ReadonlySet<string>) {
    if (clientTxIds.size === 0) return;
    try {
      if (this.options.removePendingTransactions) {
        await this.options.removePendingTransactions([...clientTxIds]);
        return;
      }
      const remove = this.options.removePendingTransaction;
      if (!remove) return;
      await Promise.all([...clientTxIds].map(async (clientTxId) => await remove(clientTxId)));
    } catch (error) {
      try {
        this.options.onPersistenceError?.(asError(error), "remove");
      } catch {
        // The authoritative receipt makes a later duplicate retry safe. A
        // reporting callback must not destabilize the live stream.
      }
      throw error;
    }
  }

  private restartAfterStreamFailure() {
    const socket = this.socket;
    if (!socket) return;
    this.handleUnexpectedDisconnect(socket, this.connectionGeneration, true, true);
  }

  private assertWritesAccepted() {
    if (this.permanentWriteFence) {
      throw new Error(`This collaboration branch is permanently ${this.permanentWriteFence.kind}`);
    }
    if (!this.writeAllowed) {
      throw new Error("This collaboration session is temporarily write-gated");
    }
  }

  private trackPersistenceOperation<T>(operation: Promise<T>): Promise<T> {
    this.persistenceOperations.add(operation);
    void operation
      .finally(() => {
        this.persistenceOperations.delete(operation);
      })
      .catch(() => undefined);
    return operation;
  }

  private handleUnexpectedDisconnect(
    socket: TransportSocket,
    generation: number,
    closeSocket: boolean,
    reconnectImmediately = false,
  ) {
    if (!this.isSocketCurrent(socket, generation)) return;
    this.socket = null;
    this.connectionGeneration += 1;
    this.bootstrapAbortController?.abort();
    this.bootstrapAbortController = null;
    this.clearRefreshTimer();
    this.clearAttemptTimer();
    this.liveQueue = [];
    if (this.pending[0]) this.pending[0].sent = false;
    if (closeSocket) {
      try {
        socket.close(1011, "Document sync connection will be retried");
      } catch {
        // The stale socket is already fenced and can be ignored.
      }
    }
    if (!this.online) {
      this.setStatus("offline");
      return;
    }
    this.scheduleReconnect(reconnectImmediately);
  }

  private handleConnectionAttemptFailure(generation: number) {
    if (!this.isConnectionAttemptCurrent(generation)) return;
    this.clearAttemptTimer();
    this.connectionGeneration += 1;
    if (!this.online) {
      this.setStatus("offline");
      return;
    }
    this.scheduleReconnect(false);
  }

  private handleUrlRefreshFailure(error: unknown, generation: number) {
    if (!this.isConnectionAttemptCurrent(generation)) return;
    if (error instanceof CollaborationSyncServerUrlRefusedError) {
      // A refusal is not an outage: no later attempt would fare better, and a
      // reconnect loop would only hide it behind "reconnecting".
      this.fail(error);
      return;
    }
    this.handleConnectionAttemptFailure(generation);
  }

  private scheduleReconnect(immediate: boolean) {
    if (this.disposed || !this.online || this.reconnectTimer !== null) return;
    this.setStatus("reconnecting");
    const delayMs = immediate ? 0 : this.nextReconnectDelay();
    this.reconnectTimer = this.scheduleTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed || !this.online) return;
      this.startConnection(true);
    }, delayMs);
  }

  private nextReconnectDelay() {
    const exponent = Math.min(this.reconnectAttempt++, 30);
    const baseDelay = Math.min(this.reconnectMaxDelayMs, this.reconnectBaseDelayMs * 2 ** exponent);
    const random = Math.min(1, Math.max(0, this.random()));
    const jitter = (random * 2 - 1) * this.reconnectJitterRatio;
    return Math.min(this.reconnectMaxDelayMs, Math.max(0, Math.round(baseDelay * (1 + jitter))));
  }

  private armSyncUrlRefresh() {
    this.clearRefreshTimer();
    if (!this.refreshSyncServerUrl || this.disposed || !this.online) return;
    const remainingMs = Math.max(
      0,
      this.syncServerUrlMaxAgeMs - (this.now() - this.syncServerUrlResolvedAt),
    );
    this.refreshTimer = this.scheduleTimeout(() => {
      this.refreshTimer = null;
      if (
        this.disposed ||
        !this.online ||
        (this.status !== "live" && this.status !== "read-only")
      ) {
        return;
      }
      this.retireActiveSocket(4001, "Refreshing document sync authorization");
      this.startConnection(true);
    }, remainingMs);
  }

  private retireActiveSocket(code: number, reason: string) {
    this.clearRefreshTimer();
    this.clearAttemptTimer();
    this.connectionGeneration += 1;
    this.bootstrapAbortController?.abort();
    this.bootstrapAbortController = null;
    const socket = this.socket;
    this.socket = null;
    this.liveQueue = [];
    if (this.pending[0]) this.pending[0].sent = false;
    try {
      socket?.close(code, reason);
    } catch {
      // The socket is already retired and all of its callbacks are fenced.
    }
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer === null) return;
    this.cancelTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearRefreshTimer() {
    if (this.refreshTimer === null) return;
    this.cancelTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  private armAttemptTimeout(socket: TransportSocket, generation: number, timeoutMs: number) {
    this.clearAttemptTimer();
    this.attemptTimer = this.scheduleTimeout(() => {
      this.attemptTimer = null;
      if (!this.isSocketCurrent(socket, generation)) return;
      this.handleUnexpectedDisconnect(socket, generation, true);
    }, timeoutMs);
  }

  private armConnectionAttemptTimeout(generation: number) {
    this.clearAttemptTimer();
    this.attemptTimer = this.scheduleTimeout(() => {
      this.attemptTimer = null;
      this.handleConnectionAttemptFailure(generation);
    }, this.connectionOpenTimeoutMs);
  }

  private clearAttemptTimer() {
    if (this.attemptTimer === null) return;
    this.cancelTimeout(this.attemptTimer);
    this.attemptTimer = null;
  }

  private isConnectionAttemptCurrent(generation: number) {
    return !this.disposed && this.online && generation === this.connectionGeneration;
  }

  private isSocketCurrent(socket: TransportSocket, generation: number) {
    return this.isConnectionAttemptCurrent(generation) && socket === this.socket;
  }

  private setStatus(status: CollaborationTransportStatus) {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatusChange?.(status);
  }

  private fail(error: Error, socket?: TransportSocket, generation?: number) {
    if (this.disposed || this.status === "error") return;
    if (socket && generation !== undefined && !this.isSocketCurrent(socket, generation)) return;
    this.clearReconnectTimer();
    this.clearRefreshTimer();
    this.clearAttemptTimer();
    this.connectionGeneration += 1;
    this.bootstrapAbortController?.abort();
    this.bootstrapAbortController = null;
    const activeSocket = this.socket;
    this.socket = null;
    this.liveQueue = [];
    if (this.pending[0]) this.pending[0].sent = false;
    this.setStatus("error");
    try {
      activeSocket?.close(1011, error.message.slice(0, 120));
    } catch {
      // The fatal state is already visible and the socket is fenced.
    }
  }
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function validatePermanentWriteFence(fence: CollaborationPermanentWriteFence) {
  if (
    (fence.kind !== "read-only" && fence.kind !== "archived") ||
    !Number.isSafeInteger(fence.fencedAtMs) ||
    fence.fencedAtMs < 0
  ) {
    throw new Error("The permanent collaboration write fence is invalid");
  }
}

function clonePermanentWriteFence(
  fence: CollaborationPermanentWriteFence | null,
): CollaborationPermanentWriteFence | null {
  if (!fence) return null;
  validatePermanentWriteFence(fence);
  return { ...fence };
}

function selectPermanentWriteFence(
  existing: CollaborationPermanentWriteFence | null,
  requested: CollaborationPermanentWriteFence,
) {
  if (!existing) return requested;
  if (existing.kind === "archived" || requested.kind === "read-only") return existing;
  return requested;
}

function samePermanentWriteFence(
  left: CollaborationPermanentWriteFence | null,
  right: CollaborationPermanentWriteFence | null,
) {
  return left?.kind === right?.kind && left?.fencedAtMs === right?.fencedAtMs;
}

/** True when a decoded JSON body is shaped like a Leaf bootstrap payload. */
function isRecognizableBootstrapPayload(decoded: unknown): boolean {
  if (typeof decoded !== "object" || decoded === null) return false;
  const type = (decoded as { type?: unknown }).type;
  return type === "snapshot" || type === "checkpoint" || type === "tail";
}

class SnapshotInstallError extends Error {
  constructor(cause: Error) {
    super("The collaboration snapshot could not be installed.", { cause });
    this.name = "SnapshotInstallError";
  }
}

function restorePendingTransactions(
  pending: readonly CollaborationTransportPendingTransaction[],
): PendingTransaction[] {
  const restored = [...pending]
    .map((entry) => toPublicPendingTransaction(entry))
    .sort(
      (left, right) =>
        left.clientSequence - right.clientSequence ||
        left.clientTxId.localeCompare(right.clientTxId),
    );
  const ids = new Set<string>();
  const sequences = new Set<number>();
  for (const entry of restored) {
    if (
      !entry.clientTxId ||
      !entry.historyGroupId ||
      !Number.isSafeInteger(entry.clientSequence) ||
      entry.clientSequence < 1 ||
      ids.has(entry.clientTxId) ||
      sequences.has(entry.clientSequence) ||
      (entry.kind === "user" && (!entry.commands || entry.commands.length === 0)) ||
      (entry.kind !== "user" && entry.commands !== undefined)
    ) {
      throw new Error("Persisted collaboration transaction is invalid");
    }
    ids.add(entry.clientTxId);
    sequences.add(entry.clientSequence);
  }
  return restored.map((entry) => ({ ...entry, durable: true, sent: false, wireMessage: null }));
}

function toPublicPendingTransaction(
  pending: CollaborationTransportPendingTransaction,
): CollaborationTransportPendingTransaction {
  return {
    clientTxId: pending.clientTxId,
    clientSequence: pending.clientSequence,
    historyGroupId: pending.historyGroupId,
    kind: pending.kind,
    ...(pending.commands ? { commands: structuredClone(pending.commands) } : {}),
  };
}
