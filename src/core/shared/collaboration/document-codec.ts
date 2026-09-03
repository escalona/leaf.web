import type { DesignNode } from "../../types";
import {
  getDocumentPages,
  type PersistedDesignNode,
  type PersistedEditorDocument,
} from "../../state/document";
import {
  LEAF_DEFAULT_PAGE_ID,
  LEAF_MAX_RECORD_SCHEMA_VERSION,
  LEAF_MIN_RECORD_SCHEMA_VERSION,
  LEAF_RECORD_SCHEMA_VERSION,
  getLeafPages,
  type LeafNodeRecord,
  type LeafPageRecord,
  type LeafRecordSnapshot,
} from "./protocol";
import { createInitialLeafRank } from "./model";

export function persistedDocumentToLeafSnapshot(
  document: PersistedEditorDocument,
): LeafRecordSnapshot {
  const records: LeafNodeRecord[] = [];
  const documentPages = getDocumentPages(document);
  const pages: LeafPageRecord[] = documentPages.map((page, index) => {
    const background = page.background?.trim();
    return background
      ? { id: page.id, name: page.name, rank: createInitialLeafRank(index), background }
      : { id: page.id, name: page.name, rank: createInitialLeafRank(index) };
  });

  // Rank uniqueness is enforced per PARENT, and every root has `parentId: null`
  // regardless of which page it sits on — so root ranks have to be allocated
  // across the whole document, not restarted per page. Restarting gives the
  // first root of every page the same rank and the snapshot is rejected with
  // "Duplicate sibling rank" the moment a model is built from it.
  let rootRankIndex = 0;
  const visit = (
    nodes: readonly PersistedDesignNode[],
    parentId: string | null,
    pageId: string,
  ) => {
    nodes.forEach((node, index) => {
      const rank = createInitialLeafRank(parentId === null ? rootRankIndex++ : index);
      records.push(persistedNodeToLeafRecord(node, parentId, rank, pageId));
      visit(node.children, String(node.id), pageId);
    });
  };
  for (const page of documentPages) visit(page.nodes, null, page.id);

  return { schemaVersion: LEAF_RECORD_SCHEMA_VERSION, records, pages };
}

