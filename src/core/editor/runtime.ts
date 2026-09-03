import { makeAutoObservable, runInAction } from "mobx";
import { truncateName } from "./import/html-parser";
import type { HtmlParseOptions } from "./import/html-parser";
import type { DesignNode, EditorPage, ImageAssetRef, NodeType, Point } from "../types";
import {
  LEAF_MAX_COMMENT_RECORDS_PER_COMMAND,
  type LeafCommentRecord,
} from "../shared/collaboration";
import type { EditorStore } from "../state/EditorStore";
import { applyCommentWritesToStore } from "../state/collaboration-comments";
import {
  applyCommentAnchorConversions,
  collectCommentAnchorConversions,
} from "./comment-anchor-lifecycle";
import type {
  DocumentMutation,
  DocumentPersistenceAdapter,
  DuplicateNodeRequest,
  MoveNodeToParentOptions,
  PasteNodeRequest,
  PasteNodeResult,
  PreparedPasteNode,
  RenameNodeRequest,
  SetTextContentRequest,
  StyleUpdateRequest,
} from "../state/document-adapter";
import {
  clampInsertionIndex,
  getFlowInsertionChildIndex,
  planNodeMove,
} from "./interaction/flex-insertion";
import {
  findAvailableRootPlacement,
  getRootCanvasAabbs,
  getNodeModelAabb,
  type RootPlacementInput,
} from "./root-placement";
import { applyStyleUpdate, removeStyleKeys, type StylePatch } from "./style-mutation";
import {
  commitPreparedPaste as commitRuntimePreparedPaste,
  duplicateNodes as duplicateRuntimeNodes,
  preparePasteNodes as prepareRuntimePasteNodes,
  preparePasteNodesIncrementally as prepareRuntimePasteNodesIncrementally,
} from "./runtime-clipboard";
import {
  addNode as addRuntimeNode,
  createArtboard as createRuntimeArtboard,
  createImage as createRuntimeImage,
  createScriptNode as createRuntimeScriptNode,
  createSvg as createRuntimeSvg,
  type ArtboardCreationOptions,
  type ImageCreationOptions,
  type RootCreationOptions,
} from "./runtime-creation";
import { writeHtml as writeRuntimeHtml } from "./runtime-html";
import type { RuntimeOperationContext } from "./runtime-operation-context";
import {
  createPage as createRuntimePage,
  deletePage as deleteRuntimePage,
  duplicatePage as duplicateRuntimePage,
  moveNodesToPage as moveRuntimeNodesToPage,
  renamePage as renameRuntimePage,
  setPageBackground as setRuntimePageBackground,
  reorderPages as reorderRuntimePages,
} from "./runtime-pages";

export type {
  ArtboardCreationOptions,
  ImageCreationOptions,
  RootCreationOptions,
} from "./runtime-creation";

export class EditorRuntime {
  private readonly store: EditorStore;
  private readonly operationContext: RuntimeOperationContext;
  private mutationDepth = 0;

  constructor(store: EditorStore) {
    this.store = store;
    this.operationContext = {
      store,
      applyMutation: (mutation, apply) => this.applyMutation(mutation, apply),
      assertParentPageTarget: (parentId, pageId) => this.assertParentPageTarget(parentId, pageId),
      getAutomaticRootPosition: (size, pageId, preferred) =>
        this.getAutomaticRootPosition(size, pageId, preferred),
      insertRootNode: (node, pageId) => this.insertRootNode(node, pageId),
      markMaterializing: (nodes) => this.markMaterializing(nodes),
      requireNode: (nodeId) => this.requireNode(nodeId),
      requirePage: (pageId) => this.requirePage(pageId),
    };
    makeAutoObservable<
      EditorRuntime,
      "adapter" | "applyMutation" | "mutationDepth" | "operationContext" | "store"
    >(
      this,
      {
        adapter: false,
        applyMutation: false,
        mutationDepth: false,
        operationContext: false,
        store: false,
      },
      { autoBind: true },
    );
  }

