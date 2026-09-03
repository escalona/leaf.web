import { buildFlowDetachResidue } from "../../core/editor/auto-layout";
import { computeSelectionBounds } from "../../core/editor/interaction/math";
import type { EditorStore } from "../../core/state/EditorStore";
import type { DesignNode, Rect } from "../../core/types";
import { getRotatedBounds } from "../canvas-overlay/CanvasOverlay";
import { getNodeOrientedBox } from "../canvas-overlay/live-node-geometry";
import { getNodesInDocumentOrder } from "./clipboard-placement";
import { getTopLevelDraggedIds, getTransformableSelectedIds } from "./selection-targets";

/**
 * Ancestor ids from the page root down to the node's parent. Empty for roots.
 */
function getAncestorChain(store: EditorStore, nodeId: string): string[] {
  const chain: string[] = [];
  let currentId = store.parentMap.get(nodeId);
  while (currentId) {
    chain.unshift(currentId);
    currentId = store.parentMap.get(currentId);
  }
  return chain;
}

/**
 * Deepest container that is an ancestor of every node, or undefined when the
 * nodes only meet at the page root.
 */
function getCommonAncestorId(store: EditorStore, nodeIds: readonly string[]): string | undefined {
  let common = getAncestorChain(store, nodeIds[0]!);
  for (const nodeId of nodeIds.slice(1)) {
    const chain = getAncestorChain(store, nodeId);
    let sharedLength = 0;
    while (
      sharedLength < common.length &&
      sharedLength < chain.length &&
      common[sharedLength] === chain[sharedLength]
    ) {
      sharedLength += 1;
    }
    common.length = sharedLength;
    if (common.length === 0) break;
  }
  return common[common.length - 1];
}

/**
 * Wrap the current selection in a new frame sized to its canvas bounding box.
 *
 * The frame is inserted under the deepest common ancestor of the selection
 * (the page root when the selection spans containers) at the first wrapped
 * node's sibling slot, so stacking order survives the wrap. Each selected
 * top-level node is reparented into it at an unchanged canvas position:
 * transparent background, no radius, and `position: absolute` when nested.
 * Flow children of the ancestor hand their layout slot to the frame instead
 * (it joins the flow where they sat) and are detached into absolute placement
 * at their measured box. The new frame becomes the selection. Returns null
 * when nothing wrappable is selected.
 */
export function wrapSelectionInFrame(
  store: EditorStore,
  viewportEl: Element | null,
): DesignNode | null {
  const ids = getTopLevelDraggedIds(store, getTransformableSelectedIds(store));
  if (ids.length === 0) return null;

  // Reparenting appends in call order, so visiting nodes in document order
  // preserves their relative stacking inside the new frame.
  const nodes = getNodesInDocumentOrder(
    store,
    ids.map((id) => store.getNode(id)!),
  );
  const sortedIds = nodes.map((node) => node.id);

  const viewportRect = viewportEl?.getBoundingClientRect();
  const rects = new Map<string, Rect>();
  const extents: Rect[] = [];
  for (const node of nodes) {
    const box = getNodeOrientedBox(node, store, viewportEl, viewportRect);
    // Children are reparented at their own box, but the frame has to cover what
    // the selection visibly covers: each node's extent under the total rotation
    // turning it, its own and every ancestor's.
    rects.set(node.id, box.rect);
    extents.push(getRotatedBounds(box.rect, box.rotation));
  }
  const bounds = computeSelectionBounds(extents)!;

  const containerId = getCommonAncestorId(store, sortedIds);
  const container = containerId ? store.getNode(containerId) : undefined;
  const pageId = store.getPageIdForNode(sortedIds[0]!) ?? undefined;

  // Extracting a flow child leaves a hole in the container's layout; the frame
  // takes over the first vacated slot instead of floating next to the reflowed
  // siblings.
  const flowChildIds = new Set(sortedIds.filter((id) => store.isFlowChild(id)));
  const frameJoinsFlow =
    containerId !== undefined &&
    sortedIds.some((id) => flowChildIds.has(id) && store.parentMap.get(id) === containerId);

  // The sibling slot the frame returns to after creation appends it last:
  // the earliest slot holding wrapped content (or an ancestor of it).
  const siblings = container ? container.children : store.getRootSiblingsForNode(sortedIds[0]!);
  const anchorIndices = sortedIds
    .map((id) => {
      let anchorId = id;
      let parentId = store.parentMap.get(anchorId);
      while (parentId && parentId !== containerId) {
        anchorId = parentId;
        parentId = store.parentMap.get(anchorId);
      }
      return siblings.findIndex((sibling) => sibling.id === anchorId);
    })
    .filter((index) => index !== -1);
  const frameIndex = Math.min(...anchorIndices);

  store.beginHistoryTransaction();
  try {
    const containerCanvasPosition = containerId ? store.getCanvasPosition(containerId) : undefined;
    const frame = store.runtime.createScriptNode(
      "frame",
      {
        name: "Frame",
        x: bounds.x - (containerCanvasPosition?.x ?? 0),
        y: bounds.y - (containerCanvasPosition?.y ?? 0),
        width: bounds.width,
        height: bounds.height,
        backgroundColor: "transparent",
        borderRadius: 0,
        styles: containerId && !frameJoinsFlow ? { position: "absolute" } : {},
      },
      containerId,
      containerId ? {} : { pageId },
    );

    // moveNodeToParent subtracts the canvas position the store resolves for
    // the still-unmounted frame, which can differ from the live position the
    // frame was anchored against when an ancestor is laid out by CSS flow.
    // Compensate so the children land at exact offsets either way.
    const resolvedFramePosition = store.getCanvasPosition(frame.id) ?? {
      x: frame.x,
      y: frame.y,
    };
    const compensation = {
      x: resolvedFramePosition.x - bounds.x,
      y: resolvedFramePosition.y - bounds.y,
    };

    for (const node of nodes) {
      const rect = rects.get(node.id)!;
      const detachResidue = flowChildIds.has(node.id) ? buildFlowDetachResidue(node) : null;
      store.runtime.moveNodeToParent(
        node.id,
        { x: rect.x + compensation.x, y: rect.y + compensation.y },
        frame.id,
      );
      if (detachResidue) {
        // CSS placed and sized this node until now; bake the measured box so
        // it does not jump or collapse once the flow parent stops doing so.
        store.runtime.updateStyles([{ nodeIds: [node.id], styles: detachResidue }]);
        store.runtime.updateNode(node.id, { width: rect.width, height: rect.height });
      }
    }

    // Created at the end of its siblings; slide the frame back to where the
    // wrapped content sat so z-order (and the vacated flow slot, when the
    // container lays out its children) survive the wrap.
    store.runtime.moveNodeToParent(frame.id, { x: bounds.x, y: bounds.y }, containerId, {
      index: frameIndex,
      mode: frameJoinsFlow ? "flow" : "absolute",
    });

    store.setSelectedIds([frame.id]);
    return frame;
  } finally {
    store.endHistoryTransaction();
  }
}
