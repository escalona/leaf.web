import { getRotatedBounds, type OrientedBox } from "../../core/editor/interaction/math";
import {
  getEffectiveModelDimension,
  hasUnsafeModelGeometry,
  nodeChainUsesLiveGeometry,
} from "../../core/editor/model-geometry";
import {
  REMOTE_DRAG_APPLIED_X_VAR,
  REMOTE_DRAG_APPLIED_Y_VAR,
} from "../node-renderer/node-renderer-style";
import type { EditorStore } from "../../core/state/EditorStore";
import type { DesignNode, Rect } from "../../core/types";

/**
 * Sum the remote drag preview translates currently applied in the DOM between
 * an element and the viewport. Reading the applied inline custom properties —
 * rather than `store.remoteDragPreviews` — stays correct during the frame
 * where the map has changed but React has not committed the new transform yet.
 */
function readAppliedRemoteDragOffset(el: Element, viewportEl: Element) {
  let x = 0;
  let y = 0;
  for (let current: Element | null = el; current && current !== viewportEl; ) {
    const style = (current as HTMLElement).style;
    const appliedX = style?.getPropertyValue(REMOTE_DRAG_APPLIED_X_VAR);
    if (appliedX) {
      x += Number.parseFloat(appliedX) || 0;
      y += Number.parseFloat(style.getPropertyValue(REMOTE_DRAG_APPLIED_Y_VAR)) || 0;
    }
    current = current.parentElement;
  }
  return { x, y };
}

function getModelRect(node: DesignNode, x: number, y: number): Rect {
  return {
    x,
    y,
    width: getEffectiveModelDimension(node.width, node.styles.width),
    height: getEffectiveModelDimension(node.height, node.styles.height),
  };
}

/**
 * The canvas-space rect for a node and the rotation the renderer turns it by.
 *
 * Prefers model geometry only when the node's full placement chain is explicit.
 * Falls back to DOM measurement when the node or any ancestor depends on CSS
 * flow, positioning, or live sizing. The rotation rides along rather than being
 * looked up separately, because the model path composes it during the same
 * ancestor walk that produces the position — so an unrotated document pays no
 * walk it was not already paying.
 */
function getNodeCanvasGeometry(
  node: DesignNode,
  store: EditorStore,
  viewportEl: Element | null,
  viewportRect?: DOMRectReadOnly,
): OrientedBox {
  // During drag, DOM measurement lags one frame behind. Use the offset captured
  // at drag start to translate node properties into canvas-space coordinates.
  const offset = store.dragCanvasOffset.get(node.id);
  if (offset) {
    return {
      rect: {
        x: node.x + offset.x,
        y: node.y + offset.y,
        width: node.width + offset.width,
        height: node.height + offset.height,
      },
      rotation: store.getWorldRotation(node.id),
    };
  }

  const needsLiveGeometry = nodeChainUsesLiveGeometry(node, store);
  // Layout-dependent geometry requires a live DOM measurement. Avoid calling
  // getCanvasTransform first because that would measure the same element and
  // viewport a second time below.
  const transform = needsLiveGeometry ? undefined : store.getCanvasTransform(node.id);
  if (transform && !hasUnsafeModelGeometry(node)) {
    return { rect: getModelRect(node, transform.x, transform.y), rotation: transform.rotation };
  }

  const el = store.domIndex.getElement(node);
  if (el && viewportEl) {
    const domRect = el.getBoundingClientRect();
    const vpRect = viewportRect ?? viewportEl.getBoundingClientRect();
    // DOM measurements report the previewed position of nodes a remote peer is
    // dragging; subtract the applied translates so every path through this
    // function agrees on committed canvas space.
    const applied = readAppliedRemoteDragOffset(el, viewportEl);
    return {
      rect: {
        x: (domRect.left - vpRect.left - store.panX) / store.zoom - applied.x,
        y: (domRect.top - vpRect.top - store.panY) / store.zoom - applied.y,
        width: domRect.width / store.zoom,
        height: domRect.height / store.zoom,
      },
      rotation: store.getWorldRotation(node.id),
    };
  }

  const fallback = transform ?? store.getCanvasTransform(node.id);
  if (fallback) {
    return { rect: getModelRect(node, fallback.x, fallback.y), rotation: fallback.rotation };
  }

  return { rect: getModelRect(node, node.x, node.y), rotation: node.rotation ?? 0 };
}

export function getNodeCanvasRect(
  node: DesignNode,
  store: EditorStore,
  viewportEl: Element | null,
  viewportRect?: DOMRectReadOnly,
): Rect {
  return getNodeCanvasGeometry(node, store, viewportEl, viewportRect).rect;
}

/**
 * The node's real, oriented canvas geometry: its own un-rotated box plus the
 * rotation the renderer turns it by — its own AND every ancestor's, because
 * each ancestor's `rotate()` turns the whole subtree beneath it. Selection
 * chrome and hit-testing share this boundary so a rotated node is picked over
 * the area it visibly covers, wherever it sits in the tree.
 *
 * Both geometry sources land on the same answer without composing anything
 * twice. The model path reports the ancestor chain already composed, and the
 * DOM path reports the axis-aligned box around the finished turn — whose CENTER
 * is the true one either way, since rotation about a rect's center preserves
 * it. So the node's own box is recovered from that shared center and its layout
 * size.
 */
export function getNodeOrientedBox(
  node: DesignNode,
  store: EditorStore,
  viewportEl: Element | null,
  viewportRect?: DOMRectReadOnly,
): OrientedBox {
  const { rect, rotation } = getNodeCanvasGeometry(node, store, viewportEl, viewportRect);
  if (!rotation) return { rect, rotation };

  const element = store.domIndex.getElement(node);
  const layoutWidth = element?.offsetWidth;
  const layoutHeight = element?.offsetHeight;
  if (!layoutWidth || !layoutHeight) return { rect, rotation };

  return {
    rect: {
      x: rect.x + rect.width / 2 - layoutWidth / 2,
      y: rect.y + rect.height / 2 - layoutHeight / 2,
      width: layoutWidth,
      height: layoutHeight,
    },
    rotation,
  };
}

/**
 * The axis-aligned canvas extent the node really covers: its oriented box
 * widened by the total rotation turning it, its own and every ancestor's.
 *
 * Fitting, wrapping, snapping, and the selection-background hit test all frame
 * the area the user sees, so they read this rather than pairing the node's own
 * box with `node.rotation` — which under-covers exactly when the turn is
 * inherited and the node's own angle is zero.
 */
export function getNodeCanvasExtent(
  node: DesignNode,
  store: EditorStore,
  viewportEl: Element | null,
  viewportRect?: DOMRectReadOnly,
): Rect {
  const { rect, rotation } = getNodeOrientedBox(node, store, viewportEl, viewportRect);
  return getRotatedBounds(rect, rotation);
}

/** The node's own, un-rotated box in canvas space. */
export function getNodeLocalCanvasRect(
  node: DesignNode,
  store: EditorStore,
  viewportEl: Element | null,
  viewportRect?: DOMRectReadOnly,
): Rect {
  return getNodeOrientedBox(node, store, viewportEl, viewportRect).rect;
}
