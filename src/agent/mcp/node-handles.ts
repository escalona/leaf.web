import type { EditorStore } from "../../core/state/EditorStore";

/**
 * Short per-session handles for generated node IDs at the MCP boundary.
 *
 * Generated node IDs are `node_<uuid>` — 41 characters that tokenize at
 * roughly 2.4 characters per token and appear in every tree line, search
 * match, mutation echo, and follow-up request. The bridge presents them to
 * agents as `#1`, `#2`, … instead and resolves those handles back to real IDs
 * on the way in. The mapping never touches the document model or the
 * collaboration protocol.
 *
 * Design constraints:
 * - Handles start with `#`, which the authored `data-leaf-node-id` grammar
 *   (`[A-Za-z0-9][A-Za-z0-9._:-]*`) cannot produce, so a handle can never
 *   collide with a real node ID. Authored and test-counter IDs (`hero`,
 *   `node_1`) are already short and pass through unaliased in both directions.
 * - Handles are stable for the life of the document session, keyed by the
 *   document identity (`fileId:branchId`) when the caller knows it, so a
 *   collaboration reconnect or authoritative snapshot that replaces the
 *   EditorStore instance preserves every issued handle. Stores without a
 *   resolved document identity fall back to per-store state. After an app
 *   restart — or a switch to a different document — an old handle resolves to
 *   nothing and the agent gets an explicit re-discovery error; real IDs
 *   remain accepted inbound at any time. A handle must never silently resolve
 *   to a different node than the one it was issued for.
 */

// Alias only complete ID tokens. An authored ID may embed a generated-looking
// substring (`hero-node_<uuid>-copy`); rewriting its middle would return an ID
// inbound resolution cannot accept. A trailing sentence period that is not
// followed by more ID characters still counts as a boundary so error messages
// like "Node not found: node_<uuid>." stay aliased.
const NODE_UUID_PATTERN =
  /(?<![A-Za-z0-9._:-])node_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![A-Za-z0-9_:-])(?!\.[A-Za-z0-9._:-])/g;
const HANDLE_PATTERN = /^#\d+$/;

