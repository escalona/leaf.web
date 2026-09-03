import type { DesignNode } from "../types";
import type { DragInsertionPreview } from "../types";
import type { DomIndex } from "./DomIndex";

const MAX_PERSISTENT_CULL_SHELL_FRAMES = 1500;
const DESCENDANT_CULL_NODE_THRESHOLD = 2000;

export interface RenderPinState {
  dragDetachedIds: ReadonlySet<string>;
  dragCanvasOffsetIds: Iterable<string>;
  remoteDragPreviewIds: Iterable<string>;
  forcedRenderIds: Iterable<string>;
  editingTextNodeId: string | null;
  enteredContainerId: string | null;
  activeInteractionId: string | null;
  parentMap: ReadonlyMap<string, string>;
}

interface DeletableIds {
  delete(id: string): boolean;
}

export interface RenderTreeRemovalState {
  nodeMap: Map<string, DesignNode>;
  parentMap: Map<string, string>;
  selectedIds: DeletableIds;
  workingOnIds: DeletableIds;
  materializingIds: DeletableIds;
  hoveredId: string | null;
  clearHoveredNode(): void;
  forcedRenderCounts: DeletableIds;
  scriptInteractionRootIds: DeletableIds;
  deferredDetailRootIds: DeletableIds;
  generatedImageJobs: DeletableIds;
  dragCanvasOffset: DeletableIds;
  remoteDragPreviews: DeletableIds;
  dragDetachedIds: DeletableIds;
  dragPendingParentIds: DeletableIds;
  activeInteractiveSurfaceId: string | null;
  enteredContainerId: string | null;
  dragInsertionPreview: DragInsertionPreview | null;
  readonly editingTextNodeId: string | null;
  finishTextEditing(options?: { deleteEmptyText?: boolean }): void;
  evictRenderMembershipComputeds(nodeId: string): void;
  domIndex: DomIndex;
}

export type RenderTreeRemovalOptions = {
  preserveScriptSessionStateIds?: ReadonlySet<string>;
  preserveTextEditingSessionIds?: ReadonlySet<string>;
};

export function collectRenderPinnedAncestorIds(state: RenderPinState): Set<string> {
  const pinnedIds = new Set<string>([
    ...state.dragDetachedIds,
    ...state.dragCanvasOffsetIds,
    ...state.remoteDragPreviewIds,
    ...state.forcedRenderIds,
  ]);
  if (state.editingTextNodeId) pinnedIds.add(state.editingTextNodeId);
  if (state.enteredContainerId) pinnedIds.add(state.enteredContainerId);
  if (state.activeInteractionId) pinnedIds.add(state.activeInteractionId);

  const ancestors = new Set<string>();
  for (const pinnedId of pinnedIds) {
    let currentId: string | undefined = pinnedId;
    while (currentId && !ancestors.has(currentId)) {
      ancestors.add(currentId);
      currentId = state.parentMap.get(currentId);
    }
  }
  return ancestors;
}

export function collectForcedRenderSubtreeIds(
  forcedRenderIds: Iterable<string>,
  nodeMap: ReadonlyMap<string, DesignNode>,
): Set<string> {
  const subtreeIds = new Set<string>();
  const pending: DesignNode[] = [];

  for (const rootId of forcedRenderIds) {
    const root = nodeMap.get(rootId);
    if (root) pending.push(root);
  }

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (subtreeIds.has(current.id)) continue;
    subtreeIds.add(current.id);
    for (const child of current.children) pending.push(child);
  }

  return subtreeIds;
}

export function shouldCullDescendants(nodeCount: number): boolean {
  return nodeCount > DESCENDANT_CULL_NODE_THRESHOLD;
}

export function shouldKeepOffscreenFrameShells(nodeMap: ReadonlyMap<string, DesignNode>): boolean {
  let frameCount = 0;
  for (const [id, node] of nodeMap) {
    // Real nodeMap entries are keyed by their node id. Ignoring aliases also
    // keeps synthetic size-only test entries from distorting this guard.
    if (id !== node.id || node.type !== "frame") continue;
    frameCount += 1;
    if (frameCount > MAX_PERSISTENT_CULL_SHELL_FRAMES) return false;
  }
  return true;
}

export function registerNodeTreeEntries(
  node: DesignNode,
  nodeMap: Map<string, DesignNode>,
  parentMap: Map<string, string>,
  parentId?: string,
) {
  nodeMap.set(node.id, node);
  if (parentId) parentMap.set(node.id, parentId);
  for (const child of node.children) {
    registerNodeTreeEntries(child, nodeMap, parentMap, node.id);
  }
}

export function unregisterNodeTreeEntries(
  state: RenderTreeRemovalState,
  node: DesignNode,
  options: RenderTreeRemovalOptions = {},
) {
  for (const child of node.children) {
    unregisterNodeTreeEntries(state, child, options);
  }
  state.nodeMap.delete(node.id);
  state.parentMap.delete(node.id);
  state.selectedIds.delete(node.id);
  state.workingOnIds.delete(node.id);
  state.materializingIds.delete(node.id);
  if (state.hoveredId === node.id) {
    state.clearHoveredNode();
  }
  if (!options.preserveScriptSessionStateIds?.has(node.id)) {
    state.forcedRenderCounts.delete(node.id);
    state.scriptInteractionRootIds.delete(node.id);
  }
  state.deferredDetailRootIds.delete(node.id);
  state.evictRenderMembershipComputeds(node.id);
  state.generatedImageJobs.delete(node.id);
  state.dragCanvasOffset.delete(node.id);
  state.remoteDragPreviews.delete(node.id);
  state.dragDetachedIds.delete(node.id);
  state.dragPendingParentIds.delete(node.id);
  if (state.activeInteractiveSurfaceId === node.id) {
    state.activeInteractiveSurfaceId = null;
  }
  if (state.enteredContainerId === node.id) {
    state.enteredContainerId = null;
  }
  if (
    state.dragInsertionPreview?.nodeId === node.id ||
    state.dragInsertionPreview?.parentId === node.id
  ) {
    state.dragInsertionPreview = null;
  }
  if (state.editingTextNodeId === node.id && !options.preserveTextEditingSessionIds?.has(node.id)) {
    // The caller is already removing this subtree. Finishing a newly-created
    // empty text session must not start a nested delete against the same list.
    state.finishTextEditing({ deleteEmptyText: false });
  }
  state.domIndex.unregister(node);
}
