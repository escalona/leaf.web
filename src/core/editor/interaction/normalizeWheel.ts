const MAX_ZOOM_STEP = 10;

type WheelLikeEvent = Pick<WheelEvent, "deltaX" | "deltaY" | "ctrlKey" | "metaKey">;

export type NormalizedWheelDelta = {
  x: number;
  y: number;
  z: number;
};

function normalizeSignedZero(value: number) {
  return Object.is(value, -0) ? 0 : value;
}

/**
 * Normalize wheel deltas so zoom gestures feel consistent across mice and trackpads.
 */
export function normalizeWheel(event: WheelLikeEvent): NormalizedWheelDelta {
  let deltaZ = 0;

  if (event.ctrlKey || event.metaKey) {
    const zoomDelta =
      Math.abs(event.deltaY) > MAX_ZOOM_STEP
        ? MAX_ZOOM_STEP * Math.sign(event.deltaY)
        : event.deltaY;
    deltaZ = zoomDelta / 100;
  }

  return {
    x: normalizeSignedZero(-event.deltaX),
    y: normalizeSignedZero(-event.deltaY),
    z: normalizeSignedZero(-deltaZ),
  };
}