// Scoped inbound resolution for image-edit references: handles inside the
// documented `reference_nodes` query of a `leaf-gen://` URL (raw `#n` or the
// URL-encoded `%23n`) resolve to real IDs wherever the URL appears — html,
// backgroundImage, or any other string. Nothing outside that query segment of
// a leaf-gen URL is ever rewritten.
const LEAF_GEN_URL_PATTERN = /leaf-gen:[^\s"'<>()]+/g;
const REFERENCE_NODES_QUERY_PATTERN = /(reference_nodes=)([^&]*)/i;
const REFERENCE_HANDLE_TOKEN_PATTERN = /^(?:#|%23)\d+$/;

interface HandleState {
  byReal: Map<string, string>;
  byHandle: Map<string, string>;
  next: number;
}

const handleStatesByDocument = new Map<string, HandleState>();
const handleStatesByStore = new WeakMap<EditorStore, HandleState>();

/**
 * Amortized prune: past this many aliased IDs, drop mappings whose real node
 * no longer exists so heavy write_html churn does not grow the registry for
 * the life of the session. The counter never resets, so pruned numbers are
 * never reissued — a pruned stale handle fails with the documented
 * re-discovery error instead of resolving to another node.
 */
const HANDLE_PRUNE_THRESHOLD = 10_000;

function pruneDeadHandles(state: HandleState, store: EditorStore) {
  if (state.byReal.size < HANDLE_PRUNE_THRESHOLD) return;
  for (const [realId, handle] of state.byReal) {
    if (store.nodeMap.has(realId)) continue;
    state.byReal.delete(realId);
    state.byHandle.delete(handle);
  }
}

function stateFor(store: EditorStore, documentKey: string | null | undefined): HandleState {
  if (documentKey) {
    let state = handleStatesByDocument.get(documentKey);
    if (!state) {
      // Adopt any state the store accumulated before its document identity
      // resolved, so handles issued during that window stay valid.
      state = handleStatesByStore.get(store) ?? { byReal: new Map(), byHandle: new Map(), next: 1 };
      handleStatesByDocument.set(documentKey, state);
    }
    handleStatesByStore.set(store, state);
    return state;
  }
  let state = handleStatesByStore.get(store);
  if (!state) {
    state = { byReal: new Map(), byHandle: new Map(), next: 1 };
    handleStatesByStore.set(store, state);
  }
  return state;
}

/**
 * Strings that can never carry a generated node ID or a leaf-gen URL and are
 * often megabytes long: raster data URLs, and base64 image payloads under the
 * MCP image content key. Skipping them keeps screenshot responses from paying
 * a full linear scan per capture.
 */
function isOpaquePayload(key: string | undefined, value: string): boolean {
  if (value.startsWith("data:image/")) return true;
  return key === "data" && value.length > 4096;
}

function handleFor(state: HandleState, realId: string): string {
  const existing = state.byReal.get(realId);
  if (existing) return existing;
  const handle = `#${state.next++}`;
  state.byReal.set(realId, handle);
  state.byHandle.set(handle, realId);
  return handle;
}

function aliasString(state: HandleState, value: string): string {
  if (!value.includes("node_")) return value;
  return value.replace(NODE_UUID_PATTERN, (match) => handleFor(state, match));
}

/** Replace every generated node ID in an outbound result with its handle. */
export function aliasOutboundNodeIds(
  store: EditorStore,
  value: unknown,
  documentKey?: string | null,
): unknown {
  const state = stateFor(store, documentKey);
  pruneDeadHandles(state, store);
  const visit = (current: unknown, parentKey?: string): unknown => {
    if (typeof current === "string") {
      return isOpaquePayload(parentKey, current) ? current : aliasString(state, current);
    }
    if (Array.isArray(current)) return current.map((entry) => visit(entry, parentKey));
    if (current !== null && typeof current === "object") {
      const rewritten: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(current)) {
        rewritten[aliasString(state, key)] = visit(entry, key);
      }
      return rewritten;
    }
    return current;
  };
  return visit(value);
}

/** Parameter keys whose string values (or array entries) carry node IDs. */
const NODE_ID_PARAMETER_KEYS = new Set([
  "id",
  "nextTo",
  "nodeId",
  "nodeIds",
  "parentId",
  "rootId",
  "targetNodeId",
]);

/**
 * Resolve inbound `#n` handles back to real node IDs. Resolution is scoped to
 * the known node-ID parameter keys plus the `reference_nodes` query of
 * embedded `leaf-gen://` URLs, so a literal `#41` inside text content, HTML,
 * or a search pattern is never touched, and non-handle values — real IDs
 * included — pass through everywhere.
 */
export function resolveInboundNodeHandles(
  store: EditorStore,
  value: unknown,
  documentKey?: string | null,
): unknown {
  const state = stateFor(store, documentKey);
  const requireRealId = (handle: string): string => {
    const realId = state.byHandle.get(handle);
    if (!realId) {
      throw new Error(
        `Unknown node handle ${handle}. Handles are stable within one document session; ` +
          `re-discover the node with find_nodes or get_tree_summary.`,
      );
    }
    return realId;
  };
  const resolveHandle = (current: string): string => {
    if (!HANDLE_PATTERN.test(current)) return current;
    return requireRealId(current);
  };
  const resolveLeafGenReferences = (current: string, parentKey?: string): string => {
    if (isOpaquePayload(parentKey, current)) return current;
    if (!current.includes("leaf-gen:")) return current;
    return current.replace(LEAF_GEN_URL_PATTERN, (url) =>
      url.replace(REFERENCE_NODES_QUERY_PATTERN, (_match, key: string, ids: string) => {
        const resolved = ids.split(/%2C|,/i).map((token) => {
          if (!REFERENCE_HANDLE_TOKEN_PATTERN.test(token)) return token;
          return requireRealId(`#${token.replace(/^(?:#|%23)/, "")}`);
        });
        return key + resolved.join(",");
      }),
    );
  };
  const visit = (current: unknown, underNodeIdKey: boolean, parentKey?: string): unknown => {
    if (typeof current === "string") {
      return resolveLeafGenReferences(underNodeIdKey ? resolveHandle(current) : current, parentKey);
    }
    if (Array.isArray(current)) {
      return current.map((entry) => visit(entry, underNodeIdKey, parentKey));
    }
    if (current !== null && typeof current === "object") {
      const rewritten: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(current)) {
        rewritten[key] = visit(entry, NODE_ID_PARAMETER_KEYS.has(key), key);
      }
      return rewritten;
    }
    return current;
  };
  return visit(value, false);
}

/** Alias generated node IDs inside an error message before it reaches the agent. */
export function aliasNodeIdsInMessage(
  store: EditorStore,
  message: string,
  documentKey?: string | null,
): string {
  return aliasString(stateFor(store, documentKey), message);
}
