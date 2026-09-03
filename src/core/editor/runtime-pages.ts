import { cloneNodeTree } from "../nodes/specs";
import type { DesignNode, EditorPage } from "../types";
import type { RuntimeOperationContext } from "./runtime-operation-context";

export function createPage(context: RuntimeOperationContext, name?: string): EditorPage {
  return applyPageMutation(context, () => {
    const page: EditorPage = {
      id: createPageId(),
      name: normalizePageName(name) ?? nextPageName(context),
      nodes: [],
    };
    context.store.pages.push(page);
    // The stored page is the observable MobX makes of the literal above.
    return context.requirePage(page.id);
  });
}

/** Copies a page and its contents, then activates the populated copy. */
export function duplicatePage(context: RuntimeOperationContext, pageId: string): EditorPage {
  const source = context.requirePage(pageId);

  const duplicatedPageId = applyPageMutation(context, () => {
    const page: EditorPage = {
      id: createPageId(),
      name: nextPageName(context),
      nodes: [],
    };
    context.store.pages.splice(context.store.pages.indexOf(source) + 1, 0, page);
    const sourceRoots = [...source.nodes];
    // Announce the page before its contents. A peer cannot route a cloned root
    // to a page it has not been told about yet.
    syncDocumentPages(context);

    for (const root of sourceRoots) {
      context.applyMutation({ type: "create-root" }, () =>
        context.insertRootNode(cloneNodeTree(root, {}), page.id),
      );
    }
    context.store.setActivePage(page.id);
    return page.id;
  });
  // A dispatcher-backed history transaction can replace the observable page
  // object while replaying its canonical batch, so resolve it after finalize.
  context.store.setActivePage(duplicatedPageId);
  return context.requirePage(duplicatedPageId);
}

export function renamePage(
  context: RuntimeOperationContext,
  pageId: string,
  name: string,
): EditorPage {
  return applyPageMutation(context, () => {
    const page = context.requirePage(pageId);
    const nextName = normalizePageName(name);
    if (nextName) page.name = nextName;
    return page;
  });
}

/** Sets or clears (with `null`) a page's durable canvas background colour. */
export function setPageBackground(
  context: RuntimeOperationContext,
  pageId: string,
  background: string | null,
): EditorPage {
  return applyPageMutation(context, () => {
    const page = context.requirePage(pageId);
    const color = background?.trim();
    if (color) page.background = color;
    else delete page.background;
    return page;
  });
}

/** Removes a page and every node on it. Refuses to empty the document. */
export function deletePage(context: RuntimeOperationContext, pageId: string): string {
  if (context.store.pages.length <= 1) throw new Error("Attempted to delete the only page");

  // An active-page delete is authoritative over the captured pointer stream.
  // Retire the gesture group before opening the page mutation, otherwise the
  // delete joins that group and its inverse can replay after the drawn node has
  // already disappeared. Resolve the page afterwards because cancellation can
  // rebuild the observable projection and replace its object identities.
  if (pageId === context.store.activePageId && context.store.pointerGestureActive) {
    context.store.cancelHistoryTransaction();
  }
  const page = context.requirePage(pageId);

  // The page's comment threads stay put. Comment records never enter the
  // canvas undo stack, so deleting them here would outlive an undo of the
  // page delete: the page and its nodes would come back, the conversations
  // would not. Left in place (keyed by the dead pageId, node anchors intact)
  // they are simply unreachable — the pins overlay scopes to the active page
  // and the sidebar hides threads whose page is gone — until an undo restores
  // the page, when they reappear exactly as they were. Only the session-local
  // UI that points at them is released.
  const openThread = context.store.openCommentThreadId
    ? context.store.commentRecords.get(context.store.openCommentThreadId)
    : undefined;
  if (openThread?.kind === "thread" && openThread.pageId === pageId) {
    context.store.setOpenCommentThread(null);
  }
  if (context.store.pendingCommentDraft?.pageId === pageId) {
    context.store.setPendingCommentDraft(null);
  }

  const deletedPageId = applyPageMutation(context, () => {
    const index = context.store.pages.indexOf(page);
    if (pageId === context.store.activePageId) {
      const successor = context.store.pages[index + 1] ?? context.store.pages[index - 1]!;
      context.store.setActivePage(successor.id, { allowDuringPointerGesture: true });
    }

    const roots = page.nodes.slice();
    for (const root of roots) {
      context.applyMutation({ type: "delete-subtree", nodeId: root.id }, () => {
        removePageRoot(context, page, root);
      });
      // A delete for a node the collaboration document never saw returns
      // before it runs the closure. Repeat the removal so no orphan remains.
      removePageRoot(context, page, root);
    }

    context.store.pages.splice(context.store.pages.indexOf(page), 1);
    return pageId;
  });
  return deletedPageId;
}

