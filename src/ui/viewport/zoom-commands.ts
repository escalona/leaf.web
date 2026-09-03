import {
  computeCenteredCameraForBounds,
  computeSelectionBounds,
  MAX_ZOOM,
} from "../../core/editor/interaction/math";
import { getNodeTreeBounds } from "../../core/state/editor-camera-state";
import type { EditorStore } from "../../core/state/EditorStore";
import type { Point } from "../../core/types";
import { getNodeCanvasExtent } from "../canvas-overlay/live-node-geometry";

/** One keyboard/menu zoom step. 1.1 per press mirrors the historical feel. */
export const ZOOM_STEP_FACTOR = 1.1;

/**
 * Screen-pixel margin left around fitted content. Matches the padding the
 * initial page camera uses so "Zoom to fit" lands on the same framing.
 */
const FIT_PADDING = 50;

/**
 * Prefer the mounted viewport element's live rect; fall back to the store's
 * tracked size when no element is available.
 */
function getViewportSize(store: EditorStore, viewportEl: Element | null | undefined) {
  const rect = viewportEl?.getBoundingClientRect();
  if (rect && rect.width > 0 && rect.height > 0) {
    return { width: rect.width, height: rect.height };
  }
  return { width: store.viewportWidth, height: store.viewportHeight };
}

function getViewportCenter(store: EditorStore, viewportEl: Element | null | undefined): Point {
  const size = getViewportSize(store, viewportEl);
  return { x: size.width / 2, y: size.height / 2 };
}

export function zoomInStep(store: EditorStore, viewportEl?: Element | null) {
  store.setZoomAtPoint(store.zoom * ZOOM_STEP_FACTOR, getViewportCenter(store, viewportEl));
}

export function zoomOutStep(store: EditorStore, viewportEl?: Element | null) {
  store.setZoomAtPoint(store.zoom / ZOOM_STEP_FACTOR, getViewportCenter(store, viewportEl));
}

/** Set an absolute zoom level, keeping the viewport center fixed. */
export function zoomToLevel(store: EditorStore, zoom: number, viewportEl?: Element | null) {
  store.setZoomAtPoint(zoom, getViewportCenter(store, viewportEl));
}

/**
 * Center the camera on all content of the active page. Unlike the initial page
 * camera this may zoom in past 100%: an explicit fit request on a small
 * document should still fill the viewport. Returns false when the page is
 * empty or the viewport is unmeasured.
 */
export function zoomToFit(store: EditorStore, viewportEl?: Element | null): boolean {
  const bounds = getNodeTreeBounds(store.nodes);
  if (!bounds) return false;
  const camera = computeCenteredCameraForBounds(bounds, getViewportSize(store, viewportEl), {
    padding: FIT_PADDING,
    maxZoom: MAX_ZOOM,
  });
  if (!camera) return false;
  store.setViewport(camera);
  return true;
}

/**
 * Center the camera on the current selection. Flow children and rotated nodes
 * resolve through the live-geometry path, so pass the viewport element when
 * one is mounted. Returns false when nothing is selected or bounds degenerate.
 */
export function zoomToSelection(store: EditorStore, viewportEl: Element | null): boolean {
  const nodes = [...store.selectedIds]
    .map((id) => store.getNode(id))
    .filter((node) => node !== undefined);
  if (nodes.length === 0) return false;

  const viewportRect = viewportEl?.getBoundingClientRect();
  const bounds = computeSelectionBounds(
    nodes.map((node) => getNodeCanvasExtent(node, store, viewportEl, viewportRect)),
  );
  if (!bounds) return false;

  const camera = computeCenteredCameraForBounds(bounds, getViewportSize(store, viewportEl), {
    padding: FIT_PADDING,
    maxZoom: MAX_ZOOM,
  });
  if (!camera) return false;
  store.setViewport(camera);
  return true;
}
