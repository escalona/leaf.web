import {
  flexContainerWraps,
  getFlexFlowChildren,
  resolveFlexInsertionLine,
} from "../../core/editor/interaction/flex-insertion";
import { getRotatedBounds } from "../../core/editor/interaction/math";
import { nodeChainUsesLiveGeometry } from "../../core/editor/model-geometry";
import type { CollaborationPresencePeer } from "../../core/state/collaboration-presence";
import type { EditorStore } from "../../core/state/EditorStore";
import type { CompassDirection, DesignNode, Rect } from "../../core/types";
import { getNodeCanvasRect, getNodeOrientedBox } from "./live-node-geometry";

const HANDLE_SIZE = 8;
const ROTATE_HANDLE_SIZE = 14;
const ROTATE_HANDLE_OFFSET = 10;
export const DETAILED_SELECTION_LIMIT = 500;

/** Sentinel used by Viewport to transform every member of a multi-selection. */
export const SELECTION_TRANSFORM_HANDLE_ID = "__selection__";

export type CanvasBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

function parsePixelSize(value: string | number | undefined, fallback = 0) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function parseOptionalPixelSize(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const result = parsePixelSize(value, Number.NaN);
  return Number.isFinite(result) ? result : null;
}

function getPaddingInset(
  styles: Record<string, unknown>,
  side: "top" | "right" | "bottom" | "left",
) {
  const key =
    side === "top"
      ? "paddingTop"
      : side === "right"
        ? "paddingRight"
        : side === "bottom"
          ? "paddingBottom"
          : "paddingLeft";
  const specific = parseOptionalPixelSize(styles[key]);
  if (specific !== null) return specific;
  return parseOptionalPixelSize(styles.padding) ?? 0;
}

export function getParentOutlineRects(
  selectedNodes: DesignNode[],
  selectedIds: ReadonlySet<string>,
  store: EditorStore,
  viewportEl: Element | null,
) {
  const seen = new Set<string>();
  const parents: DesignNode[] = [];
  for (const selectedNode of selectedNodes) {
    const parent = store.getParent(selectedNode.id);
    if (!parent || parent.type !== "frame" || selectedIds.has(parent.id) || seen.has(parent.id)) {
      continue;
    }
    seen.add(parent.id);
    parents.push(parent);
  }
  return parents.map((node) => ({
    node,
    ...getNodeOrientedBox(node, store, viewportEl),
  }));
}

