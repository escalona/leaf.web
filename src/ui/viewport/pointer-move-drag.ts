import {
  findFlexInsertionIndex,
  flexContainerWraps,
  getFlexFlowChildren,
} from "../../core/editor/interaction/flex-insertion";
import {
  applyAxisLock,
  computeMove,
  computeSelectionBounds,
  computeSnap,
  getRotatedBounds,
  orientedBoxContainsPoint,
} from "../../core/editor/interaction/math";
import type { CanvasPoint } from "../../core/editor/interaction/coordinate-spaces";
import type { EditorStore } from "../../core/state/EditorStore";
import type { DragInsertionPreview, Rect } from "../../core/types";
import {
  getNodeCanvasRect,
  getNodeLocalCanvasRect,
  getNodeOrientedBox,
} from "../canvas-overlay/live-node-geometry";
import {
  buildFrameDropTargetLookup,
  buildFrameDropTargets,
  buildSnapTargetRects,
  createFrameDropTarget,
  findFrameDropTargetAtPoint,
  findFrameDropTargetOverlappingRect,
  getFlexAxis,
  getTopLevelDraggedIds,
  normalizeFlexNodeForDirectManipulation,
  shouldUseFlexGhostDrag,
  type FrameDropTarget,
} from "./interaction-helpers";
import type { DragState, ViewportInteractionCoordinator } from "./interaction-coordinator";
import { timeLeafPerfTrace } from "../../core/lib/perf-trace";
import { getExpandedViewportCanvasBounds } from "./pointer-utils";

const AUTO_LAYOUT_BREAK_THRESHOLD = 8;
const FLEX_INSERTION_POINTER_SLOP = 16;
const MOVE_DRAG_THRESHOLD = 4;

type MovingState = Extract<DragState, { type: "moving" }>;

