/**
 * Immutable edits to the anchor model.
 *
 * Every operation returns a new path so a drag can recompute from the gesture's
 * starting geometry instead of accumulating rounding error frame by frame.
 */

import { clonePath, type VectorAnchor, type VectorPath, type VectorPoint } from "./path-data";
import type { VectorHandleKind } from "./geometry";

export function moveAnchor(path: VectorPath, index: number, dx: number, dy: number): VectorPath {
  const next = clonePath(path);
  const anchor = next.anchors[index];
  if (!anchor) return next;
  anchor.x += dx;
  anchor.y += dy;
  if (anchor.inHandle) {
    anchor.inHandle.x += dx;
    anchor.inHandle.y += dy;
  }
  if (anchor.outHandle) {
    anchor.outHandle.x += dx;
    anchor.outHandle.y += dy;
  }
  return next;
}

function opposite(handle: VectorHandleKind): VectorHandleKind {
  return handle === "in" ? "out" : "in";
}

function setHandle(anchor: VectorAnchor, handle: VectorHandleKind, point: VectorPoint | undefined) {
  if (handle === "in") {
    if (point) anchor.inHandle = point;
    else delete anchor.inHandle;
  } else if (point) {
    anchor.outHandle = point;
  } else {
    delete anchor.outHandle;
  }
}

function getHandle(anchor: VectorAnchor, handle: VectorHandleKind): VectorPoint | undefined {
  return handle === "in" ? anchor.inHandle : anchor.outHandle;
}

/**
 * Place one bezier handle.
 *
 * `mirror` reflects the opposite handle through the anchor, which is what keeps
 * a curve smooth while it is being shaped. Alt-dragging passes `mirror: false`
 * to break the symmetry and turn the anchor into a cusp.
 */
export function moveHandle(
  path: VectorPath,
  index: number,
  handle: VectorHandleKind,
  point: VectorPoint,
  options: { mirror?: boolean } = {},
): VectorPath {
  const next = clonePath(path);
  const anchor = next.anchors[index];
  if (!anchor) return next;

  setHandle(anchor, handle, { x: point.x, y: point.y });

  if (options.mirror !== false && getHandle(anchor, opposite(handle))) {
    setHandle(anchor, opposite(handle), {
      x: anchor.x * 2 - point.x,
      y: anchor.y * 2 - point.y,
    });
  }

  return next;
}

export function setPathClosed(path: VectorPath, closed: boolean): VectorPath {
  const next = clonePath(path);
  next.closed = closed;
  if (!closed) {
    // The closing segment is gone, so the handles that shaped it would draw
    // nothing and would still inflate the bounds.
    const first = next.anchors[0];
    const last = next.anchors[next.anchors.length - 1];
    if (first) delete first.inHandle;
    if (last) delete last.outHandle;
  }
  return next;
}

export function appendAnchor(path: VectorPath, anchor: VectorAnchor): VectorPath {
  const next = clonePath(path);
  next.anchors.push({ ...anchor });
  return next;
}

/**
 * Remove an anchor, dropping the handles that pointed at it.
 *
 * Refuses to leave fewer than two anchors: a one-anchor path draws nothing and
 * would strand the node on canvas with no way to grab it.
 */
export function removeAnchor(path: VectorPath, index: number): VectorPath {
  if (path.anchors.length <= 2) return clonePath(path);
  const next = clonePath(path);
  next.anchors.splice(index, 1);
  const isEnd = !next.closed && (index === 0 || index === next.anchors.length);
  if (isEnd) {
    const exposed = index === 0 ? next.anchors[0] : next.anchors[next.anchors.length - 1];
    if (exposed) setHandle(exposed, index === 0 ? "in" : "out", undefined);
  }
  return next;
}
