import type { EditorStore } from "../state/EditorStore";
import type { DesignNode, Point, Rect, Size } from "../types";
import { measureWithVisibleLayout } from "./forced-layout";

/** Canvas space kept between independently placed roots. */
export const ROOT_PLACEMENT_GAP = 80;

export interface RootPlacementInput {
  /** The canvas-space rectangle currently visible through the camera. */
  viewport: Rect;
  /** Canvas-space AABBs for every root on the destination page. */
  occupied: readonly Rect[];
  /** Canvas-space AABB size of the root being placed. */
  size: Size;
  /** Prefer placing beside this rectangle, as for an artboard duplicate. */
  preferred?: Rect;
  gap?: number;
}

/**
 * Return the first collision-free root position near the current viewport.
 *
 * Placement first tries the right and bottom edges of the source/other roots, then
 * empty slots inside the viewport. A `preferred` anchor is an explicit request
 * (duplicate source or create_artboard nextTo), so its slots are honored even
 * when the anchor is off-camera; only the anchor-less scans require viewport
 * visibility. The final right-edge fallback is deliberately independent of
 * viewport size: even a newly opened/headless document with no measured
 * viewport still gets a non-overlapping result.
 */
export function findAvailableRootPlacement({
  viewport,
  occupied,
  size,
  preferred,
  gap = ROOT_PLACEMENT_GAP,
}: RootPlacementInput): Point {
  requirePositiveSize(size);
  if (!isFiniteRect(viewport) || viewport.width <= 0 || viewport.height <= 0) {
    throw new Error("Root placement viewport must be a positive finite rectangle");
  }
  if (!Number.isFinite(gap) || gap < 0) {
    throw new Error("Root placement gap must be a non-negative finite number");
  }

  const obstacles = occupied.filter(
    (rect) => isFiniteRect(rect) && rect.width > 0 && rect.height > 0,
  );
  const preferredRect =
    preferred && isFiniteRect(preferred) && preferred.width > 0 && preferred.height > 0
      ? preferred
      : undefined;

  const available = (point: Point) =>
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    !overlapsAnyWithGap(obstacles, point, size, gap);
  const availableAndVisible = (point: Point) =>
    isSufficientlyVisible(point, size, viewport) && available(point);

  if (preferredRect) {
    const toRight = { x: right(preferredRect) + gap, y: preferredRect.y };
    const rightYSlots = collectVerticalSlots(
      obstacles,
      preferredRect.y,
      bottom(preferredRect),
      size.height,
      gap,
    );
    for (const y of rightYSlots) {
      const candidate = { x: toRight.x, y };
      if (available(candidate)) return candidate;
    }

    const below = { x: preferredRect.x, y: bottom(preferredRect) + gap };
    const belowXSlots = collectHorizontalSlots(
      obstacles,
      preferredRect.x,
      right(preferredRect),
      size.width,
      gap,
    );
    for (const x of belowXSlots) {
      const candidate = { x, y: below.y };
      if (available(candidate)) return candidate;
    }
  }

  const rightEdgeCandidates = obstacles
    .map((rect) => ({ x: right(rect) + gap, y: rect.y }))
    .sort(compareCanvasPoints);
  for (const candidate of rightEdgeCandidates) {
    if (availableAndVisible(candidate)) return candidate;
  }

  const bottomEdgeCandidates = obstacles
    .map((rect) => ({ x: rect.x, y: bottom(rect) + gap }))
    .sort(compareCanvasPoints);
  for (const candidate of bottomEdgeCandidates) {
    if (availableAndVisible(candidate)) return candidate;
  }

  const innerViewport: Rect = {
    x: viewport.x + gap,
    y: viewport.y + gap,
    width: Math.max(0, viewport.width - gap * 2),
    height: Math.max(0, viewport.height - gap * 2),
  };
  if (size.width <= innerViewport.width && size.height <= innerViewport.height) {
    const centered = centerRect(viewport, size);
    const viewportHasObstacle = obstacles.some((rect) => rectsOverlap(rect, viewport));
    if (!viewportHasObstacle && available(centered)) return centered;

    const xSlots = new Set<number>([innerViewport.x]);
    const ySlots = new Set<number>([innerViewport.y]);
    for (const rect of obstacles) {
      xSlots.add(rect.x);
      xSlots.add(right(rect) + gap);
      ySlots.add(rect.y);
      ySlots.add(bottom(rect) + gap);
    }
    const xs = [...xSlots]
      .filter((x) => x >= innerViewport.x && x + size.width <= right(innerViewport))
      .sort((a, b) => a - b);
    const ys = [...ySlots]
      .filter((y) => y >= innerViewport.y && y + size.height <= bottom(innerViewport))
      .sort((a, b) => a - b);
    for (const y of ys) {
      for (const x of xs) {
        const candidate = { x, y };
        if (available(candidate)) return candidate;
      }
    }
  }

  // The viewport-aware attempts above intentionally prefer visible work. If
  // none fit, retain the right/bottom ordering without allowing an
  // overlap merely because the viewport is crowded or not measured yet.
  // Preferred-anchor slots were already tried without a visibility gate.
  const fallbackCandidates: Point[] = [...rightEdgeCandidates, ...bottomEdgeCandidates];
  for (const candidate of fallbackCandidates) {
    if (candidate.x >= viewport.x && candidate.y >= viewport.y && available(candidate)) {
      return candidate;
    }
  }

  if (obstacles.length === 0) return centerRect(viewport, size);

  // Moving past the rightmost AABB guarantees separation from every finite
  // obstacle, regardless of their vertical arrangement.
  return {
    x: Math.max(...obstacles.map(right)) + gap,
    y: Math.max(viewport.y, preferredRect?.y ?? centerRect(viewport, size).y),
  };
}

