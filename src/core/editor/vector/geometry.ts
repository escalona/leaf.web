/**
 * Geometry for the anchor model: bounds, hit-testing, and node re-fitting.
 *
 * A path node maps its own path coordinate space onto the node box, the same
 * way an SVG node maps its `viewBox`. Resizing the node therefore scales the
 * artwork, and vector editing has to run the mapping in both directions.
 */

import { clonePath, type VectorAnchor, type VectorPath, type VectorPoint } from "./path-data";

export interface VectorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type VectorHandleKind = "in" | "out";

export type VectorHit =
  | { type: "anchor"; index: number }
  | { type: "handle"; index: number; handle: VectorHandleKind };

/** A degenerate axis (a horizontal line) gets this much room so it can scale. */
const MIN_EXTENT = 1;

function cubicAxisExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const roots: number[] = [];

  const push = (t: number) => {
    if (t > 0 && t < 1) roots.push(t);
  };

  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) push(-c / b);
  } else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      push((-b + root) / (2 * a));
      push((-b - root) / (2 * a));
    }
  }

  return roots.map((t) => {
    const inverse = 1 - t;
    return (
      inverse * inverse * inverse * p0 +
      3 * inverse * inverse * t * p1 +
      3 * inverse * t * t * p2 +
      t * t * t * p3
    );
  });
}

function segments(path: VectorPath): Array<[VectorAnchor, VectorAnchor]> {
  const pairs: Array<[VectorAnchor, VectorAnchor]> = [];
  for (let index = 1; index < path.anchors.length; index++) {
    pairs.push([path.anchors[index - 1]!, path.anchors[index]!]);
  }
  if (path.closed && path.anchors.length > 1) {
    pairs.push([path.anchors[path.anchors.length - 1]!, path.anchors[0]!]);
  }
  return pairs;
}

/**
 * Tight bounds of the drawn curve — control points outside the curve do not
 * inflate it, so a re-fit node box hugs the artwork.
 */