function clipRectToBounds(rect: Rect, bounds: CanvasBounds): Rect | null {
  const left = Math.max(rect.x, bounds.left);
  const top = Math.max(rect.y, bounds.top);
  const right = Math.min(rect.x + rect.width, bounds.right);
  const bottom = Math.min(rect.y + rect.height, bounds.bottom);
  if (right < left || bottom < top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function unionRects(left: Rect | null, right: Rect): Rect {
  if (!left) return right;
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const maxX = Math.max(left.x + left.width, right.x + right.width);
  const maxY = Math.max(left.y + left.height, right.y + right.height);
  return { x, y, width: maxX - x, height: maxY - y };
}

/**
 * Screen-space slack around the viewport before a remote cursor is culled. The
 * glyph and name pill extend right/down from the hotspot, so a hotspot just
 * outside an edge can still poke into view; the margin is generous because the
 * target is far-away cursors, whose DOM and frame work culling avoids.
 */
const REMOTE_CURSOR_CULL_MARGIN_SCREEN_PX = 200;

/**
 * Whether a remote cursor is close enough to the viewport to render. Culled
 * cursors unmount and re-enter with a
 * snap, so a far-off cursor never glides across the local screen.
 */
export function isRemoteCursorVisible(
  cursor: { x: number; y: number } | null,
  bounds: CanvasBounds,
  zoom: number,
): boolean {
  if (!cursor) return false;
  const margin = REMOTE_CURSOR_CULL_MARGIN_SCREEN_PX / zoom;
  return (
    cursor.x >= bounds.left - margin &&
    cursor.x <= bounds.right + margin &&
    cursor.y >= bounds.top - margin &&
    cursor.y <= bounds.bottom + margin
  );
}

export function remotePresenceColor(peer: CollaborationPresencePeer) {
  if (peer.color && /^#[0-9a-f]{6}$/i.test(peer.color)) return peer.color;
  const palette = ["#7c3aed", "#db2777", "#ea580c", "#0891b2", "#16a34a", "#2563eb"];
  let hash = 0;
  for (const character of peer.actorId) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return palette[Math.abs(hash) % palette.length]!;
}

export function getLargeSelectionOutline(
  selectedNodes: readonly DesignNode[],
  store: EditorStore,
  viewportEl: Element | null,
  visibleCanvasBounds: CanvasBounds,
  limit = DETAILED_SELECTION_LIMIT,
) {
  const viewportRect = viewportEl?.getBoundingClientRect() ?? null;
  const boundedLimit = Math.max(1, limit);
  let rect: Rect | null = null;
  let renderedNodeCount = 0;
  let domMeasurementCount = 0;
  let usesLiveGeometry = false;
  const sampledNodeCount = Math.min(selectedNodes.length, boundedLimit);

  for (let sampleIndex = 0; sampleIndex < sampledNodeCount; sampleIndex += 1) {
    const nodeIndex =
      sampledNodeCount === 1
        ? 0
        : Math.round((sampleIndex * (selectedNodes.length - 1)) / (sampledNodeCount - 1));
    const node = selectedNodes[nodeIndex]!;
    if (store.isInteractionActiveForNode(node.id)) continue;

    let nodeRect: Rect | null = null;
    const dragOffset = store.dragCanvasOffset.get(node.id);
    const needsDomGeometry = !dragOffset && nodeChainUsesLiveGeometry(node, store);
    if (needsDomGeometry) {
      usesLiveGeometry = true;
      const element = store.domIndex.getElement(node);
      if (!element || !viewportRect) continue;
      const domRect = element.getBoundingClientRect();
      domMeasurementCount += 1;
      if (
        domRect.right < viewportRect.left ||
        domRect.left > viewportRect.right ||
        domRect.bottom < viewportRect.top ||
        domRect.top > viewportRect.bottom
      ) {
        continue;
      }
      nodeRect = {
        x: (domRect.left - viewportRect.left - store.panX) / store.zoom,
        y: (domRect.top - viewportRect.top - store.panY) / store.zoom,
        width: domRect.width / store.zoom,
        height: domRect.height / store.zoom,
      };
    } else {
      nodeRect = getNodeCanvasRect(node, store, viewportEl, viewportRect ?? undefined);
    }

    const visibleRect = clipRectToBounds(nodeRect, visibleCanvasBounds);
    if (!visibleRect) continue;
    rect = unionRects(rect, visibleRect);
    renderedNodeCount += 1;
    if (renderedNodeCount >= boundedLimit) break;
  }

  return {
    rect,
    sampledNodeCount,
    renderedNodeCount,
    domMeasurementCount,
    usesLiveGeometry,
    needsFallbackIndicator: rect === null && selectedNodes.length > 0,
  };
}

export function getHandlePositions(rect: Rect, zoom: number) {
  const size = HANDLE_SIZE / zoom;
  const half = size / 2;
  const { x, y, width, height } = rect;
  const middleX = x + width / 2;
  const middleY = y + height / 2;
  return [
    { dir: "nw" as CompassDirection, cx: x, cy: y },
    { dir: "n" as CompassDirection, cx: middleX, cy: y },
    { dir: "ne" as CompassDirection, cx: x + width, cy: y },
    { dir: "e" as CompassDirection, cx: x + width, cy: middleY },
    { dir: "se" as CompassDirection, cx: x + width, cy: y + height },
    { dir: "s" as CompassDirection, cx: middleX, cy: y + height },
    { dir: "sw" as CompassDirection, cx: x, cy: y + height },
    { dir: "w" as CompassDirection, cx: x, cy: middleY },
  ].map((handle) => ({
    ...handle,
    rect: {
      x: handle.cx - half,
      y: handle.cy - half,
      width: size,
      height: size,
    },
  }));
}

export function getRotateHandlePositions(rect: Rect, zoom: number) {
  const size = ROTATE_HANDLE_SIZE / zoom;
  const offset = ROTATE_HANDLE_OFFSET / zoom;
  const { x, y, width, height } = rect;
  return [
    { dir: "nw" as CompassDirection, cx: x - offset, cy: y - offset },
    { dir: "ne" as CompassDirection, cx: x + width + offset, cy: y - offset },
    { dir: "se" as CompassDirection, cx: x + width + offset, cy: y + height + offset },
    { dir: "sw" as CompassDirection, cx: x - offset, cy: y + height + offset },
  ].map((handle) => ({
    ...handle,
    rect: {
      x: handle.cx - size / 2,
      y: handle.cy - size / 2,
      width: size,
      height: size,
    },
  }));
}

export function shouldRenderResizeHandles(store: Pick<EditorStore, "dragCanvasOffset">) {
  return store.dragCanvasOffset.size === 0;
}

export type SelectionTransformBox = {
  handleNodeId: string;
  rect: Rect;
  rotation: number;
};

export function getSelectionTransformBox(
  entries: readonly { node: DesignNode; rect: Rect; rotation: number }[],
): SelectionTransformBox | null {
  if (entries.length === 0) return null;
  if (entries.length === 1) {
    const only = entries[0]!;
    return { handleNodeId: only.node.id, rect: only.rect, rotation: only.rotation };
  }
  let union: Rect | null = null;
  for (const entry of entries) {
    union = unionRects(union, getRotatedBounds(entry.rect, entry.rotation));
  }
  return union ? { handleNodeId: SELECTION_TRANSFORM_HANDLE_ID, rect: union, rotation: 0 } : null;
}

// Overlay chrome and hit-testing must agree on a rotated node's real extent, so
// the rotated-bounds math lives with the rest of the interaction geometry.
export { getRotatedBounds };

export function getDragInsertionIndicator(
  store: EditorStore,
  viewportEl: Element | null,
  zoom: number,
) {
  const preview = store.dragInsertionPreview;
  if (!preview) return null;
  const parent = store.getNode(preview.parentId);
  if (!parent) return null;

  const parentRect = getNodeCanvasRect(parent, store, viewportEl);
  const siblingRects = getFlexFlowChildren(parent.children)
    .filter((child) => child.id !== preview.nodeId && !store.dragDetachedIds.has(child.id))
    .map((child) => getNodeCanvasRect(child, store, viewportEl));
  const insertionLine = resolveFlexInsertionLine(
    siblingRects,
    preview.axis,
    preview.index,
    flexContainerWraps(parent),
  );
  const contentBounds = {
    left: parentRect.x + getPaddingInset(parent.styles, "left"),
    right: parentRect.x + parentRect.width - getPaddingInset(parent.styles, "right"),
    top: parentRect.y + getPaddingInset(parent.styles, "top"),
    bottom: parentRect.y + parentRect.height - getPaddingInset(parent.styles, "bottom"),
  };
  const gap = parsePixelSize(parent.styles.gap, 0);
  const axis = preview.axis;
  let coordinate: number;
  if (insertionLine.indexWithinLine <= 0) {
    const firstRect = insertionLine.rects[0];
    coordinate = firstRect
      ? axis === "column"
        ? firstRect.y - gap / 2
        : firstRect.x - gap / 2
      : axis === "column"
        ? parentRect.y + parentRect.height / 2
        : parentRect.x + parentRect.width / 2;
  } else if (insertionLine.indexWithinLine >= insertionLine.rects.length) {
    const lastRect = insertionLine.rects.at(-1);
    coordinate = lastRect
      ? axis === "column"
        ? lastRect.y + lastRect.height + gap / 2
        : lastRect.x + lastRect.width + gap / 2
      : axis === "column"
        ? parentRect.y + parentRect.height / 2
        : parentRect.x + parentRect.width / 2;
  } else {
    const previousRect = insertionLine.rects[insertionLine.indexWithinLine - 1]!;
    const nextRect = insertionLine.rects[insertionLine.indexWithinLine]!;
    coordinate =
      axis === "column"
        ? (previousRect.y + previousRect.height + nextRect.y) / 2
        : (previousRect.x + previousRect.width + nextRect.x) / 2;
  }

  const lineThickness = 3 / zoom;
  if (axis === "column") {
    return {
      axis,
      line: {
        x: contentBounds.left,
        y: coordinate - lineThickness / 2,
        width: Math.max(0, contentBounds.right - contentBounds.left),
        height: lineThickness,
      },
    };
  }
  return {
    axis,
    line: {
      x: coordinate - lineThickness / 2,
      y: contentBounds.top,
      width: lineThickness,
      height: Math.max(0, contentBounds.bottom - contentBounds.top),
    },
  };
}
