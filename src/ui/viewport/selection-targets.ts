import {
  getRotatedBounds,
  orientedBoxIntersectsRect,
  rectContainsOrientedBox,
} from "../../core/editor/interaction/math";
import {
  getEffectiveModelDimension,
  hasUnsafeModelGeometry,
} from "../../core/editor/model-geometry";
import type { EditorStore } from "../../core/state/EditorStore";
import type { DesignNode, Point, Rect } from "../../core/types";
import { getNodeCanvasExtent, getNodeOrientedBox } from "../canvas-overlay/live-node-geometry";

/** Structurally an `OrientedBox`, so it passes straight to the hit predicates. */
export type MarqueeSelectionTarget = {
  id: string;
  rect: Rect;
  rotation: number;
};

export type CanvasBounds = {
  bottom: number;
  left: number;
  right: number;
  top: number;
};

export function getMountedViewportNodes(store: EditorStore, viewportEl: Element | null) {
  if (!viewportEl) return [];
  // A DomIndex belongs to exactly one EditorStore/Viewport session. Rechecking
  // `viewport.contains(element)` for every mounted node turns target construction
  // into thousands of DOM ancestry walks on large single-artboard documents.
  return store.domIndex.getMountedNodes();
}

export function getConservativeModelRect(store: EditorStore, node: DesignNode): Rect | null {
  let candidate = node;
  let rotatedBelowCandidate = false;
  let current: DesignNode | undefined = node;
  while (current) {
    // A CSS transform/offset can move a mounted node far away from its model box.
    // In that case there is no conservative model-space rejection: measure DOM.
    if (hasUnsafeModelGeometry(current)) return null;
    if (current.rotation) rotatedBelowCandidate = true;
    if (store.isFlowChild(current.id)) {
      const flowParent = store.getParent(current.id);
      if (!flowParent) return null;
      // Substituting the flow parent gives up the model position of everything
      // under it, and a turn down there reaches outside the parent's box. The
      // parent's box would then be the tighter rect, which this must never be.
      if (rotatedBelowCandidate) return null;
      candidate = flowParent;
    }
    current = store.getParent(current.id);
  }
  const transform = store.getCanvasTransform(candidate.id);
  if (!transform) return null;
  // This rect only ever rejects, so it must never be tighter than the real
  // extent — hence the widening, by the candidate's WORLD rotation so a frame
  // turned by an ancestor is widened by the turn the user actually sees.
  return getRotatedBounds(
    {
      x: transform.x,
      y: transform.y,
      width: getEffectiveModelDimension(candidate.width, candidate.styles.width),
      height: getEffectiveModelDimension(candidate.height, candidate.styles.height),
    },
    transform.rotation,
  );
}

/**
 * A node is locked when it or any ancestor carries `locked`. Locked nodes stay
 * visible and keep rendering; they just drop out of hit-testing and transforms.
 */
export function isNodeLocked(store: EditorStore, nodeId: string): boolean {
  let currentId: string | undefined = nodeId;
  while (currentId) {
    if (store.getNode(currentId)?.locked) return true;
    currentId = store.parentMap.get(currentId);
  }
  return false;
}

/**
 * A node's lock comes from above it. Clearing the node's own `locked` flag
 * would leave it locked all the same, so the affordances that unlock have
 * nothing to offer here: the ancestor that owns the lock is where it lifts.
 */
export function hasLockedAncestor(store: EditorStore, nodeId: string): boolean {
  const parentId = store.parentMap.get(nodeId);
  return parentId ? isNodeLocked(store, parentId) : false;
}

/** Selected nodes a transform gesture is allowed to touch. */
export function getTransformableSelectedIds(store: EditorStore): string[] {
  return Array.from(store.selectedIds).filter((id) => !isNodeLocked(store, id));
}

/**
 * Resolve a raw pointer hit (the deepest node under the cursor) to the
 * hover/click target: the shallowest node on the hit path,
 * drilling deeper only through containers that are ancestors of the
 * current selection. The entered container and an active interaction re-scope
 * the path to their children. Returns null when the hit is the backdrop
 * of an ancestor of the entered container (e.g. the artboard around an
 * entered frame): that press reads as empty canvas — deselect or marquee
 * within the scope — not as selecting the ancestor.
 */
export function resolveShallowSelectionTarget(
  store: EditorStore,
  hitNode: DesignNode,
): DesignNode | null {
  if (
    store.enteredContainerId &&
    hitNode.id !== store.enteredContainerId &&
    store.isDescendant(store.enteredContainerId, hitNode.id)
  ) {
    return null;
  }

  const scopeRootIds = new Set<string>();
  if (store.enteredContainerId) scopeRootIds.add(store.enteredContainerId);
  if (store.activeInteractiveSurfaceId) scopeRootIds.add(store.activeInteractiveSurfaceId);

  const hitPath: DesignNode[] = [];
  let current: DesignNode | undefined = hitNode;
  while (current && !scopeRootIds.has(current.id)) {
    hitPath.push(current);
    current = store.getParent(current.id);
  }
  hitPath.reverse();

  const openContainerIds = store.shallowTargetOpenContainerIds;
  for (const node of hitPath) {
    if (!openContainerIds.has(node.id)) return node;
  }
  return hitNode;
}

export function getTopLevelDraggedIds(store: EditorStore, nodeIds: Iterable<string>) {
  const ids = Array.from(nodeIds);
  const idSet = new Set(ids);

  return ids.filter((id) => {
    let currentId = store.parentMap.get(id);
    while (currentId) {
      if (idSet.has(currentId)) return false;
      currentId = store.parentMap.get(currentId);
    }
    return true;
  });
}

