import type { EditorStore, RenderTreeInsertMutation } from "../../core/state/EditorStore";
import type { DesignNode } from "../../core/types";
import { buildVisibleLayerRows, type LayerRow } from "./layer-model";
import {
  getLayerRowsContentWidth,
  getLayerRowWidth,
  LAYER_ROW_DISCLOSURE_WIDTH,
  withDisclosureColumn,
} from "./layer-row-width";

export type LayerRowsCache = {
  collapsedIds: Set<string>;
  version: number;
  rows: LayerRow[];
  rowOrderById: Map<string, number>;
  subtreeEndOrderById: Map<string, number>;
  hasExpandableRows: boolean;
  contentWidth: number;
};

export function buildLayerRowMetadata(rows: LayerRow[]) {
  const rowOrderById = new Map<string, number>();
  const subtreeEndOrderById = new Map<string, number>();
  const openRows: LayerRow[] = [];
  let contentWidth = 0;
  let hasExpandableRows = false;

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    contentWidth = Math.max(contentWidth, getLayerRowWidth(row));
    if (row.hasChildren) hasExpandableRows = true;
    while (openRows.length > 0 && openRows[openRows.length - 1]!.depth >= row.depth) {
      subtreeEndOrderById.set(openRows.pop()!.node.id, index);
    }
    rowOrderById.set(row.node.id, index);
    openRows.push(row);
  }
  while (openRows.length > 0) {
    subtreeEndOrderById.set(openRows.pop()!.node.id, Number.POSITIVE_INFINITY);
  }
  return {
    rowOrderById,
    subtreeEndOrderById,
    hasExpandableRows,
    contentWidth: withDisclosureColumn(contentWidth, hasExpandableRows),
  };
}

export function findRowIndexAtOrder(cache: LayerRowsCache, targetOrder: number) {
  let low = 0;
  let high = cache.rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const order = cache.rowOrderById.get(cache.rows[middle]!.node.id);
    if (order === undefined || order >= targetOrder) high = middle;
    else low = middle + 1;
  }
  return low;
}

function addInsertedRowMetadata(
  cache: LayerRowsCache,
  rows: LayerRow[],
  insertionIndex: number,
  boundaryOrder: number,
) {
  if (rows.length === 0) return true;
  const previousOrder =
    insertionIndex === 0
      ? boundaryOrder - rows.length - 1
      : cache.rowOrderById.get(cache.rows[insertionIndex - 1]!.node.id);
  if (previousOrder === undefined) return false;
  const step = Number.isFinite(boundaryOrder)
    ? (boundaryOrder - previousOrder) / (rows.length + 1)
    : 1;
  const scale = Math.max(1, Math.abs(previousOrder), Math.abs(boundaryOrder));
  if (!Number.isFinite(step) || step <= scale * Number.EPSILON * 4) return false;

  const orders = rows.map((row, index) => {
    const order = previousOrder + step * (index + 1);
    cache.rowOrderById.set(row.node.id, order);
    return order;
  });
  const openRows: Array<{ row: LayerRow; index: number }> = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    while (openRows.length > 0 && openRows[openRows.length - 1]!.row.depth >= row.depth) {
      cache.subtreeEndOrderById.set(openRows.pop()!.row.node.id, orders[index]!);
    }
    openRows.push({ row, index });
  }
  while (openRows.length > 0) {
    cache.subtreeEndOrderById.set(openRows.pop()!.row.node.id, boundaryOrder);
  }
  return true;
}

/**
 * Extends the prior flattened row projection when a mutation appended one
 * group of sibling nodes. Returns null when the mutation cannot be proven safe,
 * causing the panel to rebuild its projection from the canonical node tree.
 */
