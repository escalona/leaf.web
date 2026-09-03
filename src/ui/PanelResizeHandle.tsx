/**
 * Shared edge-drag resize handle for docked editor panels — one gesture,
 * keyboard, and ARIA implementation for the layers sidebar, the pages list,
 * and the properties panel, so every panel resizes and looks the same.
 *
 * The owner passes its current size and a setter; clamping lives with the
 * owner's store setter so keyboard Home/End and drags share one bounds source.
 */
import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

const PANEL_RESIZE_KEY_STEP = 16;

export type PanelResizeEdge = "start" | "end" | "bottom";

const EDGE_CLASS: Record<PanelResizeEdge, string> = {
  start: "panel-resize-handle-vertical-start",
  end: "panel-resize-handle-vertical",
  bottom: "panel-resize-handle-horizontal",
};

export function PanelResizeHandle({
  edge,
  label,
  name,
  min,
  max,
  value,
  onResize,
}: {
  /** Which panel edge the handle occupies; sets drag direction and styling. */
  edge: PanelResizeEdge;
  /** Accessible name, e.g. "Resize layers sidebar". */
  label: string;
  /** `data-panel-resize-handle` value for tests and tooling. */
  name: string;
  min: number;
  max: number;
  value: number;
  /** Receives the proposed size; the owner's setter clamps and stores it. */
  onResize: (next: number) => void;
}) {
  const gestureRef = useRef<{ pointerId: number; start: number; startSize: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  const horizontal = edge !== "bottom";
  // A "start" edge grows the panel when dragged toward smaller coordinates.
  const sign = edge === "start" ? -1 : 1;

  const begin = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current = {
      pointerId: event.pointerId,
      start: horizontal ? event.clientX : event.clientY,
      startSize: value,
    };
    setResizing(true);
  };

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    const position = horizontal ? event.clientX : event.clientY;
    onResize(gesture.startSize + sign * (position - gesture.start));
  };

  const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    try {
      event.currentTarget.releasePointerCapture(gesture.pointerId);
    } catch {
      // Pointer capture can already be gone after a platform-level cancellation.
    }
    gestureRef.current = null;
    setResizing(false);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const decreaseKey = horizontal ? "ArrowLeft" : "ArrowUp";
    const increaseKey = horizontal ? "ArrowRight" : "ArrowDown";
    let next: number | null = null;
    if (event.key === decreaseKey) next = value - sign * PANEL_RESIZE_KEY_STEP;
    if (event.key === increaseKey) next = value + sign * PANEL_RESIZE_KEY_STEP;
    if (event.key === "Home") next = min;
    if (event.key === "End") next = max;
    if (next === null) return;
    event.preventDefault();
    onResize(next);
  };

  return (
    <div
      aria-label={label}
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      aria-valuemax={max}
      aria-valuemin={min}
      aria-valuenow={value}
      className={`panel-resize-handle ${EDGE_CLASS[edge]}`}
      data-panel-resize-handle={name}
      data-resizing={resizing || undefined}
      onKeyDown={onKeyDown}
      onPointerCancel={finish}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={finish}
      onLostPointerCapture={() => {
        gestureRef.current = null;
        setResizing(false);
      }}
      role="separator"
      tabIndex={0}
    />
  );
}
