import type { DragEvent } from "react";
import { useCallback, useEffect, useRef } from "react";

/** Distance from the list's top/bottom edge, in px, within which dragging scrolls it. */
export const LAYER_DRAG_SCROLL_EDGE = 32;
/** Scroll speed at the very edge, in px per animation frame. */
export const LAYER_DRAG_SCROLL_MAX_SPEED = 14;

/**
 * Scroll velocity for a pointer at `pointerY` over a list spanning
 * `top..bottom`: negative near the top edge, positive near the bottom, zero in
 * the middle, ramping linearly so the list creeps at the edge's inner boundary
 * and races at the very edge. Beyond the list (the pointer left it while the
 * browser keeps firing dragover on a captured row) it scrolls at full speed.
 */
export function getLayerDragScrollVelocity(
  pointerY: number,
  top: number,
  bottom: number,
  { edge = LAYER_DRAG_SCROLL_EDGE, maxSpeed = LAYER_DRAG_SCROLL_MAX_SPEED } = {},
): number {
  if (bottom - top <= edge * 2) return 0;
  if (pointerY < top + edge) {
    const depth = Math.min(1, (top + edge - pointerY) / edge);
    return -Math.ceil(depth * maxSpeed);
  }
  if (pointerY > bottom - edge) {
    const depth = Math.min(1, (pointerY - (bottom - edge)) / edge);
    return Math.ceil(depth * maxSpeed);
  }
  return 0;
}

/**
 * Edge auto-scroll for the layers list's HTML5 drag. `dragover` near the top
 * or bottom edge starts a requestAnimationFrame loop that nudges `scrollTop`
 * each frame; the loop stops when the pointer moves back inside, the drag
 * drops, ends, or leaves the list, or the panel unmounts.
 *
 * Native drag does not fire pointer events, and `dragover` only fires while
 * the pointer moves — so a pointer parked at the edge would stall without the
 * frame loop.
 */
export function useLayerDragAutoScroll(scrollRef: { current: HTMLElement | null }) {
  const velocityRef = useRef(0);
  const frameRef = useRef<number | null>(null);

  const stop = useCallback(() => {
    velocityRef.current = 0;
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  const tick = useCallback(() => {
    frameRef.current = null;
    const element = scrollRef.current;
    const velocity = velocityRef.current;
    if (!element || velocity === 0) return;
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    const next = Math.min(maxScrollTop, Math.max(0, element.scrollTop + velocity));
    if (next !== element.scrollTop) {
      element.scrollTop = next;
      // The panel virtualizes rows from its own scroll state, which listens
      // for `scroll`; a programmatic scrollTop write fires it in browsers,
      // but not in every test DOM, so say it explicitly.
      element.dispatchEvent(new Event("scroll"));
    }
    if ((velocity < 0 && next === 0) || (velocity > 0 && next === maxScrollTop)) return;
    frameRef.current = requestAnimationFrame(tick);
  }, [scrollRef]);

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLElement>) => {
      const element = scrollRef.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const velocity = getLayerDragScrollVelocity(event.clientY, rect.top, rect.bottom);
      velocityRef.current = velocity;
      if (velocity === 0) {
        stop();
        return;
      }
      if (frameRef.current === null) frameRef.current = requestAnimationFrame(tick);
    },
    [scrollRef, stop, tick],
  );

  useEffect(() => stop, [stop]);

  return { handleDragOver, stop };
}
