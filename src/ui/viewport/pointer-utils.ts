import type { EditorStore } from "../../core/state/EditorStore";
import { screenPoint, type CanvasPoint } from "../../core/editor/interaction/coordinate-spaces";
import type { DesignNode, ToolMode } from "../../core/types";
import { isNodeLocked } from "./interaction-helpers";

type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

function getTextOffsetFromPoint(root: HTMLElement, clientX: number, clientY: number) {
  const documentWithCaret = root.ownerDocument as CaretDocument;
  const caret = documentWithCaret.caretPositionFromPoint?.(clientX, clientY);
  const range = caret ? null : documentWithCaret.caretRangeFromPoint?.(clientX, clientY);
  const node = caret?.offsetNode ?? range?.startContainer;
  const offset = caret?.offset ?? range?.startOffset;
  if (!node || offset === undefined || !root.contains(node)) return null;

  let textOffset = 0;
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    if (current === node) {
      return textOffset + Math.max(0, Math.min(current.textContent?.length ?? 0, offset));
    }
    textOffset += current.textContent?.length ?? 0;
    current = walker.nextNode();
  }

  return textOffset;
}

export function getTextCaretSelectionFromPoint(
  target: EventTarget | null,
  clientX: number,
  clientY: number,
) {
  const element = target instanceof Element ? target : null;
  const textContentElement = element
    ?.closest("[data-node-id]")
    ?.querySelector<HTMLElement>("[data-text-content]");
  const offset = textContentElement
    ? getTextOffsetFromPoint(textContentElement, clientX, clientY)
    : null;
  return offset === null ? ({ type: "end" } as const) : ({ type: "offset", offset } as const);
}

export function getFallbackEmptyTextHeight(node: DesignNode) {
  const lineHeight = Number.parseFloat(String(node.styles.lineHeight ?? ""));
  if (Number.isFinite(lineHeight)) {
    return lineHeight > 4 ? Math.ceil(lineHeight) : Math.ceil(node.fontSize * lineHeight);
  }
  return Math.ceil(node.fontSize * 1.4);
}

export function setInteractionPointerCapture(target: HTMLElement, pointerId: number) {
  try {
    target.setPointerCapture(pointerId);
  } catch {
    // Ignore capture failures from unsupported or already-ended pointers.
  }
}

export function releaseInteractionPointerCapture(target: HTMLElement | null, pointerId: number) {
  try {
    target?.releasePointerCapture?.(pointerId);
  } catch {
    // Ignore release failures from unsupported or already-ended pointers.
  }
}

/**
 * Hits filter on locks only, not on the entered-container scope: a hit
 * outside the entered container retargets that scope on click and
 * previews the same target on hover, instead of being swallowed.
 */
export function isNodeHittable(store: EditorStore, nodeId: string) {
  return !isNodeLocked(store, nodeId);
}

/**
 * True for a tool whose press creates something on the canvas rather than
 * acting on the existing selection. While one is armed, the selection's
 * transform handles and the hover ring stand down: the press must draw, not
 * grab a handle of whatever happened to be selected before.
 */
export function isCreationTool(tool: ToolMode): boolean {
  return tool === "frame" || tool === "rectangle" || tool === "text" || tool === "ink";
}

export function getNodeFromPointerTarget(store: EditorStore, target: EventTarget | null) {
  if (!(target instanceof Element)) return null;
  const targetNodeId = target.getAttribute("data-node-id");
  if (targetNodeId) {
    const node = store.getNode(targetNodeId);
    if (node && isNodeHittable(store, node.id)) return node;
  }
  const node = target instanceof HTMLElement ? store.domIndex.findNodeFromElement(target) : null;
  return node && isNodeHittable(store, node.id) ? node : null;
}

export function hitTestSelectableNode(store: EditorStore, screenX: number, screenY: number) {
  const elements = document.elementsFromPoint(screenX, screenY);
  for (const element of elements) {
    if (element instanceof Element) {
      const nodeId = element.getAttribute("data-node-id");
      if (nodeId) {
        const node = store.getNode(nodeId);
        // A locked hit is not selectable, but something behind it may be.
        if (node && isNodeHittable(store, node.id)) return node;
      }
    }
    if (element instanceof HTMLElement) {
      const node = store.domIndex.findNodeFromElement(element);
      if (node && isNodeHittable(store, node.id)) return node;
    }
  }
  return null;
}

export function getCanvasPointFromClient(
  store: EditorStore,
  viewportEl: HTMLElement | null,
  clientX: number,
  clientY: number,
): CanvasPoint | null {
  const rect = viewportEl?.getBoundingClientRect() ?? null;
  if (!rect) return null;
  return store.screenToCanvas(screenPoint(clientX - rect.left, clientY - rect.top));
}

export function getExpandedViewportCanvasBounds(
  store: EditorStore,
  viewportEl: HTMLElement | null,
  marginPx: number,
) {
  const rect = viewportEl?.getBoundingClientRect() ?? null;
  if (!rect) return null;
  const topLeft = store.screenToCanvas(screenPoint(-marginPx, -marginPx));
  const bottomRight = store.screenToCanvas(
    screenPoint(rect.width + marginPx, rect.height + marginPx),
  );
  return {
    left: topLeft.x,
    top: topLeft.y,
    right: bottomRight.x,
    bottom: bottomRight.y,
  };
}