export function reorderPages(context: RuntimeOperationContext, pageIds: string[]): EditorPage[] {
  return applyPageMutation(context, () => {
    const byId = new Map(context.store.pages.map((page) => [page.id, page]));
    if (
      pageIds.length !== byId.size ||
      new Set(pageIds).size !== pageIds.length ||
      pageIds.some((pageId) => !byId.has(pageId))
    ) {
      throw new Error("reorderPages needs every page id exactly once");
    }
    context.store.pages = pageIds.map((pageId) => byId.get(pageId)!);
    return context.store.pages;
  });
}

/**
 * Moves nodes to another page as roots, keeping their canvas position so a
 * node lands where it looked, not where its old parent put it.
 */
export function moveNodesToPage(
  context: RuntimeOperationContext,
  nodeIds: string[],
  pageId: string,
): string[] {
  const page = context.requirePage(pageId);

  return applyPageMutation(context, () => {
    const moved: string[] = [];
    // A descendant travels with its ancestor, so moving both would tear the
    // subtree apart and leave the child as a sibling of its own parent.
    const topLevelIds = nodeIds.filter(
      (nodeId) =>
        !nodeIds.some(
          (candidate) => candidate !== nodeId && context.store.isDescendant(nodeId, candidate),
        ),
    );
    for (const nodeId of topLevelIds) {
      const node = context.store.getNode(nodeId);
      if (!node) continue;
      const isRoot = !context.store.parentMap.has(nodeId);
      if (isRoot && page.nodes.includes(node)) continue;

      const canvasPosition = context.store.getCanvasPosition(nodeId) ?? {
        x: node.x,
        y: node.y,
      };
      // Route through the shared mutation boundary so the reparent reaches
      // collaboration and history with the new page and canvas position.
      context.applyMutation({ type: "move-node", nodeId, patchFields: true }, () => {
        detachFromTree(context, node);
        context.store.parentMap.delete(nodeId);
        node.x = canvasPosition.x;
        node.y = canvasPosition.y;
        node.styles = { ...node.styles };
        delete node.styles.position;
        page.nodes.push(node);
      });
      moved.push(nodeId);
    }

    if (moved.length) {
      if (pageId !== context.store.activePageId) {
        const movedIds = new Set(moved);
        context.store.setSelectedIds(
          [...context.store.selectedIds].filter((selectedId) => !movedIds.has(selectedId)),
        );
      }
      context.store.markRenderTreeChanged();
    }
    return moved;
  });
}

/**
 * Page list writes share one history transaction with their implied node
 * operations. The settled page list is sent after the local mutation.
 */
function applyPageMutation<T>(context: RuntimeOperationContext, apply: () => T): T {
  const adapter = context.store.documentAdapter;
  if (!adapter) return apply();
  adapter.beginHistoryTransaction();
  try {
    const result = apply();
    syncDocumentPages(context);
    return result;
  } finally {
    adapter.endHistoryTransaction();
  }
}

function syncDocumentPages(context: RuntimeOperationContext) {
  context.applyMutation({ type: "set-pages" }, () => undefined);
}

function nextPageName(context: RuntimeOperationContext): string {
  const taken = new Set(context.store.pages.map((page) => page.name));
  let index = context.store.pages.length + 1;
  while (taken.has(`Page ${index}`)) index += 1;
  return `Page ${index}`;
}

function detachFromTree(context: RuntimeOperationContext, node: DesignNode) {
  const parent = context.store.getParent(node.id);
  if (parent) {
    const index = parent.children.indexOf(node);
    if (index !== -1) parent.children.splice(index, 1);
    return;
  }
  for (const page of context.store.pages) {
    const index = page.nodes.indexOf(node);
    if (index !== -1) {
      page.nodes.splice(index, 1);
      return;
    }
  }
}

function removePageRoot(context: RuntimeOperationContext, page: EditorPage, root: DesignNode) {
  const index = page.nodes.indexOf(root);
  if (index === -1) return;
  page.nodes.splice(index, 1);
  context.store.unregisterNodeTree(root);
}

function normalizePageName(name: string | undefined): string | null {
  const trimmed = name?.trim();
  return trimmed ? trimmed.slice(0, 50) : null;
}

let nextPageSequence = 0;

function createPageId(): string {
  const uuid = (
    globalThis as typeof globalThis & { crypto?: { randomUUID?: () => string } }
  ).crypto?.randomUUID?.();
  return `page_${uuid ?? `${Date.now().toString(36)}_${(nextPageSequence += 1)}`}`;
}
