import { action, runInAction } from "mobx";
import { useCallback, useEffect, useLayoutEffect, type Dispatch, type RefObject } from "react";
import { asScreenPoint } from "../../core/editor/interaction/coordinate-spaces";
import { computePinchCamera } from "../../core/editor/interaction/math";
import { normalizeWheel } from "../../core/editor/interaction/normalizeWheel";
import type { EditorStore } from "../../core/state/EditorStore";
import type { Point, Rect } from "../../core/types";
import type { ViewportInteractionCoordinator } from "./interaction-coordinator";

interface GestureEventLike extends Event {
  scale: number;
  clientX: number;
  clientY: number;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

export function getPointDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function getPointMidpoint(a: Point, b: Point, rect: DOMRect): Point {
  return {
    x: (a.x + b.x) / 2 - rect.left,
    y: (a.y + b.y) / 2 - rect.top,
  };
}

export function getViewportTouchAction(activeInteractiveSurfaceId: string | null): "auto" | "none" {
  return activeInteractiveSurfaceId ? "auto" : "none";
}

export function useViewportCameraInput({
  interaction,
  resetGestureInteractionState,
  setMarqueeRect,
  store,
  viewportRef,
}: {
  interaction: ViewportInteractionCoordinator;
  resetGestureInteractionState: () => void;
  setMarqueeRect: Dispatch<React.SetStateAction<Rect | null>>;
  store: EditorStore;
  viewportRef: RefObject<HTMLDivElement | null>;
}) {
  const markZooming = useCallback(() => interaction.markZooming(store), [interaction, store]);
  const markPanning = useCallback(() => interaction.markPanning(store), [interaction, store]);

  useEffect(
    () => () => {
      interaction.clearCameraMotion(store);
    },
    [interaction, store],
  );

  const onWheel = useCallback(
    (event: WheelEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-overlay-ui]")) return;

      event.preventDefault();
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!rect) return;
      const delta = normalizeWheel(event);
      const screenPoint = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };

      runInAction(() => {
        if (event.ctrlKey || event.metaKey) {
          markZooming();
          store.zoomWithWheel(delta.z, screenPoint);
        } else {
          markPanning();
          store.pan(delta.x, delta.y);
        }
      });
    },
    [markPanning, markZooming, store, viewportRef],
  );

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [onWheel, viewportRef]);

  // Cache viewport pixel size so camera/culling input never forces layout.
  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    store.setViewportSize(rect.width, rect.height);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const box = entry.contentRect;
      store.setViewportSize(box.width, box.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [store, viewportRef]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element || !("GestureEvent" in window)) return;

    const isWithinViewport = (target: EventTarget | null) =>
      target === element || (target instanceof Node && element.contains(target));
    const getGestureMidpoint = (event: GestureEventLike): Point => {
      const rect = element.getBoundingClientRect();
      return {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };
    };

    const onGestureStart = action((event: Event) => {
      const gesture = event as GestureEventLike;
      if (!isWithinViewport(gesture.target)) return;
      gesture.preventDefault();
      gesture.stopPropagation();

      const midpoint = getGestureMidpoint(gesture);
      interaction.pinchState = {
        mode: "zooming",
        initialDistance: 1,
        initialZoom: store.zoom,
        initialPan: { x: store.panX, y: store.panY },
        initialMidpoint: midpoint,
        previousMidpoint: midpoint,
        source: "gesture",
      };

      interaction.pendingTouchStart = null;
      store.setPointerGestureActive(true);
      setMarqueeRect(null);
      store.dragCanvasOffset.clear();
      store.dragInsertionPreview = null;
      interaction.dragState = { type: "idle" };
    });

    const onGestureChange = action((event: Event) => {
      const gesture = event as GestureEventLike;
      const state = interaction.pinchState;
      if (!isWithinViewport(gesture.target) || !state || state.source !== "gesture") return;
      gesture.preventDefault();
      gesture.stopPropagation();

      const midpoint = getGestureMidpoint(gesture);
      const anchorCanvas = store.screenToCanvas(asScreenPoint(state.previousMidpoint));
      const nextCamera = computePinchCamera(
        anchorCanvas,
        midpoint,
        state.initialZoom * gesture.scale,
      );

      markZooming();
      store.zoom = nextCamera.zoom;
      store.panX = nextCamera.panX;
      store.panY = nextCamera.panY;
      state.previousMidpoint = midpoint;
    });

    const onGestureEnd = action((event: Event) => {
      const gesture = event as GestureEventLike;
      if (!isWithinViewport(gesture.target) || interaction.pinchState?.source !== "gesture") return;
      gesture.preventDefault();
      gesture.stopPropagation();
      interaction.pinchState = null;
      resetGestureInteractionState();
    });

    element.addEventListener("gesturestart", onGestureStart);
    element.addEventListener("gesturechange", onGestureChange);
    element.addEventListener("gestureend", onGestureEnd);

    return () => {
      element.removeEventListener("gesturestart", onGestureStart);
      element.removeEventListener("gesturechange", onGestureChange);
      element.removeEventListener("gestureend", onGestureEnd);
    };
  }, [interaction, markZooming, resetGestureInteractionState, setMarqueeRect, store, viewportRef]);

  return { markPanning, markZooming };
}