/** Canvas-space model AABB, including the typed rotation around node center. */
export function getNodeModelAabb(
  node: Pick<DesignNode, "height" | "rotation" | "width" | "x" | "y">,
): Rect | null {
  if (
    !Number.isFinite(node.x) ||
    !Number.isFinite(node.y) ||
    !Number.isFinite(node.width) ||
    !Number.isFinite(node.height) ||
    node.width <= 0 ||
    node.height <= 0
  ) {
    return null;
  }

  const rotation = Number.isFinite(node.rotation) ? (node.rotation ?? 0) : 0;
  if (rotation % 360 === 0) {
    return { x: node.x, y: node.y, width: node.width, height: node.height };
  }

  const radians = (rotation * Math.PI) / 180;
  const halfWidth =
    (Math.abs(Math.cos(radians)) * node.width + Math.abs(Math.sin(radians)) * node.height) / 2;
  const halfHeight =
    (Math.abs(Math.sin(radians)) * node.width + Math.abs(Math.cos(radians)) * node.height) / 2;
  const centerX = node.x + node.width / 2;
  const centerY = node.y + node.height / 2;
  return {
    x: centerX - halfWidth,
    y: centerY - halfHeight,
    width: halfWidth * 2,
    height: halfHeight * 2,
  };
}

/**
 * Read a mounted root's rendered canvas AABB.
 *
 * `getBoundingClientRect()` includes content-driven sizing and authored CSS
 * transforms. Undoing only the viewport camera transform therefore produces
 * the world-space AABB used for root collision packing.
 */
export function getNodeLiveCanvasAabb(store: EditorStore, node: DesignNode): Rect | null {
  const element = store.domIndex.getElement(node);
  const viewport = element?.closest<HTMLElement>("[data-viewport]");
  if (
    !element ||
    !viewport ||
    !Number.isFinite(store.zoom) ||
    store.zoom <= 0 ||
    !Number.isFinite(store.panX) ||
    !Number.isFinite(store.panY)
  ) {
    return null;
  }

  const rect = element.getBoundingClientRect();
  const viewportRect = viewport.getBoundingClientRect();
  const canvasRect = {
    x: (rect.left - viewportRect.left - store.panX) / store.zoom,
    y: (rect.top - viewportRect.top - store.panY) / store.zoom,
    width: rect.width / store.zoom,
    height: rect.height / store.zoom,
  };
  return isPositiveFiniteRect(canvasRect) ? canvasRect : null;
}

/**
 * Measure every currently mounted root in one culling-safe layout window.
 *
 * The map intentionally contains live bounds only. Callers can distinguish a
 * rendered measurement from the rotation-aware model fallback used for
 * unmounted/background/hidden roots.
 */
