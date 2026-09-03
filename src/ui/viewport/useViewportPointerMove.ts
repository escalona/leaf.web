import { action } from "mobx";
import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import { asScreenPoint, type CanvasPoint } from "../../core/editor/interaction/coordinate-spaces";
import { computePan, computePinchCamera } from "../../core/editor/interaction/math";
import { resolvePinchGestureMode } from "../../core/editor/interaction/pinchGesture";
import type { EditorStore } from "../../core/state/EditorStore";
import type { InkPoint, Rect } from "../../core/types";
import { getNodeCanvasRect } from "../canvas-overlay/live-node-geometry";
import {
  buildMarqueeSelectionTargets,
  createCanvasRectFromPoints,
  getMarqueeSelectionIdsFromTargets,
  resolveShallowSelectionTarget,
} from "./interaction-helpers";
import type { ViewportInteractionCoordinator } from "./interaction-coordinator";
import { updateMovingGesture } from "./pointer-move-drag";
import {
  updateGapGesture,
  updateNodeResizeGesture,
  updatePaddingGesture,
  updateRotationGesture,
  updateSelectionResizeGesture,
} from "./pointer-transforms";
import {
  getExpandedViewportCanvasBounds,
  getNodeFromPointerTarget,
  isCreationTool,
} from "./pointer-utils";
import { getPointDistance, getPointMidpoint } from "./useViewportCameraInput";
import { getTrackedInkPointerSamples, shouldUseRealPressure } from "./useViewportInk";

const MARQUEE_SELECTION_DRAG_THRESHOLD = 4;

function shouldSuppressHoverState(activeTool: EditorStore["activeTool"]) {
  // A creation tool draws on press wherever the pointer is, so previewing a
  // hover target it will never act on only misleads.
  return activeTool === "pan" || isCreationTool(activeTool);
}

