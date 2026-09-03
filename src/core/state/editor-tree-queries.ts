import { isFlexLayoutDisplay, isFlowLayoutDisplay } from "../editor/layout-display";
import { getEffectiveModelDimension } from "../editor/model-geometry";
import type { DesignNode, EditorPage, Point } from "../types";
import type { DomIndex } from "./DomIndex";

export interface EditorTreeQueryContext {
  activePageId: string;
  pages: readonly EditorPage[];
  nodeMap: ReadonlyMap<string, DesignNode>;
  parentMap: ReadonlyMap<string, string>;
  dragDetachedIds: ReadonlySet<string>;
  domIndex: DomIndex;
  panX: number;
  panY: number;
  zoom: number;
}

export function getPageIdForNode(context: EditorTreeQueryContext, nodeId: string): string | null {
  let current: string | undefined = nodeId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const parent = context.parentMap.get(current);
    if (!parent) break;
    current = parent;
  }
  if (!current) return null;
  const rootId = current;
  const active =
    context.pages.find((page) => page.id === context.activePageId) ?? context.pages[0]!;
  if (active.nodes.some((node) => node.id === rootId)) return active.id;
  for (const page of context.pages) {
    if (page.id === active.id) continue;
    if (page.nodes.some((node) => node.id === rootId)) return page.id;
  }
  return null;
}

export function getRootSiblingsForNode(
  context: EditorTreeQueryContext,
  nodeId: string,
): DesignNode[] {
  const pageId = getPageIdForNode(context, nodeId);
  const active =
    context.pages.find((page) => page.id === context.activePageId) ?? context.pages[0]!;
  if (pageId === null) return active.nodes;
  return context.pages.find((page) => page.id === pageId)?.nodes ?? active.nodes;
}

export function getParent(context: EditorTreeQueryContext, nodeId: string): DesignNode | undefined {
  const parentId = context.parentMap.get(nodeId);
  return parentId ? context.nodeMap.get(parentId) : undefined;
}

export function isDescendant(context: EditorTreeQueryContext, nodeId: string, ancestorId: string) {
  let currentId: string | undefined = nodeId;
  while (currentId) {
    if (currentId === ancestorId) return true;
    currentId = context.parentMap.get(currentId);
  }
  return false;
}

export function isFlexChild(context: EditorTreeQueryContext, nodeId: string): boolean {
  const parent = getParent(context, nodeId);
  if (!parent || !isFlexLayoutDisplay(parent.styles.display || "block")) return false;
  return context.nodeMap.get(nodeId)?.styles.position !== "absolute";
}

export function isFlowChild(context: EditorTreeQueryContext, nodeId: string): boolean {
  const parent = getParent(context, nodeId);
  if (!parent || !isFlowLayoutDisplay(parent.styles.display || "block")) return false;
  return context.nodeMap.get(nodeId)?.styles.position !== "absolute";
}

export function getArtboard(
  context: EditorTreeQueryContext,
  nodeId: string,
): DesignNode | undefined {
  let currentId: string | undefined = nodeId;
  while (currentId) {
    const node = context.nodeMap.get(currentId);
    if (node?.isArtboard) return node;
    currentId = context.parentMap.get(currentId);
  }
  return undefined;
}

/**
 * A node's placement in canvas space: the top-left of its OWN, unrotated box
 * plus the total rotation the renderer turns that box by about its center.
 *
 * This is structurally an `OrientedBox` once the node's size is attached, which
 * is what every consumer — selection chrome, hit-testing, culling, comment pins
 * — actually needs. A full 2×3 matrix would carry no more information: every
 * node is a rectangle and every `rotate()` turns about a center, so a chain of
 * them composes to exactly one (angle sum, moved center).
 */
export type CanvasTransform = { x: number; y: number; rotation: number };

/**
 * The total rotation CSS applies to `node`: its own plus every ancestor's,
 * because each ancestor's `rotate()` turns the whole subtree beneath it.
 */
export function getWorldRotation(context: EditorTreeQueryContext, nodeId: string): number {
  const node = context.nodeMap.get(nodeId);
  if (!node) return 0;
  let rotation = node.rotation ?? 0;
  if (context.dragDetachedIds.has(nodeId)) return rotation;
  let currentId = context.parentMap.get(nodeId);
  while (currentId) {
    const parent = context.nodeMap.get(currentId);
    if (!parent) break;
    rotation += parent.rotation ?? 0;
    if (context.dragDetachedIds.has(currentId)) break;
    currentId = context.parentMap.get(currentId);
  }
  return rotation;
}

