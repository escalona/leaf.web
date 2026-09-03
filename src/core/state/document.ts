import type { DesignNode, NodeType } from "../types";
import { cloneNodeFields, createNode, generateId, getNodeDefaults } from "../nodes/specs";

export interface PersistedDesignNode extends Omit<DesignNode, "children"> {
  children: PersistedDesignNode[];
}

export interface PersistedPage {
  id: string;
  name: string;
  nodes: PersistedDesignNode[];
  camera?: { zoom: number; panX: number; panY: number };
  /** Colour behind this page's artboards; absent means the default canvas colour. */
  background?: string;
}

export interface PersistedEditorDocument {
  version: 1;
  /**
   * Root nodes of the first page. Kept as the canonical single-page shape so
   * pre-pages documents load untouched; `pages` supersedes it when present.
   */
  nodes: PersistedDesignNode[];
  pages?: PersistedPage[];
  /**
   * Colour painted behind the artboards, edited as the `Page` panel's colour.
   * Absent means "whatever the canvas has always looked like", so a document
   * that predates the field opens unchanged.
   *
   * The durable value lives per page (`PersistedPage.background`); this
   * document-level field is the pre-pages single-page shape and is folded
   * into the first page by `getDocumentPages`.
   */
  canvasBackground?: string;
}

export const DEFAULT_PAGE_ID = "page-default";
export const DEFAULT_PAGE_NAME = "Page 1";

/** The default colour painted behind the active page's artboards. */
export const DEFAULT_CANVAS_BACKGROUND = "#eeee";

export function getDocumentCanvasBackground(document: PersistedEditorDocument): string {
  const firstPage = document.pages?.[0];
  return resolvePageBackground(firstPage?.background ?? document.canvasBackground);
}

/** The colour to paint for a page's stored background: the default when unset. */
export function resolvePageBackground(background: string | undefined): string {
  const trimmed = background?.trim();
  return trimmed ? trimmed : DEFAULT_CANVAS_BACKGROUND;
}

/**
 * Normalize a document to its page list. A document without `pages` is a
 * single-page document whose page is its `nodes`; a document-level
 * `canvasBackground` becomes that first page's background.
 */
export function getDocumentPages(document: PersistedEditorDocument): PersistedPage[] {
  const canvasBackground = document.canvasBackground?.trim();
  if (document.pages && document.pages.length > 0) {
    const [first, ...rest] = document.pages;
    if (!canvasBackground || first!.background) return document.pages;
    return [{ ...first!, background: canvasBackground }, ...rest];
  }
  return [
    {
      id: DEFAULT_PAGE_ID,
      name: DEFAULT_PAGE_NAME,
      nodes: document.nodes,
      ...(canvasBackground ? { background: canvasBackground } : {}),
    },
  ];
}

export function designNodeToPersistedNode(node: DesignNode): PersistedDesignNode {
  return {
    id: node.id,
    type: node.type,
    ...cloneNodeFields(node),
    children: node.children.map(designNodeToPersistedNode),
  };
}

type HydratedNodeVisitor = (node: DesignNode, parentId?: string) => void;

function hydratePersistedNode(
  node: PersistedDesignNode,
  idMap?: Record<string, string>,
  visit?: HydratedNodeVisitor,
  parentId?: string,
): DesignNode {
  const sourceId = String(node.id);
  const id = idMap ? generateId() : sourceId;
  if (idMap) idMap[sourceId] = id;
  const designNode = createNode(String(node.type) as NodeType, {
    ...cloneNodeFields(node),
    id,
    children: node.children.map((child) => hydratePersistedNode(child, idMap, visit, id)),
  });
  visit?.(designNode, parentId);
  return designNode;
}

export function persistedNodeToDesignNode(
  node: PersistedDesignNode,
  visit?: HydratedNodeVisitor,
  parentId?: string,
): DesignNode {
  return hydratePersistedNode(node, undefined, visit, parentId);
}

/** Hydrate a clipboard subtree and assign its complete ID map in one traversal. */
export function clonePersistedNodeToDesignNode(
  node: PersistedDesignNode,
  idMap: Record<string, string>,
  visit?: HydratedNodeVisitor,
  parentId?: string,
): DesignNode {
  return hydratePersistedNode(node, idMap, visit, parentId);
}

export function createPersistedNode(
  type: NodeType,
  overrides: Partial<PersistedDesignNode> = {},
): PersistedDesignNode {
  const defaults = getNodeDefaults(type);

  const node: PersistedDesignNode = {
    id: overrides.id ?? generateId(),
    type,
    name: overrides.name ?? defaults.name ?? type,
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    width: overrides.width ?? defaults.width ?? 0,
    height: overrides.height ?? defaults.height ?? 0,
    rotation: overrides.rotation ?? defaults.rotation ?? 0,
    visible: overrides.visible !== false,
    locked: overrides.locked === true,
    backgroundColor: overrides.backgroundColor ?? defaults.backgroundColor ?? "transparent",
    borderRadius: overrides.borderRadius ?? defaults.borderRadius ?? 0,
    borderColor: overrides.borderColor ?? defaults.borderColor ?? "transparent",
    borderWidth: overrides.borderWidth ?? defaults.borderWidth ?? 0,
    content: overrides.content ?? defaults.content ?? "",
    imageAsset: overrides.imageAsset ?? defaults.imageAsset ?? null,
    imageGeneration: overrides.imageGeneration ?? defaults.imageGeneration ?? null,
    fontSize: overrides.fontSize ?? defaults.fontSize ?? 16,
    fontFamily: overrides.fontFamily ?? defaults.fontFamily ?? "",
    color: overrides.color ?? defaults.color ?? "#000000",
    fontWeight: overrides.fontWeight ?? defaults.fontWeight ?? "normal",
    textAutoSize: overrides.textAutoSize ?? defaults.textAutoSize ?? false,
    isArtboard: overrides.isArtboard ?? false,
    styles: overrides.styles ?? {},
    children: overrides.children?.map(clonePersistedNode) ?? [],
  };
  return { ...node, ...cloneNodeFields(node) };
}

function clonePersistedNode(node: PersistedDesignNode): PersistedDesignNode {
  return {
    id: String(node.id),
    type: String(node.type) as NodeType,
    ...cloneNodeFields(node),
    children: node.children.map(clonePersistedNode),
  };
}

function countPersistedNodes(nodes: PersistedDesignNode[]): number {
  return nodes.reduce((count, node) => count + 1 + countPersistedNodes(node.children), 0);
}

export function getPersistedDocumentNodeCount(document: PersistedEditorDocument): number {
  return countPersistedNodes(document.nodes);
}
