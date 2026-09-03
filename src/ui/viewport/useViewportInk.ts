import { action } from "mobx";
import { useCallback, useState, type RefObject } from "react";
import { canvasPoint, type CanvasPoint } from "../../core/editor/interaction/coordinate-spaces";
import { appendInkPoints, buildInkPreview, buildInkShape } from "../../core/editor/ink";
import type { EditorStore } from "../../core/state/EditorStore";
import type { InkPoint } from "../../core/types";
import { findDrawParentFrameId } from "./draw-parenting";
import type { InkSession, ViewportInteractionCoordinator } from "./interaction-coordinator";

export function shouldUseRealPressure(pointerType: string, pressure: number): boolean {
  return pointerType === "pen" && pressure > 0;
}

export function getInkPointerSamples(event: PointerEvent): PointerEvent[] {
  const samples = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
  const allEvents = [...samples, event];
  const deduped: PointerEvent[] = [];

  for (const sample of allEvents) {
    const previous = deduped[deduped.length - 1];
    if (
      previous &&
      previous.clientX === sample.clientX &&
      previous.clientY === sample.clientY &&
      previous.pressure === sample.pressure
    ) {
      continue;
    }
    deduped.push(sample);
  }

  return deduped;
}

export function getTrackedInkPointerSamples(
  event: PointerEvent,
  pointerId: number,
): PointerEvent[] {
  if (event.pointerId !== pointerId) return [];
  return getInkPointerSamples(event).filter((sample) => sample.pointerId === pointerId);
}

export function useViewportInk({
  getCanvasPoint,
  interaction,
  store,
  viewportRef,
}: {
  getCanvasPoint: (clientX: number, clientY: number) => CanvasPoint | null;
  interaction: ViewportInteractionCoordinator;
  store: EditorStore;
  /** The mounted viewport; without it the parent lookup falls back to the DOM. */
  viewportRef?: RefObject<HTMLElement | null>;
}) {
  const [inkSession, setInkSession] = useState<InkSession | null>(null);

  const updateInkSession = useCallback(
    (nextSession: InkSession | null) => {
      interaction.inkSession = nextSession;
      setInkSession(nextSession);
    },
    [interaction],
  );

  const clearInkSession = useCallback(() => {
    updateInkSession(null);
  }, [updateInkSession]);

  const createInkPoint = useCallback(
    (
      clientX: number,
      clientY: number,
      pressure: number,
      useRealPressure: boolean,
      preserveRawPressure: boolean,
    ): InkPoint | null => {
      const canvasPoint = getCanvasPoint(clientX, clientY);
      if (!canvasPoint) return null;
      return {
        x: canvasPoint.x,
        y: canvasPoint.y,
        pressure: useRealPressure || preserveRawPressure ? pressure : 0.5,
      };
    },
    [getCanvasPoint],
  );

  const extendInkSession = useCallback(
    (samples: InkPoint[], useRealPressure: boolean, pointerId: number, last: boolean) => {
      const previousSession = interaction.inkSession;
      const nextPoints = appendInkPoints(previousSession?.points ?? [], samples);
      const preview = buildInkPreview(nextPoints, { useRealPressure, last });
      if (!preview) return;
      updateInkSession({
        pathData: preview.pathData,
        points: nextPoints,
        pointerId,
        useRealPressure,
      });
    },
    [interaction, updateInkSession],
  );

  const commitInkSession = useCallback(
    action(() => {
      const currentSession = interaction.inkSession;
      clearInkSession();
      if (!currentSession) return;

      const inkShape = buildInkShape(currentSession.points, currentSession.useRealPressure);
      if (!inkShape) return;

      // The stroke is parented by where it was pressed, exactly as the shape
      // tools parent a draw: the deepest unlocked frame under the press point.
      // Parenting by the current selection instead let a stroke drawn on empty
      // canvas land inside a clipping artboard it never touched and vanish.
      const pressPoint = currentSession.points[0]!;
      const viewportEl =
        viewportRef?.current ?? document.querySelector<HTMLElement>("[data-viewport]");
      const parentId = findDrawParentFrameId(
        store,
        viewportEl,
        canvasPoint(pressPoint.x, pressPoint.y),
      );
      const node = store.runtime.createSvg(
        inkShape.svgMarkup,
        {
          width: inkShape.bounds.width,
          height: inkShape.bounds.height,
        },
        {
          x: inkShape.bounds.x,
          y: inkShape.bounds.y,
        },
        "Ink Stroke",
        parentId,
      );
      store.selectNode(node.id);
    }),
    [clearInkSession, interaction, store, viewportRef],
  );

  return {
    clearInkSession,
    commitInkSession,
    createInkPoint,
    extendInkSession,
    inkSession,
  };
}