export function leafSnapshotToPersistedDocument(
  snapshot: LeafRecordSnapshot,
): PersistedEditorDocument {
  const schemaVersion = Number(snapshot.schemaVersion);
  if (
    !Number.isFinite(schemaVersion) ||
    schemaVersion < LEAF_MIN_RECORD_SCHEMA_VERSION ||
    schemaVersion > LEAF_MAX_RECORD_SCHEMA_VERSION
  ) {
    throw new Error(`Unsupported Leaf record schema: ${snapshot.schemaVersion}`);
  }
  const recordMap = new Map(snapshot.records.map((record) => [record.id, record]));
  if (recordMap.size !== snapshot.records.length)
    throw new Error("Snapshot contains duplicate IDs");
  const children = new Map<string | null, LeafNodeRecord[]>();
  for (const record of snapshot.records) {
    if (record.parentId !== null && !recordMap.has(record.parentId)) {
      throw new Error(`Snapshot parent not found: ${record.parentId}`);
    }
    const siblings = children.get(record.parentId) ?? [];
    siblings.push(record);
    children.set(record.parentId, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort(
      (left, right) => left.rank.localeCompare(right.rank) || left.id.localeCompare(right.id),
    );
  }
  const building = new Set<string>();
  const built = new Set<string>();
  const build = (record: LeafNodeRecord): PersistedDesignNode => {
    if (building.has(record.id)) throw new Error("Snapshot contains a cycle");
    building.add(record.id);
    const node = leafRecordToPersistedNode(record);
    node.children = (children.get(record.id) ?? []).map(build);
    building.delete(record.id);
    built.add(record.id);
    return node;
  };
  const roots = children.get(null) ?? [];
  const snapshotPages = getLeafPages(snapshot);
  const rootsByPage = new Map<string, LeafNodeRecord[]>();
  for (const root of roots) {
    const pageId = root.pageId;
    const bucket = rootsByPage.get(pageId) ?? [];
    bucket.push(root);
    rootsByPage.set(pageId, bucket);
  }

  const pages = snapshotPages.map((page) => ({
    id: page.id,
    name: page.name,
    nodes: (rootsByPage.get(page.id) ?? []).map(build),
    ...(page.background ? { background: page.background } : {}),
  }));

  // Roots pointing at a page that no longer exists would otherwise vanish
  // silently; fold them onto the first page instead of dropping the work.
  const knownPageIds = new Set(snapshotPages.map((page) => page.id));
  for (const [pageId, bucket] of rootsByPage) {
    if (knownPageIds.has(pageId)) continue;
    pages[0]!.nodes.push(...bucket.map(build));
  }

  if (built.size !== snapshot.records.length)
    throw new Error("Snapshot contains unreachable nodes");
  return { version: 1, nodes: pages[0]!.nodes, pages };
}

export function persistedNodeToLeafRecord(
  node: PersistedDesignNode,
  parentId: string | null,
  rank: string,
  pageId: string = LEAF_DEFAULT_PAGE_ID,
): LeafNodeRecord {
  return {
    id: String(node.id),
    parentId,
    pageId,
    rank,
    type: node.type,
    name: String(node.name),
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    rotation: node.rotation ?? 0,
    visible: node.visible !== false,
    locked: node.locked === true,
    backgroundColor: String(node.backgroundColor),
    borderRadius: node.borderRadius,
    borderColor: String(node.borderColor),
    borderWidth: node.borderWidth,
    content: String(node.content),
    imageAsset: node.imageAsset ? { ...node.imageAsset } : null,
    imageGeneration: node.imageGeneration
      ? { ...node.imageGeneration, referenceNodeIds: [...node.imageGeneration.referenceNodeIds] }
      : null,
    fontSize: node.fontSize,
    fontFamily: String(node.fontFamily),
    color: String(node.color),
    fontWeight: String(node.fontWeight),
    textAutoSize: node.textAutoSize ?? false,
    isArtboard: node.isArtboard,
    styles: { ...node.styles },
  };
}

export function designNodeToLeafRecord(
  node: DesignNode,
  parentId: string | null,
  rank: string,
  pageId: string = LEAF_DEFAULT_PAGE_ID,
): LeafNodeRecord {
  return persistedNodeToLeafRecord(node, parentId, rank, pageId);
}

export function designSubtreeToLeafRecords(
  root: DesignNode,
  parentId: string | null,
  rootRank: string,
  pageId: string = LEAF_DEFAULT_PAGE_ID,
): LeafNodeRecord[] {
  const records: LeafNodeRecord[] = [];
  const visit = (node: DesignNode, currentParentId: string | null, rank: string) => {
    records.push(designNodeToLeafRecord(node, currentParentId, rank, pageId));
    node.children.forEach((child, index) => visit(child, node.id, createInitialLeafRank(index)));
  };
  visit(root, parentId, rootRank);
  return records;
}

export function leafRecordToPersistedNode(record: LeafNodeRecord): PersistedDesignNode {
  return {
    id: record.id,
    type: record.type,
    name: record.name,
    x: record.x,
    y: record.y,
    width: record.width,
    height: record.height,
    rotation: record.rotation ?? 0,
    visible: record.visible,
    locked: record.locked === true,
    backgroundColor: record.backgroundColor,
    borderRadius: record.borderRadius,
    borderColor: record.borderColor,
    borderWidth: record.borderWidth,
    content: record.content,
    imageAsset: record.imageAsset ? { ...record.imageAsset } : null,
    imageGeneration: record.imageGeneration
      ? {
          ...record.imageGeneration,
          referenceNodeIds: [...record.imageGeneration.referenceNodeIds],
        }
      : null,
    fontSize: record.fontSize,
    fontFamily: record.fontFamily,
    color: record.color,
    fontWeight: record.fontWeight,
    textAutoSize: record.textAutoSize,
    isArtboard: record.isArtboard,
    styles: { ...record.styles },
    children: [],
  };
}
