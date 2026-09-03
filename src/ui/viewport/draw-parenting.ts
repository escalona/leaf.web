import {
  parentPoint,
  type CanvasPoint,
  type ParentPoint,
} from "../../core/editor/interaction/coordinate-spaces";
import type { EditorStore } from "../../core/state/EditorStore";
import {
  buildFrameDropTargetLookup,
  buildFrameDropTargets,
  findFrameDropTargetAtPoint,
} from "./interaction-helpers";

const NO_EXCLUDED_IDS: ReadonlySet<string> = new Set<string>();

/**
 * The frame a draw gesture starting at `canvasPoint` should create into.
 *
 * Drawing inside an artboard is how designers say "this belongs to that frame",
 * so the draw tools resolve the same deepest-frame target that a drag drop and
 * a paste already resolve, rather than dropping everything at the document
 * root. Returns undefined when the gesture starts on empty canvas.
 */
export function findDrawParentFrameId(
  store: EditorStore,
  viewportEl: Element | null,
  canvasPoint: CanvasPoint,
): string | undefined {
  const lookup = buildFrameDropTargetLookup(
    buildFrameDropTargets(store, viewportEl, NO_EXCLUDED_IDS, {
      left: canvasPoint.x,
      top: canvasPoint.y,
      right: canvasPoint.x,
      bottom: canvasPoint.y,
    }),
  );
  return findFrameDropTargetAtPoint(lookup, canvasPoint)?.node.id;
}

/**
 * Where a node created into `parentId` has to sit so it lands on the canvas
 * point the user drew at. Child coordinates are parent-relative.
 */
export function toParentRelativePoint(
  store: EditorStore,
  parentId: string | undefined,
  canvasPoint: CanvasPoint,
): ParentPoint {
  if (!parentId) return parentPoint(canvasPoint.x, canvasPoint.y);
  const parentOrigin = store.getCanvasPosition(parentId);
  if (!parentOrigin) return parentPoint(canvasPoint.x, canvasPoint.y);
  return parentPoint(canvasPoint.x - parentOrigin.x, canvasPoint.y - parentOrigin.y);
}
