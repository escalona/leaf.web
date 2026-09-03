import { isFlowLayoutDisplay } from "../../core/editor/layout-display";
import { screenPoint } from "../../core/editor/interaction/coordinate-spaces";
import type {
  NodeClipboardEntry,
  NodeClipboardPayload,
} from "../../core/editor/clipboard/node-paste";
import type { EditorStore } from "../../core/state/EditorStore";
import type { DesignNode, Point, Rect } from "../../core/types";
import {
  buildFrameDropTargetLookup,
  buildFrameDropTargets,
  findFrameDropTargetAtPoint,
  isNodeLocked,
} from "./interaction-helpers";

export function getClipboardEntryIds(entry: NodeClipboardEntry, ids = new Set<string>()) {
  ids.add(entry.node.id);
  for (const child of entry.node.children) {
    getClipboardEntryIds({ node: child, canvasPosition: entry.canvasPosition }, ids);
  }
  return ids;
}

export function getClipboardPayloadNodeCount(payload: NodeClipboardPayload): number {
  const countEntry = (entry: NodeClipboardEntry): number =>
    1 +
    entry.node.children.reduce(
      (count, child) => count + countEntry({ node: child, canvasPosition: entry.canvasPosition }),
      0,
    );
  return payload.nodes.reduce((count, entry) => count + countEntry(entry), 0);
}

export function getClipboardBounds(entries: NodeClipboardEntry[]): Rect | null {
  if (entries.length === 0) return null;
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    left = Math.min(left, entry.canvasPosition.x);
    top = Math.min(top, entry.canvasPosition.y);
    right = Math.max(right, entry.canvasPosition.x + entry.node.width);
    bottom = Math.max(bottom, entry.canvasPosition.y + entry.node.height);
  }
  return Number.isFinite(left)
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : null;
}

export function getNodesInDocumentOrder(store: EditorStore, nodes: readonly DesignNode[]) {
  if (nodes.length <= 1) return [...nodes];
  const siblingIndices = new WeakMap<DesignNode[], Map<string, number>>();
  const getSiblingIndex = (siblings: DesignNode[], nodeId: string) => {
    let indices = siblingIndices.get(siblings);
    if (!indices) {
      indices = new Map(siblings.map((sibling, index) => [sibling.id, index]));
      siblingIndices.set(siblings, indices);
    }
    return indices.get(nodeId) ?? Number.MAX_SAFE_INTEGER;
  };
  const getPath = (node: DesignNode) => {
    const path: number[] = [];
    let current: DesignNode | undefined = node;
    while (current) {
      const parent = store.getParent(current.id);
      const siblings = parent?.children ?? store.nodes;
      path.unshift(getSiblingIndex(siblings, current.id));
      current = parent;
    }
    return path;
  };

  return nodes
    .map((node, originalIndex) => ({ node, originalIndex, path: getPath(node) }))
    .sort((left, right) => {
      const length = Math.min(left.path.length, right.path.length);
      for (let index = 0; index < length; index++) {
        if (left.path[index] !== right.path[index]) return left.path[index]! - right.path[index]!;
      }
      return left.path.length - right.path.length || left.originalIndex - right.originalIndex;
    })
    .map(({ node }) => node);
}

function getFrameAncestorChain(store: EditorStore, nodeId: string) {
  const frames: DesignNode[] = [];
  let currentId: string | undefined = nodeId;
  while (currentId) {
    const currentNode = store.getNode(currentId);
    if (currentNode?.type === "frame") frames.push(currentNode);
    currentId = store.parentMap.get(currentId);
  }
  return frames;
}

