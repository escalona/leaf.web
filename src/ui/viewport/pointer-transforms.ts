import { gapPatch, paddingPatch } from "../../core/editor/auto-layout";
import {
  computeGroupResize,
  computeResize,
  computeResizeWithRotation,
  computeRotationDelta,
  getAngleFromCenter,
  normalizeAngle,
  rotatePointAround,
  rotateVector,
} from "../../core/editor/interaction/math";
import type { CanvasPoint } from "../../core/editor/interaction/coordinate-spaces";
import type { EditorStore } from "../../core/state/EditorStore";
import type { DesignNode } from "../../core/types";
import { getNodeCanvasRect } from "../canvas-overlay/live-node-geometry";
import {
  bakeModelSizeForDirectManipulation,
  normalizeFlexNodeForDirectManipulation,
  setTransformHud,
} from "./interaction-helpers";
import type { DragState } from "./interaction-coordinator";

type RotatingState = Extract<DragState, { type: "rotating" }>;
type GapResizeState = Extract<DragState, { type: "resizing-gap" }>;
type PaddingResizeState = Extract<DragState, { type: "resizing-padding" }>;
type SelectionResizeState = Extract<DragState, { type: "resizing-selection" }>;
type NodeResizeState = Extract<DragState, { type: "resizing" }>;

export function updateRotationGesture(
  {
    getCanvasPoint,
    shiftKey,
    state,
    store,
  }: {
    getCanvasPoint: (clientX: number, clientY: number) => CanvasPoint | null;
    shiftKey: boolean;
    state: RotatingState;
    store: EditorStore;
  },
  clientX: number,
  clientY: number,
) {
  const pointerCanvas = getCanvasPoint(clientX, clientY);
  if (!pointerCanvas) return;

  const pointerAngle = getAngleFromCenter(state.center, pointerCanvas);
  const rotationDelta = computeRotationDelta(
    state.startBoundsRotation,
    state.startPointerAngle,
    pointerAngle,
    shiftKey,
  );
  for (const [id, startRotation] of state.startRotations) {
    const patch: Partial<DesignNode> = {
      rotation: normalizeAngle(startRotation + rotationDelta),
    };
    const startCenter = state.startCenters.get(id);
    const startModel = state.startModels.get(id);
    if (startCenter && startModel && !store.isFlowChild(id)) {
      const orbited = rotatePointAround(startCenter, state.center, rotationDelta);
      const parentDelta = rotateVector(
        { x: orbited.x - startCenter.x, y: orbited.y - startCenter.y },
        -(state.startAncestorRotations.get(id) ?? 0),
      );
      patch.x = Math.round(startModel.x + parentDelta.x);
      patch.y = Math.round(startModel.y + parentDelta.y);
    }
    store.runtime.updateNode(id, patch);
  }
  const hudDegrees =
    state.startRotations.size === 1
      ? normalizeAngle(state.startBoundsRotation + rotationDelta)
      : ((normalizeAngle(rotationDelta) + 180) % 360) - 180;
  setTransformHud({
    rect: state.rect,
    rotation: 0,
    text: `${Math.round(hudDegrees)}°`,
  });
}

export function updateGapGesture({
  clientX,
  clientY,
  state,
  store,
}: {
  clientX: number;
  clientY: number;
  state: GapResizeState;
  store: EditorStore;
}) {
  const node = store.getNode(state.nodeId);
  if (!node) return;

  const pointerDelta =
    state.pointerAxis === "x" ? clientX - state.startMouse.x : clientY - state.startMouse.y;
  const nextGap = Math.max(
    0,
    Math.round(state.startGap + (state.sign * pointerDelta) / store.zoom / state.divisor),
  );
  const patch = state.linked
    ? gapPatch(nextGap, nextGap, true)
    : state.gapAxis === "row"
      ? gapPatch(nextGap, state.otherGap, false)
      : gapPatch(state.otherGap, nextGap, false);
  store.runtime.updateStyles([{ nodeIds: [state.nodeId], styles: patch }]);
  store.domIndex.scheduleGeometryRefresh();
  // No transform HUD here: the highlighted band's pink value badge is the
  // live readout, and it tracks the reflowed band each frame.
}