export function useViewportPointerMove({
  commitPendingTouchStart,
  createInkPoint,
  extendInkSession,
  getCanvasPoint,
  interaction,
  markPanning,
  markZooming,
  setMarqueeRect,
  store,
  viewportRef,
}: {
  commitPendingTouchStart: (currentTarget: HTMLElement) => void;
  createInkPoint: (
    clientX: number,
    clientY: number,
    pressure: number,
    useRealPressure: boolean,
    preserveRawPressure: boolean,
  ) => InkPoint | null;
  extendInkSession: (
    samples: InkPoint[],
    useRealPressure: boolean,
    pointerId: number,
    last: boolean,
  ) => void;
  getCanvasPoint: (clientX: number, clientY: number) => CanvasPoint | null;
  interaction: ViewportInteractionCoordinator;
  markPanning: () => void;
  markZooming: () => void;
  setMarqueeRect: Dispatch<SetStateAction<Rect | null>>;
  store: EditorStore;
  viewportRef: RefObject<HTMLDivElement | null>;
}) {
  return useCallback(
    action((event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "touch") {
        if (!interaction.activeTouchPoints.has(event.pointerId)) return;

        interaction.activeTouchPoints.set(event.pointerId, {
          x: event.clientX,
          y: event.clientY,
        });

        const pinchState = interaction.pinchState;
        const rect = viewportRef.current?.getBoundingClientRect();
        const [first, second] = Array.from(interaction.activeTouchPoints.values());
        if (pinchState && rect && first && second && pinchState.initialDistance !== 0) {
          const midpoint = getPointMidpoint(first, second, rect);
          const distance = getPointDistance(first, second);
          const nextMode = resolvePinchGestureMode({
            mode: pinchState.mode,
            initialDistance: pinchState.initialDistance,
            currentDistance: distance,
            initialMidpoint: pinchState.initialMidpoint,
            currentMidpoint: midpoint,
          });
          const dx = midpoint.x - pinchState.previousMidpoint.x;
          const dy = midpoint.y - pinchState.previousMidpoint.y;

          pinchState.mode = nextMode;

          if (nextMode === "panning") {
            markPanning();
            store.pan(dx, dy);
          } else if (nextMode === "zooming") {
            markZooming();
            const anchorCanvas = store.screenToCanvas(asScreenPoint(pinchState.previousMidpoint));
            const nextCamera = computePinchCamera(
              anchorCanvas,
              midpoint,
              pinchState.initialZoom * (distance / pinchState.initialDistance),
            );

            store.zoom = nextCamera.zoom;
            store.panX = nextCamera.panX;
            store.panY = nextCamera.panY;
          }

          pinchState.previousMidpoint = midpoint;
          return;
        }

        if (
          interaction.pendingTouchStart?.pointerId === event.pointerId &&
          interaction.activeTouchPoints.size === 1
        ) {
          commitPendingTouchStart(event.currentTarget);
        }
      }

      if (interaction.pinchState) return;
      const state = interaction.dragState;

      if (state.type === "idle") {
        if (shouldSuppressHoverState(store.activeTool)) {
          store.clearHoveredNode();
          if (store.spacingBandHighlight) store.spacingBandHighlight = null;
          return;
        }

        // Hovering a spacing band (gap or padding strip) promotes its dash to
        // the full pink section with the value badge. Bands are overlay
        // chrome without a node id, so this rides the same idle pass that
        // resolves node hover.
        const bandElement =
          event.target instanceof Element
            ? event.target.closest("[data-gap-band-node],[data-padding-band-node]")
            : null;
        const bandKind = bandElement?.hasAttribute("data-padding-band-node")
          ? ("padding" as const)
          : ("gap" as const);
        const bandNodeId = bandElement?.getAttribute(`data-${bandKind}-band-node`) ?? null;
        const bandKey = bandElement
          ? Number(bandElement.getAttribute(`data-${bandKind}-band-key`))
          : Number.NaN;
        let nextHighlight: EditorStore["spacingBandHighlight"] = null;
        if (bandElement && bandNodeId && Number.isFinite(bandKey)) {
          if (bandKind === "gap") {
            const gapAxis =
              bandElement.getAttribute("data-gap-band-gap-axis") === "column"
                ? ("column" as const)
                : ("row" as const);
            nextHighlight = { nodeId: bandNodeId, kind: "gap", bandKey, gapAxis };
          } else {
            const sideAttribute = bandElement.getAttribute("data-padding-band-side");
            if (
              sideAttribute === "top" ||
              sideAttribute === "right" ||
              sideAttribute === "bottom" ||
              sideAttribute === "left"
            ) {
              nextHighlight = { nodeId: bandNodeId, kind: "padding", bandKey, side: sideAttribute };
            }
          }
        }
        const highlightIdentity = (highlight: EditorStore["spacingBandHighlight"]) =>
          highlight === null
            ? null
            : `${highlight.nodeId}:${highlight.kind}:${highlight.bandKey}:${
                highlight.kind === "gap" ? highlight.gapAxis : highlight.side
              }`;
        if (highlightIdentity(store.spacingBandHighlight) !== highlightIdentity(nextHighlight)) {
          store.spacingBandHighlight = nextHighlight;
        }

        const hitNode = getNodeFromPointerTarget(store, event.target);
        const hoverNode = hitNode ? resolveShallowSelectionTarget(store, hitNode) : null;
        const nextHoveredId = hoverNode?.id ?? null;
        if (nextHoveredId !== store.hoveredId) {
          store.setHoveredNode(
            nextHoveredId,
            hoverNode ? getNodeCanvasRect(hoverNode, store, viewportRef.current) : null,
          );
        } else if (nextHoveredId && store.hoveredCanvasRect === null) {
          store.setHoveredNode(
            nextHoveredId,
            getNodeCanvasRect(hoverNode!, store, viewportRef.current),
          );
        }
        return;
      }

      if (state.type === "panning") {
        markPanning();
        const nextPan = computePan(state.startPan, state.startMouse, {
          x: event.clientX,
          y: event.clientY,
        });
        store.panX = nextPan.x;
        store.panY = nextPan.y;
        return;
      }

      if (state.type === "marquee") {
        const nextCanvasPoint = getCanvasPoint(event.clientX, event.clientY);
        if (!nextCanvasPoint) return;

        const hasStarted =
          state.started ||
          getPointDistance(state.startMouse, { x: event.clientX, y: event.clientY }) >=
            MARQUEE_SELECTION_DRAG_THRESHOLD;
        if (!hasStarted) return;

        if (!state.started) {
          state.started = true;
          store.marqueeSelecting = true;
        }
        if (!state.selectionTargets) {
          state.selectionTargets = buildMarqueeSelectionTargets(
            store,
            viewportRef.current,
            getExpandedViewportCanvasBounds(store, viewportRef.current, 200),
          );
        }
        const nextMarqueeRect = createCanvasRectFromPoints(state.startCanvas, nextCanvasPoint);
        setMarqueeRect(nextMarqueeRect);
        store.setSelectedIds(
          getMarqueeSelectionIdsFromTargets(
            store,
            nextMarqueeRect,
            state.selectionTargets,
            state.baseSelectedIds,
          ),
        );
        return;
      }

      if (state.type === "inking") {
        const nativeEvent = event.nativeEvent;
        const pointerEvents =
          event.pointerType !== "touch"
            ? getTrackedInkPointerSamples(nativeEvent, state.pointerId)
            : [];
        const nextUseRealPressure =
          state.useRealPressure ||
          pointerEvents.some((sample) => shouldUseRealPressure(event.pointerType, sample.pressure));
        const samples = pointerEvents
          .map((sample) =>
            createInkPoint(
              sample.clientX,
              sample.clientY,
              sample.pressure,
              nextUseRealPressure,
              event.pointerType === "pen",
            ),
          )
          .filter((point): point is InkPoint => point !== null);

        if (samples.length > 0) {
          if (nextUseRealPressure !== state.useRealPressure) {
            interaction.dragState = { ...state, useRealPressure: nextUseRealPressure };
          }
          extendInkSession(samples, nextUseRealPressure, state.pointerId, false);
        }
        return;
      }

      if (state.type === "moving") {
        updateMovingGesture({
          altKey: event.altKey,
          clientX: event.clientX,
          clientY: event.clientY,
          getCanvasPoint,
          interaction,
          shiftKey: event.shiftKey,
          state,
          store,
          viewportEl: viewportRef.current,
        });
        return;
      }

      if (state.type === "rotating") {
        updateRotationGesture(
          { getCanvasPoint, shiftKey: event.shiftKey, state, store },
          event.clientX,
          event.clientY,
        );
        return;
      }

      if (state.type === "resizing-gap") {
        updateGapGesture({
          clientX: event.clientX,
          clientY: event.clientY,
          state,
          store,
        });
        return;
      }

      if (state.type === "resizing-padding") {
        updatePaddingGesture({
          clientX: event.clientX,
          clientY: event.clientY,
          state,
          store,
        });
        return;
      }

      if (state.type === "resizing-selection") {
        updateSelectionResizeGesture({
          clientX: event.clientX,
          clientY: event.clientY,
          shiftKey: event.shiftKey,
          state,
          store,
          viewportEl: viewportRef.current,
        });
        return;
      }

      if (state.type === "resizing") {
        updateNodeResizeGesture({
          clientX: event.clientX,
          clientY: event.clientY,
          shiftKey: event.shiftKey,
          state,
          store,
          viewportEl: viewportRef.current,
        });
      }
    }),
    [
      commitPendingTouchStart,
      createInkPoint,
      extendInkSession,
      getCanvasPoint,
      interaction,
      markPanning,
      markZooming,
      setMarqueeRect,
      store,
      viewportRef,
    ],
  );
}
