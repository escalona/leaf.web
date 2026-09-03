import {
  getOrientedBoxOverlapArea,
  getRotatedBounds,
  orientedBoxContainsPoint,
  rotateVector,
  type OrientedBox,
} from "../../core/editor/interaction/math";
import { getEffectiveModelDimension } from "../../core/editor/model-geometry";
import type { EditorStore } from "../../core/state/EditorStore";
import type { DesignNode, Point, Rect } from "../../core/types";
import { getNodeOrientedBox } from "../canvas-overlay/live-node-geometry";
import { getFlexAxis } from "./direct-manipulation";
import {
  getConservativeModelRect,
  getMountedViewportNodes,
  getNodeDepth,
  intersectsCanvasBounds,
  isNodeLocked,
  isNodeWithinDraggedSubtree,
  type CanvasBounds,
} from "./selection-targets";

/**
 * A candidate drop parent. `rect`/`rotation` are the frame's oriented box, so
 * the target structurally satisfies `OrientedBox` and a rotated frame only
 * claims the area it visibly covers. `area` stays the frame's own area, which
 * rotation does not change, so the smallest-frame tie-break is stable.
 */
export type FrameDropTarget = {
  area: number;
  depth: number;
  node: DesignNode;
  rect: Rect;
  rotation: number;
};

export function createFrameDropTarget(
  store: EditorStore,
  node: DesignNode,
  box: OrientedBox,
): FrameDropTarget {
  return {
    area: box.rect.width * box.rect.height,
    depth: getNodeDepth(store, node.id),
    node,
    ...box,
  };
}

export type FrameDropTargetLookup = {
  buckets: Map<string, FrameDropTarget[]>;
  cellSize: number;
  globalTargets: FrameDropTarget[];
  targets: FrameDropTarget[];
};

export function buildFrameDropTargets(
  store: EditorStore,
  viewportEl: Element | null,
  draggedNodeIds: ReadonlySet<string>,
  canvasBounds?: CanvasBounds | null,
) {
  const targets: FrameDropTarget[] = [];
  const mountedNodes = getMountedViewportNodes(store, viewportEl);

  if (mountedNodes.length > 0) {
    const viewportRect = viewportEl?.getBoundingClientRect();
    for (const node of mountedNodes) {
      if (node.type !== "frame") continue;
      if (!store.isNodeWithinSelectionScope(node.id)) continue;
      if (isNodeWithinDraggedSubtree(store, node.id, draggedNodeIds)) continue;
      // A locked frame (or one under a locked ancestor) accepts nothing, so a
      // canvas drop, a draw, and a paste agree with the layers panel.
      if (isNodeLocked(store, node.id)) continue;
      const modelRect = canvasBounds ? getConservativeModelRect(store, node) : null;
      if (canvasBounds && modelRect && !intersectsCanvasBounds(modelRect, canvasBounds)) continue;
      const box = getNodeOrientedBox(node, store, viewportEl, viewportRect);
      if (
        canvasBounds &&
        !intersectsCanvasBounds(getRotatedBounds(box.rect, box.rotation), canvasBounds)
      ) {
        continue;
      }
      targets.push(createFrameDropTarget(store, node, box));
    }
    targets.sort((left, right) => right.depth - left.depth || left.area - right.area);
    return targets;
  }

  const viewportRect = viewportEl?.getBoundingClientRect();

  /**
   * `centerX`/`centerY` and `rotation` are the node's composed canvas frame —
   * its own center after every ancestor's turn, and the total of those turns.
   * Threading them down keeps the walk O(1) per node while giving each child
   * the same placement `getCanvasTransform` computes for it in isolation.
   */
  const visit = (node: DesignNode, centerX: number, centerY: number, rotation: number) => {
    // A lock covers the whole subtree, so nothing below a locked node can be a
    // target either; the walk stops here.
    if (node.locked) return;
    const width = getEffectiveModelDimension(node.width, node.styles.width);
    const height = getEffectiveModelDimension(node.height, node.styles.height);

    if (canvasBounds) {
      // Prune on the rotated extent: a turned frame reaches far outside its model
      // box, and this check only rejects, so it must not be the tighter rect.
      const pruneRect = getRotatedBounds(
        { x: centerX - width / 2, y: centerY - height / 2, width, height },
        rotation,
      );
      if (
        pruneRect.x + pruneRect.width < canvasBounds.left - 200 &&
        pruneRect.y + pruneRect.height < canvasBounds.top - 200
      ) {
        return;
      }
      if (pruneRect.x > canvasBounds.right + 200 || pruneRect.y > canvasBounds.bottom + 200) {
        return;
      }
    }

    if (
      node.type === "frame" &&
      store.isNodeWithinSelectionScope(node.id) &&
      !isNodeWithinDraggedSubtree(store, node.id, draggedNodeIds)
    ) {
      const box = getNodeOrientedBox(node, store, viewportEl, viewportRect);
      targets.push(createFrameDropTarget(store, node, box));
    }

    for (const child of node.children) {
      const childWidth = getEffectiveModelDimension(child.width, child.styles.width);
      const childHeight = getEffectiveModelDimension(child.height, child.styles.height);
      const offset = rotateVector(
        { x: child.x + childWidth / 2 - width / 2, y: child.y + childHeight / 2 - height / 2 },
        rotation,
      );
      visit(child, centerX + offset.x, centerY + offset.y, rotation + (child.rotation ?? 0));
    }
  };

  for (const root of store.nodes) {
    visit(
      root,
      root.x + getEffectiveModelDimension(root.width, root.styles.width) / 2,
      root.y + getEffectiveModelDimension(root.height, root.styles.height) / 2,
      root.rotation ?? 0,
    );
  }

  targets.sort((left, right) => right.depth - left.depth || left.area - right.area);
  return targets;
}

