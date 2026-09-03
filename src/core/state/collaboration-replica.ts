import { runInAction } from "mobx";
import type { DesignNode } from "../types";
import {
  LeafReferenceDocument,
  cloneLeafRecord,
  leafRecordToPersistedNode,
  persistedDocumentToLeafSnapshot,
  type LeafCanonicalPatch,
  type LeafNodeRecord,
  type LeafRecordSnapshot,
} from "../shared/collaboration";
import {
  designNodeToPersistedNode,
  persistedNodeToDesignNode,
  type PersistedEditorDocument,
} from "./document";
import type { EditorStore } from "./EditorStore";
import { applyPagesToStore } from "./collaboration-pages";
import { applyCommentEntriesToStore, replaceStoreComments } from "./collaboration-comments";
import {
  noteCommentAnchorNodesDeleted,
  noteCommentAnchorNodesRestored,
} from "../editor/comment-anchor-lifecycle";
import {
  collectProgressiveDetailGates,
  PROGRESSIVE_INSERT_NODE_THRESHOLD,
} from "../editor/progressive-render";

type ReplicaApplyOptions = {
  preserveTextEditingSessionIds?: ReadonlySet<string>;
};

/** Incrementally applies canonical collaboration patches to the existing MobX graph. */
export class EditorStoreCollaborationReplica {
  readonly document: LeafReferenceDocument;

  constructor(
    private readonly store: EditorStore,
    initial: PersistedEditorDocument | LeafRecordSnapshot,
  ) {
    const snapshot = "version" in initial ? persistedDocumentToLeafSnapshot(initial) : initial;
    this.document = LeafReferenceDocument.adopt(
      snapshot.records,
      snapshot.pages,
      snapshot.comments,
    );
    replaceStoreComments(store, this.document.comments());
  }

  getRecord(nodeId: string) {
    const record = this.document.records.get(nodeId);
    return record ? cloneLeafRecord(record) : null;
  }

  snapshot() {
    return this.document.snapshot();
  }

  apply(patches: readonly LeafCanonicalPatch[], options: ReplicaApplyOptions = {}) {
    if (patches.length === 0) return;
    this.document.apply(patches);
    runInAction(() => {
      for (const patch of patches) this.applyToStore(patch, options);
      this.store.setHistoryState(this.store.canUndo, this.store.canRedo);
    });
  }

  /** Restores the MobX projection after an editor mutation fails before canonical acceptance. */
  restoreStoreFromDocument() {
    // Project EVERY page, not `store.nodes` (which is only the active page's
    // roots). Projecting one page while re-creating the whole canonical document
    // leaves background-page roots in the store, so the createRecords pass below
    // throws `Replica node exists` and the rollback fails outright.
    const projected = persistedDocumentToLeafSnapshot({
      version: 1,
      nodes: this.store.pages[0]?.nodes.map(designNodeToPersistedNode) ?? [],
      pages: this.store.pages.map((page) => ({
        id: page.id,
        name: page.name,
        nodes: page.nodes.map(designNodeToPersistedNode),
      })),
    }).records;
    const canonical = this.document.snapshot();
    runInAction(() => {
      if (projected.length) this.applyToStore({ type: "deleteRecords", records: projected });
      // Reinstate the canonical page list first so the roots below route to the
      // page their record names rather than to whichever page is active.
      applyPagesToStore(this.store, this.document.pages());
      replaceStoreComments(this.store, this.document.comments());
      if (canonical.length) this.applyToStore({ type: "createRecords", records: canonical });
      this.store.setHistoryState(this.store.canUndo, this.store.canRedo);
    });
  }

