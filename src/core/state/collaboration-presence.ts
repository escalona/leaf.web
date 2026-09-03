import {
  LEAF_PRESENCE_HEARTBEAT_INTERVAL_MS,
  LEAF_PRESENCE_MAX_BATCH_EVENTS,
  LEAF_PRESENCE_MAX_MESSAGE_BYTES,
  LEAF_PRESENCE_PROTOCOL_VERSION,
  createEmptyLeafPresenceState,
  leafPresenceCursorMoved,
  parseLeafPresenceServerMessage,
  parseLeafPresenceState,
  type LeafPresenceClientEvent,
  type LeafPresenceClientBatchMessage,
  type LeafPresencePeerProfile,
  type LeafPresenceServerEvent,
  type LeafPresenceState,
} from "../shared/collaboration/presence";

const SOCKET_OPEN = 1;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const DEFAULT_BACKPRESSURE_BYTES = 128 * 1024;
const DEFAULT_IDLE_INTERVAL_MS = 100;
const DEFAULT_TRANSFORM_INTERVAL_MS = 33;
const MAX_COMPLETED_INTERACTIONS = 32;
const MAX_PENDING_COMPLETIONS = 8;

type PresenceSocketEvent = Event | MessageEvent | CloseEvent;
type PresenceTimer = number | ReturnType<typeof globalThis.setTimeout>;

type PresenceSocket = {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(value: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "close" | "error" | "message" | "open",
    listener: (event: PresenceSocketEvent) => void,
  ): void;
};

export type CollaborationPresenceStatus = "idle" | "connecting" | "live" | "closed" | "error";

export type CollaborationPresencePeer = LeafPresencePeerProfile & {
  sequence: number;
  state: LeafPresenceState;
};

export interface CollaborationPresenceClientOptions {
  presenceServerUrl: string;
  createSocket?: (url: string) => PresenceSocket;
  initialState?: LeafPresenceState;
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => PresenceTimer;
  clearTimeout?: (timer: PresenceTimer) => void;
  maxBackpressureBytes?: number;
  idleIntervalMs?: number;
  transformIntervalMs?: number;
  onPeersChange?: (peers: CollaborationPresencePeer[]) => void;
  onStatusChange?: (status: CollaborationPresenceStatus) => void;
  onDroppedUpdate?: () => void;
}

/**
 * Lossy/coalescing browser client for the isolated presence lane.
 *
 * This client never participates in durable transaction dispatch. If its socket
 * is congested, replaceable presence snapshots are dropped rather than queued.
 */
export class CollaborationPresenceClient {
  private readonly createSocket: (url: string) => PresenceSocket;
  private readonly now: () => number;
  private readonly scheduleTimeout: (callback: () => void, delayMs: number) => PresenceTimer;
  private readonly cancelTimeout: (timer: PresenceTimer) => void;
  private readonly maxBackpressureBytes: number;
  private readonly idleIntervalMs: number;
  private readonly transformIntervalMs: number;
  private socket: PresenceSocket | null = null;
  private status: CollaborationPresenceStatus = "idle";
  private state: LeafPresenceState;
  private peersBySession = new Map<string, CollaborationPresencePeer>();
  private completedBySession = new Map<string, string[]>();
  private completedLocalInteractions: string[] = [];
  private pendingCompletions: string[] = [];
  private pendingStateDirty = true;
  private pendingCursorMove = false;
  private lastSentCursorMove = false;
  private sendTimer: PresenceTimer | null = null;
  private sendTimerDueAt = Number.POSITIVE_INFINITY;
  private heartbeatTimer: PresenceTimer | null = null;
  private sequence = 0;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private serverMinIntervalMs = DEFAULT_IDLE_INTERVAL_MS;
  private serverMinTransformIntervalMs = DEFAULT_TRANSFORM_INTERVAL_MS;
  private heartbeatIntervalMs = LEAF_PRESENCE_HEARTBEAT_INTERVAL_MS;
  private adaptivePenalty = 1;
  private ready = false;
  private disposed = false;
  private ownSessionId: string | null = null;

