/**
 * Environment-neutral contract for Leaf's lossy multiplayer presence lane.
 *
 * Presence is deliberately separate from the durable collaboration protocol:
 * it carries complete, replaceable snapshots and may be coalesced or dropped.
 */

export const LEAF_PRESENCE_PROTOCOL_VERSION = 1 as const;
export const LEAF_PRESENCE_MAX_MESSAGE_BYTES = 64 * 1024;
export const LEAF_PRESENCE_MAX_BATCH_EVENTS = 16;
export const LEAF_PRESENCE_MAX_SELECTION_IDS = 128;
export const LEAF_PRESENCE_MAX_TRANSFORM_DELTAS = 64;
export const LEAF_PRESENCE_SESSION_TIMEOUT_MS = 45_000;
export const LEAF_PRESENCE_HEARTBEAT_INTERVAL_MS = 15_000;

const MAX_ID_LENGTH = 256;
const MAX_INTERACTION_ID_LENGTH = 128;
const MAX_TOOL_LENGTH = 64;
const MAX_DISPLAY_NAME_LENGTH = 120;
const MAX_COORDINATE = 1_000_000_000;
const MAX_ZOOM = 10_000;

export interface LeafPresenceRoomIdentity {
  workspaceId: string;
  fileId: string;
  branchId: string;
}

export interface LeafPresenceConnectionIdentity extends LeafPresenceRoomIdentity {
  actorId: string;
  sessionId: string;
  expiresAt: number;
  displayName: string | null;
  color: string | null;
}

export interface LeafPresencePoint {
  x: number;
  y: number;
}

export interface LeafPresenceViewport extends LeafPresencePoint {
  width: number;
  height: number;
  zoom: number;
}

export type LeafPresenceTransformKind = "drag" | "resize" | "rotate";

export interface LeafPresenceTransformDelta {
  nodeId: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
}

export interface LeafPresenceTransformPreview {
  interactionId: string;
  kind: LeafPresenceTransformKind;
  deltas: LeafPresenceTransformDelta[];
}

/** A complete replaceable snapshot, not a patch. */
export interface LeafPresenceState {
  cursor: LeafPresencePoint | null;
  /**
   * The document page the peer is viewing. Cursor, selection, and transform
   * previews only paint for peers on the viewer's active page. `null` means the
   * sender predates this field, and such a peer paints on every page.
   */
  pageId: string | null;
  selectedNodeIds: string[];
  tool: string;
  viewport: LeafPresenceViewport | null;
  transform: LeafPresenceTransformPreview | null;
}

export type LeafPresenceClientEvent =
  | { type: "update"; sequence: number; state: LeafPresenceState }
  | { type: "complete"; sequence: number; interactionId: string }
  | { type: "heartbeat"; sequence: number };

export interface LeafPresenceClientBatchMessage {
  type: "presence:batch";
  protocolVersion: typeof LEAF_PRESENCE_PROTOCOL_VERSION;
  events: LeafPresenceClientEvent[];
}

export interface LeafPresencePeerProfile {
  actorId: string;
  sessionId: string;
  displayName: string | null;
  color: string | null;
}

export type LeafPresenceServerEvent =
  | ({ type: "peer"; sequence: number; state: LeafPresenceState } & LeafPresencePeerProfile)
  | ({ type: "complete"; sequence: number; interactionId: string } & LeafPresencePeerProfile)
  | ({
      type: "leave";
      reason: "closed" | "expired" | "replaced" | "fenced";
    } & LeafPresencePeerProfile);

export type LeafPresenceServerMessage =
  | {
      type: "presence:ready";
      protocolVersion: typeof LEAF_PRESENCE_PROTOCOL_VERSION;
      sessionId: string;
      acceptedSequence: number;
      heartbeatIntervalMs: number;
      minUpdateIntervalMs: number;
      minTransformIntervalMs: number;
      peerCount: number;
    }
  | {
      type: "presence:budget";
      protocolVersion: typeof LEAF_PRESENCE_PROTOCOL_VERSION;
      minUpdateIntervalMs: number;
      minTransformIntervalMs: number;
      peerCount: number;
      dropped: boolean;
    }
  | {
      type: "presence:refresh";
      protocolVersion: typeof LEAF_PRESENCE_PROTOCOL_VERSION;
      reason: "join" | "wake";
    }
  | {
      type: "presence:batch";
      protocolVersion: typeof LEAF_PRESENCE_PROTOCOL_VERSION;
      events: LeafPresenceServerEvent[];
    };