  private getAutomaticRootPosition(
    size: RootPlacementInput["size"],
    pageId?: string,
    preferred?: DesignNode,
  ) {
    const page = pageId ? this.requirePage(pageId) : this.store.activePage;
    const rootBounds = getRootCanvasAabbs(this.store, page.nodes);
    const occupied = page.nodes
      .map((node) => rootBounds.get(node.id))
      .filter((rect): rect is NonNullable<typeof rect> => rect !== undefined);
    const preferredRect = preferred
      ? (rootBounds.get(preferred.id) ?? getNodeModelAabb(preferred))
      : null;
    const camera =
      page.id === this.store.activePageId
        ? { panX: this.store.panX, panY: this.store.panY, zoom: this.store.zoom }
        : (page.camera ?? {
            panX: this.store.panX,
            panY: this.store.panY,
            zoom: this.store.zoom,
          });
    const hasMeasuredViewport =
      this.store.viewportWidth > 0 &&
      this.store.viewportHeight > 0 &&
      Number.isFinite(camera.zoom) &&
      camera.zoom > 0 &&
      Number.isFinite(camera.panX) &&
      Number.isFinite(camera.panY);
    const viewport = hasMeasuredViewport
      ? {
          x: -camera.panX / camera.zoom,
          y: -camera.panY / camera.zoom,
          width: this.store.viewportWidth / camera.zoom,
          height: this.store.viewportHeight / camera.zoom,
        }
      : {
          // Headless tests and a just-opened canvas have no measured viewport
          // yet. This preserves Leaf's historical first-root position (100,100)
          // while the obstacle candidates still keep later roots apart.
          x: 0,
          y: 0,
          width: size.width + 200,
          height: size.height + 200,
        };

    return findAvailableRootPlacement({
      viewport,
      occupied,
      size,
      ...(preferredRect ? { preferred: preferredRect } : {}),
    });
  }

  private insertRootNode(node: DesignNode, pageId?: string) {
    const page = pageId ? this.requirePage(pageId) : this.store.activePage;
    page.nodes.push(node);
    this.store.registerNodeTree(node);
    return node;
  }