export function applyInsertedLayerRows(
  previous: LayerRowsCache,
  mutation: RenderTreeInsertMutation,
  store: EditorStore,
  collapsedIds: Set<string>,
) {
  if (
    mutation.version !== previous.version + 1 ||
    previous.collapsedIds !== collapsedIds ||
    mutation.insertions.length === 0
  ) {
    return null;
  }

  const insertedIds = new Set(mutation.insertions.map(({ nodeId }) => nodeId));
  if (mutation.insertions.some(({ parentId }) => parentId && insertedIds.has(parentId))) {
    return null;
  }

  const groups = new Map<string | null, DesignNode[]>();
  for (const { nodeId, parentId } of mutation.insertions) {
    const node = store.getNode(nodeId);
    if (!node || store.parentMap.get(nodeId) !== parentId) return null;
    const key = parentId ?? null;
    const group = groups.get(key);
    if (group) group.push(node);
    else groups.set(key, [node]);
  }

  if (groups.size !== 1) return null;
  const [parentId, nodes] = [...groups][0]!;
  const siblings = parentId ? store.getNode(parentId)?.children : store.nodes;
  if (!siblings || nodes.length > siblings.length) return null;
  const suffixStart = siblings.length - nodes.length;
  if (!nodes.every((node, index) => siblings[suffixStart + index] === node)) return null;

  const parentOrder = parentId ? previous.rowOrderById.get(parentId) : undefined;
  const parentRowIndex =
    parentOrder === undefined ? undefined : findRowIndexAtOrder(previous, parentOrder);
  const insertionHidden = Boolean(
    parentId && (parentRowIndex === undefined || collapsedIds.has(parentId)),
  );
  // Row widths are measured without the disclosure column so a tree that only
  // now gains its first expandable row pays for that column once, against the
  // same baseline every row was measured on.
  const baseContentWidth =
    previous.contentWidth - (previous.hasExpandableRows ? LAYER_ROW_DISCLOSURE_WIDTH : 0);

  // Validation above reads only `previous`/`store`; the copies below protect the
  // committed cache from the metadata mutations and are built only once the
  // mutation is known to be applicable.
  const nextCache: LayerRowsCache = {
    ...previous,
    version: mutation.version,
    rows: [...previous.rows],
    rowOrderById: new Map(previous.rowOrderById),
    subtreeEndOrderById: new Map(previous.subtreeEndOrderById),
  };
  if (parentRowIndex !== undefined) {
    const row = nextCache.rows[parentRowIndex]!;
    if (!row.hasChildren) nextCache.rows[parentRowIndex] = { ...row, hasChildren: true };
    nextCache.hasExpandableRows = true;
  }
  if (insertionHidden) {
    nextCache.contentWidth = withDisclosureColumn(baseContentWidth, nextCache.hasExpandableRows);
    return nextCache;
  }

  // Appended siblings are frontmost in document paint order, so they enter the
  // frontmost-first projection before every existing sibling at any depth.
  const insertionIndex = parentId === null ? 0 : parentRowIndex! + 1;
  const boundaryOrder =
    previous.rowOrderById.get(previous.rows[insertionIndex]?.node.id ?? "") ??
    (parentId === null
      ? 0
      : (previous.subtreeEndOrderById.get(parentId) ?? Number.POSITIVE_INFINITY));
  const insertedRows = buildVisibleLayerRows(
    nodes,
    collapsedIds,
    parentId === null ? 0 : previous.rows[parentRowIndex!]!.depth + 1,
  );
  if (!addInsertedRowMetadata(nextCache, insertedRows, insertionIndex, boundaryOrder)) return null;
  nextCache.rows.splice(insertionIndex, 0, ...insertedRows);
  if (insertedRows.some((row) => row.hasChildren)) nextCache.hasExpandableRows = true;
  nextCache.contentWidth = withDisclosureColumn(
    getLayerRowsContentWidth(insertedRows, baseContentWidth),
    nextCache.hasExpandableRows,
  );
  return nextCache;
}

export function expandSelectedAncestors(
  collapsedIds: Set<string>,
  selectedIds: Set<string>,
  parentMap: Map<string, string>,
) {
  let changed = false;
  const nextCollapsedIds = new Set(collapsedIds);

  for (const selectedId of selectedIds) {
    let parentId = parentMap.get(selectedId);
    while (parentId) {
      if (nextCollapsedIds.delete(parentId)) changed = true;
      parentId = parentMap.get(parentId);
    }
  }

  return changed ? nextCollapsedIds : collapsedIds;
}
