/**
 * Pure functions for canvas interaction math — resize, move, pan, pinch zoom.
 * Extracted from Viewport.tsx for testability.
 */

import type { CompassDirection, Point, Rect, Size, SnapGuide } from "../../types";

/** Minimum size in pixels for any dimension during resize */
export const MIN_SIZE = 10;

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 10;

/** Degrees the rotate gizmo quantizes to while Shift is held. */
export const ROTATION_SNAP_DEGREES = 15;

/** Canvas-space distance an arrow key moves the selection. */
export const NUDGE_STEP = 1;
export const NUDGE_LARGE_STEP = 10;

const DEGREES_TO_RADIANS = Math.PI / 180;

/** Rotate a vector clockwise by `degrees`, matching CSS `rotate()` in a y-down space. */
export function rotateVector(vector: Point, degrees: number): Point {
  if (degrees === 0) return { x: vector.x, y: vector.y };
  const radians = degrees * DEGREES_TO_RADIANS;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: vector.x * cos - vector.y * sin,
    y: vector.x * sin + vector.y * cos,
  };
}

export function rotatePointAround(point: Point, center: Point, degrees: number): Point {
  const rotated = rotateVector({ x: point.x - center.x, y: point.y - center.y }, degrees);
  return { x: center.x + rotated.x, y: center.y + rotated.y };
}