  private applyToStore(patch: LeafCanonicalPatch, options: ReplicaApplyOptions = {}) {
    switch (patch.type) {
      case "patchFields": {
        const node = this.store.nodeMap.get(patch.nodeId);
        if (!node) return;
        let nextStyles: Record<string, string | number> | null = null;
        for (const delta of patch.deltas) {
          if (delta.target === "style") {
            nextStyles ??= { ...node.styles };
            if (delta.after.present) nextStyles[delta.key] = delta.after.value as string | number;
            else delete nextStyles[delta.key];
            continue;
          }
          assignNodeField(node, delta.key, delta.after.value);
        }
        if (nextStyles) node.styles = nextStyles;
        return;
      }
      case "moveRecord": {
        const node = this.store.nodeMap.get(patch.nodeId);
        if (!node) return;
        if (patch.after.parentId && !this.store.nodeMap.has(patch.after.parentId)) {
          return;
        }
        // A root's page is not part of the move patch — `pageId` travels as an
        // ordinary field write in the paired patchFields — so both ends of the
        // move have to be resolved from the record, or a move touching a
        // background page detaches from one page's array and re-attaches into
        // whichever page happens to be active, leaving the node in two places.
        const pageId = this.document.records.get(patch.nodeId)?.pageId;
        detachNode(this.store, node, pageId);
        attachNode(this.store, this.document.records, node, patch.after.parentId, pageId);
        this.store.markRenderTreeChanged();
        return;
      }
      case "deleteRecords": {
        // A redo or remote delete never runs the interactive conversion path;
        // capture anchored-thread geometry before the nodes leave the store
        // (deferred write — see noteCommentAnchorNodesDeleted).
        noteCommentAnchorNodesDeleted(
          this.store,
          patch.records.map((record) => record.id),
        );
        const deletedIds = new Set(patch.records.map((record) => record.id));
        for (const record of patch.records) {
          if (record.parentId !== null && deletedIds.has(record.parentId)) continue;
          const node = this.store.getNode(record.id);
          if (!node) continue;
          detachNode(this.store, node, record.pageId);
          this.store.unregisterNodeTree(node, {
            preserveTextEditingSessionIds: options.preserveTextEditingSessionIds,
          });
        }
        return;
      }
      case "createRecords": {
        const createdIds = new Set(patch.records.map((record) => record.id));
        const nodes = new Map<string, DesignNode>();
        for (const record of patch.records) {
          if (this.store.getNode(record.id)) throw new Error(`Replica node exists: ${record.id}`);
          nodes.set(record.id, persistedNodeToDesignNode(leafRecordToPersistedNode(record)));
        }
        for (const record of patch.records) {
          if (!record.parentId || !createdIds.has(record.parentId)) continue;
          nodes.get(record.parentId)!.children.push(nodes.get(record.id)!);
        }
        const roots = patch.records
          .filter((record) => record.parentId === null || !createdIds.has(record.parentId))
          .sort(compareRecords);
        if (patch.records.length >= PROGRESSIVE_INSERT_NODE_THRESHOLD) {
          this.store.deferRenderDetails(
            collectProgressiveDetailGates(roots.map((record) => nodes.get(record.id)!)),
          );
        }
        for (const record of roots) {
          const node = nodes.get(record.id)!;
          attachNode(this.store, this.document.records, node, record.parentId, record.pageId);
          this.store.registerNodeTree(node, record.parentId ?? undefined);
        }
        // An undone delete may restore a node whose comment threads this
        // session converted to point anchors; the lifecycle re-attaches them
        // (deferred — see noteCommentAnchorNodesRestored).
        noteCommentAnchorNodesRestored(
          this.store,
          patch.records.map((record) => record.id),
        );
        return;
      }
      case "setPages": {
        applyPagesToStore(this.store, patch.after);
        return;
      }
      case "commentRecords": {
        applyCommentEntriesToStore(this.store, patch.entries);
      }
    }
  }
}

function assignNodeField(node: DesignNode, key: string, value: unknown) {
  let clonedValue = value;
  if (value && typeof value === "object" && (key === "imageAsset" || key === "imageGeneration")) {
    clonedValue = structuredClone(value);
  }
  (node as unknown as Record<string, unknown>)[key] = clonedValue;
}

/**
 * The array a root record lives in.
 *
 * `store.nodes` is the ACTIVE page's roots, so using it directly routes every
 * remote root onto whatever page this client happens to be looking at. Resolving
 * through `record.pageId` is what keeps a peer's edit on a background page from
 * landing on the foreground one; an unknown page falls back to the active one,
 * matching how `leafSnapshotToPersistedDocument` folds orphaned roots.
 */
function rootSiblingsForPage(store: EditorStore, pageId: string | undefined) {
  if (!pageId) return store.nodes;
  return store.pages.find((page) => page.id === pageId)?.nodes ?? store.nodes;
}

function detachNode(store: EditorStore, node: DesignNode, pageId?: string) {
  const parent = store.getParent(node.id);
  const siblings = parent ? parent.children : rootSiblingsForPage(store, pageId);
  const index = siblings.indexOf(node);
  if (index >= 0) siblings.splice(index, 1);
  store.parentMap.delete(node.id);
}

function attachNode(
  store: EditorStore,
  records: ReadonlyMap<string, LeafNodeRecord>,
  node: DesignNode,
  parentId: string | null,
  pageId?: string,
) {
  const parent = parentId ? store.nodeMap.get(parentId) : null;
  if (parentId && !parent) throw new Error(`Replica parent not found: ${parentId}`);
  const siblings = parent ? parent.children : rootSiblingsForPage(store, pageId);
  const target = records.get(node.id);
  if (!target) throw new Error(`Replica ordering missing node: ${node.id}`);
  let low = 0;
  let high = siblings.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const sibling = records.get(siblings[middle].id);
    if (!sibling || compareRecords(sibling, target) <= 0) low = middle + 1;
    else high = middle;
  }
  siblings.splice(low, 0, node);
  if (parentId) store.parentMap.set(node.id, parentId);
}

function compareRecords(left: LeafNodeRecord, right: LeafNodeRecord) {
  return left.rank.localeCompare(right.rank) || left.id.localeCompare(right.id);
}
