import type { EditorStore } from "../../core/state/EditorStore";
import type { EditorPage } from "../../core/types";

export interface PageCameraSummary {
  zoom: number;
  panX: number;
  panY: number;
}

/**
 * Compact, structured-cloneable page metadata for the MCP boundary.
 *
 * `rootCount` deliberately counts only the page's roots. Descendants remain
 * available through the existing node inspection tools.
 */
export interface PageSummary {
  id: string;
  name: string;
  index: number;
  active: boolean;
  rootCount: number;
  camera?: PageCameraSummary;
}

export interface PageResult {
  page: PageSummary;
  activePageId: string;
}

export interface DuplicatePageResult extends PageResult {
  descendantIdMap: Record<string, string>;
}

export interface DeletePageResult {
  deletedPageId: string;
  activePageId: string;
  activePage: PageSummary;
}

export interface MoveNodesToPageResult {
  moved: string[];
  page: PageSummary;
}

function requirePage(store: EditorStore, pageId: string): EditorPage {
  const page = store.pages.find((candidate) => candidate.id === pageId);
  if (!page) throw new Error(`Page not found: ${pageId}`);
  return page;
}

function summarizePage(store: EditorStore, summarized: EditorPage): PageSummary {
  // Resolve by id: mutation pipelines can replace page instances, so the
  // object handed in may no longer be identity-equal to the stored page,
  // which made indexOf report -1 for a page that clearly exists.
  const page = store.pages.find((candidate) => candidate.id === summarized.id) ?? summarized;
  const index = store.pages.findIndex((candidate) => candidate.id === page.id);
  const active = page.id === store.activePageId;
  // The active camera is live on EditorStore. It is parked on EditorPage only
  // when the user leaves that page, so reading page.camera here would report a
  // stale camera for the page currently on screen.
  const camera = active
    ? { zoom: store.zoom, panX: store.panX, panY: store.panY }
    : page.camera
      ? { ...page.camera }
      : undefined;

  return {
    id: page.id,
    name: page.name,
    index,
    active,
    rootCount: page.nodes.length,
    ...(camera ? { camera } : {}),
  };
}

export function listPages(store: EditorStore): PageSummary[] {
  return store.pages.map((page) => summarizePage(store, page));
}

export function createPage(store: EditorStore, name?: string): PageResult {
  const page = store.runtime.createPage(name);
  return {
    page: summarizePage(store, page),
    activePageId: store.activePageId,
  };
}

export function activatePage(store: EditorStore, pageId: string): PageResult {
  const page = requirePage(store, pageId);
  store.setActivePage(pageId);
  return {
    page: summarizePage(store, page),
    activePageId: store.activePageId,
  };
}

export function renamePage(store: EditorStore, pageId: string, name: string): PageSummary {
  requirePage(store, pageId);
  return summarizePage(store, store.runtime.renamePage(pageId, name));
}

export function deletePage(store: EditorStore, pageId: string): DeletePageResult {
  // Preflight before EditorRuntime checks the one-page invariant so a bogus id
  // always reports the missing target, even in a one-page document.
  requirePage(store, pageId);
  const deletedPageId = store.runtime.deletePage(pageId);
  return {
    deletedPageId,
    activePageId: store.activePageId,
    activePage: summarizePage(store, store.activePage),
  };
}

export function duplicatePage(store: EditorStore, pageId: string): DuplicatePageResult {
  const source = requirePage(store, pageId);
  type SourceTree = { id: string; children: SourceTree[] };
  const snapshotTree = (node: EditorPage["nodes"][number]): SourceTree => ({
    id: node.id,
    children: node.children.map(snapshotTree),
  });
  // Page duplication publishes the new page before its roots. Collaboration
  // reconciliation may replace observable page objects during that sequence,
  // so retain the source tree's stable shape/IDs rather than pairing against a
  // potentially stale page reference after the runtime mutation completes.
  const sourceRoots = source.nodes.map(snapshotTree);
  const page = store.runtime.duplicatePage(pageId);
  const descendantIdMap: Record<string, string> = {};
  const pairTrees = (sourceNode: SourceTree, copyNode: EditorPage["nodes"][number]) => {
    descendantIdMap[sourceNode.id] = copyNode.id;
    if (sourceNode.children.length !== copyNode.children.length) {
      throw new Error(`Duplicated page tree shape changed beneath source node ${sourceNode.id}`);
    }
    sourceNode.children.forEach((child, index) => pairTrees(child, copyNode.children[index]!));
  };
  if (sourceRoots.length !== page.nodes.length) {
    throw new Error(
      `Duplicated page root count changed for page ${pageId}: expected ${sourceRoots.length} roots (${sourceRoots.map((root) => root.id).join(", ")}), received ${page.nodes.length} (${page.nodes.map((root) => root.id).join(", ")})`,
    );
  }
  sourceRoots.forEach((root, index) => pairTrees(root, page.nodes[index]!));
  return {
    page: summarizePage(store, page),
    activePageId: store.activePageId,
    descendantIdMap,
  };
}

export function reorderPages(store: EditorStore, pageIds: string[]): PageSummary[] {
  // EditorRuntime validates completeness and uniqueness. This preflight makes
  // an explicit unknown id use the same strict missing-page error as every
  // other operation.
  for (const pageId of pageIds) requirePage(store, pageId);
  store.runtime.reorderPages(pageIds);
  return listPages(store);
}

export function moveNodesToPage(
  store: EditorStore,
  nodeIds: string[],
  pageId: string,
): MoveNodesToPageResult {
  const page = requirePage(store, pageId);
  const moved = store.runtime.moveNodesToPage(nodeIds, pageId);
  return { moved, page: summarizePage(store, page) };
}
