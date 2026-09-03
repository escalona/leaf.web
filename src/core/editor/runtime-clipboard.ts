import { cloneNodeTree } from "../nodes/specs";
import { clonePersistedNodeToDesignNode } from "../state/document";
import type {
  DuplicateNodeRequest,
  PasteNodeRequest,
  PasteNodeResult,
  PreparedPasteNode,
} from "../state/document-adapter";
import type { DesignNode } from "../types";
import { clampInsertionIndex } from "./interaction/flex-insertion";
import {
  collectProgressiveDetailGates,
  PROGRESSIVE_INSERT_NODE_THRESHOLD,
} from "./progressive-render";
import { getNodeModelAabb } from "./root-placement";
import type { RuntimeOperationContext } from "./runtime-operation-context";

export function duplicateNodes(context: RuntimeOperationContext, nodes: DuplicateNodeRequest[]) {
  return context.applyMutation({ type: "duplicate-nodes" }, () => {
    const results: Array<{
      sourceId: string;
      newId: string;
      descendantIdMap: Record<string, string>;
    }> = [];
    const insertionGroups = new Map<
      string,
      {
        siblings: DesignNode[];
        entries: Array<{
          source: DesignNode;
          clone: DesignNode;
          sourceSiblingIndex: number;
          inputIndex: number;
        }>;
      }
    >();

    for (let inputIndex = 0; inputIndex < nodes.length; inputIndex++) {
      const { id, parentId } = nodes[inputIndex]!;
      const source = context.requireNode(id);
      const sourceParentId = context.store.parentMap.get(id);
      const sourceSiblings = sourceParentId
        ? context.requireNode(sourceParentId).children
        : context.store.getRootSiblingsForNode(id);
      const sourceSiblingIndex = sourceSiblings.indexOf(source);
      const idMap: Record<string, string> = {};
      const cloned = cloneNodeTree(source, idMap);
      let destinationKey: string;
      let destinationSiblings: DesignNode[];

      if (parentId) {
        const parent = context.requireNode(parentId);
        parent.children.push(cloned);
        context.store.registerNodeTree(cloned, parentId);
        destinationKey = `node:${parentId}`;
        destinationSiblings = parent.children;
      } else if (sourceParentId) {
        const parent = context.store.getNode(sourceParentId);
        if (!parent) throw new Error(`Parent not found: ${sourceParentId}`);
        parent.children.push(cloned);
        context.store.registerNodeTree(cloned, sourceParentId);
        destinationKey = `node:${sourceParentId}`;
        destinationSiblings = parent.children;
      } else {
        const pageId = context.store.getPageIdForNode(id);
        if (!pageId) throw new Error(`Cannot resolve page for root node: ${id}`);
        const sourceBounds = getNodeModelAabb(source);
        const cloneBounds = getNodeModelAabb(cloned);
        if (!sourceBounds || !cloneBounds) {
          throw new Error(`Cannot duplicate root ${id} with invalid dimensions or placement`);
        }
        const placement = context.getAutomaticRootPosition(
          { width: cloneBounds.width, height: cloneBounds.height },
          pageId,
          source,
        );
        // Placement works in AABB coordinates. Translate the cloned model
        // position by the same delta so rotated roots remain separated too.
        cloned.x += placement.x - cloneBounds.x;
        cloned.y += placement.y - cloneBounds.y;
        context.insertRootNode(cloned, pageId);
        destinationKey = `page:${pageId}`;
        destinationSiblings = context.requirePage(pageId).nodes;
      }

      let insertionGroup = insertionGroups.get(destinationKey);
      if (!insertionGroup) {
        insertionGroup = { siblings: destinationSiblings, entries: [] };
        insertionGroups.set(destinationKey, insertionGroup);
      }
      insertionGroup.entries.push({
        source,
        clone: cloned,
        sourceSiblingIndex,
        inputIndex,
      });

      results.push({
        sourceId: id,
        newId: cloned.id,
        descendantIdMap: idMap,
      });
    }

    for (const { siblings, entries } of insertionGroups.values()) {
      entries.sort(
        (left, right) =>
          left.sourceSiblingIndex - right.sourceSiblingIndex || left.inputIndex - right.inputIndex,
      );

      const clones = entries.map(({ clone }) => clone);
      const cloneIds = new Set(clones.map(({ id }) => id));
      for (let index = siblings.length - 1; index >= 0; index--) {
        if (cloneIds.has(siblings[index]!.id)) siblings.splice(index, 1);
      }

      const lastSource = entries.at(-1)!.source;
      const lastSourceIndex = siblings.indexOf(lastSource);
      const insertionIndex = lastSourceIndex === -1 ? siblings.length : lastSourceIndex + 1;
      siblings.splice(insertionIndex, 0, ...clones);
    }

    return results;
  });
}

