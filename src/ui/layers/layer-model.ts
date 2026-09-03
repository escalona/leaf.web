import type { DragEvent } from "react";
import { getFlexFlowChildren } from "../../core/editor/interaction/flex-insertion";
import type { EditorStore } from "../../core/state/EditorStore";
import type { DesignNode } from "../../core/types";
import { isNodeLocked } from "../viewport/selection-targets";

export const LAYER_ROW_HEIGHT = 28;
export const LAYER_ROW_INDENT = 16;
export const LAYER_ROW_OVERSCAN = 12;

export type LayerRow = {
  depth: number;
  hasChildren: boolean;
  node: DesignNode;
};

export type LayerDropInstruction = "reorder-above" | "reorder-below" | "make-child";

export function buildVisibleLayerRows(
  nodes: readonly DesignNode[],
  collapsedIds: ReadonlySet<string>,
  depth = 0,
  rows: LayerRow[] = [],
): LayerRow[] {
  // Document arrays paint back to front, while the Layers panel reads front to
  // back. Apply that projection at every depth so a row higher in the tree
  // always means the same z-order relationship.
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index]!;
    const hasChildren = node.children.length > 0;
    rows.push({ depth, hasChildren, node });
    if (hasChildren && !collapsedIds.has(node.id)) {
      buildVisibleLayerRows(node.children, collapsedIds, depth + 1, rows);
    }
  }
  return rows;
}

export function isFlexContainer(node: DesignNode | undefined) {
  if (!node) return false;
  return node.styles.display === "flex" || node.styles.display === "inline-flex";
}

export function resolveLayerDropInstruction(
  event: DragEvent<HTMLDivElement>,
  row: LayerRow,
): LayerDropInstruction {
  const bounds = event.currentTarget.getBoundingClientRect();
  const offsetY = event.clientY - bounds.top;
  const ratio = bounds.height > 0 ? offsetY / bounds.height : 0.5;

  if (row.node.type === "frame" && ratio >= 0.28 && ratio <= 0.72) {
    return "make-child";
  }

  return ratio < 0.5 ? "reorder-above" : "reorder-below";
}

/**
 * `sourceIndex` is the source's position in the same list the target is indexed
 * in, or -1 when it does not sit in that list at all. Only a source that holds
 * a slot there vacates one, and only then does the target index shift down.
 */
export function getLayerInsertionIndex(
  targetIndex: number,
  sourceIndex: number,
  instruction: "reorder-above" | "reorder-below",
) {
  if (sourceIndex === -1) {
    return instruction === "reorder-above" ? targetIndex : targetIndex + 1;
  }

  if (instruction === "reorder-above") {
    return sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
  }

  return sourceIndex < targetIndex ? targetIndex : targetIndex + 1;
}

export function getLayerDropTarget(
  store: EditorStore,
  sourceId: string,
  targetNode: DesignNode,
  instruction: LayerDropInstruction,
) {
  const sourceNode = store.getNode(sourceId);
  if (
    !sourceNode ||
    sourceId === targetNode.id ||
    store.isDescendant(targetNode.id, sourceId) ||
    isNodeLocked(store, sourceId)
  ) {
    return null;
  }

  let parentId: string | undefined;
  let index: number;
  let mode: "absolute" | "flow" = "absolute";

  if (instruction === "make-child") {
    if (isNodeLocked(store, targetNode.id)) return null;
    parentId = targetNode.id;
    index = targetNode.children.length;
    if (isFlexContainer(targetNode) && sourceNode.styles.position !== "absolute") {
      mode = "flow";
      index = getFlexFlowChildren(targetNode.children).length;
    }
  } else {
    const targetParent = store.getParent(targetNode.id);
    // A reorder inside a locked parent would mutate that protected subtree,
    // even when the particular target row has no lock flag of its own.
    if (targetParent && isNodeLocked(store, targetParent.id)) return null;
    // Rows are frontmost-first at every depth, the inverse of the document's
    // back-to-front arrays.
    const actualInstruction = instruction === "reorder-above" ? "reorder-below" : "reorder-above";

    parentId = targetParent?.id;
    if (
      targetParent &&
      isFlexContainer(targetParent) &&
      sourceNode.styles.position !== "absolute" &&
      targetNode.styles.position !== "absolute"
    ) {
      mode = "flow";
      const siblings = getFlexFlowChildren(targetParent.children);
      const targetIndex = siblings.findIndex((child) => child.id === targetNode.id);
      const sourceIndex = siblings.findIndex((child) => child.id === sourceId);
      if (targetIndex === -1) return null;
      // A hidden child holds no flow slot — CSS skips it, so `getFlexFlowChildren`
      // leaves it out — which is why its `sourceIndex` is -1 even in its own
      // container, and why nothing is charged for it vacating.
      index = getLayerInsertionIndex(targetIndex, sourceIndex, actualInstruction);
    } else {
      const siblings = targetParent ? targetParent.children : store.nodes;
      const targetIndex = siblings.findIndex((child) => child.id === targetNode.id);
      const sourceIndex = siblings.findIndex((child) => child.id === sourceId);
      if (targetIndex === -1) return null;
      index = getLayerInsertionIndex(targetIndex, sourceIndex, actualInstruction);
    }
  }

  return { index, mode, parentId };
}