/**
 * Whether an update's cursor moved: a position change, appearance, or clearing.
 * Client pacing and worker admission both use this to route cursor motion onto
 * the fast transform cadence; a single definition keeps the two ends from
 * disagreeing about which updates deserve the fast lane. An unknown previous
 * state (`undefined` — a session's first update, or a worker that lost its
 * in-memory snapshot across hibernation) counts a visible cursor as moved:
 * that lenient direction admits at most one extra fast-lane update, while the
 * strict direction would drop a compliant fast-lane client's update.
 */
export function leafPresenceCursorMoved(
  previous: LeafPresencePoint | null | undefined,
  next: LeafPresencePoint | null,
): boolean {
  if (previous === undefined) return next !== null;
  return previous?.x !== next?.x || previous?.y !== next?.y;
}

export function createEmptyLeafPresenceState(): LeafPresenceState {
  return {
    cursor: null,
    pageId: null,
    selectedNodeIds: [],
    tool: "select",
    viewport: null,
    transform: null,
  };
}

/**
 * Whether a peer snapshot should paint on the viewer's active page. A snapshot
 * without a page (a client that predates `pageId`) paints on every page.
 */
export function isLeafPresenceStateOnPage(
  state: Pick<LeafPresenceState, "pageId">,
  activePageId: string,
) {
  return state.pageId === null || state.pageId === activePageId;
}

export function parseLeafPresenceClientMessage(
  value: unknown,
): LeafPresenceClientBatchMessage | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["type", "protocolVersion", "events"]) ||
    value.type !== "presence:batch" ||
    value.protocolVersion !== LEAF_PRESENCE_PROTOCOL_VERSION ||
    !Array.isArray(value.events) ||
    value.events.length < 1 ||
    value.events.length > LEAF_PRESENCE_MAX_BATCH_EVENTS
  ) {
    return null;
  }
  const events: LeafPresenceClientEvent[] = [];
  let previousSequence = 0;
  for (const candidate of value.events) {
    const event = parseClientEvent(candidate);
    if (!event || event.sequence <= previousSequence) return null;
    previousSequence = event.sequence;
    events.push(event);
  }
  return {
    type: "presence:batch",
    protocolVersion: LEAF_PRESENCE_PROTOCOL_VERSION,
    events,
  };
}

export function parseLeafPresenceServerMessage(value: unknown): LeafPresenceServerMessage | null {
  if (!isRecord(value) || value.protocolVersion !== LEAF_PRESENCE_PROTOCOL_VERSION) return null;
  if (value.type === "presence:ready") {
    if (
      !hasOnlyKeys(value, [
        "type",
        "protocolVersion",
        "sessionId",
        "acceptedSequence",
        "heartbeatIntervalMs",
        "minUpdateIntervalMs",
        "minTransformIntervalMs",
        "peerCount",
      ]) ||
      !isId(value.sessionId) ||
      !isNonNegativeSafeInteger(value.acceptedSequence) ||
      !isPositiveSafeInteger(value.heartbeatIntervalMs) ||
      !isPositiveSafeInteger(value.minUpdateIntervalMs) ||
      !isPositiveSafeInteger(value.minTransformIntervalMs) ||
      !isNonNegativeSafeInteger(value.peerCount)
    ) {
      return null;
    }
    return {
      type: value.type,
      protocolVersion: LEAF_PRESENCE_PROTOCOL_VERSION,
      sessionId: value.sessionId,
      acceptedSequence: value.acceptedSequence,
      heartbeatIntervalMs: value.heartbeatIntervalMs,
      minUpdateIntervalMs: value.minUpdateIntervalMs,
      minTransformIntervalMs: value.minTransformIntervalMs,
      peerCount: value.peerCount,
    };
  }
  if (value.type === "presence:budget") {
    if (
      !hasOnlyKeys(value, [
        "type",
        "protocolVersion",
        "minUpdateIntervalMs",
        "minTransformIntervalMs",
        "peerCount",
        "dropped",
      ]) ||
      !isPositiveSafeInteger(value.minUpdateIntervalMs) ||
      !isPositiveSafeInteger(value.minTransformIntervalMs) ||
      !isNonNegativeSafeInteger(value.peerCount) ||
      typeof value.dropped !== "boolean"
    ) {
      return null;
    }
    return {
      type: value.type,
      protocolVersion: LEAF_PRESENCE_PROTOCOL_VERSION,
      minUpdateIntervalMs: value.minUpdateIntervalMs,
      minTransformIntervalMs: value.minTransformIntervalMs,
      peerCount: value.peerCount,
      dropped: value.dropped,
    };
  }
  if (value.type === "presence:refresh") {
    if (
      !hasOnlyKeys(value, ["type", "protocolVersion", "reason"]) ||
      (value.reason !== "join" && value.reason !== "wake")
    ) {
      return null;
    }
    return {
      type: value.type,
      protocolVersion: LEAF_PRESENCE_PROTOCOL_VERSION,
      reason: value.reason,
    };
  }
  if (
    value.type !== "presence:batch" ||
    !hasOnlyKeys(value, ["type", "protocolVersion", "events"])
  ) {
    return null;
  }
  if (!Array.isArray(value.events) || value.events.length > 256) return null;
  const events: LeafPresenceServerEvent[] = [];
  for (const candidate of value.events) {
    const event = parseServerEvent(candidate);
    if (!event) return null;
    events.push(event);
  }
  return { type: value.type, protocolVersion: LEAF_PRESENCE_PROTOCOL_VERSION, events };
}

