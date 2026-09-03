import {
  LEAF_NODE_FIELD_KEYS,
  createLeafRankBetween,
  createLeafRanksBetween,
  designNodeToLeafRecord,
  designSubtreeToLeafRecords,
  type LeafNodeRecord,
  type LeafPropertyMutation,
  type LeafSemanticCommand,
} from "../shared/collaboration";
import type { DesignNode } from "../types";
import type { EditorStore } from "./EditorStore";

/**
 * The page a node's records belong to.
 *
 * Every record in a subtree carries its root ancestor's page, matching how
 * `persistedDocumentToLeafSnapshot` stamps a document on load. Falling back to
 * the record's existing page (rather than to the default) keeps a node whose
 * root the store has not attached yet — mid-mutation, or a detached subtree —
 * from being silently relocated to page one.
 */
function resolveRecordPageId(
  store: EditorStore,
  nodeId: string,
  fallback: LeafNodeRecord | undefined,
): string {
  return store.getPageIdForNode(nodeId) ?? fallback?.pageId ?? store.activePageId;
}

export function createPatchFieldsCommand(
  store: EditorStore,
  records: ReadonlyMap<string, LeafNodeRecord>,
  nodeId: string,
): LeafSemanticCommand | null {
  const before = records.get(nodeId);
  const node = store.getNode(nodeId);
  if (!before || !node) return null;
  const after = designNodeToLeafRecord(
    node,
    store.parentMap.get(nodeId) ?? null,
    before.rank,
    resolveRecordPageId(store, nodeId, before),
  );
  const mutations = diffRecordProperties(before, after);
  return mutations.length ? { type: "patchFields", nodeId, mutations } : null;
}

export function createMoveRecordCommand(
  store: EditorStore,
  records: ReadonlyMap<string, LeafNodeRecord>,
  nodeId: string,
): LeafSemanticCommand | null {
  const before = records.get(nodeId);
  const node = store.getNode(nodeId);
  if (!before || !node) return null;
  const parentId = store.parentMap.get(nodeId) ?? null;
  const siblings = parentId
    ? (store.getNode(parentId)?.children ?? [])
    : store.getRootSiblingsForNode(node.id);
  const index = siblings.indexOf(node);
  const afterId = findExistingSiblingId(siblings, index - 1, -1, records);
  const beforeId = findExistingSiblingId(siblings, index + 1, 1, records);
  const afterRank = afterId ? records.get(afterId)?.rank : undefined;
  const beforeRank = beforeId ? records.get(beforeId)?.rank : undefined;
  if (
    before.parentId === parentId &&
    (!afterRank || afterRank < before.rank) &&
    (!beforeRank || before.rank < beforeRank)
  ) {
    return null;
  }
  return {
    type: "moveRecord",
    nodeId,
    parentId,
    ...(afterId ? { afterId } : {}),
    ...(beforeId ? { beforeId } : {}),
  };
}

export function createRecordsCommand(
  store: EditorStore,
  existingRecords: ReadonlyMap<string, LeafNodeRecord>,
  nodes: readonly DesignNode[],
  explicitParentId?: string | null,
): LeafSemanticCommand {
  const pendingRanks = allocateCreatedSiblingRanks(store, existingRecords, nodes, explicitParentId);
  const records: LeafNodeRecord[] = [];
  for (const node of nodes) {
    const parentId =
      explicitParentId === undefined ? (store.parentMap.get(node.id) ?? null) : explicitParentId;
    const siblings = parentId
      ? (store.getNode(parentId)?.children ?? [])
      : store.getRootSiblingsForNode(node.id);
    const lastIndex = siblings.length - 1;
    const index = siblings[lastIndex] === node ? lastIndex : siblings.indexOf(node);
    const lowerRank = findSiblingRank(siblings, index - 1, -1, existingRecords, pendingRanks);
    const upperRank = findSiblingRank(siblings, index + 1, 1, existingRecords, pendingRanks);
    const rank = createLeafRankBetween(lowerRank, upperRank);
    pendingRanks.set(node.id, rank);
    // Without the page id every record created after load lands on the default
    // page, and reload folds the whole document onto page one.
    records.push(
      ...designSubtreeToLeafRecords(
        node,
        parentId,
        rank,
        resolveRecordPageId(store, node.id, existingRecords.get(node.id)),
      ),
    );
  }
  return { type: "createRecords", records };
}