/** Fold an angle into [0, 360). */
export function normalizeAngle(degrees: number): number {
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

export function snapAngle(degrees: number, step = ROTATION_SNAP_DEGREES): number {
  if (step <= 0) return degrees;
  return Math.round(degrees / step) * step;
}

/** Angle in degrees from `center` to `point`, measured clockwise from +x. */
export function getAngleFromCenter(center: Point, point: Point): number {
  return Math.atan2(point.y - center.y, point.x - center.x) / DEGREES_TO_RADIANS;
}

/**
 * A node's own box plus the rotation the renderer applies about its center.
 *
 * Hit-testing works on this rather than a bare `Rect` because a rotated node's
 * axis-aligned bounding box covers area the node does not: a 45°-turned square
 * only fills half of it. `MarqueeSelectionTarget` and `FrameDropTarget` are
 * structurally oriented boxes, so they pass to these predicates directly.
 */
export type OrientedBox = { rect: Rect; rotation: number };

function rectsIntersect(a: Rect, b: Rect) {
  return (
    a.x + a.width >= b.x && a.x <= b.x + b.width && a.y + a.height >= b.y && a.y <= b.y + b.height
  );
}

function rectContainsRect(outer: Rect, inner: Rect) {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function getRectCorners(rect: Rect): Point[] {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
}

function getRectCenter(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** The axis-aligned box that contains every one of `points`. */
function getPointsBounds(points: readonly Point[]): Rect {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * The box's canvas-space corners, starting at its local top-left and winding
 * the same way a y-down rect does. Rotation preserves that winding, so callers
 * can rely on it for polygon clipping.
 */
function getOrientedBoxCorners({ rect, rotation }: OrientedBox): Point[] {
  const corners = getRectCorners(rect);
  if (!rotation) return corners;
  const center = getRectCenter(rect);
  return corners.map((corner) => rotatePointAround(corner, center, rotation));
}

/** The axis-aligned box that contains all of a rotated rect. */
export function getRotatedBounds(rect: Rect, rotation: number): Rect {
  if (!rotation) return rect;
  return getPointsBounds(getOrientedBoxCorners({ rect, rotation }));
}

/**
 * True when `point` falls inside the box's real, rotated area, expanded by
 * `margin` in the box's own frame.
 */
export function orientedBoxContainsPoint(
  { rect, rotation }: OrientedBox,
  point: Point,
  margin = 0,
): boolean {
  const local = rotation ? rotatePointAround(point, getRectCenter(rect), -rotation) : point;
  return (
    local.x >= rect.x - margin &&
    local.x <= rect.x + rect.width + margin &&
    local.y >= rect.y - margin &&
    local.y <= rect.y + rect.height + margin
  );
}

/**
 * True when the box's rotated area overlaps the axis-aligned `other`.
 *
 * Two convex boxes are separated only along one of the four edge normals they
 * contribute, and an interval test along a shape's own two normals is exactly
 * an overlap test of both extents measured in that shape's frame. So the
 * world-frame comparison covers `other`'s normals and the box-frame one covers
 * the box's — the same four tests a separating-axis loop would run. Touching
 * counts as overlapping, matching the plain-rect predicate it replaces.
 */
export function orientedBoxIntersectsRect(box: OrientedBox, other: Rect): boolean {
  if (!box.rotation) return rectsIntersect(box.rect, other);
  if (!rectsIntersect(getRotatedBounds(box.rect, box.rotation), other)) return false;
  const center = getRectCenter(box.rect);
  const localOther = getRectCorners(other).map((corner) =>
    rotatePointAround(corner, center, -box.rotation),
  );
  return rectsIntersect(box.rect, getPointsBounds(localOther));
}

/** `other`'s extents measured in `box`'s own frame, against `box`'s own rect. */
function extentsOverlapInBoxFrame(box: OrientedBox, other: OrientedBox): boolean {
  const center = getRectCenter(box.rect);
  const localCorners = getOrientedBoxCorners(other).map((corner) =>
    rotatePointAround(corner, center, -box.rotation),
  );
  return rectsIntersect(box.rect, getPointsBounds(localCorners));
}

/**
 * True when two rotated areas cover any of the same canvas.
 *
 * The separating-axis argument from `orientedBoxIntersectsRect`, run once in
 * each box's frame: a pair of convex boxes is separated only along one of the
 * four edge normals they contribute, and an extent test inside one box's frame
 * is exactly the pair of tests for that box's normals. Touching counts as
 * overlapping, matching the predicates above.
 */
export function orientedBoxesIntersect(box: OrientedBox, other: OrientedBox): boolean {
  if (!box.rotation) return orientedBoxIntersectsRect(other, box.rect);
  if (!other.rotation) return orientedBoxIntersectsRect(box, other.rect);
  const bounds = getRotatedBounds(box.rect, box.rotation);
  const otherBounds = getRotatedBounds(other.rect, other.rotation);
  if (!rectsIntersect(bounds, otherBounds)) return false;
  return extentsOverlapInBoxFrame(box, other) && extentsOverlapInBoxFrame(other, box);
}

/**
 * True when the axis-aligned `rect` encloses the box's rotated area. A rect
 * holds every corner exactly when it holds the box those corners bound.
 */
export function rectContainsOrientedBox(rect: Rect, box: OrientedBox): boolean {
  return rectContainsRect(rect, getRotatedBounds(box.rect, box.rotation));
}

/** Signed-area sum for a polygon wound the way `getOrientedBoxCorners` winds. */
function getPolygonArea(points: readonly Point[]) {
  let total = 0;
  for (let index = 0; index < points.length; index++) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    total += current.x * next.y - next.x * current.y;
  }
  return Math.abs(total) / 2;
}

/** Sutherland–Hodgman clip of a convex `subject` against a convex `clip`. */
function clipConvexPolygon(subject: readonly Point[], clip: readonly Point[]): Point[] {
  let output: Point[] = subject.slice();

  for (let index = 0; index < clip.length && output.length > 0; index++) {
    const edgeStart = clip[index]!;
    const edgeEnd = clip[(index + 1) % clip.length]!;
    const edgeX = edgeEnd.x - edgeStart.x;
    const edgeY = edgeEnd.y - edgeStart.y;
    const side = (point: Point) =>
      edgeX * (point.y - edgeStart.y) - edgeY * (point.x - edgeStart.x);

    const input = output;
    output = [];
    for (let vertex = 0; vertex < input.length; vertex++) {
      const current = input[vertex]!;
      const previous = input[(vertex + input.length - 1) % input.length]!;
      const currentSide = side(current);
      const previousSide = side(previous);

      if (currentSide >= 0) {
        if (previousSide < 0) {
          const t = previousSide / (previousSide - currentSide);
          output.push({
            x: previous.x + (current.x - previous.x) * t,
            y: previous.y + (current.y - previous.y) * t,
          });
        }
        output.push(current);
      } else if (previousSide >= 0) {
        const t = previousSide / (previousSide - currentSide);
        output.push({
          x: previous.x + (current.x - previous.x) * t,
          y: previous.y + (current.y - previous.y) * t,
        });
      }
    }
  }

  return output;
}

/**
 * Canvas area the two boxes share. Drop-target resolution ranks candidates by
 * it, so a rotated frame must not claim the corners of its bounding box.
 */
export function getOrientedBoxOverlapArea(box: OrientedBox, other: OrientedBox): number {
  if (!box.rotation && !other.rotation) {
    const overlapWidth =
      Math.min(box.rect.x + box.rect.width, other.rect.x + other.rect.width) -
      Math.max(box.rect.x, other.rect.x);
    const overlapHeight =
      Math.min(box.rect.y + box.rect.height, other.rect.y + other.rect.height) -
      Math.max(box.rect.y, other.rect.y);
    if (overlapWidth <= 0 || overlapHeight <= 0) return 0;
    return overlapWidth * overlapHeight;
  }

  return getPolygonArea(
    clipConvexPolygon(getOrientedBoxCorners(box), getOrientedBoxCorners(other)),
  );
}

/**
 * One shared rotation delta for a gizmo drag.
 *
 * Snapping quantizes the angle of the box the user grabbed — a single node's own
 * angle, or 0 for the axis-aligned box around a multi-node selection — and the
 * resulting delta then goes to every member unchanged. Snapping each member's
 * own absolute angle instead would hand them different deltas and the selection
 * would stop turning as a rigid body.
 */
export function computeRotationDelta(
  boundsRotation: number,
  startPointerAngle: number,
  currentPointerAngle: number,
  snap = false,
): number {
  const delta = currentPointerAngle - startPointerAngle;
  if (!snap) return delta;
  return snapAngle(boundsRotation + delta) - boundsRotation;
}

/**
 * Resize a rotated node along its own axes.
 *
 * The pointer delta is taken into the node's local frame, resized there, and the
 * resulting local-center shift is taken back out. That keeps the handle opposite
 * the dragged one pinned where the user sees it. With no rotation this is
 * exactly `computeResize`.
 *
 * The two ends of the gesture live in different spaces, so they use different
 * angles. `dx`/`dy` arrive in canvas space, where the node is turned by
 * everything CSS applies to it — its own `rotation` plus `ancestorRotation` —
 * so that sum brings the drag into the node's frame. `startRect` and the rect
 * returned are parent-local, and only the node's OWN rotation stands between
 * its frame and its parent's, so that is what takes the center shift back out.
 * With no rotated ancestor both angles are the node's own, which is what this
 * has always computed.
 */
export function computeResizeWithRotation(
  startRect: Rect,
  direction: CompassDirection,
  dx: number,
  dy: number,
  rotation: number,
  ancestorRotation = 0,
  preserveAspectRatio = false,
): Rect {
  if (!rotation && !ancestorRotation) {
    return computeResize(startRect, direction, dx, dy, preserveAspectRatio);
  }

  const localDelta = rotateVector({ x: dx, y: dy }, -(rotation + ancestorRotation));
  const localRect = computeResize(
    startRect,
    direction,
    localDelta.x,
    localDelta.y,
    preserveAspectRatio,
  );

  const startCenter = {
    x: startRect.x + startRect.width / 2,
    y: startRect.y + startRect.height / 2,
  };
  const localCenter = {
    x: localRect.x + localRect.width / 2,
    y: localRect.y + localRect.height / 2,
  };
  const parentCenterDelta = rotateVector(
    { x: localCenter.x - startCenter.x, y: localCenter.y - startCenter.y },
    rotation,
  );

  return {
    x: Math.round(startCenter.x + parentCenterDelta.x - localRect.width / 2),
    y: Math.round(startCenter.y + parentCenterDelta.y - localRect.height / 2),
    width: localRect.width,
    height: localRect.height,
  };
}

/** Drop the smaller component of a drag delta so the move follows one axis. */
export function applyAxisLock(dx: number, dy: number, enabled: boolean) {
  if (!enabled) return { dx, dy };
  return Math.abs(dx) >= Math.abs(dy) ? { dx, dy: 0 } : { dx: 0, dy };
}

/**
 * Map every member of a multi-node selection through the scale implied by the
 * group's bounding box moving from `startUnion` to `nextUnion`.
 *
 * Members move by their center rather than their origin. At rotation 0 the two
 * are algebraically the same, but a rotated member's local box is not its
 * contribution to the union — only its center is shared between the two frames.
 */
export function computeGroupResize(
  startUnion: Rect,
  nextUnion: Rect,
  startRects: ReadonlyMap<string, Rect>,
): Map<string, Rect> {
  const scaleX = startUnion.width > 0 ? nextUnion.width / startUnion.width : 1;
  const scaleY = startUnion.height > 0 ? nextUnion.height / startUnion.height : 1;
  const result = new Map<string, Rect>();

  for (const [id, rect] of startRects) {
    const width = Math.max(1, Math.round(rect.width * scaleX));
    const height = Math.max(1, Math.round(rect.height * scaleY));
    const centerX = nextUnion.x + (rect.x + rect.width / 2 - startUnion.x) * scaleX;
    const centerY = nextUnion.y + (rect.y + rect.height / 2 - startUnion.y) * scaleY;
    result.set(id, {
      x: Math.round(centerX - width / 2),
      y: Math.round(centerY - height / 2),
      width,
      height,
    });
  }

  return result;
}

export type AlignEdge =
  | "left"
  | "horizontal-center"
  | "right"
  | "top"
  | "vertical-center"
  | "bottom";

export type DistributeAxis = "horizontal" | "vertical";

/**
 * Canvas-space deltas that align every rect to the selection's own bounding box.
 * Callers add these to model positions, so a rect already on the edge yields 0.
 */
export function computeAlignDeltas(
  rects: ReadonlyMap<string, Rect>,
  edge: AlignEdge,
): Map<string, Point> {
  const deltas = new Map<string, Point>();
  const bounds = computeSelectionBounds(Array.from(rects.values()));
  if (!bounds) return deltas;

  for (const [id, rect] of rects) {
    let dx = 0;
    let dy = 0;
    switch (edge) {
      case "left":
        dx = bounds.x - rect.x;
        break;
      case "horizontal-center":
        dx = bounds.x + bounds.width / 2 - (rect.x + rect.width / 2);
        break;
      case "right":
        dx = bounds.x + bounds.width - (rect.x + rect.width);
        break;
      case "top":
        dy = bounds.y - rect.y;
        break;
      case "vertical-center":
        dy = bounds.y + bounds.height / 2 - (rect.y + rect.height / 2);
        break;
      case "bottom":
        dy = bounds.y + bounds.height - (rect.y + rect.height);
        break;
    }
    deltas.set(id, { x: Math.round(dx), y: Math.round(dy) });
  }

  return deltas;
}

/**
 * Canvas-space deltas that equalize the gaps between rects along one axis.
 * The outermost two rects stay put, which is what makes repeated presses stable.
 */
export function computeDistributeDeltas(
  rects: ReadonlyMap<string, Rect>,
  axis: DistributeAxis,
): Map<string, Point> {
  const deltas = new Map<string, Point>();
  const entries = Array.from(rects.entries());
  if (entries.length < 3) return deltas;

  const isHorizontal = axis === "horizontal";
  const start = (rect: Rect) => (isHorizontal ? rect.x : rect.y);
  const size = (rect: Rect) => (isHorizontal ? rect.width : rect.height);

  entries.sort(([, a], [, b]) => start(a) - start(b));

  const first = entries[0]![1];
  const last = entries[entries.length - 1]![1];
  const span = start(last) + size(last) - start(first);
  const occupied = entries.reduce((total, [, rect]) => total + size(rect), 0);
  const gap = (span - occupied) / (entries.length - 1);

  let cursor = start(first);
  for (const [id, rect] of entries) {
    const delta = Math.round(cursor - start(rect));
    deltas.set(id, isHorizontal ? { x: delta, y: 0 } : { x: 0, y: delta });
    cursor += size(rect) + gap;
  }

  return deltas;
}

/** Default sizes per node type, used when a drawn node is too small */
export const DEFAULT_SIZES: Record<string, [number, number]> = {
  frame: [300, 200],
  text: [200, 40],
  rectangle: [150, 150],
  svg: [400, 300],
  "interactive-surface": [1440, 900],
};

/**
 * Compute the new rect after a resize drag.
 * @param startRect  The node's rect when the drag began
 * @param direction  Which handle/edge is being dragged
 * @param dx         Mouse delta in canvas-space (already divided by zoom)
 * @param dy         Mouse delta in canvas-space (already divided by zoom)
 * @param preserveAspectRatio  When true, scales proportionally from the opposite handle anchor
 */
export function computeResize(
  startRect: Rect,
  direction: CompassDirection,
  dx: number,
  dy: number,
  preserveAspectRatio = false,
): Rect {
  if (preserveAspectRatio) {
    // Draw gestures begin from a synthetic zero-sized southeast resize. They
    // have no existing aspect ratio to preserve, so Shift supplies the
    // conventional 1:1 ratio from the pointer delta instead.
    if (startRect.width === 0 && startRect.height === 0 && direction === "se") {
      const size = Math.max(MIN_SIZE, Math.abs(dx), Math.abs(dy));
      return {
        x: Math.round(startRect.x + (dx < 0 ? -size : 0)),
        y: Math.round(startRect.y + (dy < 0 ? -size : 0)),
        width: Math.round(size),
        height: Math.round(size),
      };
    }
    if (startRect.width > 0 && startRect.height > 0) {
      const minScale = Math.max(MIN_SIZE / startRect.width, MIN_SIZE / startRect.height);
      const clampScale = (scale: number) => Math.max(minScale, scale);
      const centerX = startRect.x + startRect.width / 2;
      const centerY = startRect.y + startRect.height / 2;
      const right = startRect.x + startRect.width;
      const bottom = startRect.y + startRect.height;

      let scale: number;

      if (direction === "e") {
        scale = clampScale((startRect.width + dx) / startRect.width);
      } else if (direction === "w") {
        scale = clampScale((startRect.width - dx) / startRect.width);
      } else if (direction === "s") {
        scale = clampScale((startRect.height + dy) / startRect.height);
      } else if (direction === "n") {
        scale = clampScale((startRect.height - dy) / startRect.height);
      } else {
        // Project the pointer onto the locked diagonal so off-axis drags stay stable.
        const diagonalX = direction.includes("e") ? startRect.width : -startRect.width;
        const diagonalY = direction.includes("s") ? startRect.height : -startRect.height;
        const projectedScale =
          ((diagonalX + dx) * diagonalX + (diagonalY + dy) * diagonalY) /
          (diagonalX * diagonalX + diagonalY * diagonalY);
        scale = clampScale(projectedScale);
      }

      const width = startRect.width * scale;
      const height = startRect.height * scale;

      let x = startRect.x;
      let y = startRect.y;

      switch (direction) {
        case "e":
          y = centerY - height / 2;
          break;
        case "w":
          x = right - width;
          y = centerY - height / 2;
          break;
        case "s":
          x = centerX - width / 2;
          break;
        case "n":
          x = centerX - width / 2;
          y = bottom - height;
          break;
        case "se":
          break;
        case "nw":
          x = right - width;
          y = bottom - height;
          break;
        case "ne":
          y = bottom - height;
          break;
        case "sw":
          x = right - width;
          break;
      }

      return {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
      };
    }
  }

  // The same synthetic zero-sized draw, unmodified: the pointer is free to cross
  // the press point, and the box flips to follow it instead of pinning its
  // top-left there and clamping to MIN_SIZE. A drag up-left therefore commits
  // the box the user dragged out, exactly as the Shift branch above does.
  if (startRect.width === 0 && startRect.height === 0 && direction === "se") {
    const width = Math.max(MIN_SIZE, Math.abs(dx));
    const height = Math.max(MIN_SIZE, Math.abs(dy));
    return {
      x: Math.round(startRect.x + (dx < 0 ? -width : 0)),
      y: Math.round(startRect.y + (dy < 0 ? -height : 0)),
      width: Math.round(width),
      height: Math.round(height),
    };
  }

  let { x, y, width, height } = startRect;

  if (direction.includes("e")) {
    width = Math.max(MIN_SIZE, startRect.width + dx);
  }
  if (direction.includes("w")) {
    width = Math.max(MIN_SIZE, startRect.width - dx);
    x = startRect.x + startRect.width - width;
  }
  if (direction.includes("s")) {
    height = Math.max(MIN_SIZE, startRect.height + dy);
  }
  if (direction.includes("n")) {
    height = Math.max(MIN_SIZE, startRect.height - dy);
    y = startRect.y + startRect.height - height;
  }

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/**
 * Compute new positions for a set of nodes being moved.
 * @param startPositions  Map of nodeId → start position
 * @param dx              Raw mouse delta (screen pixels)
 * @param dy              Raw mouse delta (screen pixels)
 * @param zoom            Current camera zoom
 * @returns Map of nodeId → new position (rounded)
 */
export function computeMove(
  startPositions: Map<string, Point>,
  dx: number,
  dy: number,
  zoom: number,
): Map<string, Point> {
  const result = new Map<string, Point>();
  const canvasDx = dx / zoom;
  const canvasDy = dy / zoom;
  for (const [id, start] of startPositions) {
    result.set(id, {
      x: Math.round(start.x + canvasDx),
      y: Math.round(start.y + canvasDy),
    });
  }
  return result;
}

/**
 * Compute new pan values after a drag.
 * @param startPan    Pan values when drag began
 * @param startMouse  Mouse position when drag began
 * @param currentMouse  Current mouse position
 */
export function computePan(startPan: Point, startMouse: Point, currentMouse: Point): Point {
  return {
    x: startPan.x + (currentMouse.x - startMouse.x),
    y: startPan.y + (currentMouse.y - startMouse.y),
  };
}

/**
 * Compute the camera after a pinch gesture around a fixed canvas-space anchor.
 * This lets the gesture midpoint move while keeping the same canvas point
 * under the user's fingers.
 */
export function computePinchCamera(
  anchorCanvas: Point,
  screenPoint: Point,
  zoom: number,
  minZoom = MIN_ZOOM,
  maxZoom = MAX_ZOOM,
): { zoom: number; panX: number; panY: number } {
  const nextZoom = Math.min(Math.max(zoom, minZoom), maxZoom);
  return {
    zoom: nextZoom,
    panX: screenPoint.x - anchorCanvas.x * nextZoom,
    panY: screenPoint.y - anchorCanvas.y * nextZoom,
  };
}

export function computeCenteredCameraForBounds(
  bounds: Rect,
  viewportSize: Size,
  options: { padding?: number; minZoom?: number; maxZoom?: number } = {},
): { zoom: number; panX: number; panY: number } | null {
  if (
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    viewportSize.width <= 0 ||
    viewportSize.height <= 0
  ) {
    return null;
  }

  const padding = Math.max(0, options.padding ?? 96);
  const minZoom = options.minZoom ?? MIN_ZOOM;
  const maxZoom = options.maxZoom ?? 1;
  const availableWidth = Math.max(1, viewportSize.width - padding * 2);
  const availableHeight = Math.max(1, viewportSize.height - padding * 2);
  const fitZoom = Math.min(availableWidth / bounds.width, availableHeight / bounds.height);
  const zoom = Math.min(Math.max(fitZoom, minZoom), maxZoom);
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;

  return {
    zoom,
    panX: viewportSize.width / 2 - centerX * zoom,
    panY: viewportSize.height / 2 - centerY * zoom,
  };
}

/**
 * Check if a newly drawn node needs default sizing.
 *
 * A true click — both dimensions under `threshold` — yields the kind's default
 * size. A deliberate thin drag (only one dimension under the threshold, say a
 * 203×4 divider) keeps the dimension the user drew and clamps only the thin one
 * up to `MIN_SIZE`, rather than replacing the whole box with the default pair.
 * @returns The [width, height] to apply, or null if no change is needed.
 */
export function getDefaultSizeIfNeeded(
  width: number,
  height: number,
  nodeType: string,
  threshold = 20,
): [number, number] | null {
  const widthIsTiny = width < threshold;
  const heightIsTiny = height < threshold;
  if (widthIsTiny && heightIsTiny) {
    return DEFAULT_SIZES[nodeType] ?? [100, 100];
  }
  if (widthIsTiny || heightIsTiny) {
    const clampedWidth = Math.max(MIN_SIZE, width);
    const clampedHeight = Math.max(MIN_SIZE, height);
    if (clampedWidth === width && clampedHeight === height) return null;
    return [clampedWidth, clampedHeight];
  }
  return null;
}

/** True when `rect` overlaps the given canvas-space bounding box. */
export function intersectsCanvasBounds(
  rect: { x: number; y: number; width: number; height: number },
  bounds: { left: number; top: number; right: number; bottom: number },
) {
  return (
    rect.x + rect.width >= bounds.left &&
    rect.x <= bounds.right &&
    rect.y + rect.height >= bounds.top &&
    rect.y <= bounds.bottom
  );
}

export function computeSelectionBounds(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;

  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;

  for (const rect of rects) {
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.width);
    bottom = Math.max(bottom, rect.y + rect.height);
  }

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

/**
 * Alignment deltas and guides for a drag.
 *
 * Guides are axis-aligned, so a rotated node participates through the bounding
 * box of its rotated area — its real leftmost/topmost extent — rather than the
 * edges of its unrotated box. Rotation turns about the center, so center
 * alignment is unaffected either way. Callers pass `getRotatedBounds(...)`.
 */
export function computeSnap(
  movingBounds: Rect,
  targetRects: Rect[],
  threshold = 5,
): { dx: number; dy: number; guides: SnapGuide[] } {
  if (targetRects.length === 0) {
    return { dx: 0, dy: 0, guides: [] };
  }

  const moving = {
    left: movingBounds.x,
    right: movingBounds.x + movingBounds.width,
    centerX: movingBounds.x + movingBounds.width / 2,
    top: movingBounds.y,
    bottom: movingBounds.y + movingBounds.height,
    centerY: movingBounds.y + movingBounds.height / 2,
  };

  let bestDx = Number.POSITIVE_INFINITY;
  let bestDy = Number.POSITIVE_INFINITY;
  const guides: SnapGuide[] = [];

  for (const rect of targetRects) {
    const target = {
      left: rect.x,
      right: rect.x + rect.width,
      centerX: rect.x + rect.width / 2,
      top: rect.y,
      bottom: rect.y + rect.height,
      centerY: rect.y + rect.height / 2,
    };

    const xPairs: Array<[number, number]> = [
      [moving.left, target.left],
      [moving.left, target.right],
      [moving.right, target.left],
      [moving.right, target.right],
      [moving.centerX, target.centerX],
    ];

    for (const [movingValue, targetValue] of xPairs) {
      const delta = targetValue - movingValue;
      if (Math.abs(delta) > threshold || Math.abs(delta) > Math.abs(bestDx)) continue;

      if (Math.abs(delta) < Math.abs(bestDx)) {
        bestDx = delta;
        for (let index = guides.length - 1; index >= 0; index--) {
          if (guides[index]!.axis === "x") guides.splice(index, 1);
        }
      }

      if (Math.abs(delta) === Math.abs(bestDx)) {
        guides.push({
          axis: "x",
          position: targetValue,
          from: Math.min(moving.top, target.top),
          to: Math.max(moving.bottom, target.bottom),
        });
      }
    }

    const yPairs: Array<[number, number]> = [
      [moving.top, target.top],
      [moving.top, target.bottom],
      [moving.bottom, target.top],
      [moving.bottom, target.bottom],
      [moving.centerY, target.centerY],
    ];

    for (const [movingValue, targetValue] of yPairs) {
      const delta = targetValue - movingValue;
      if (Math.abs(delta) > threshold || Math.abs(delta) > Math.abs(bestDy)) continue;

      if (Math.abs(delta) < Math.abs(bestDy)) {
        bestDy = delta;
        for (let index = guides.length - 1; index >= 0; index--) {
          if (guides[index]!.axis === "y") guides.splice(index, 1);
        }
      }

      if (Math.abs(delta) === Math.abs(bestDy)) {
        guides.push({
          axis: "y",
          position: targetValue,
          from: Math.min(moving.left, target.left),
          to: Math.max(moving.right, target.right),
        });
      }
    }
  }

  return {
    dx: Number.isFinite(bestDx) ? bestDx : 0,
    dy: Number.isFinite(bestDy) ? bestDy : 0,
    guides,
  };
}