export function parseLeafPresenceState(value: unknown): LeafPresenceState | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["cursor", "pageId", "selectedNodeIds", "tool", "viewport", "transform"])
  ) {
    return null;
  }
  const cursor = value.cursor === null ? null : parsePoint(value.cursor);
  const viewport = value.viewport === null ? null : parseViewport(value.viewport);
  const transform = value.transform === null ? null : parseTransform(value.transform);
  // A snapshot from a client that predates page-scoped presence omits `pageId`;
  // it reads as `null` so the peer keeps painting on every page.
  const pageId = value.pageId === undefined || value.pageId === null ? null : value.pageId;
  if (
    (value.cursor !== null && !cursor) ||
    (value.viewport !== null && !viewport) ||
    (value.transform !== null && !transform) ||
    (pageId !== null && !isId(pageId)) ||
    !Array.isArray(value.selectedNodeIds) ||
    value.selectedNodeIds.length > LEAF_PRESENCE_MAX_SELECTION_IDS ||
    typeof value.tool !== "string" ||
    value.tool.length < 1 ||
    value.tool.length > MAX_TOOL_LENGTH
  ) {
    return null;
  }
  const selectedNodeIds: string[] = [];
  const seen = new Set<string>();
  for (const nodeId of value.selectedNodeIds) {
    if (!isId(nodeId) || seen.has(nodeId)) return null;
    seen.add(nodeId);
    selectedNodeIds.push(nodeId);
  }
  return { cursor, pageId, selectedNodeIds, tool: value.tool, viewport, transform };
}

export function isLeafPresenceRoomIdentity(value: unknown): value is LeafPresenceRoomIdentity {
  return isRecord(value) && isId(value.workspaceId) && isId(value.fileId) && isId(value.branchId);
}

function parseClientEvent(value: unknown): LeafPresenceClientEvent | null {
  if (!isRecord(value) || !isPositiveSafeInteger(value.sequence)) return null;
  if (value.type === "heartbeat") {
    return hasOnlyKeys(value, ["type", "sequence"])
      ? { type: value.type, sequence: value.sequence }
      : null;
  }
  if (value.type === "complete") {
    return hasOnlyKeys(value, ["type", "sequence", "interactionId"]) &&
      isInteractionId(value.interactionId)
      ? { type: value.type, sequence: value.sequence, interactionId: value.interactionId }
      : null;
  }
  if (value.type !== "update" || !hasOnlyKeys(value, ["type", "sequence", "state"])) {
    return null;
  }
  const state = parseLeafPresenceState(value.state);
  return state ? { type: value.type, sequence: value.sequence, state } : null;
}