function allocateCreatedSiblingRanks(
  store: EditorStore,
  existingRecords: ReadonlyMap<string, LeafNodeRecord>,
  nodes: readonly DesignNode[],
  explicitParentId?: string | null,
) {
  const createdIds = new Set(nodes.map((node) => node.id));
  const parentIds = new Set(
    nodes.map((node) =>
      explicitParentId === undefined ? (store.parentMap.get(node.id) ?? null) : explicitParentId,
    ),
  );
  const ranks = new Map<string, string>();

  for (const parentId of parentIds) {
    // For the root bucket, resolve siblings from the page that actually owns
    // these nodes rather than whichever page happens to be active.
    const rootSample = nodes.find(
      (candidate) =>
        (explicitParentId === undefined
          ? (store.parentMap.get(candidate.id) ?? null)
          : explicitParentId) === null,
    );
    const siblings = parentId
      ? (store.getNode(parentId)?.children ?? [])
      : rootSample
        ? store.getRootSiblingsForNode(rootSample.id)
        : store.nodes;
    let index = 0;
    while (index < siblings.length) {
      if (!createdIds.has(siblings[index]!.id)) {
        index += 1;
        continue;
      }
      const start = index;
      while (index < siblings.length && createdIds.has(siblings[index]!.id)) index += 1;
      const run = siblings.slice(start, index);
      if (!run.length) continue;
      const lowerRank = findSiblingRank(siblings, start - 1, -1, existingRecords, ranks);
      const upperRank = findSiblingRank(siblings, index, 1, existingRecords, ranks);
      const allocated = createLeafRanksBetween(run.length, lowerRank, upperRank);
      run.forEach((node, runIndex) => ranks.set(node.id, allocated[runIndex]!));
    }
  }

  return ranks;
}

function diffRecordProperties(before: LeafNodeRecord, after: LeafNodeRecord) {
  const mutations: LeafPropertyMutation[] = [];
  for (const key of LEAF_NODE_FIELD_KEYS) {
    if (!deepEqual(before[key], after[key])) {
      const value = after[key];
      mutations.push({
        type: "setField",
        field: key,
        value: value && typeof value === "object" ? structuredClone(value) : value,
      });
    }
  }
  const styleKeys = new Set([...Object.keys(before.styles), ...Object.keys(after.styles)]);
  for (const key of styleKeys) {
    if (!(key in after.styles)) mutations.push({ type: "deleteStyle", key });
    else if (!deepEqual(before.styles[key], after.styles[key])) {
      mutations.push({ type: "setStyle", key, value: after.styles[key] });
    }
  }
  return mutations;
}

function findExistingSiblingId(
  siblings: readonly DesignNode[],
  start: number,
  direction: -1 | 1,
  records: ReadonlyMap<string, LeafNodeRecord>,
) {
  for (let index = start; index >= 0 && index < siblings.length; index += direction) {
    if (records.has(siblings[index].id)) return siblings[index].id;
  }
  return undefined;
}

function findSiblingRank(
  siblings: readonly DesignNode[],
  start: number,
  direction: -1 | 1,
  records: ReadonlyMap<string, LeafNodeRecord>,
  pendingRanks: ReadonlyMap<string, string>,
) {
  for (let index = start; index >= 0 && index < siblings.length; index += direction) {
    const siblingId = siblings[index].id;
    const rank = pendingRanks.get(siblingId) ?? records.get(siblingId)?.rank;
    if (rank) return rank;
  }
  return undefined;
}

function deepEqual(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}