export function preparePasteNodes(
  context: RuntimeOperationContext,
  nodes: PasteNodeRequest[],
): PreparedPasteNode[] {
  const pageId = context.store.activePageId;
  return nodes.map((request) => preparePasteNode(request, pageId));
}

export async function preparePasteNodesIncrementally(
  context: RuntimeOperationContext,
  nodes: PasteNodeRequest[],
): Promise<PreparedPasteNode[]> {
  const prepared: PreparedPasteNode[] = [];
  // Captured once, up front: the yields below let the user switch pages
  // before the last slice is prepared, and the paste belongs where it began.
  const pageId = context.store.activePageId;
  let sliceStartedAt = performance.now();
  for (const request of nodes) {
    prepared.push(preparePasteNode(request, pageId));
    if (performance.now() - sliceStartedAt < 6 || prepared.length === nodes.length) continue;
    await yieldToMainThread();
    sliceStartedAt = performance.now();
  }
  return prepared;
}

export function commitPreparedPaste(
  context: RuntimeOperationContext,
  nodes: PreparedPasteNode[],
): PasteNodeResult[] {
  return context.applyMutation({ type: "paste-nodes" }, () => {
    const results: PasteNodeResult[] = [];
    const registrations: Array<{ node: DesignNode; parentId?: string }> = [];

    const pastedNodeCount = nodes.reduce(
      (count, prepared) => count + Object.keys(prepared.result.descendantIdMap).length,
      0,
    );
    if (pastedNodeCount >= PROGRESSIVE_INSERT_NODE_THRESHOLD) {
      context.store.deferRenderDetails(
        collectProgressiveDetailGates(nodes.map(({ node }) => node)),
      );
    }

    for (const { node: cloned, parentId, pageId, index, afterNodeId, result } of nodes) {
      const parent = parentId ? context.store.getNode(parentId) : undefined;
      const siblings = parent ? parent.children : resolvePasteTargetPage(context, pageId).nodes;
      // Resolve the anchor against the live sibling list because earlier
      // entries in this same batch have already changed its indices.
      const anchorIndex = afterNodeId
        ? siblings.findIndex((sibling) => sibling.id === afterNodeId)
        : -1;
      const insertAt =
        anchorIndex >= 0
          ? anchorIndex + 1
          : index === undefined
            ? siblings.length
            : clampInsertionIndex(index, siblings.length);
      siblings.splice(insertAt, 0, cloned);
      registrations.push(parent ? { node: cloned, parentId } : { node: cloned });
      results.push(result);
    }

    context.store.registerNodeTrees(registrations);
    return results;
  });
}

/**
 * The page a root-level paste entry commits into. Entries prepared before a
 * page switch keep their captured page; a page deleted in the meantime fails
 * the paste with a message the feedback surface can show verbatim.
 */
function resolvePasteTargetPage(context: RuntimeOperationContext, pageId: string | undefined) {
  if (!pageId) return context.store.activePage;
  const page = context.store.pages.find((candidate) => candidate.id === pageId);
  if (!page) {
    throw new Error("The page this paste was headed for was deleted before it finished.");
  }
  return page;
}

function preparePasteNode(
  { node, parentId, offset, index, afterNodeId }: PasteNodeRequest,
  pageId: string,
): PreparedPasteNode {
  const idMap: Record<string, string> = {};
  const cloned = clonePersistedNodeToDesignNode(node, idMap);
  if (offset) {
    cloned.x += offset.x;
    cloned.y += offset.y;
  }
  return {
    node: cloned,
    ...(parentId ? { parentId } : { pageId }),
    ...(index === undefined ? {} : { index }),
    ...(afterNodeId === undefined ? {} : { afterNodeId }),
    result: { newId: cloned.id, descendantIdMap: idMap },
  };
}

function yieldToMainThread() {
  const browserScheduler = (
    globalThis as unknown as { scheduler?: { yield?: () => Promise<void> } }
  ).scheduler;
  if (browserScheduler?.yield) return browserScheduler.yield();
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}