  private requireNode(nodeId: string): DesignNode {
    const node = this.store.getNode(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    return node;
  }

  private assertParentPageTarget(parentId: string, pageId: string | undefined) {
    if (!pageId) return;
    this.requirePage(pageId);
    const parentPageId = this.store.getPageIdForNode(parentId);
    if (parentPageId !== pageId) {
      throw new Error(`Parent ${parentId} does not belong to page ${pageId}`);
    }
  }

  private get adapter(): DocumentPersistenceAdapter | null {
    return this.store.documentAdapter;
  }

  private applyMutation<T>(mutation: DocumentMutation, apply: () => T): T {
    const adapter = this.adapter;
    if (!adapter || this.mutationDepth > 0) return apply();
    return adapter.executeMutation(mutation, () => {
      this.mutationDepth += 1;
      try {
        return apply();
      } finally {
        this.mutationDepth -= 1;
      }
    });
  }

  private markMaterializing(nodes: DesignNode[]) {
    const newIds: string[] = [];
    const collectIds = (node: DesignNode) => {
      newIds.push(node.id);
      for (const child of node.children) collectIds(child);
    };

    for (const node of nodes) collectIds(node);

    const batchStagger = newIds.length * 40;
    for (let i = 0; i < newIds.length; i++) {
      this.store.materializingIds.set(newIds[i], i * 40);
    }

    const batchIds = new Set(newIds);
    setTimeout(
      () =>
        runInAction(() => {
          for (const id of batchIds) {
            if (this.store.materializingIds.has(id) && batchIds.has(id)) {
              this.store.materializingIds.delete(id);
            }
          }
        }),
      500 + batchStagger + 200,
    );
  }

  addNode(type: NodeType, position: Point, options: RootCreationOptions = {}): DesignNode {
    return addRuntimeNode(this.operationContext, type, position, options);
  }

  removeNode(id: string) {
    // Captured before the delete (the pin's spot needs the node's geometry),
    // written after it as a separate durable comment transaction. Skipped for
    // nested calls: the outermost public entry point owns the conversion.
    const anchorConversions =
      this.mutationDepth === 0 ? collectCommentAnchorConversions(this.store, [id]) : [];
    const result = this.applyMutation({ type: "delete-subtree", nodeId: id }, () => {
      const node = this.store.getNode(id);
      if (!node) return;

      const parentId = this.store.parentMap.get(id);
      if (parentId) {
        const parent = this.store.getNode(parentId);
        if (parent) {
          const idx = parent.children.indexOf(node);
          if (idx !== -1) parent.children.splice(idx, 1);
        }
      }

      if (!parentId) {
        const siblings = this.store.getRootSiblingsForNode(id);
        const index = siblings.indexOf(node);
        if (index !== -1) siblings.splice(index, 1);
      }
      this.store.unregisterNodeTree(node);
    });
    applyCommentAnchorConversions(this.store, anchorConversions);
    return result;
  }

  reparentNode(nodeId: string, newParentId: string) {
    return this.applyMutation({ type: "move-node", nodeId }, () => {
      const node = this.store.getNode(nodeId);
      if (!node) return;

      const oldParent = this.store.getParent(nodeId);
      const newParent = this.store.getNode(newParentId);
      if (!newParent || oldParent === newParent) return;

      if (oldParent) {
        const idx = oldParent.children.indexOf(node);
        if (idx !== -1) oldParent.children.splice(idx, 1);
      } else {
        const siblings = this.store.getRootSiblingsForNode(nodeId);
        const idx = siblings.indexOf(node);
        if (idx !== -1) siblings.splice(idx, 1);
      }

      newParent.children.push(node);
      this.store.parentMap.set(nodeId, newParentId);
      this.store.markRenderTreeChanged();
    });
  }

  moveNodeToParent(
    nodeId: string,
    canvasPosition: Point,
    newParentId?: string,
    options?: MoveNodeToParentOptions,
  ) {
    return this.applyMutation({ type: "move-node", nodeId, patchFields: true }, () => {
      const node = this.store.getNode(nodeId);
      if (!node) return;

      const oldParent = this.store.getParent(nodeId);
      const newParent = newParentId ? this.store.getNode(newParentId) : undefined;
      if (newParentId && !newParent) return;
      const rootSiblings = this.store.getRootSiblingsForNode(nodeId);
      const oldSiblings = oldParent ? oldParent.children : rootSiblings;
      const currentIndex = oldSiblings.indexOf(node);
      if (currentIndex === -1) return;

      const plan = planNodeMove(
        {
          nodeId,
          nodePosition: node.styles.position as string | undefined,
          nodeX: node.x,
          nodeY: node.y,
          currentIndex,
          currentSiblings: oldSiblings,
          currentParentId: oldParent?.id,
          newParentChildren: newParent?.children,
          newParentId,
          rootSiblingCount: rootSiblings.length,
        },
        options,
      );
      if (plan.isNoOp) return;

      node.styles = { ...node.styles };
      oldSiblings.splice(currentIndex, 1);

      if (newParent) {
        if (plan.mode === "flow") {
          if (options?.flowRestore) {
            node.x = options.flowRestore.x;
            node.y = options.flowRestore.y;
            if (options.flowRestore.position === null) {
              delete node.styles.position;
            } else {
              node.styles.position = options.flowRestore.position;
            }
          } else if (node.styles.position === "relative") {
            node.styles.position = "relative";
          } else {
            node.x = 0;
            node.y = 0;
            delete node.styles.position;
          }
        } else {
          const parentCanvasPosition = this.store.getCanvasPosition(newParent.id) ?? {
            x: newParent.x,
            y: newParent.y,
          };
          node.x = canvasPosition.x - parentCanvasPosition.x;
          node.y = canvasPosition.y - parentCanvasPosition.y;
        }
        const insertionIndex =
          plan.mode === "flow"
            ? getFlowInsertionChildIndex(newParent.children, plan.nextFlowIndex ?? 0)
            : clampInsertionIndex(options?.index, newParent.children.length);
        newParent.children.splice(insertionIndex, 0, node);
        this.store.parentMap.set(nodeId, newParent.id);
        this.store.markRenderTreeChanged();
        return;
      }

      node.x = canvasPosition.x;
      node.y = canvasPosition.y;
      this.store.parentMap.delete(nodeId);
      delete node.styles.position;
      const insertionIndex = clampInsertionIndex(options?.index, rootSiblings.length);
      rootSiblings.splice(insertionIndex, 0, node);
      this.store.markRenderTreeChanged();
    });
  }

  updateNode(nodeId: string, patch: Partial<DesignNode>) {
    return this.applyMutation({ type: "patch-node", nodeId }, () => {
      const node = this.requireNode(nodeId);
      Object.assign(node, patch);
      return node;
    });
  }

  updateNodeStyles(
    nodeId: string,
    styles: StylePatch,
    ensureFontsLoaded?: (family: string) => void,
  ) {
    return this.applyMutation({ type: "patch-node", nodeId }, () => {
      this.updateStyles([{ nodeIds: [nodeId], styles }], ensureFontsLoaded);
      return this.requireNode(nodeId);
    });
  }

  /**
   * Take style keys off nodes. Distinct from writing an empty string, which
   * leaves a dead entry in the styles map that the Other-styles list would
   * keep showing.
   */
  removeNodeStyles(nodeIds: string[], keys: string[]): string[] {
    return this.applyMutation({ type: "patch-nodes" }, () => {
      const updated: string[] = [];
      for (const nodeId of nodeIds) {
        const node = this.requireNode(nodeId);
        removeStyleKeys(node, keys);
        updated.push(nodeId);
      }
      return updated;
    });
  }

  createScriptNode(
    type: NodeType,
    overrides: Partial<Omit<DesignNode, "children" | "type">> = {},
    parentId?: string,
    options: RootCreationOptions = {},
  ): DesignNode {
    return createRuntimeScriptNode(this.operationContext, type, overrides, parentId, options);
  }

  createArtboard(
    name: string,
    styles: Record<string, string | number>,
    options: ArtboardCreationOptions = {},
  ): DesignNode {
    return createRuntimeArtboard(this.operationContext, name, styles, options);
  }

  createSvg(
    content: string,
    size: { width: number; height: number },
    position: Point,
    name = "Ink Stroke",
    parentId?: string,
    options: RootCreationOptions = {},
  ): DesignNode {
    return createRuntimeSvg(
      this.operationContext,
      content,
      size,
      position,
      name,
      parentId,
      options,
    );
  }

  createImage(
    source: string | ImageAssetRef,
    size: { width: number; height: number },
    position?: Point,
    name = "Image",
    parentId?: string,
    options: ImageCreationOptions = {},
  ): DesignNode {
    return createRuntimeImage(
      this.operationContext,
      source,
      size,
      position,
      name,
      parentId,
      options,
    );
  }

  writeHtml(
    html: string,
    targetNodeId: string,
    mode: "insert-children" | "replace",
    options: Omit<HtmlParseOptions, "contextElement"> = {},
  ): DesignNode[] {
    return writeRuntimeHtml(this.operationContext, html, targetNodeId, mode, options);
  }

  updateStyles(
    updates: StyleUpdateRequest[],
    ensureFontsLoaded?: (family: string) => void,
  ): string[] {
    return this.applyMutation({ type: "patch-nodes" }, () => {
      const updated: string[] = [];
      for (const { nodeIds, styles } of updates) {
        for (const nodeId of nodeIds) {
          const node = this.requireNode(nodeId);
          applyStyleUpdate(node, styles, ensureFontsLoaded);
          updated.push(nodeId);
        }
      }
      return updated;
    });
  }

  setTextContent(updates: SetTextContentRequest[]): string[] {
    return this.applyMutation({ type: "patch-nodes" }, () => {
      const updated: string[] = [];
      for (const { nodeId, textContent } of updates) {
        const node = this.requireNode(nodeId);
        // Text node names default to a truncation of their content. Keep that
        // derived name in sync so tree summaries and the layers panel reflect
        // the new text, but never overwrite a custom (user or agent) name.
        const hadDerivedName = node.name === (truncateName(node.content) || "Text");
        node.content = textContent;
        if (node.type === "text" && hadDerivedName) {
          node.name = truncateName(textContent) || "Text";
        }
        updated.push(nodeId);
      }
      return updated;
    });
  }

  duplicateNodes(nodes: DuplicateNodeRequest[]) {
    return duplicateRuntimeNodes(this.operationContext, nodes);
  }

  preparePasteNodes(nodes: PasteNodeRequest[]): PreparedPasteNode[] {
    return prepareRuntimePasteNodes(this.operationContext, nodes);
  }

  async preparePasteNodesIncrementally(nodes: PasteNodeRequest[]): Promise<PreparedPasteNode[]> {
    return prepareRuntimePasteNodesIncrementally(this.operationContext, nodes);
  }

  commitPreparedPaste(nodes: PreparedPasteNode[]): PasteNodeResult[] {
    return commitRuntimePreparedPaste(this.operationContext, nodes);
  }

  deleteNodes(nodeIds: string[]): string[] {
    const anchorConversions =
      this.mutationDepth === 0 ? collectCommentAnchorConversions(this.store, nodeIds) : [];
    const deleted = this.applyMutation({ type: "delete-nodes", nodeIds }, () => {
      const removed: string[] = [];
      for (const nodeId of nodeIds) {
        if (this.store.getNode(nodeId)) {
          this.removeNode(nodeId);
          removed.push(nodeId);
        }
      }
      return removed;
    });
    if (deleted.length) applyCommentAnchorConversions(this.store, anchorConversions);
    return deleted;
  }

  renameNodes(updates: RenameNodeRequest[]): string[] {
    return this.applyMutation({ type: "patch-nodes" }, () => {
      const renamed: string[] = [];
      for (const { nodeId, name } of updates) {
        const node = this.requireNode(nodeId);
        node.name = name.slice(0, 50);
        renamed.push(nodeId);
      }
      return renamed;
    });
  }

  /**
   * Durable comment-lane writes. Comments travel with the document and sync
   * through the same adapter, but they are not canvas content: the controller
   * keeps comment-only transactions out of the canvas undo stack.
   */
  updateCommentRecords(puts: readonly LeafCommentRecord[], deletes: readonly string[] = []) {
    if (puts.length === 0 && deletes.length === 0) return;
    // The room caps every commentRecords command at
    // LEAF_MAX_COMMENT_RECORDS_PER_COMMAND touched records; an oversized write
    // (deleting a long thread, dropping a page's lane) must be split or the
    // whole transaction is rejected and the local projection resyncs it back.
    let putIndex = 0;
    let deleteIndex = 0;
    while (putIndex < puts.length || deleteIndex < deletes.length) {
      const putChunk = puts.slice(putIndex, putIndex + LEAF_MAX_COMMENT_RECORDS_PER_COMMAND);
      putIndex += putChunk.length;
      const deleteChunk = deletes.slice(
        deleteIndex,
        deleteIndex + LEAF_MAX_COMMENT_RECORDS_PER_COMMAND - putChunk.length,
      );
      deleteIndex += deleteChunk.length;
      this.applyMutation(
        { type: "comment-records", puts: structuredClone(putChunk), deletes: [...deleteChunk] },
        () => {
          applyCommentWritesToStore(this.store, putChunk, deleteChunk);
        },
      );
    }
  }

  private requirePage(pageId: string): EditorPage {
    const page = this.store.pages.find((candidate) => candidate.id === pageId);
    if (!page) throw new Error(`Page not found: ${pageId}`);
    return page;
  }

  createPage(name?: string): EditorPage {
    return createRuntimePage(this.operationContext, name);
  }

  duplicatePage(pageId: string): EditorPage {
    return duplicateRuntimePage(this.operationContext, pageId);
  }

  renamePage(pageId: string, name: string): EditorPage {
    return renameRuntimePage(this.operationContext, pageId, name);
  }

  setPageBackground(pageId: string, background: string | null): EditorPage {
    return setRuntimePageBackground(this.operationContext, pageId, background);
  }

  deletePage(pageId: string): string {
    return deleteRuntimePage(this.operationContext, pageId);
  }

  reorderPages(pageIds: string[]): EditorPage[] {
    return reorderRuntimePages(this.operationContext, pageIds);
  }

  moveNodesToPage(nodeIds: string[], pageId: string): string[] {
    return moveRuntimeNodesToPage(this.operationContext, nodeIds, pageId);
  }
}
