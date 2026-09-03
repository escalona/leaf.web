/**
 * What happens to a comment when the thing it points at goes away.
 *
 * When a node with anchored threads is deleted, each thread converts to a
 * `point` anchor at the exact spot its pin was sitting — the conversation
 * outlives its subject. The conversion runs wherever the delete is applied:
 * interactively on the originating client, or via the replica hook for redo,
 * remote, and resync deletes. Concurrent conversions converge — the point is
 * computed from model geometry, so every session writes the same record.
 *
 * If the deleted node comes back (undo), the thread re-attaches to it — unless
 * the pin was deliberately moved in the meantime, in which case the manual
 * placement wins. No dirty flag is needed: a thread still sitting at exactly
 * the point the conversion left it has, by identity, not been touched.
 *
 * Conversion state is session-local and keyed off the store instance; it never
 * syncs and dies with the session, which is exactly the scope "this client did
 * the delete" has.
 *
 * The session's pending placement draft gets the same treatment: a draft
 * anchored to a node deleted mid-compose becomes a point draft at the spot its
 * pin was sitting, so posting still produces a pin. Nothing is remembered for
 * it — a draft is transient, and re-attaching one is not worth the state.
 */
import type { LeafCommentAnchor, LeafCommentThreadRecord } from "../shared/collaboration";
import type { EditorStore } from "../state/EditorStore";
import { anchorPointForRect } from "./comment-anchor-math";

type ConvertedAnchor = {
  /** The thread being converted, or null for the session's pending draft. */
  threadId: string | null;
  nodeAnchor: Extract<LeafCommentAnchor, { type: "node" }>;
  point: { x: number; y: number };
};

/** Whether a node anchor points into the subtrees being deleted, and where its pin sits. */
function convertedPoint(
  store: EditorStore,
  deletedIds: ReadonlySet<string>,
  anchor: LeafCommentAnchor,
): ConvertedAnchor["point"] | null {
  if (anchor.type !== "node" || !deletedIds.has(anchor.nodeId)) return null;
  const node = store.getNode(anchor.nodeId);
  const transform = node ? store.getCanvasTransform(node.id) : null;
  if (!node || !transform) return null;
  return anchorPointForRect(
    { x: transform.x, y: transform.y, width: node.width, height: node.height },
    transform.rotation,
    anchor.u,
    anchor.v,
  );
}

/** Applies a pending-draft conversion if the draft still points at the gone node. */
function convertPendingDraft(store: EditorStore, conversion: ConvertedAnchor): void {
  const draft = store.pendingCommentDraft;
  if (
    !draft ||
    draft.anchor.type !== "node" ||
    draft.anchor.nodeId !== conversion.nodeAnchor.nodeId ||
    store.getNode(draft.anchor.nodeId)
  ) {
    return;
  }
  store.setPendingCommentDraft({
    ...draft,
    anchor: { type: "point", x: conversion.point.x, y: conversion.point.y },
    canvasPoint: { x: conversion.point.x, y: conversion.point.y },
  });
}

const CONVERTED_BY_STORE = new WeakMap<EditorStore, Map<string, ConvertedAnchor[]>>();

function convertedByNode(store: EditorStore): Map<string, ConvertedAnchor[]> {
  let map = CONVERTED_BY_STORE.get(store);
  if (!map) {
    map = new Map();
    CONVERTED_BY_STORE.set(store, map);
  }
  return map;
}

/** The node ids of `nodeIds` plus all their descendants. */
function collectSubtreeIds(store: EditorStore, nodeIds: readonly string[]): Set<string> {
  const ids = new Set<string>();
  const visit = (id: string) => {
    if (ids.has(id)) return;
    ids.add(id);
    for (const child of store.getNode(id)?.children ?? []) visit(child.id);
  };
  for (const id of nodeIds) visit(id);
  return ids;
}

/**
 * Threads anchored to any node in the subtrees about to be deleted, paired
 * with the canvas point their pin currently resolves to. Model geometry is
 * used deliberately: this runs on the delete path where the DOM may already
 * be unmountable, and a model-space point is exactly what the stored `point`
 * anchor will mean afterwards. The canvas transform carries the node's own
 * rotation AND every ancestor's, matching the pin's rendered position, so a
 * delete never makes the pin jump.
 */
export function collectCommentAnchorConversions(
  store: EditorStore,
  nodeIds: readonly string[],
): ConvertedAnchor[] {
  const draft = store.pendingCommentDraft;
  if (store.commentRecords.size === 0 && draft?.anchor.type !== "node") return [];
  const deletedIds = collectSubtreeIds(store, nodeIds);
  const conversions: ConvertedAnchor[] = [];
  for (const record of store.commentRecords.values()) {
    if (record.kind !== "thread" || record.anchor.type !== "node") continue;
    const point = convertedPoint(store, deletedIds, record.anchor);
    if (point) conversions.push({ threadId: record.id, nodeAnchor: { ...record.anchor }, point });
  }
  if (draft?.anchor.type === "node") {
    const point = convertedPoint(store, deletedIds, draft.anchor);
    if (point) conversions.push({ threadId: null, nodeAnchor: { ...draft.anchor }, point });
  }
  return conversions;
}