export function getPathBounds(path: VectorPath): VectorRect | null {
  const first = path.anchors[0];
  if (!first) return null;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  const includeX = (x: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  };
  const includeY = (y: number) => {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };

  for (const anchor of path.anchors) {
    includeX(anchor.x);
    includeY(anchor.y);
  }

  for (const [from, to] of segments(path)) {
    if (!from.outHandle && !to.inHandle) continue;
    const control1 = from.outHandle ?? { x: from.x, y: from.y };
    const control2 = to.inHandle ?? { x: to.x, y: to.y };
    cubicAxisExtrema(from.x, control1.x, control2.x, to.x).forEach(includeX);
    cubicAxisExtrema(from.y, control1.y, control2.y, to.y).forEach(includeY);
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Bounds with every axis given a usable extent, for viewBox and node sizing. */
export function getPathLayoutBounds(path: VectorPath): VectorRect | null {
  const bounds = getPathBounds(path);
  if (!bounds) return null;
  const width = bounds.width > 0 ? bounds.width : MIN_EXTENT;
  const height = bounds.height > 0 ? bounds.height : MIN_EXTENT;
  return {
    x: bounds.x - (width - bounds.width) / 2,
    y: bounds.y - (height - bounds.height) / 2,
    width,
    height,
  };
}

export function translatePath(path: VectorPath, dx: number, dy: number): VectorPath {
  if (dx === 0 && dy === 0) return clonePath(path);
  const move = (point: VectorPoint) => ({ x: point.x + dx, y: point.y + dy });
  return {
    closed: path.closed,
    anchors: path.anchors.map((anchor) => ({
      x: anchor.x + dx,
      y: anchor.y + dy,
      ...(anchor.inHandle ? { inHandle: move(anchor.inHandle) } : {}),
      ...(anchor.outHandle ? { outHandle: move(anchor.outHandle) } : {}),
    })),
  };
}

/**
 * Scale factor from path coordinates to node coordinates.
 *
 * `sourceBounds` is the layout bounds the node box was last fitted to. After a
 * plain re-fit it equals the node box and the factor is 1; after the user drags
 * a resize handle it is what makes anchors land where the artwork is painted.
 */
export function getPathScale(
  node: { width: number; height: number },
  sourceBounds: VectorRect,
): { x: number; y: number } {
  return {
    x: sourceBounds.width > 0 ? node.width / sourceBounds.width : 1,
    y: sourceBounds.height > 0 ? node.height / sourceBounds.height : 1,
  };
}

export function pathPointToCanvas(
  point: VectorPoint,
  node: { width: number; height: number },
  origin: VectorPoint,
  sourceBounds: VectorRect,
): VectorPoint {
  const scale = getPathScale(node, sourceBounds);
  return {
    x: origin.x + (point.x - sourceBounds.x) * scale.x,
    y: origin.y + (point.y - sourceBounds.y) * scale.y,
  };
}

export function canvasPointToPath(
  point: VectorPoint,
  node: { width: number; height: number },
  origin: VectorPoint,
  sourceBounds: VectorRect,
): VectorPoint {
  const scale = getPathScale(node, sourceBounds);
  return {
    x: sourceBounds.x + (point.x - origin.x) / (scale.x || 1),
    y: sourceBounds.y + (point.y - origin.y) / (scale.y || 1),
  };
}

/** The whole path in canvas coordinates, for overlay drawing and hit-testing. */
export function mapPathToCanvas(
  path: VectorPath,
  node: { width: number; height: number },
  origin: VectorPoint,
  sourceBounds: VectorRect,
): VectorPath {
  const map = (point: VectorPoint) => pathPointToCanvas(point, node, origin, sourceBounds);
  return {
    closed: path.closed,
    anchors: path.anchors.map((anchor) => {
      const mapped = map(anchor);
      return {
        x: mapped.x,
        y: mapped.y,
        ...(anchor.inHandle ? { inHandle: map(anchor.inHandle) } : {}),
        ...(anchor.outHandle ? { outHandle: map(anchor.outHandle) } : {}),
      };
    }),
  };
}

function withinTolerance(a: VectorPoint, b: VectorPoint, tolerance: number): boolean {
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;
}

/**
 * Find what sits under `point`, in path coordinates.
 *
 * Handles win over anchors because they are drawn on top, but a handle parked
 * on its own anchor is skipped — otherwise a retracted handle would make its
 * anchor unselectable.
 */
export function hitTestPath(
  path: VectorPath,
  point: VectorPoint,
  tolerance: number,
): VectorHit | null {
  for (let index = 0; index < path.anchors.length; index++) {
    const anchor = path.anchors[index]!;
    for (const handle of ["out", "in"] as const) {
      const control = handle === "in" ? anchor.inHandle : anchor.outHandle;
      if (!control || withinTolerance(control, anchor, tolerance)) continue;
      if (withinTolerance(control, point, tolerance)) return { type: "handle", index, handle };
    }
  }

  for (let index = 0; index < path.anchors.length; index++) {
    const anchor = path.anchors[index]!;
    if (withinTolerance(anchor, point, tolerance)) return { type: "anchor", index };
  }

  return null;
}

export interface RefitResult {
  path: VectorPath;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Re-fit the node box around an edited path.
 *
 * The path is moved so its layout bounds start at the origin, and the node box
 * absorbs the same delta through the current scale — so the artwork does not
 * appear to jump, and the node's stored size describes what is painted again.
 */
export function refitPathToNode(
  path: VectorPath,
  node: { x: number; y: number; width: number; height: number },
  sourceBounds: VectorRect,
): RefitResult | null {
  const bounds = getPathLayoutBounds(path);
  if (!bounds) return null;
  const scale = getPathScale(node, sourceBounds);
  return {
    path: translatePath(path, -bounds.x, -bounds.y),
    x: node.x + (bounds.x - sourceBounds.x) * scale.x,
    y: node.y + (bounds.y - sourceBounds.y) * scale.y,
    width: bounds.width * scale.x,
    height: bounds.height * scale.y,
  };
}
