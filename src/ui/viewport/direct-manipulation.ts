import { observable, runInAction } from "mobx";
import {
  computeAlignDeltas,
  computeDistributeDeltas,
  type AlignEdge,
  type DistributeAxis,
} from "../../core/editor/interaction/math";
import type { EditorStore } from "../../core/state/EditorStore";
import type { DesignNode, DragInsertionAxis, Point, Rect } from "../../core/types";
import { getNodeCanvasRect, getNodeLocalCanvasRect } from "../canvas-overlay/live-node-geometry";
import { getTopLevelDraggedIds, getTransformableSelectedIds } from "./selection-targets";

export type FlexDirectManipulationOptions = {
  mode?: "preserve-slot" | "detach";
};

export function getFlexAxis(node: DesignNode): DragInsertionAxis | null {
  const display = node.styles.display as string | undefined;
  if (display !== "flex" && display !== "inline-flex") return null;

  const direction = String(node.styles.flexDirection ?? "row");
  return direction.startsWith("column") ? "column" : "row";
}

export function shouldUseFlexGhostDrag(
  store: EditorStore,
  draggedRootIds: readonly string[],
  nodeId: string,
) {
  if (draggedRootIds.length !== 1 || draggedRootIds[0] !== nodeId) return false;
  const parent = store.getParent(nodeId);
  return !!(parent?.type === "frame" && getFlexAxis(parent) && store.isFlexChild(nodeId));
}

export function getDragRenderRoots(store: EditorStore) {
  const detachedNodes = Array.from(store.dragDetachedIds)
    .map((id) => store.getNode(id))
    .filter((node): node is NonNullable<typeof node> => !!node);
  return [...store.nodes, ...detachedNodes];
}

export function normalizeFlexNodeForDirectManipulation(
  store: EditorStore,
  nodeId: string,
  options?: FlexDirectManipulationOptions,
) {
  const node = store.getNode(nodeId);
  if (!node || !store.isFlexChild(nodeId)) return null;

  const offset = store.dragCanvasOffset.get(nodeId);
  const liveCanvasRect = offset
    ? {
        x: node.x + offset.x,
        y: node.y + offset.y,
        width: node.width + offset.width,
        height: node.height + offset.height,
      }
    : (() => {
        const el = store.domIndex.getElement(node);
        if (!el) return null;
        const viewportEl = el.closest("[data-viewport]");
        const elRect = el.getBoundingClientRect();
        if (!(viewportEl instanceof HTMLElement)) {
          return {
            x: node.x,
            y: node.y,
            width: elRect.width / store.zoom,
            height: elRect.height / store.zoom,
          };
        }
        const viewportRect = viewportEl.getBoundingClientRect();
        return {
          x: (elRect.left - viewportRect.left - store.panX) / store.zoom,
          y: (elRect.top - viewportRect.top - store.panY) / store.zoom,
          width: elRect.width / store.zoom,
          height: elRect.height / store.zoom,
        };
      })();
  if (!liveCanvasRect) return null;

  const mode = options?.mode ?? "preserve-slot";
  const oldRect = {
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
  };
  const nextRect =
    mode === "detach"
      ? {
          x: Math.round(liveCanvasRect.x),
          y: Math.round(liveCanvasRect.y),
          width: Math.round(liveCanvasRect.width),
          height: Math.round(liveCanvasRect.height),
        }
      : {
          x: node.x,
          y: node.y,
          width: Math.round(liveCanvasRect.width),
          height: Math.round(liveCanvasRect.height),
        };

  store.runtime.updateNode(nodeId, nextRect);
  if (mode === "detach") {
    store.runtime.updateNodeStyles(nodeId, { position: "absolute" });
    store.dragDetachedIds.add(nodeId);
  } else {
    store.runtime.updateNodeStyles(nodeId, { position: "relative" });
  }

  return { oldRect, nextRect };
}

/**
 * Style keys that would keep beating the typed size after a resize writes it.
 * `styles.width` wins over `node.width` in `buildBaseStyle`, flex sizing wins
 * over both, and a min/max/aspect constraint clamps whatever survives.
 */