export function isNodeWithinDraggedSubtree(
  store: EditorStore,
  nodeId: string,
  draggedNodeIds: ReadonlySet<string>,
) {
  let currentId: string | undefined = nodeId;
  while (currentId) {
    if (draggedNodeIds.has(currentId)) return true;
    currentId = store.parentMap.get(currentId);
  }
  return false;
}

export function getNodeDepth(store: EditorStore, nodeId: string) {
  let depth = 0;
  let currentId = store.parentMap.get(nodeId);
  while (currentId) {
    depth += 1;
    currentId = store.parentMap.get(currentId);
  }
  return depth;
}

export function createCanvasRectFromPoints(a: Point, b: Point): Rect {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const right = Math.max(a.x, b.x);
  const bottom = Math.max(a.y, b.y);

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

export function intersectsCanvasBounds(rect: Rect, bounds: CanvasBounds) {
  return (
    rect.x + rect.width >= bounds.left &&
    rect.x <= bounds.right &&
    rect.y + rect.height >= bounds.top &&
    rect.y <= bounds.bottom
  );
}

export function isAdditiveSelectionKey(shiftKey: boolean, accelKey: boolean) {
  return shiftKey || accelKey;
}

function getMarqueeSelectionTargetId(
  store: EditorStore,
  nodeId: string,
  enclosedIds: ReadonlySet<string>,
) {
  const originalNodeId = nodeId;
  let currentId = nodeId;
  const scopeRootId = store.enteredContainerId;
  let highestEnclosedFrameId: string | null = null;

  while (true) {
    const currentNode = store.getNode(currentId);
    if (currentNode?.type === "frame" && enclosedIds.has(currentId)) {
      highestEnclosedFrameId = currentId;
    }

    if (currentId === nodeId && currentNode?.type === "frame" && !enclosedIds.has(currentId)) {
      return null;
    }

    const parentId = store.parentMap.get(currentId);
    if (!parentId) return highestEnclosedFrameId ?? originalNodeId;
    if (scopeRootId && parentId === scopeRootId) {
      return highestEnclosedFrameId ?? originalNodeId;
    }
    currentId = parentId;
  }
}

export function buildMarqueeSelectionTargets(
  store: EditorStore,
  viewportEl: Element | null,
  canvasBounds?: CanvasBounds | null,
) {
  const targets: MarqueeSelectionTarget[] = [];
  const mountedNodes = getMountedViewportNodes(store, viewportEl);
  // Tests and non-DOM consumers can still request model-wide targets.
  const candidates = mountedNodes.length > 0 ? mountedNodes : Array.from(store.nodeMap.values());
  const viewportRect = viewportEl?.getBoundingClientRect();
  for (const node of candidates) {
    if (!store.isNodeWithinSelectionScope(node.id)) continue;
    if (isNodeLocked(store, node.id)) continue;
    const modelRect = canvasBounds ? getConservativeModelRect(store, node) : null;
    if (canvasBounds && modelRect && !intersectsCanvasBounds(modelRect, canvasBounds)) continue;
    targets.push({
      id: node.id,
      ...getNodeOrientedBox(node, store, viewportEl, viewportRect),
    });
  }
  return targets;
}

export function getMarqueeSelectionIdsFromTargets(
  store: EditorStore,
  marqueeRect: Rect,
  targets: readonly MarqueeSelectionTarget[],
  baseSelectedIds: ReadonlySet<string>,
) {
  const enclosedIds = new Set<string>();
  const intersectingIds = new Set<string>();

  // The marquee itself is axis-aligned; the targets are not, so both tests run
  // against each target's rotated quad rather than its bounding box.
  for (const target of targets) {
    if (orientedBoxIntersectsRect(target, marqueeRect)) {
      intersectingIds.add(target.id);
    }
    if (rectContainsOrientedBox(marqueeRect, target)) {
      enclosedIds.add(target.id);
    }
  }

  const nextSelectedIds = new Set(baseSelectedIds);

  for (const nodeId of intersectingIds) {
    const targetId = getMarqueeSelectionTargetId(store, nodeId, enclosedIds);
    if (targetId) nextSelectedIds.add(targetId);
  }

  return nextSelectedIds;
}

/**
 * Axis-aligned edges a drag can align to.
 *
 * A rotated node has no axis-aligned edges of its own, so it contributes the
 * bounding box of its rotated area — the extent the user actually sees — rather
 * than its unrotated box. Rotation turns about the center, so the center guides
 * land in the same place either way.
 */
export function buildSnapTargetRects(
  store: EditorStore,
  viewportEl: Element | null,
  draggedNodeIds: ReadonlySet<string>,
  canvasBounds?: CanvasBounds | null,
) {
  const targetRects: Rect[] = [];
  const mountedNodes = getMountedViewportNodes(store, viewportEl);
  const candidates = mountedNodes.length > 0 ? mountedNodes : Array.from(store.nodeMap.values());
  const viewportRect = viewportEl?.getBoundingClientRect();
  const rotatedExtent = (node: DesignNode) =>
    getNodeCanvasExtent(node, store, viewportEl, viewportRect);
  for (const node of candidates) {
    if (!store.isNodeWithinSelectionScope(node.id)) continue;
    if (isNodeWithinDraggedSubtree(store, node.id, draggedNodeIds)) continue;

    let bounds: Rect | null = null;
    if (canvasBounds) {
      const modelRect = getConservativeModelRect(store, node);
      if (modelRect && !intersectsCanvasBounds(modelRect, canvasBounds)) continue;
      if (store.isFlowChild(node.id)) {
        bounds = rotatedExtent(node);
        if (!intersectsCanvasBounds(bounds, canvasBounds)) continue;
      }
    }
    targetRects.push(bounds ?? rotatedExtent(node));
  }
  return targetRects;
}
