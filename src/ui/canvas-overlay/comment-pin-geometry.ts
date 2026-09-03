/**
 * Comment-anchor geometry: the one place a `LeafCommentAnchor` becomes a canvas
 * point and back.
 *
 * A node anchor stores a normalized `u`/`v` inside the node's own UNROTATED
 * bounds, so the pin keeps its spot through move, resize, and rotation — the
 * node's own AND any ancestor's. Both directions read the node's oriented box,
 * which already carries the composed ancestor placement and the summed
 * rotation, so this module never re-composes a chain of its own. Getting it
 * right here fixes it everywhere: pin render, placement, pin-drag re-anchoring,
 * and clustering leaves all compose this module.
 */
import type { LeafCommentAnchor } from "../../core/shared/collaboration";
import {
  anchorPointForRect,
  normalizedAnchorInRect,
  regionPinPoint,
} from "../../core/editor/comment-anchor-math";
import type { EditorStore } from "../../core/state/EditorStore";
import type { DesignNode } from "../../core/types";
import { getNodeOrientedBox } from "./live-node-geometry";

export type CanvasXY = { x: number; y: number };

/** A node is hidden when it or any ancestor has `visible: false`. */
function isNodeHidden(store: EditorStore, nodeId: string): boolean {
  let currentId: string | undefined = nodeId;
  while (currentId) {
    if (store.getNode(currentId)?.visible === false) return true;
    currentId = store.parentMap.get(currentId);
  }
  return false;
}

/**
 * The node a comment may anchor to at a screen point — shared by tool
 * placement and pin-drop re-anchoring so both agree on what counts. Unlike
 * selection hit-testing, LOCKED nodes qualify: a lock stops edits, and a
 * comment on a locked node is a legitimate (often the intended) conversation.
 * Hidden nodes never qualify; something behind them may.
 */
export function commentAnchorTargetAtPoint(
  store: EditorStore,
  clientX: number,
  clientY: number,
): DesignNode | null {
  return commentAnchorTargetInElements(store, document.elementsFromPoint(clientX, clientY));
}

/** `commentAnchorTargetAtPoint` over an already-resolved top-to-bottom hit list. */
export function commentAnchorTargetInElements(
  store: EditorStore,
  elements: readonly Element[],
): DesignNode | null {
  for (const element of elements) {
    const nodeId = element.getAttribute("data-node-id");
    const node =
      (nodeId ? store.getNode(nodeId) : undefined) ??
      (element instanceof HTMLElement ? store.domIndex.findNodeFromElement(element) : null);
    if (node && !isNodeHidden(store, node.id)) return node;
  }
  return null;
}

/** Where a node anchor sits on the canvas right now. */
function nodeAnchorCanvasPoint(
  store: EditorStore,
  node: DesignNode,
  u: number,
  v: number,
  viewportEl: Element | null,
): CanvasXY {
  const { rect, rotation } = getNodeOrientedBox(node, store, viewportEl);
  return anchorPointForRect(rect, rotation, u, v);
}

/** The anchor a comment-tool click at `canvasPoint` should store. */
export function commentAnchorForCanvasPoint(
  store: EditorStore,
  node: DesignNode | null,
  canvasPoint: CanvasXY,
  viewportEl: Element | null,
): LeafCommentAnchor {
  if (!node) return { type: "point", x: canvasPoint.x, y: canvasPoint.y };
  const { rect, rotation } = getNodeOrientedBox(node, store, viewportEl);
  const { u, v } = normalizedAnchorInRect(rect, rotation, canvasPoint);
  return { type: "node", nodeId: node.id, u, v };
}

/**
 * Where an anchor's pin sits on the canvas right now, or null when it has no
 * spatial position — a page anchor, or a node anchor whose node is gone (the
 * anchor lifecycle converts those to points; until it does, render nothing
 * rather than something wrong).
 */
export function resolveCommentAnchorCanvasPoint(
  store: EditorStore,
  anchor: LeafCommentAnchor,
  viewportEl: Element | null,
): CanvasXY | null {
  switch (anchor.type) {
    case "point":
      return { x: anchor.x, y: anchor.y };
    case "region":
      return regionPinPoint(anchor, anchor.pinX, anchor.pinY);
    case "page":
      return null;
    case "node": {
      const node = store.getNode(anchor.nodeId);
      if (!node) return null;
      const point = nodeAnchorCanvasPoint(store, node, anchor.u, anchor.v, viewportEl);
      // `getNodeCanvasRect` already folds in a LOCAL drag's offset but reports
      // committed space for a REMOTE peer's in-flight drag; adding the preview
      // offset keeps the pin on the element the peer is visibly moving.
      const remoteOffset = store.remoteDragPreviews.get(node.id);
      return {
        x: point.x + (remoteOffset?.x ?? 0),
        y: point.y + (remoteOffset?.y ?? 0),
      };
    }
  }
}
