import type { EditorStore } from "../state/EditorStore";
import type { DocumentMutation } from "../state/document-adapter";
import type { DesignNode, EditorPage, Point } from "../types";
import type { RootPlacementInput } from "./root-placement";

/**
 * The narrow set of façade-owned capabilities used by EditorRuntime operation
 * modules. Keeping mutation dispatch here makes the extracted modules share the
 * exact same collaboration and history boundary as public EditorRuntime calls.
 */
export interface RuntimeOperationContext {
  store: EditorStore;
  applyMutation<T>(mutation: DocumentMutation, apply: () => T): T;
  assertParentPageTarget(parentId: string, pageId: string | undefined): void;
  getAutomaticRootPosition(
    size: RootPlacementInput["size"],
    pageId?: string,
    preferred?: DesignNode,
  ): Point;
  insertRootNode(node: DesignNode, pageId?: string): DesignNode;
  markMaterializing(nodes: DesignNode[]): void;
  requireNode(nodeId: string): DesignNode;
  requirePage(pageId: string): EditorPage;
}