export function getCommonSelectedPasteParent(store: EditorStore, copiedIds: ReadonlySet<string>) {
  const selectedNodes = store.selectedNodes.filter((node) => !copiedIds.has(node.id));
  if (selectedNodes.length !== store.selectedNodes.length && selectedNodes.length === 0)
    return null;
  if (store.enteredContainerId) {
    const entered = store.getNode(store.enteredContainerId);
    if (
      entered?.type === "frame" &&
      !copiedIds.has(entered.id) &&
      !isNodeLocked(store, entered.id)
    ) {
      return entered;
    }
  }
  if (selectedNodes.length === 0) return null;

  // A locked frame accepts no paste, the same as it accepts no canvas drop or
  // layer drop, so the chain walks past it to the nearest unlocked ancestor.
  const firstChain = getFrameAncestorChain(store, selectedNodes[0].id);
  return (
    firstChain.find(
      (candidate) =>
        !copiedIds.has(candidate.id) &&
        !isNodeLocked(store, candidate.id) &&
        selectedNodes.every((node) =>
          getFrameAncestorChain(store, node.id).some((frame) => frame.id === candidate.id),
        ),
    ) ?? null
  );
}

export function getViewportCanvasCenter(store: EditorStore, viewportEl: HTMLElement) {
  const rect = viewportEl.getBoundingClientRect();
  return store.screenToCanvas(screenPoint(rect.width / 2, rect.height / 2));
}

export function getViewportCenterPasteParent(
  store: EditorStore,
  viewportEl: HTMLElement,
  copiedIds: ReadonlySet<string>,
) {
  const center = getViewportCanvasCenter(store, viewportEl);
  const viewportRect = viewportEl.getBoundingClientRect();
  const screenX = viewportRect.left + viewportRect.width / 2;
  const screenY = viewportRect.top + viewportRect.height / 2;

  if (typeof document.elementsFromPoint === "function") {
    const visitedNodeIds = new Set<string>();
    let sawDesignNode = false;
    for (const element of document.elementsFromPoint(screenX, screenY)) {
      let node =
        (element instanceof Element
          ? store.getNode(element.getAttribute("data-node-id") ?? "")
          : undefined) ??
        (element instanceof HTMLElement ? store.domIndex.findNodeFromElement(element) : undefined);
      if (node) sawDesignNode = true;
      while (node && !visitedNodeIds.has(node.id)) {
        visitedNodeIds.add(node.id);
        if (
          node.type === "frame" &&
          !copiedIds.has(node.id) &&
          store.isNodeWithinSelectionScope(node.id) &&
          !isNodeLocked(store, node.id)
        ) {
          return node;
        }
        node = store.getParent(node.id);
      }
    }
    if (sawDesignNode) return null;
  }

  const lookup = buildFrameDropTargetLookup(
    buildFrameDropTargets(store, viewportEl, copiedIds, {
      left: center.x,
      top: center.y,
      right: center.x,
      bottom: center.y,
    }),
  );
  const target = findFrameDropTargetAtPoint(lookup, center)?.node ?? null;
  return target && !copiedIds.has(target.id) ? target : null;
}

export function clonePersistedNodeWithPosition(
  entry: NodeClipboardEntry,
  position: Point,
  options?: { absoluteWithinParent?: boolean },
): NodeClipboardEntry["node"] {
  return {
    ...entry.node,
    styles: {
      ...entry.node.styles,
      ...(options?.absoluteWithinParent ? { position: "absolute" } : {}),
    },
    x: position.x,
    y: position.y,
  };
}

export function getSourceSiblingPasteParent(store: EditorStore, payload: NodeClipboardPayload) {
  const parentIds = new Set(payload.nodes.map((entry) => entry.parentId));
  if (parentIds.size !== 1) return null;
  const [parentId] = [...parentIds];
  if (!parentId) return null;
  const parent = store.getNode(parentId);
  if (parent?.type !== "frame") return null;
  return isFlowLayoutDisplay(parent.styles.display) ? parent : null;
}

export function isFlowChildEntry(store: EditorStore, entry: NodeClipboardEntry): boolean {
  if (entry.node.styles.position === "absolute" || !entry.parentId) return false;
  const parent = store.getNode(entry.parentId);
  return !!parent && isFlowLayoutDisplay(parent.styles.display);
}