export function updatePaddingGesture({
  clientX,
  clientY,
  state,
  store,
}: {
  clientX: number;
  clientY: number;
  state: PaddingResizeState;
  store: EditorStore;
}) {
  const node = store.getNode(state.nodeId);
  if (!node) return;

  const pointerDelta =
    state.pointerAxis === "x" ? clientX - state.startMouse.x : clientY - state.startMouse.y;
  const nextPadding = Math.max(
    0,
    Math.round(state.startPadding + (state.sign * pointerDelta) / store.zoom),
  );
  const sides = { ...state.startSides, [state.side]: nextPadding };
  const uniform = [sides.right, sides.bottom, sides.left].every(
    (value) => String(value) === String(sides.top),
  );
  store.runtime.updateStyles([{ nodeIds: [state.nodeId], styles: paddingPatch(sides, uniform) }]);
  store.domIndex.scheduleGeometryRefresh();
  // The highlighted strip's pink value badge is the live readout.
}

export function updateSelectionResizeGesture({
  clientX,
  clientY,
  shiftKey,
  state,
  store,
  viewportEl,
}: {
  clientX: number;
  clientY: number;
  shiftKey: boolean;
  state: SelectionResizeState;
  store: EditorStore;
  viewportEl: HTMLElement | null;
}) {
  if (!state.baked) {
    state.baked = true;
    for (const id of state.startRects.keys()) {
      bakeModelSizeForDirectManipulation(store, id, viewportEl);
    }
  }

  const nextUnion = computeResize(
    state.startUnion,
    state.direction,
    (clientX - state.startMouse.x) / store.zoom,
    (clientY - state.startMouse.y) / store.zoom,
    shiftKey || state.lockProportions,
  );
  const memberRects = computeGroupResize(state.startUnion, nextUnion, state.startRects);

  for (const [id, memberRect] of memberRects) {
    const startRect = state.startRects.get(id);
    const startModel = state.startModels.get(id);
    if (!startRect || !startModel) continue;
    // The scale moved the member's CENTER in canvas space; its stored position
    // is the top-left of its own box in its parent's frame. Turn the center
    // shift into that frame, then step back off the resized box's own half.
    // Any rotation in the chain forces proportional scaling, so the member's
    // box only ever grows uniformly here and the two frames stay comparable.
    const centerDelta = rotateVector(
      {
        x: memberRect.x + memberRect.width / 2 - (startRect.x + startRect.width / 2),
        y: memberRect.y + memberRect.height / 2 - (startRect.y + startRect.height / 2),
      },
      -(state.startAncestorRotations.get(id) ?? 0),
    );
    store.runtime.updateNode(id, {
      x: startModel.x + centerDelta.x - (memberRect.width - startRect.width) / 2,
      y: startModel.y + centerDelta.y - (memberRect.height - startRect.height) / 2,
      width: memberRect.width,
      height: memberRect.height,
    });
  }
  setTransformHud({
    rect: nextUnion,
    rotation: 0,
    text: `${Math.round(nextUnion.width)} × ${Math.round(nextUnion.height)}`,
  });
}

export function updateNodeResizeGesture({
  clientX,
  clientY,
  shiftKey,
  state,
  store,
  viewportEl,
}: {
  clientX: number;
  clientY: number;
  shiftKey: boolean;
  state: NodeResizeState;
  store: EditorStore;
  viewportEl: HTMLElement | null;
}) {
  const node = store.getNode(state.nodeId);
  if (!node) return;

  if (!state.flexReparented) {
    const baked = bakeModelSizeForDirectManipulation(store, state.nodeId, viewportEl);
    if (baked) {
      state.startRect = {
        ...state.startRect,
        width: baked.width,
        height: baked.height,
      };
    }
    const normalized = normalizeFlexNodeForDirectManipulation(store, state.nodeId);
    if (normalized) state.startRect = normalized.nextRect;
    state.flexReparented = true;
  }

  if (!store.dragCanvasOffset.has(state.nodeId)) {
    const canvasRect = getNodeCanvasRect(node, store, viewportEl);
    store.dragCanvasOffset.set(state.nodeId, {
      x: canvasRect.x - node.x,
      y: canvasRect.y - node.y,
      width: canvasRect.width - node.width,
      height: canvasRect.height - node.height,
    });
  }

  const nextRect = computeResizeWithRotation(
    state.startRect,
    state.direction,
    (clientX - state.startMouse.x) / store.zoom,
    (clientY - state.startMouse.y) / store.zoom,
    state.rotation,
    state.ancestorRotation,
    shiftKey,
  );

  store.runtime.updateNode(node.id, nextRect);
  const offset = store.dragCanvasOffset.get(state.nodeId);
  setTransformHud({
    rect: {
      x: nextRect.x + (offset?.x ?? 0),
      y: nextRect.y + (offset?.y ?? 0),
      width: nextRect.width,
      height: nextRect.height,
    },
    // The badge hangs off the box as drawn, which is turned by the whole chain.
    rotation: state.rotation + state.ancestorRotation,
    text: `${Math.round(nextRect.width)} × ${Math.round(nextRect.height)}`,
  });
}
