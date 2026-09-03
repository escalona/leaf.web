import { computeCenteredCameraForBounds, MAX_ZOOM, MIN_ZOOM } from "../editor/interaction/math";
import {
  canvasPoint,
  type CanvasPoint,
  type ScreenPoint,
} from "../editor/interaction/coordinate-spaces";
import type { DesignNode, EditorPage, Point, Rect } from "../types";
import type { ViewportCanvasBounds } from "./EditorStore";

const PAGE_CAMERA_FIT_PADDING = 50;

export interface CameraState {
  zoom: number;
  panX: number;
  panY: number;
}

export function getCssTransform(camera: CameraState): string {
  return `matrix(${camera.zoom}, 0, 0, ${camera.zoom}, ${camera.panX}, ${camera.panY})`;
}

export function getCssTransform3d(camera: CameraState): string {
  return `matrix3d(${camera.zoom}, 0, 0, 0, 0, ${camera.zoom}, 0, 0, 0, 0, 1, 0, ${camera.panX}, ${camera.panY}, 0, 1)`;
}

export function screenToCanvas(camera: CameraState, screen: ScreenPoint): CanvasPoint {
  return canvasPoint(
    (screen.x - camera.panX) / camera.zoom,
    (screen.y - camera.panY) / camera.zoom,
  );
}

export function setZoomAtPoint(
  camera: CameraState,
  nextZoom: number,
  screenPoint: Point,
): CameraState {
  const newZoom = Math.min(Math.max(nextZoom, MIN_ZOOM), MAX_ZOOM);
  if (newZoom === camera.zoom) return camera;
  return {
    panX: screenPoint.x - (screenPoint.x - camera.panX) * (newZoom / camera.zoom),
    panY: screenPoint.y - (screenPoint.y - camera.panY) * (newZoom / camera.zoom),
    zoom: newZoom,
  };
}

export function clampZoom(zoom: number): number {
  return Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM);
}

export function areViewportBoundsEqual(
  previous: ViewportCanvasBounds | null,
  next: ViewportCanvasBounds | null,
): boolean {
  return (
    previous === next ||
    !!(
      previous &&
      next &&
      previous.left === next.left &&
      previous.top === next.top &&
      previous.right === next.right &&
      previous.bottom === next.bottom
    )
  );
}

export function getInitialViewportTargetBounds(nodes: readonly DesignNode[]): Rect | null {
  const firstArtboard = nodes.find((node) => node.isArtboard);
  if (
    firstArtboard &&
    firstArtboard.visible !== false &&
    Number.isFinite(firstArtboard.x) &&
    Number.isFinite(firstArtboard.y) &&
    Number.isFinite(firstArtboard.width) &&
    Number.isFinite(firstArtboard.height) &&
    firstArtboard.width > 0 &&
    firstArtboard.height > 0
  ) {
    return {
      x: firstArtboard.x,
      y: firstArtboard.y,
      width: firstArtboard.width,
      height: firstArtboard.height,
    };
  }

  return firstArtboard ? getNodeTreeBounds([firstArtboard]) : getNodeTreeBounds(nodes);
}

export function getNodeTreeBounds(nodes: readonly DesignNode[]): Rect | null {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;

  const includeNode = (node: DesignNode, parentPosition: Point) => {
    if (node.visible === false) return;

    const x = parentPosition.x + node.x;
    const y = parentPosition.y + node.y;

    if (node.width > 0 && node.height > 0) {
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x + node.width);
      bottom = Math.max(bottom, y + node.height);
    }

    for (const child of node.children) {
      includeNode(child, { x, y });
    }
  };

  for (const node of nodes) {
    includeNode(node, { x: 0, y: 0 });
  }

  if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

/**
 * The camera a page with nothing to fit opens with: the world origin at the
 * viewport center, 1×. Installing it eagerly matters — a page whose camera
 * waits for content would jump to fit the user's own first drawing.
 */
export function getEmptyPageCamera(viewport: { width: number; height: number }): CameraState {
  return {
    zoom: 1,
    panX: viewport.width / 2,
    panY: viewport.height / 2,
  };
}

export function getInitialCameraForPage(
  page: EditorPage,
  viewportWidth: number,
  viewportHeight: number,
): CameraState | null {
  const viewport = {
    width: Math.max(0, viewportWidth),
    height: Math.max(0, viewportHeight),
  };
  if (viewport.width <= 0 || viewport.height <= 0) return null;
  const bounds = getNodeTreeBounds(page.nodes);
  const fitted =
    bounds &&
    computeCenteredCameraForBounds(bounds, viewport, {
      padding: PAGE_CAMERA_FIT_PADDING,
      maxZoom: 1,
    });
  return fitted ?? getEmptyPageCamera(viewport);
}