/** Writes the point anchors for a completed delete and remembers them. */
export function applyCommentAnchorConversions(
  store: EditorStore,
  conversions: readonly ConvertedAnchor[],
): void {
  if (conversions.length === 0) return;
  const puts: LeafCommentThreadRecord[] = [];
  for (const conversion of conversions) {
    if (conversion.threadId === null) {
      convertPendingDraft(store, conversion);
      continue;
    }
    const thread = store.commentRecords.get(conversion.threadId);
    if (thread?.kind !== "thread") continue;
    puts.push({
      ...thread,
      anchor: { type: "point", x: conversion.point.x, y: conversion.point.y },
    });
    const remembered = convertedByNode(store).get(conversion.nodeAnchor.nodeId) ?? [];
    convertedByNode(store).set(conversion.nodeAnchor.nodeId, [...remembered, conversion]);
  }
  if (puts.length) store.runtime.updateCommentRecords(puts);
}

/**
 * Called (deferred) when node records reappear in the store — an undone
 * delete, locally or from the room. Re-attaches only threads still sitting at
 * exactly the point the conversion left them.
 */
function reattachCommentAnchorsForRestoredNodes(
  store: EditorStore,
  nodeIds: readonly string[],
): void {
  const map = CONVERTED_BY_STORE.get(store);
  if (!map || map.size === 0) return;
  // History preview recreates nodes without reopening the document for edits;
  // a durable write here would throw, and consuming the one-shot state would
  // stop a later real undo from ever re-attaching. Leave both untouched.
  if (store.isHistoryPreviewing) return;
  const puts: LeafCommentThreadRecord[] = [];
  for (const nodeId of nodeIds) {
    const converted = map.get(nodeId);
    if (!converted) continue;
    // A pending-transaction rollback/replay cycle (an acknowledgement or a
    // rebase) transiently re-creates a deleted node, firing a "restored"
    // whose deferred call lands after the node is gone again. That is not a
    // restoration — consuming the one-shot memory for it would break the
    // real undo's re-attach later. Only a restoration that still holds when
    // this deferred call runs consumes the memory.
    if (!store.getNode(nodeId)) continue;
    // One shot per restoration: a rejected re-attach is not retried.
    map.delete(nodeId);
    for (const conversion of converted) {
      if (conversion.threadId === null) continue;
      const thread = store.commentRecords.get(conversion.threadId);
      if (thread?.kind !== "thread") continue;
      const anchor = thread.anchor;
      if (
        anchor.type !== "point" ||
        anchor.x !== conversion.point.x ||
        anchor.y !== conversion.point.y
      ) {
        continue;
      }
      puts.push({ ...thread, anchor: { ...conversion.nodeAnchor } });
    }
  }
  if (puts.length) store.runtime.updateCommentRecords(puts);
}

/**
 * Replica hook: node records were just (re)created by a canonical patch. The
 * write is deferred to a microtask because this fires inside commit
 * application, where starting a new durable transaction would re-enter the
 * controller mid-apply.
 */
export function noteCommentAnchorNodesRestored(
  store: EditorStore,
  nodeIds: readonly string[],
): void {
  const map = CONVERTED_BY_STORE.get(store);
  if (!map || map.size === 0) return;
  const restored = nodeIds.filter((id) => map.has(id));
  if (restored.length === 0) return;
  queueMicrotask(() => reattachCommentAnchorsForRestoredNodes(store, restored));
}

/**
 * Replica hook: node records are about to be removed by a canonical patch —
 * a redo of a delete, a remote delete, or a resync. The interactive delete
 * path converts anchors itself; this covers deletes that never pass through
 * it. Geometry is collected synchronously (the nodes are still in the store),
 * and the durable write is deferred like the restore hook. At fire time each
 * conversion re-checks that its thread is still anchored to a now-missing
 * node, so a conversion already written by another session (or skipped by a
 * snapshot rollback that recreated the node) becomes a no-op, and history
 * preview — where the lane must not be edited — skips the write entirely
 * without consuming anything.
 */
export function noteCommentAnchorNodesDeleted(
  store: EditorStore,
  nodeIds: readonly string[],
): void {
  const conversions = collectCommentAnchorConversions(store, nodeIds);
  if (conversions.length === 0) return;
  queueMicrotask(() => {
    if (store.isHistoryPreviewing) return;
    applyCommentAnchorConversions(
      store,
      conversions.filter((conversion) => {
        // The draft conversion re-checks its own preconditions when applied.
        if (conversion.threadId === null) return true;
        const thread = store.commentRecords.get(conversion.threadId);
        return (
          thread?.kind === "thread" &&
          thread.anchor.type === "node" &&
          thread.anchor.nodeId === conversion.nodeAnchor.nodeId &&
          !store.getNode(conversion.nodeAnchor.nodeId)
        );
      }),
    );
  });
}
