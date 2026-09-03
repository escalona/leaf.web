import { runInAction } from "mobx";
import { nodeClipsChildrenPaint } from "../../core/editor/node-overflow";
import type { CollaborationPresencePeer } from "../../core/state/collaboration-presence";
import type { EditorStore } from "../../core/state/EditorStore";
import type { DesignNode, Rect } from "../../core/types";
import { getNodeCanvasRect } from "./live-node-geometry";

const MAX_REMOTE_DRAG_PREVIEW_PEERS = 50;
// Bounds the per-frame DOM measurement below, matching the overlay's
// MAX_REMOTE_SELECTION_RECTS budget; deltas past the cap keep the ghost.
const MAX_REMOTE_DRAG_PREVIEW_DELTAS = 32;

/**
 * Project remote peers' in-flight drags onto `store.remoteDragPreviews` so the
 * real elements move live instead of rendering an overlay ghost.
 *
 * A drag preview stays live only while the previewed rect remains inside the
 * node's nearest paint-clipping ancestor: the peer's element is still attached
 * to its committed parent on this replica, so a preview that leaves the frame
 * would be clipped away. Those drags keep the overlay outline instead, which
 * `CanvasOverlay` renders for every transform delta not in the live map.
 */
export function syncRemoteDragPreviews(
  store: EditorStore,
  peers: readonly CollaborationPresencePeer[],
  viewportEl: HTMLElement | null,
) {
  const next = new Map<string, { x: number; y: number }>();
  // This runs in a pre-paint layout effect where every getBoundingClientRect
  // is a forced layout: measure the viewport once and reuse clip-ancestor
  // rects across the deltas that share a clipping frame.
  const viewportRect = viewportEl?.getBoundingClientRect();
  const clipRectCache = new Map<string, Rect>();
  for (const peer of peers.slice(0, MAX_REMOTE_DRAG_PREVIEW_PEERS)) {
    const transform = peer.state.transform;
    if (!transform || transform.kind !== "drag") continue;
    for (const delta of transform.deltas.slice(0, MAX_REMOTE_DRAG_PREVIEW_DELTAS)) {
      const node = store.getNode(delta.nodeId);
      if (!node) continue;
      // A local gesture on the same node owns the element; presence loses.
      if (store.dragCanvasOffset.has(delta.nodeId)) continue;
      if (!ancestorSpaceIsCanvasAligned(store, node)) continue;
      const offset = { x: delta.x ?? 0, y: delta.y ?? 0 };
      if (
        isPreviewInsideClippingAncestor(
          store,
          node,
          offset,
          viewportEl,
          viewportRect,
          clipRectCache,
        )
      ) {
        next.set(delta.nodeId, offset);
      }
    }
  }

  runInAction(() => {
    for (const nodeId of [...store.remoteDragPreviews.keys()]) {
      if (!next.has(nodeId)) store.remoteDragPreviews.delete(nodeId);
    }
    for (const [nodeId, offset] of next) {
      const previous = store.remoteDragPreviews.get(nodeId);
      if (!previous || previous.x !== offset.x || previous.y !== offset.y) {
        store.remoteDragPreviews.set(nodeId, offset);
      }
    }
  });
}

export function clearRemoteDragPreviews(store: EditorStore) {
  if (store.remoteDragPreviews.size === 0) return;
  runInAction(() => store.remoteDragPreviews.clear());
}

/**
 * Presence deltas are canvas-space, but the preview translate composes inside
 * the node's parent-local space; the two agree only while every ancestor maps
 * local axes onto canvas axes 1:1. A rotated or CSS-transformed ancestor bends
 * the translate, so those drags keep the (canvas-space, correct) overlay ghost.
 */
function ancestorSpaceIsCanvasAligned(store: EditorStore, node: DesignNode) {
  let current = store.getParent(node.id);
  while (current) {
    if ((current.rotation ?? 0) !== 0 || current.styles.transform !== undefined) return false;
    current = store.getParent(current.id);
  }
  return true;
}

function isPreviewInsideClippingAncestor(
  store: EditorStore,
  node: DesignNode,
  offset: { x: number; y: number },
  viewportEl: HTMLElement | null,
  viewportRect: DOMRectReadOnly | undefined,
  clipRectCache: Map<string, Rect>,
) {
  let clipAncestor = store.getParent(node.id);
  while (clipAncestor && !nodeClipsChildrenPaint(clipAncestor)) {
    clipAncestor = store.getParent(clipAncestor.id);
  }
  if (!clipAncestor) return true;

  // getNodeCanvasRect yields committed canvas space on every path (its DOM
  // branch subtracts applied preview translates), so both rects are directly
  // comparable and re-adding the delta previews the move.
  const baseRect = getNodeCanvasRect(node, store, viewportEl, viewportRect);
  let clipRect = clipRectCache.get(clipAncestor.id);
  if (!clipRect) {
    clipRect = getNodeCanvasRect(clipAncestor, store, viewportEl, viewportRect);
    clipRectCache.set(clipAncestor.id, clipRect);
  }
  return (
    baseRect.x + offset.x >= clipRect.x &&
    baseRect.y + offset.y >= clipRect.y &&
    baseRect.x + offset.x + baseRect.width <= clipRect.x + clipRect.width &&
    baseRect.y + offset.y + baseRect.height <= clipRect.y + clipRect.height
  );
}
