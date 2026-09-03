import { action } from "mobx";
import { useCallback, type Dispatch, type SetStateAction } from "react";
import { getDefaultSizeIfNeeded } from "../../core/editor/interaction/math";
import type { EditorStore } from "../../core/state/EditorStore";
import type { InkPoint, Rect } from "../../core/types";
import type { ViewportInteractionCoordinator } from "./interaction-coordinator";
import { setTransformHud } from "./interaction-helpers";
import type { PointerInteractionStart } from "./useViewportPointerStart";
import { getTrackedInkPointerSamples, shouldUseRealPressure } from "./useViewportInk";

export function useViewportPointerEnd({
  clearInkSession,
  clearMovingDragState,
  commitInkSession,
  createInkPoint,
  endHistoryTransaction,
  extendInkSession,
  finishMovingDrag,
  interaction,
  cancelGestureInteractionState,
  resetGestureInteractionState,
  setMarqueeRect,
  startPointerInteraction,
  store,
}: {
  clearInkSession: () => void;
  clearMovingDragState: (options?: { preserveGeometry?: boolean }) => void;
  commitInkSession: () => void;
  createInkPoint: (
    clientX: number,
    clientY: number,
    pressure: number,
    useRealPressure: boolean,
    preserveRawPressure: boolean,
  ) => InkPoint | null;
  endHistoryTransaction: () => void;
  extendInkSession: (
    samples: InkPoint[],
    useRealPressure: boolean,
    pointerId: number,
    last: boolean,
  ) => void;
  finishMovingDrag: () => void;
  interaction: ViewportInteractionCoordinator;
  cancelGestureInteractionState: () => boolean;
  resetGestureInteractionState: () => void;
  setMarqueeRect: Dispatch<SetStateAction<Rect | null>>;
  startPointerInteraction: (input: PointerInteractionStart) => void;
  store: EditorStore;
}) {
  return useCallback(
    action((event: React.PointerEvent<HTMLDivElement>) => {
      setTransformHud(null);
      const wasPinching = interaction.pinchState !== null;
      if (event.pointerType === "touch") {
        const hasTrackedTouch = interaction.activeTouchPoints.has(event.pointerId);
        const hasPendingTouch = interaction.pendingTouchStart?.pointerId === event.pointerId;
        if (!hasTrackedTouch && !hasPendingTouch) return;

        interaction.activeTouchPoints.delete(event.pointerId);
        if (interaction.activeTouchPoints.size < 2 && interaction.pinchState?.source === "touch") {
          interaction.pinchState = null;
        }

        if (hasPendingTouch) {
          if (
            wasPinching ||
            event.type === "pointercancel" ||
            interaction.activeTouchPoints.size > 0
          ) {
            interaction.pendingTouchStart = null;
          } else {
            const pending = interaction.pendingTouchStart;
            interaction.pendingTouchStart = null;
            if (pending) {
              startPointerInteraction({
                ...pending,
                commitSource: "up",
                currentTarget: event.currentTarget,
                pointerType: "touch",
                pressure: pending.pressure,
                accelKey: pending.accelKey,
                shouldCapture: false,
              });
            }
          }
        }
      }

      if (wasPinching) {
        resetGestureInteractionState();
        return;
      }

      if (interaction.pinchState) return;
      const state = interaction.dragState;
      if (interaction.activePointerId !== null && event.pointerId !== interaction.activePointerId) {
        return;
      }

      if (event.type === "pointercancel") {
        if (state.type === "inking" && event.pointerId !== state.pointerId) return;
        interaction.pendingTouchStart = null;
        cancelGestureInteractionState();
        return;
      }

      interaction.activePointerId = null;
      store.setPointerGestureActive(false);

      if (state.type === "inking") {
        const nativeEvent = event.nativeEvent;
        const pointerEvents =
          event.pointerType !== "touch"
            ? getTrackedInkPointerSamples(nativeEvent, state.pointerId)
            : [];

        if (nativeEvent.pointerId !== state.pointerId) return;

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
          extendInkSession(samples, nextUseRealPressure, state.pointerId, true);
        }
        commitInkSession();
        endHistoryTransaction();
        interaction.dragState = { type: "idle" };
        return;
      }

      if (state.type === "marquee") {
        // A plain click on empty canvas (marquee that never started
        // dragging) exits the entered container without requiring Escape.
        // An actual marquee drag keeps the scope it started in so its
        // selection stays scoped to the entered container.
        if (!state.started) store.retargetContainerScope(null);
        setMarqueeRect(null);
        store.marqueeSelecting = false;
        interaction.dragState = { type: "idle" };
        endHistoryTransaction();
        return;
      }

      if (state.type === "resizing") {
        const node = store.getNode(state.nodeId);
        if (state.isCreating && node && store.activeTool !== node.type) {
          cancelGestureInteractionState();
          return;
        }
        if (node) {
          if (state.isCreating) {
            const defaultSize = getDefaultSizeIfNeeded(node.width, node.height, node.type);
            if (defaultSize) {
              const [width, height] = defaultSize;
              store.runtime.updateNode(state.nodeId, { width, height });
            }
          }
        }

        if (store.activeTool !== "select" && store.activeTool !== "pan") {
          store.setTool("select");
        }
      }

      if (state.type === "moving") {
        if (!state.started && state.activateOnClickId) {
          const interactionTargetId = state.activateOnClickId;
          clearMovingDragState();
          endHistoryTransaction();
          interaction.dragState = { type: "idle" };
          store.activateInteraction(interactionTargetId);
          interaction.lastClickTime = 0;
          interaction.lastClickNodeId = null;
          return;
        }
        // A group-area press that never moved is a plain empty-canvas click:
        // clear the selection and pop the container scope, matching what the
        // marquee path would have done for this click.
        if (!state.started && state.deselectOnClick) {
          clearMovingDragState();
          endHistoryTransaction();
          interaction.dragState = { type: "idle" };
          store.deselectAll();
          store.retargetContainerScope(null);
          return;
        }
        finishMovingDrag();
        return;
      }

      store.dragCanvasOffset.clear();
      store.snapGuides = [];
      interaction.clearTargetCaches();
      store.dragInsertionPreview = null;
      // The spacing gestures pin the band highlight at pointerdown; clear it
      // here so it cannot outlive the gesture when no hover move follows
      // (touch lift-off, pointerup outside the viewport).
      if (state.type === "resizing-gap" || state.type === "resizing-padding") {
        store.spacingBandHighlight = null;
      }
      endHistoryTransaction();
      interaction.dragState = { type: "idle" };
    }),
    [
      clearInkSession,
      clearMovingDragState,
      cancelGestureInteractionState,
      commitInkSession,
      createInkPoint,
      endHistoryTransaction,
      extendInkSession,
      finishMovingDrag,
      interaction,
      resetGestureInteractionState,
      setMarqueeRect,
      startPointerInteraction,
      store,
    ],
  );
}