  constructor(private readonly options: CollaborationPresenceClientOptions) {
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url) as PresenceSocket);
    this.now = options.now ?? (() => Date.now());
    this.scheduleTimeout =
      options.setTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.cancelTimeout = options.clearTimeout ?? ((timer) => globalThis.clearTimeout(timer));
    this.maxBackpressureBytes = Math.max(
      1,
      options.maxBackpressureBytes ?? DEFAULT_BACKPRESSURE_BYTES,
    );
    this.idleIntervalMs = Math.max(1, options.idleIntervalMs ?? DEFAULT_IDLE_INTERVAL_MS);
    this.transformIntervalMs = Math.max(
      1,
      options.transformIntervalMs ?? DEFAULT_TRANSFORM_INTERVAL_MS,
    );
    const initial = parseLeafPresenceState(options.initialState ?? createEmptyLeafPresenceState());
    if (!initial) throw new Error("The initial presence state is invalid");
    this.state = initial;
  }

  get connectionStatus() {
    return this.status;
  }

  get currentState(): LeafPresenceState {
    return structuredClone(this.state);
  }

  get peers(): CollaborationPresencePeer[] {
    return [...this.peersBySession.values()].map((peer) => structuredClone(peer));
  }

  connect() {
    if (this.disposed) throw new Error("The presence client is closed");
    if (this.status === "connecting" || this.status === "live") return;
    this.clearTimers();
    this.ready = false;
    this.setStatus("connecting");
    let socket: PresenceSocket;
    try {
      socket = this.createSocket(this.options.presenceServerUrl);
    } catch {
      this.setStatus("error");
      return;
    }
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket || this.disposed) return;
      // The authenticated room's ready message establishes the server budget.
    });
    socket.addEventListener("message", (event) => this.handleMessage(socket, event));
    socket.addEventListener("close", () => this.handleDisconnect(socket));
    socket.addEventListener("error", () => this.handleDisconnect(socket));
  }

  close() {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimers();
    this.ready = false;
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close(1000, "Presence closed");
    } catch {
      // The socket may already be closed.
    }
    this.peersBySession.clear();
    this.completedBySession.clear();
    this.setStatus("closed");
  }

  update(patch: Partial<LeafPresenceState>) {
    if (this.disposed) throw new Error("The presence client is closed");
    const next = parseLeafPresenceState({ ...this.state, ...structuredClone(patch) });
    if (!next) throw new Error("The presence state update is invalid");
    if (
      next.transform &&
      (this.pendingCompletions.includes(next.transform.interactionId) ||
        this.completedLocalInteractions.includes(next.transform.interactionId))
    ) {
      next.transform = null;
    }
    // Cursor motion rides the fast transform lane (~30fps, the usual presence
    // rate); only non-cursor presence idles at the slow interval. The shared
    // predicate keeps this pacing decision identical to the worker's admission.
    if ("cursor" in patch && leafPresenceCursorMoved(this.state.cursor, next.cursor)) {
      this.pendingCursorMove = true;
    }
    this.state = next;
    this.pendingStateDirty = true;
    this.scheduleFlush(false);
  }

  completeInteraction(interactionId: string) {
    if (this.disposed) throw new Error("The presence client is closed");
    if (!interactionId || interactionId.length > 128) {
      throw new Error("The completed interaction id is invalid");
    }
    if (!this.pendingCompletions.includes(interactionId)) {
      if (this.pendingCompletions.length === MAX_PENDING_COMPLETIONS) {
        this.pendingCompletions.shift();
      }
      this.pendingCompletions.push(interactionId);
    }
    this.completedLocalInteractions = this.completedLocalInteractions.filter(
      (candidate) => candidate !== interactionId,
    );
    this.completedLocalInteractions.push(interactionId);
    if (this.completedLocalInteractions.length > MAX_COMPLETED_INTERACTIONS) {
      this.completedLocalInteractions.shift();
    }
    if (this.state.transform?.interactionId === interactionId) {
      this.state = { ...this.state, transform: null };
      this.pendingStateDirty = true;
    }
    this.scheduleFlush(true);
  }

  /** Exposed for lifecycle hooks and deterministic tests. */
  flushNow() {
    this.clearSendTimer();
    this.flush(false);
  }

  private handleMessage(socket: PresenceSocket, event: PresenceSocketEvent) {
    if (this.socket !== socket || this.disposed) return;
    const data = (event as MessageEvent).data as unknown;
    let text: string;
    if (typeof data === "string") {
      text = data;
    } else if (data instanceof ArrayBuffer) {
      if (data.byteLength > LEAF_PRESENCE_MAX_MESSAGE_BYTES) return;
      text = textDecoder.decode(data);
    } else {
      return;
    }
    if (textEncoder.encode(text).byteLength > LEAF_PRESENCE_MAX_MESSAGE_BYTES) return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      return;
    }
    const message = parseLeafPresenceServerMessage(decoded);
    if (!message) return;
    if (message.type === "presence:ready") {
      this.ownSessionId = message.sessionId;
      this.sequence = Math.max(this.sequence, message.acceptedSequence);
      this.serverMinIntervalMs = message.minUpdateIntervalMs;
      this.serverMinTransformIntervalMs = message.minTransformIntervalMs;
      this.heartbeatIntervalMs = message.heartbeatIntervalMs;
      this.adaptivePenalty = 1;
      this.ready = true;
      this.setStatus("live");
      this.pendingStateDirty = true;
      this.scheduleFlush(true);
      this.scheduleHeartbeat();
      return;
    }
    if (message.type === "presence:budget") {
      this.serverMinIntervalMs = message.minUpdateIntervalMs;
      this.serverMinTransformIntervalMs = message.minTransformIntervalMs;
      this.adaptivePenalty = message.dropped
        ? Math.min(4, this.adaptivePenalty * 1.5)
        : Math.max(1, this.adaptivePenalty * 0.85);
      if (message.dropped) {
        // The dropped batch may have carried cursor motion; keep the retry on
        // the fast lane rather than parking fresh cursor state on the idle one.
        if (this.lastSentCursorMove) this.pendingCursorMove = true;
        this.pendingStateDirty = true;
        this.scheduleFlush(false);
      }
      return;
    }
    if (message.type === "presence:refresh") {
      this.pendingStateDirty = true;
      this.scheduleFlush(true);
      return;
    }
    let changed = false;
    for (const presenceEvent of message.events) {
      changed = this.applyServerEvent(presenceEvent) || changed;
    }
    if (changed) this.emitPeers();
  }

  private applyServerEvent(event: LeafPresenceServerEvent) {
    if (event.sessionId === this.ownSessionId) return false;
    if (event.type === "leave") {
      this.completedBySession.delete(event.sessionId);
      return this.peersBySession.delete(event.sessionId);
    }
    if (event.type === "complete") {
      this.rememberCompleted(event.sessionId, event.interactionId);
      const current = this.peersBySession.get(event.sessionId);
      if (current?.state.transform?.interactionId !== event.interactionId) return false;
      this.peersBySession.set(event.sessionId, {
        ...current,
        sequence: Math.max(current.sequence, event.sequence),
        state: { ...current.state, transform: null },
      });
      return true;
    }
    const completed = this.completedBySession.get(event.sessionId) ?? [];
    const state = structuredClone(event.state);
    if (state.transform && completed.includes(state.transform.interactionId)) {
      state.transform = null;
    }
    const current = this.peersBySession.get(event.sessionId);
    if (current && current.sequence >= event.sequence) return false;
    this.peersBySession.set(event.sessionId, {
      actorId: event.actorId,
      sessionId: event.sessionId,
      displayName: event.displayName,
      color: event.color,
      sequence: event.sequence,
      state,
    });
    return true;
  }

  private rememberCompleted(sessionId: string, interactionId: string) {
    const completed = this.completedBySession.get(sessionId) ?? [];
    const filtered = completed.filter((value) => value !== interactionId);
    filtered.push(interactionId);
    if (filtered.length > MAX_COMPLETED_INTERACTIONS) filtered.shift();
    this.completedBySession.set(sessionId, filtered);
  }

  private scheduleFlush(immediate: boolean) {
    if (!this.ready || !this.socket || this.socket.readyState !== SOCKET_OPEN) return;
    const dueAt = immediate ? this.now() : this.lastSentAt + this.effectiveIntervalMs();
    const delay = Math.max(0, dueAt - this.now());
    if (this.sendTimer !== null) {
      // A cursor move can shorten the effective interval mid-wait; reschedule
      // instead of letting the update sit out the previously slower timer.
      if (!immediate && dueAt >= this.sendTimerDueAt) return;
      this.clearSendTimer();
    }
    this.sendTimerDueAt = dueAt;
    this.sendTimer = this.scheduleTimeout(() => {
      this.sendTimer = null;
      this.sendTimerDueAt = Number.POSITIVE_INFINITY;
      this.flush(false);
    }, delay);
  }

  private flush(heartbeatOnly: boolean) {
    const socket = this.socket;
    if (!this.ready || !socket || socket.readyState !== SOCKET_OPEN || this.disposed) return;
    if (socket.bufferedAmount > this.maxBackpressureBytes) {
      if (this.pendingStateDirty) {
        this.pendingStateDirty = false;
        this.pendingCursorMove = false;
        this.options.onDroppedUpdate?.();
      }
      this.adaptivePenalty = Math.min(4, this.adaptivePenalty * 1.5);
      if (this.pendingCompletions.length) this.scheduleFlush(false);
      return;
    }

    const events: LeafPresenceClientEvent[] = [];
    while (this.pendingCompletions.length && events.length < LEAF_PRESENCE_MAX_BATCH_EVENTS) {
      events.push({
        type: "complete",
        sequence: ++this.sequence,
        interactionId: this.pendingCompletions.shift()!,
      });
    }
    if (
      !heartbeatOnly &&
      this.pendingStateDirty &&
      events.length < LEAF_PRESENCE_MAX_BATCH_EVENTS
    ) {
      events.push({
        type: "update",
        sequence: ++this.sequence,
        // No defensive clone: state is replaced immutably by update() and the
        // event is stringified before this method returns.
        state: this.state,
      });
      this.lastSentCursorMove = this.pendingCursorMove;
      this.pendingStateDirty = false;
      this.pendingCursorMove = false;
    }
    if (events.length === 0) {
      events.push({ type: "heartbeat", sequence: ++this.sequence });
    }
    const message: LeafPresenceClientBatchMessage = {
      type: "presence:batch",
      protocolVersion: LEAF_PRESENCE_PROTOCOL_VERSION,
      events,
    };
    const encoded = JSON.stringify(message);
    if (textEncoder.encode(encoded).byteLength > LEAF_PRESENCE_MAX_MESSAGE_BYTES) {
      this.pendingStateDirty = false;
      this.pendingCursorMove = false;
      this.options.onDroppedUpdate?.();
      return;
    }
    try {
      socket.send(encoded);
      this.lastSentAt = this.now();
      this.adaptivePenalty = Math.max(1, this.adaptivePenalty * 0.9);
      this.scheduleHeartbeat();
    } catch {
      this.handleDisconnect(socket);
      return;
    }
    if (this.pendingCompletions.length || this.pendingStateDirty) this.scheduleFlush(false);
  }

  private effectiveIntervalMs() {
    const fastLane = this.state.transform !== null || this.pendingCursorMove;
    const local = fastLane ? this.transformIntervalMs : this.idleIntervalMs;
    const server = fastLane ? this.serverMinTransformIntervalMs : this.serverMinIntervalMs;
    return Math.ceil(Math.max(local, server) * this.adaptivePenalty);
  }

  private scheduleHeartbeat() {
    if (!this.ready || this.disposed) return;
    if (this.heartbeatTimer !== null) this.cancelTimeout(this.heartbeatTimer);
    this.heartbeatTimer = this.scheduleTimeout(() => {
      this.heartbeatTimer = null;
      this.flush(true);
    }, this.heartbeatIntervalMs);
  }

  private handleDisconnect(socket: PresenceSocket) {
    if (this.socket !== socket || this.disposed) return;
    this.socket = null;
    this.ready = false;
    this.clearTimers();
    this.peersBySession.clear();
    this.completedBySession.clear();
    this.emitPeers();
    this.setStatus("idle");
  }

  private emitPeers() {
    this.options.onPeersChange?.(this.peers);
  }

  private setStatus(status: CollaborationPresenceStatus) {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatusChange?.(status);
  }

  private clearSendTimer() {
    this.sendTimerDueAt = Number.POSITIVE_INFINITY;
    if (this.sendTimer === null) return;
    this.cancelTimeout(this.sendTimer);
    this.sendTimer = null;
  }

  private clearTimers() {
    this.clearSendTimer();
    if (this.heartbeatTimer !== null) this.cancelTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}
