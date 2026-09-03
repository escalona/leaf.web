import type { Point } from "../../types";

export type PinchGestureMode = "not sure" | "zooming" | "panning";

type ResolvePinchGestureModeOptions = {
  mode: PinchGestureMode;
  initialDistance: number;
  currentDistance: number;
  initialMidpoint: Point;
  currentMidpoint: Point;
};

const TOUCH_ZOOM_THRESHOLD = 24;
const TOUCH_PAN_THRESHOLD = 16;
const TOUCH_PAN_TO_ZOOM_THRESHOLD = 64;

/**
 * Classify two-finger touch intent so panning does not immediately become
 * zooming.
 */
export function resolvePinchGestureMode({
  mode,
  initialDistance,
  currentDistance,
  initialMidpoint,
  currentMidpoint,
}: ResolvePinchGestureModeOptions): PinchGestureMode {
  if (mode === "zooming") {
    return mode;
  }

  const touchDistance = Math.abs(currentDistance - initialDistance);
  const originDistance = Math.hypot(
    currentMidpoint.x - initialMidpoint.x,
    currentMidpoint.y - initialMidpoint.y,
  );

  switch (mode) {
    case "not sure":
      if (touchDistance > TOUCH_ZOOM_THRESHOLD) {
        return "zooming";
      }
      if (originDistance > TOUCH_PAN_THRESHOLD) {
        return "panning";
      }
      return mode;
    case "panning":
      if (touchDistance > TOUCH_PAN_TO_ZOOM_THRESHOLD) {
        return "zooming";
      }
      return mode;
    default:
      return mode;
  }
}