function getModelSize(node: DesignNode) {
  return {
    width: getEffectiveModelDimension(node.width, node.styles.width),
    height: getEffectiveModelDimension(node.height, node.styles.height),
  };
}

/**
 * Compose the placement chain the way the DOM does.
 *
 * Each ancestor contributes a translation into its parent's coordinate system
 * and, when it carries one, a rotation about its own center. Those compose to a
 * single rigid motion, so the walk only has to carry the node's CENTER: before
 * the first rotated ancestor the half-size terms telescope away and this is the
 * plain translation sum it has always been, which is why an unrotated document
 * pays nothing beyond one property read per ancestor.
 */
export function getCanvasTransform(
  context: EditorTreeQueryContext,
  nodeId: string,
): CanvasTransform | undefined {
  const node = context.nodeMap.get(nodeId);
  if (!node) return undefined;

  const ownRotation = node.rotation ?? 0;
  if (context.dragDetachedIds.has(nodeId)) {
    return { x: node.x, y: node.y, rotation: ownRotation };
  }

  let layoutNodeId: string | undefined = nodeId;
  let dependsOnFlowLayout = false;
  while (layoutNodeId) {
    if (isFlowChild(context, layoutNodeId)) {
      dependsOnFlowLayout = true;
      break;
    }
    layoutNodeId = context.parentMap.get(layoutNodeId);
  }

  if (dependsOnFlowLayout) {
    const element = context.domIndex.getElement(node);
    const viewportElement = element?.closest("[data-viewport]");
    if (element && viewportElement instanceof HTMLElement) {
      const nodeRect = element.getBoundingClientRect();
      const viewportRect = viewportElement.getBoundingClientRect();
      const rotation = getWorldRotation(context, nodeId);
      const x = (nodeRect.left - viewportRect.left - context.panX) / context.zoom;
      const y = (nodeRect.top - viewportRect.top - context.panY) / context.zoom;
      // The browser reports the axis-aligned box around the turn. Rotation
      // preserves a rect's center, so recovering the node's own box from the
      // measured center and its layout size is the same composition the model
      // branch performs — never a second application of the same rotations.
      if (!rotation) return { x, y, rotation };
      const layoutWidth = element instanceof HTMLElement ? element.offsetWidth : 0;
      const layoutHeight = element instanceof HTMLElement ? element.offsetHeight : 0;
      if (!layoutWidth || !layoutHeight) return { x, y, rotation };
      return {
        x: x + nodeRect.width / context.zoom / 2 - layoutWidth / 2,
        y: y + nodeRect.height / context.zoom / 2 - layoutHeight / 2,
        rotation,
      };
    }
  }

  let x = node.x;
  let y = node.y;
  let rotation = ownRotation;
  // Half the node's own box, added the first time a rotated ancestor turns up
  // so the walk can switch from tracking the top-left to tracking the center.
  let halfWidth = 0;
  let halfHeight = 0;
  let tracksCenter = false;
  let currentId = context.parentMap.get(nodeId);

  while (currentId) {
    const parent = context.nodeMap.get(currentId);
    if (!parent) break;
    const parentRotation = parent.rotation ?? 0;
    if (parentRotation) {
      if (!tracksCenter) {
        const size = getModelSize(node);
        halfWidth = size.width / 2;
        halfHeight = size.height / 2;
        x += halfWidth;
        y += halfHeight;
        tracksCenter = true;
      }
      const parentSize = getModelSize(parent);
      const centerX = parentSize.width / 2;
      const centerY = parentSize.height / 2;
      const radians = (parentRotation * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      const dx = x - centerX;
      const dy = y - centerY;
      x = centerX + dx * cos - dy * sin;
      y = centerY + dx * sin + dy * cos;
      rotation += parentRotation;
    }
    x += parent.x;
    y += parent.y;
    if (context.dragDetachedIds.has(currentId)) break;
    currentId = context.parentMap.get(currentId);
  }

  if (tracksCenter) {
    x -= halfWidth;
    y -= halfHeight;
  }

  return { x, y, rotation };
}

export function getCanvasPosition(
  context: EditorTreeQueryContext,
  nodeId: string,
): Point | undefined {
  const transform = getCanvasTransform(context, nodeId);
  return transform ? { x: transform.x, y: transform.y } : undefined;
}