export function updateMovingGesture({
  altKey,
  clientX,
  clientY,
  getCanvasPoint,
  interaction,
  shiftKey,
  state,
  store,
  viewportEl,
}: {
  altKey: boolean;
  clientX: number;
  clientY: number;
  getCanvasPoint: (clientX: number, clientY: number) => CanvasPoint | null;
  interaction: ViewportInteractionCoordinator;
  shiftKey: boolean;
  state: MovingState;
  store: EditorStore;
  viewportEl: HTMLElement | null;
}) {
  const dragDistance = Math.hypot(state.startMouse.x - clientX, state.startMouse.y - clientY);
  if (!state.started && dragDistance < MOVE_DRAG_THRESHOLD) return;
  if (!state.started) {
    state.started = true;
    interaction.lastClickTime = 0;
    interaction.lastClickNodeId = null;
    // Alt-drag leaves a copy behind: clone in place, then drag the originals.
    if (altKey) {
      for (const id of getTopLevelDraggedIds(store, state.startPositions.keys())) {
        const source = store.getNode(id);
        if (!source) continue;
        const [duplicate] = store.runtime.duplicateNodes([{ id }]);
        if (duplicate) store.runtime.updateNode(duplicate.newId, { x: source.x, y: source.y });
      }
    }
  }

  const draggedRootIds = getTopLevelDraggedIds(store, state.startPositions.keys());
  const shouldDelayFlexDetach =
    !state.flexReparented &&
    draggedRootIds.length === 1 &&
    shouldUseFlexGhostDrag(store, draggedRootIds, draggedRootIds[0]!) &&
    dragDistance < AUTO_LAYOUT_BREAK_THRESHOLD;

  if (shouldDelayFlexDetach) {
    store.dragPendingParentIds.clear();
    store.snapGuides = [];
    store.dragInsertionPreview = null;
    interaction.clearTargetCaches();
    store.clearHoveredNode();
    return;
  }

  // Capture canvas offsets on first move while DOM geometry is still current.
  if (store.dragCanvasOffset.size === 0) {
    timeLeafPerfTrace("drag.captureOffsets", () => {
      for (const [id] of state.startPositions) {
        const node = store.getNode(id);
        if (!node) continue;
        // The local gesture takes the element over from any in-flight remote
        // preview now; waiting for the next presence packet to re-run the
        // sync would leave the remote translate composed into this drag.
        store.remoteDragPreviews.delete(id);
        // The node's own box, not its rotated bounding box: every consumer of
        // this offset works in the node's model space, and a rotated node's
        // bounding box has neither its size nor its origin.
        const canvasRect = getNodeLocalCanvasRect(node, store, viewportEl);
        store.dragCanvasOffset.set(id, {
          x: canvasRect.x - node.x,
          y: canvasRect.y - node.y,
          width: canvasRect.width - node.width,
          height: canvasRect.height - node.height,
        });
      }
    });
  }

  // On first move, detach flex children so frames stay off the flex layout path.
  if (!state.flexReparented) {
    timeLeafPerfTrace("drag.normalizeFlex", () => {
      state.flexReparented = true;
      for (const [id] of state.startPositions) {
        const node = store.getNode(id);
        const usesFlexGhost = shouldUseFlexGhostDrag(store, draggedRootIds, id);
        if (node && usesFlexGhost && !state.flowRestoreStates.has(id)) {
          state.flowRestoreStates.set(id, {
            position: typeof node.styles.position === "string" ? node.styles.position : null,
            x: node.x,
            y: node.y,
          });
        }
        const normalized = normalizeFlexNodeForDirectManipulation(store, id, {
          mode: usesFlexGhost ? "preserve-slot" : "detach",
        });
        if (!normalized) continue;

        const previousOffset = store.dragCanvasOffset.get(id);
        if (previousOffset) {
          store.dragCanvasOffset.set(id, {
            x: previousOffset.x - (normalized.nextRect.x - normalized.oldRect.x),
            y: previousOffset.y - (normalized.nextRect.y - normalized.oldRect.y),
            width: previousOffset.width - (normalized.nextRect.width - normalized.oldRect.width),
            height:
              previousOffset.height - (normalized.nextRect.height - normalized.oldRect.height),
          });
        }
        state.startPositions.set(id, {
          x: normalized.nextRect.x,
          y: normalized.nextRect.y,
        });
      }
    });
  }

  const lockedDelta = applyAxisLock(
    clientX - state.startMouse.x,
    clientY - state.startMouse.y,
    shiftKey,
  );
  const nextPositions = computeMove(
    state.startPositions,
    lockedDelta.dx,
    lockedDelta.dy,
    store.zoom,
  );
  const shouldSnap = draggedRootIds.every(
    (id) => !shouldUseFlexGhostDrag(store, draggedRootIds, id),
  );
  if (shouldSnap) {
    const draggedRootIdSet = new Set(draggedRootIds);
    const movingRects = draggedRootIds
      .map((id) => {
        const node = store.getNode(id);
        const nextPosition = nextPositions.get(id);
        if (!node || !nextPosition) return null;
        const offset = store.dragCanvasOffset.get(id);
        // Snap by the extent the user sees, so a rotated node aligns on its
        // turned corners rather than its unrotated box — including when the
        // turn comes from an ancestor and the node's own angle is zero.
        return getRotatedBounds(
          {
            x: nextPosition.x + (offset?.x ?? 0),
            y: nextPosition.y + (offset?.y ?? 0),
            width: node.width + (offset?.width ?? 0),
            height: node.height + (offset?.height ?? 0),
          },
          store.getWorldRotation(id),
        );
      })
      .filter((rect): rect is Rect => rect !== null);
    const movingBounds = computeSelectionBounds(movingRects);

    if (movingBounds) {
      if (!interaction.snapTargetRects) {
        interaction.snapTargetRects = timeLeafPerfTrace("drag.buildSnapTargets", () =>
          buildSnapTargetRects(
            store,
            viewportEl,
            draggedRootIdSet,
            getExpandedViewportCanvasBounds(store, viewportEl, 800),
          ),
        );
      }
      const snapResult = timeLeafPerfTrace("drag.computeSnap", () =>
        computeSnap(movingBounds, interaction.snapTargetRects!),
      );

      if (snapResult.dx !== 0 || snapResult.dy !== 0) {
        for (const [id, nextPosition] of nextPositions) {
          nextPositions.set(id, {
            x: nextPosition.x + snapResult.dx,
            y: nextPosition.y + snapResult.dy,
          });
        }
      }
      store.snapGuides = snapResult.guides;
    } else {
      store.snapGuides = [];
    }
  } else {
    store.snapGuides = [];
  }

  timeLeafPerfTrace("drag.updateNodes", () => {
    for (const [id, nextPosition] of nextPositions) {
      if (store.getNode(id)) store.runtime.updateNode(id, nextPosition);
    }
  });

  const draggedRootIdSet = new Set(draggedRootIds);
  const allowsInsertionPreview = draggedRootIds.length === 1;
  const pointerCanvas = getCanvasPoint(clientX, clientY);
  if (!pointerCanvas) return;
  const deltaCanvas = {
    x: lockedDelta.dx / store.zoom,
    y: lockedDelta.dy / store.zoom,
  };
  if (interaction.frameDropTargets === null) {
    interaction.frameDropTargets = timeLeafPerfTrace("drag.buildFrameTargets", () =>
      buildFrameDropTargetLookup(
        buildFrameDropTargets(
          store,
          viewportEl,
          draggedRootIdSet,
          getExpandedViewportCanvasBounds(store, viewportEl, 600),
        ),
      ),
    );
  }

  let dragHoverId: string | null = null;
  let dragHoverRect: Rect | null = null;
  let nextInsertionPreview: DragInsertionPreview | null = null;
  let shouldRebuildFrameDropTargets = false;

  timeLeafPerfTrace("drag.dropAnalysis", () => {
    for (const id of draggedRootIds) {
      const node = store.getNode(id);
      if (!node) continue;

      const currentBox = getNodeOrientedBox(node, store, viewportEl);
      const currentRect = currentBox.rect;
      const pointerTarget = findFrameDropTargetAtPoint(interaction.frameDropTargets, pointerCanvas);
      const overlapTarget = findFrameDropTargetOverlappingRect(
        interaction.frameDropTargets,
        currentBox,
      );
      const currentParent = store.getParent(id);
      const currentFlexParent =
        currentParent?.type === "frame" && getFlexAxis(currentParent) ? currentParent : null;
      const currentFlexParentBox = currentFlexParent
        ? getNodeOrientedBox(currentFlexParent, store, viewportEl)
        : null;
      const usesFlexGhost = !!(
        currentFlexParent &&
        !store.dragDetachedIds.has(id) &&
        node.styles.position === "relative"
      );
      const pointTarget = pointerTarget;
      let targetParent: FrameDropTarget | null =
        overlapTarget && (!pointTarget || overlapTarget.depth > pointTarget.depth)
          ? overlapTarget
          : (pointTarget ?? overlapTarget);
      if (
        currentFlexParent &&
        currentFlexParentBox &&
        orientedBoxContainsPoint(currentFlexParentBox, pointerCanvas)
      ) {
        targetParent = createFrameDropTarget(store, currentFlexParent, currentFlexParentBox);
      }
      const insertionAxis = targetParent ? getFlexAxis(targetParent.node) : null;
      const pointerWithinInsertionZone =
        !!targetParent &&
        orientedBoxContainsPoint(
          targetParent,
          pointerCanvas,
          FLEX_INSERTION_POINTER_SLOP / store.zoom,
        );
      const flowChildren = targetParent ? getFlexFlowChildren(targetParent.node.children) : [];
      const insertionPreview =
        allowsInsertionPreview && targetParent && insertionAxis && pointerWithinInsertionZone
          ? {
              nodeId: id,
              parentId: targetParent.node.id,
              index: findFlexInsertionIndex(
                flowChildren
                  .filter((child) => !store.dragDetachedIds.has(child.id))
                  .filter((child) => child.id !== id)
                  .map((child) => getNodeCanvasRect(child, store, viewportEl)),
                pointerCanvas,
                insertionAxis,
                flexContainerWraps(targetParent.node),
              ),
              axis: insertionAxis,
            }
          : null;
      if (!dragHoverId && targetParent) {
        dragHoverId = targetParent.node.id;
        dragHoverRect = targetParent.rect;
      }
      const nextParentId = targetParent?.node.id;
      const isDetached = store.dragDetachedIds.has(id);

      if (
        currentParent?.type === "frame" &&
        !isDetached &&
        !usesFlexGhost &&
        (currentParent.id !== nextParentId || !!insertionPreview)
      ) {
        store.runtime.updateNodeStyles(id, { position: "absolute" });
        store.runtime.updateNode(id, { x: currentRect.x, y: currentRect.y });
        store.dragDetachedIds.add(id);
        shouldRebuildFrameDropTargets = true;
        state.startPositions.set(id, {
          x: currentRect.x - deltaCanvas.x,
          y: currentRect.y - deltaCanvas.y,
        });
        store.dragCanvasOffset.set(id, {
          x: 0,
          y: 0,
          width: currentRect.width - node.width,
          height: currentRect.height - node.height,
        });
      }

      if (insertionPreview) {
        nextInsertionPreview = insertionPreview;
        store.dragPendingParentIds.delete(id);
        continue;
      }

      if (currentParent?.id === nextParentId || (!currentParent && !nextParentId)) {
        store.dragPendingParentIds.delete(id);
      } else if (nextParentId || currentParent?.type === "frame") {
        store.dragPendingParentIds.set(id, nextParentId ?? null);
      } else {
        store.dragPendingParentIds.delete(id);
      }
    }
  });

  if (shouldRebuildFrameDropTargets) interaction.clearTargetCaches();
  store.dragInsertionPreview = nextInsertionPreview;
  if (dragHoverId !== store.hoveredId || (dragHoverId && !store.hoveredCanvasRect)) {
    store.setHoveredNode(dragHoverId, dragHoverRect);
  }
}