function getFrameDropTargetBucketKey(x: number, y: number) {
  return `${x}:${y}`;
}

export function buildFrameDropTargetLookup(
  targets: FrameDropTarget[],
  cellSize = 256,
): FrameDropTargetLookup {
  const buckets = new Map<string, FrameDropTarget[]>();
  const globalTargets: FrameDropTarget[] = [];
  const maxBucketCellsPerTarget = 1024;

  for (const target of targets) {
    // Index the rotated extent so a turned frame is in every cell it can reach.
    const bounds = getRotatedBounds(target.rect, target.rotation);
    const minX = Math.floor(bounds.x / cellSize);
    const maxX = Math.floor((bounds.x + bounds.width) / cellSize);
    const minY = Math.floor(bounds.y / cellSize);
    const maxY = Math.floor((bounds.y + bounds.height) / cellSize);
    if ((maxX - minX + 1) * (maxY - minY + 1) > maxBucketCellsPerTarget) {
      globalTargets.push(target);
      continue;
    }

    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        const key = getFrameDropTargetBucketKey(x, y);
        const bucket = buckets.get(key);
        if (bucket) bucket.push(target);
        else buckets.set(key, [target]);
      }
    }
  }

  return { buckets, cellSize, globalTargets, targets };
}

export function findFrameDropTargetAtPoint(lookup: FrameDropTargetLookup | null, point: Point) {
  const targets = lookup
    ? [
        ...(lookup.buckets.get(
          getFrameDropTargetBucketKey(
            Math.floor(point.x / lookup.cellSize),
            Math.floor(point.y / lookup.cellSize),
          ),
        ) ?? []),
        ...lookup.globalTargets,
      ]
    : [];

  let bestTarget: FrameDropTarget | null = null;
  for (const target of targets) {
    if (!orientedBoxContainsPoint(target, point)) continue;
    if (
      !bestTarget ||
      target.depth > bestTarget.depth ||
      (target.depth === bestTarget.depth && target.area < bestTarget.area)
    ) {
      bestTarget = target;
    }
  }
  return bestTarget;
}

/**
 * The flex frame a dragged node overlaps most. `box` is the dragged node's own
 * oriented geometry, so a rotated node is measured by the area it really covers
 * on both sides of the comparison.
 */
export function findFrameDropTargetOverlappingRect(
  lookup: FrameDropTargetLookup | null,
  box: OrientedBox,
) {
  if (!lookup) return null;

  let bestTarget: FrameDropTarget | null = null;
  let bestArea = 0;
  const candidates = new Set<FrameDropTarget>();
  for (const target of lookup.globalTargets) candidates.add(target);
  const rect = getRotatedBounds(box.rect, box.rotation);
  const minX = Math.floor(rect.x / lookup.cellSize);
  const maxX = Math.floor((rect.x + rect.width) / lookup.cellSize);
  const minY = Math.floor(rect.y / lookup.cellSize);
  const maxY = Math.floor((rect.y + rect.height) / lookup.cellSize);

  if ((maxX - minX + 1) * (maxY - minY + 1) > 1024) {
    for (const target of lookup.targets) candidates.add(target);
  } else {
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        for (const target of lookup.buckets.get(getFrameDropTargetBucketKey(x, y)) ?? []) {
          candidates.add(target);
        }
      }
    }
  }

  for (const target of candidates) {
    if (!getFlexAxis(target.node)) continue;

    const overlapArea = getOrientedBoxOverlapArea(target, box);
    if (overlapArea <= 0) continue;

    if (
      !bestTarget ||
      target.depth > bestTarget.depth ||
      (target.depth === bestTarget.depth &&
        (overlapArea > bestArea || (overlapArea === bestArea && target.area < bestTarget.area)))
    ) {
      bestTarget = target;
      bestArea = overlapArea;
    }
  }

  return bestTarget;
}