export function measureMountedRootCanvasAabbs(
  store: EditorStore,
  roots: readonly DesignNode[],
): ReadonlyMap<string, Rect> {
  const measured = new Map<string, Rect>();
  if (typeof document === "undefined" || roots.length === 0) return measured;

  const scope =
    roots
      .map((node) => store.domIndex.getElement(node))
      .find((element): element is HTMLElement => element !== undefined) ?? document;

  return measureWithVisibleLayout(scope, () => {
    for (const node of roots) {
      const bounds = getNodeLiveCanvasAabb(store, node);
      if (bounds) measured.set(node.id, bounds);
    }
    return measured;
  });
}

/**
 * Resolve collision obstacles for root placement.
 *
 * Live rendered AABBs win when a root is mounted. Every other root, including
 * hidden and background-page roots, retains a rotation-aware model obstacle.
 */
export function getRootCanvasAabbs(
  store: EditorStore,
  roots: readonly DesignNode[],
): ReadonlyMap<string, Rect> {
  const liveBounds = measureMountedRootCanvasAabbs(store, roots);
  const resolved = new Map<string, Rect>();
  for (const node of roots) {
    const bounds = liveBounds.get(node.id) ?? getNodeModelAabb(node);
    if (bounds) resolved.set(node.id, bounds);
  }
  return resolved;
}

function collectVerticalSlots(
  obstacles: readonly Rect[],
  start: number,
  end: number,
  height: number,
  gap: number,
) {
  const slots = new Set<number>([start]);
  for (const rect of obstacles) {
    const after = bottom(rect) + gap;
    if (after > start && after + height <= end) slots.add(after);
    if (rect.y >= start && rect.y + height <= end) slots.add(rect.y);
  }
  return [...slots].sort((a, b) => a - b);
}

function collectHorizontalSlots(
  obstacles: readonly Rect[],
  start: number,
  end: number,
  width: number,
  gap: number,
) {
  const slots = new Set<number>([start]);
  for (const rect of obstacles) {
    const after = right(rect) + gap;
    if (after > start && after + width <= end) slots.add(after);
    if (rect.x >= start && rect.x + width <= end) slots.add(rect.x);
  }
  return [...slots].sort((a, b) => a - b);
}

function compareCanvasPoints(a: Point, b: Point) {
  return a.y - b.y || a.x - b.x;
}

function isSufficientlyVisible(point: Point, size: Size, viewport: Rect) {
  const visibleWidth =
    Math.min(point.x + size.width, right(viewport)) - Math.max(point.x, viewport.x);
  const visibleHeight =
    Math.min(point.y + size.height, bottom(viewport)) - Math.max(point.y, viewport.y);
  const requiredWidth = Math.min(300, size.width);
  const requiredHeight = Math.min(300, size.height);
  return (
    visibleWidth >= requiredWidth &&
    visibleHeight >= requiredHeight &&
    visibleWidth * visibleHeight >= (size.width * size.height * 2) / 3
  );
}

function overlapsAnyWithGap(occupied: readonly Rect[], point: Point, size: Size, gap: number) {
  const left = point.x - gap;
  const top = point.y - gap;
  const rightEdge = point.x + size.width + gap;
  const bottomEdge = point.y + size.height + gap;
  return occupied.some(
    (rect) => left < right(rect) && rightEdge > rect.x && top < bottom(rect) && bottomEdge > rect.y,
  );
}

function rectsOverlap(a: Rect, b: Rect) {
  return a.x < right(b) && right(a) > b.x && a.y < bottom(b) && bottom(a) > b.y;
}

function centerRect(viewport: Rect, size: Size): Point {
  return {
    x: viewport.x + (viewport.width - size.width) / 2,
    y: viewport.y + (viewport.height - size.height) / 2,
  };
}

function requirePositiveSize(size: Size) {
  if (
    !Number.isFinite(size.width) ||
    !Number.isFinite(size.height) ||
    size.width <= 0 ||
    size.height <= 0
  ) {
    throw new Error("Root placement size must contain positive finite dimensions");
  }
}

function isFiniteRect(rect: Rect) {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height)
  );
}

function isPositiveFiniteRect(rect: Rect) {
  return isFiniteRect(rect) && rect.width > 0 && rect.height > 0;
}

function right(rect: Rect) {
  return rect.x + rect.width;
}

function bottom(rect: Rect) {
  return rect.y + rect.height;
}