function parseServerEvent(value: unknown): LeafPresenceServerEvent | null {
  if (!isRecord(value)) return null;
  const profile = parseProfile(value);
  if (!profile) return null;
  if (value.type === "leave") {
    const reason = value.reason;
    if (
      !hasOnlyKeys(value, ["type", "actorId", "sessionId", "displayName", "color", "reason"]) ||
      !["closed", "expired", "replaced", "fenced"].includes(String(reason))
    ) {
      return null;
    }
    return {
      type: value.type,
      ...profile,
      reason: reason as Extract<LeafPresenceServerEvent, { type: "leave" }>["reason"],
    };
  }
  if (!isPositiveSafeInteger(value.sequence)) return null;
  if (value.type === "complete") {
    if (
      !hasOnlyKeys(value, [
        "type",
        "actorId",
        "sessionId",
        "displayName",
        "color",
        "sequence",
        "interactionId",
      ]) ||
      !isInteractionId(value.interactionId)
    ) {
      return null;
    }
    return {
      type: value.type,
      ...profile,
      sequence: value.sequence,
      interactionId: value.interactionId,
    };
  }
  if (
    value.type !== "peer" ||
    !hasOnlyKeys(value, [
      "type",
      "actorId",
      "sessionId",
      "displayName",
      "color",
      "sequence",
      "state",
    ])
  ) {
    return null;
  }
  const state = parseLeafPresenceState(value.state);
  return state ? { type: value.type, ...profile, sequence: value.sequence, state } : null;
}

function parseProfile(value: Record<string, unknown>): LeafPresencePeerProfile | null {
  if (
    !isId(value.actorId) ||
    !isId(value.sessionId) ||
    (value.displayName !== null && !isDisplayName(value.displayName)) ||
    (value.color !== null && !isColor(value.color))
  ) {
    return null;
  }
  return {
    actorId: value.actorId,
    sessionId: value.sessionId,
    displayName: value.displayName,
    color: value.color,
  };
}

function parsePoint(value: unknown): LeafPresencePoint | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["x", "y"]) ||
    !isCoordinate(value.x) ||
    !isCoordinate(value.y)
  ) {
    return null;
  }
  return { x: value.x, y: value.y };
}

function parseViewport(value: unknown): LeafPresenceViewport | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["x", "y", "width", "height", "zoom"]) ||
    !isCoordinate(value.x) ||
    !isCoordinate(value.y) ||
    !isNonNegativeCoordinate(value.width) ||
    !isNonNegativeCoordinate(value.height) ||
    typeof value.zoom !== "number" ||
    !Number.isFinite(value.zoom) ||
    value.zoom <= 0 ||
    value.zoom > MAX_ZOOM
  ) {
    return null;
  }
  return { x: value.x, y: value.y, width: value.width, height: value.height, zoom: value.zoom };
}

function parseTransform(value: unknown): LeafPresenceTransformPreview | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["interactionId", "kind", "deltas"]) ||
    !isInteractionId(value.interactionId) ||
    !["drag", "resize", "rotate"].includes(String(value.kind)) ||
    !Array.isArray(value.deltas) ||
    value.deltas.length < 1 ||
    value.deltas.length > LEAF_PRESENCE_MAX_TRANSFORM_DELTAS
  ) {
    return null;
  }
  const deltas: LeafPresenceTransformDelta[] = [];
  const seen = new Set<string>();
  for (const candidate of value.deltas) {
    const delta = parseTransformDelta(candidate);
    if (!delta || seen.has(delta.nodeId)) return null;
    seen.add(delta.nodeId);
    deltas.push(delta);
  }
  return {
    interactionId: value.interactionId,
    kind: value.kind as LeafPresenceTransformKind,
    deltas,
  };
}

function parseTransformDelta(value: unknown): LeafPresenceTransformDelta | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["nodeId", "x", "y", "width", "height", "rotation"]) ||
    !isId(value.nodeId)
  ) {
    return null;
  }
  const delta: LeafPresenceTransformDelta = { nodeId: value.nodeId };
  let fields = 0;
  for (const key of ["x", "y", "rotation"] as const) {
    if (value[key] === undefined) continue;
    if (!isCoordinate(value[key])) return null;
    delta[key] = value[key];
    fields += 1;
  }
  for (const key of ["width", "height"] as const) {
    if (value[key] === undefined) continue;
    if (!isCoordinate(value[key])) return null;
    delta[key] = value[key];
    fields += 1;
  }
  return fields > 0 ? delta : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function isInteractionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_INTERACTION_ID_LENGTH;
}

function isDisplayName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_DISPLAY_NAME_LENGTH;
}

function isColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function isCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE;
}

function isNonNegativeCoordinate(value: unknown): value is number {
  return isCoordinate(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