const MODEL_SIZE_OVERRIDE_STYLE_KEYS = [
  "width",
  "height",
  "flex",
  "flexBasis",
  "flexGrow",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "aspectRatio",
] as const;

function hasModelSizeOverride(node: DesignNode) {
  return (
    MODEL_SIZE_OVERRIDE_STYLE_KEYS.some((key) => node.styles[key] !== undefined) ||
    node.styles.alignSelf === "stretch"
  );
}

/** Make the typed width/height the node's real size before a resize gesture. */
export function bakeModelSizeForDirectManipulation(
  store: EditorStore,
  nodeId: string,
  viewportEl: Element | null,
) {
  const node = store.getNode(nodeId);
  if (!node || !hasModelSizeOverride(node)) return null;

  const liveRect = getNodeLocalCanvasRect(node, store, viewportEl);
  const width = Math.max(1, Math.round(liveRect.width));
  const height = Math.max(1, Math.round(liveRect.height));
  const removedKeys = MODEL_SIZE_OVERRIDE_STYLE_KEYS.filter(
    (key) => node.styles[key] !== undefined,
  ) as string[];
  if (node.styles.alignSelf === "stretch") removedKeys.push("alignSelf");

  store.runtime.updateNode(nodeId, { width, height });
  if (removedKeys.length > 0) store.runtime.removeNodeStyles([nodeId], removedKeys);

  return { width, height };
}

/** Canvas rects for the selection, keyed by node id, skipping locked nodes. */
export function getSelectionCanvasRects(store: EditorStore, viewportEl: Element | null) {
  const rects = new Map<string, Rect>();
  for (const id of getTransformableSelectedIds(store)) {
    const node = store.getNode(id);
    if (!node) continue;
    rects.set(id, getNodeCanvasRect(node, store, viewportEl));
  }
  return rects;
}

function applyPositionDeltas(store: EditorStore, deltas: ReadonlyMap<string, Point>) {
  const moved: string[] = [];
  store.beginHistoryTransaction();
  try {
    for (const [id, delta] of deltas) {
      if (delta.x === 0 && delta.y === 0) continue;
      const node = store.getNode(id);
      // Flow children are placed by CSS; writing x/y would not move them.
      if (!node || store.isFlowChild(id)) continue;
      store.runtime.updateNode(id, { x: node.x + delta.x, y: node.y + delta.y });
      moved.push(id);
    }
  } finally {
    store.endHistoryTransaction();
  }
  return moved;
}

export function alignSelection(store: EditorStore, viewportEl: Element | null, edge: AlignEdge) {
  const rects = getSelectionCanvasRects(store, viewportEl);
  if (rects.size < 2) return [];
  return applyPositionDeltas(store, computeAlignDeltas(rects, edge));
}

export function distributeSelection(
  store: EditorStore,
  viewportEl: Element | null,
  axis: DistributeAxis,
) {
  const rects = getSelectionCanvasRects(store, viewportEl);
  if (rects.size < 3) return [];
  return applyPositionDeltas(store, computeDistributeDeltas(rects, axis));
}

/** Move the selection by a canvas-space delta, as arrow-key nudge does. */
export function nudgeSelection(store: EditorStore, dx: number, dy: number) {
  const deltas = new Map<string, Point>();
  for (const id of getTopLevelDraggedIds(store, getTransformableSelectedIds(store))) {
    deltas.set(id, { x: dx, y: dy });
  }
  return applyPositionDeltas(store, deltas);
}

export type TransformHud = {
  /** Canvas-space box the readout is anchored under. */
  rect: Rect;
  rotation: number;
  text: string;
};

/**
 * Live readout for the in-progress gesture. Kept as a standalone observable so
 * pointer frames do not have to re-render the Viewport tree to update it.
 */
export const transformHud = observable.box<TransformHud | null>(null, { deep: false });

export function setTransformHud(next: TransformHud | null) {
  if (transformHud.get() === null && next === null) return;
  runInAction(() => {
    transformHud.set(next);
  });
}
