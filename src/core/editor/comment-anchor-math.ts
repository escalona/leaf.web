/**
 * Pure comment-anchor math shared by the pin overlay (live DOM rects) and the
 * delete-time anchor lifecycle (model rects). One formula for how a normalized
 * `u`/`v` inside a node's unrotated bounds becomes a canvas point — and back.
 * Both callers pass the node's canvas-space box and its WORLD rotation, so the
 * ancestor chain is already composed before it gets here.
 */

export type AnchorRect = { x: number; y: number; width: number; height: number };
export type AnchorPoint = { x: number; y: number };

function rotateAboutPoint(point: AnchorPoint, center: AnchorPoint, degrees: number): AnchorPoint {
  if (!degrees) return point;
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
}

/** Canvas point of a normalized anchor inside `rect`, rotated with the node. */
export function anchorPointForRect(
  rect: AnchorRect,
  rotation: number,
  u: number,
  v: number,
): AnchorPoint {
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const unrotated = { x: rect.x + u * rect.width, y: rect.y + v * rect.height };
  return rotateAboutPoint(unrotated, center, rotation);
}

export type RegionAnchorRect = { x: number; y: number; w: number; h: number };

/** The canvas point of a region anchor's pin corner. */
export function regionPinPoint(region: RegionAnchorRect, pinX: number, pinY: number): AnchorPoint {
  return { x: region.x + pinX * region.w, y: region.y + pinY * region.h };
}

/**
 * The normalized region between a drag's origin and its current point. The pin
 * corner follows the drag direction — drag up-left, pin top-left — so the
 * composer opens at the cursor.
 */
export function regionBetween(
  origin: AnchorPoint,
  current: AnchorPoint,
): RegionAnchorRect & { pinX: number; pinY: number } {
  return {
    x: Math.min(origin.x, current.x),
    y: Math.min(origin.y, current.y),
    w: Math.abs(current.x - origin.x),
    h: Math.abs(current.y - origin.y),
    pinX: current.x >= origin.x ? 1 : 0,
    pinY: current.y >= origin.y ? 1 : 0,
  };
}

/** Normalized `u`/`v` of a canvas point inside `rect`, undoing the rotation. */
export function normalizedAnchorInRect(
  rect: AnchorRect,
  rotation: number,
  point: AnchorPoint,
): { u: number; v: number } {
  if (rect.width <= 0 || rect.height <= 0) return { u: 0.5, v: 0.5 };
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const local = rotateAboutPoint(point, center, -rotation);
  return { u: (local.x - rect.x) / rect.width, v: (local.y - rect.y) / rect.height };
}
