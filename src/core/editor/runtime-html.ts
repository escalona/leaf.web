import type { DesignNode } from "../types";
import { createModelContextElement } from "./import/html-measurement";
import {
  anchorReplacementsToTarget,
  parseHtmlToNodes,
  type HtmlParseOptions,
} from "./import/html-parser";
import { isFlowLayoutDisplay } from "./layout-display";
import type { RuntimeOperationContext } from "./runtime-operation-context";

/**
 * Resolve the containing-block element imported roots parse against. Prefer
 * the live rendered element; when the target is not in the viewport DOM (an
 * inactive page, or a culled offscreen subtree), fall back to a detached
 * stand-in built from the model so flow auto-sizing and percentage widths
 * still resolve instead of freezing at their measured-at-insert size.
 */
function nearestPositiveModelWidth(
  context: RuntimeOperationContext,
  node: DesignNode,
): number | undefined {
  let current: DesignNode | undefined = node;
  while (current) {
    if (typeof current.width === "number" && current.width > 0) return current.width;
    current = context.store.getParent(current.id);
  }
  return undefined;
}

function buildModelContext(context: RuntimeOperationContext, node: DesignNode): HTMLElement {
  return createModelContextElement(node, nearestPositiveModelWidth(context, node));
}

function resolveContextElement(
  context: RuntimeOperationContext,
  target: DesignNode,
  mode: "insert-children" | "replace",
): HTMLElement {
  const targetElement = context.store.domIndex.getElement(target);
  if (mode === "insert-children") {
    return targetElement ?? buildModelContext(context, target);
  }
  if (targetElement) return targetElement.parentElement ?? targetElement;
  const parent = context.store.getParent(target.id);
  if (parent) {
    return context.store.domIndex.getElement(parent) ?? buildModelContext(context, parent);
  }
  // Parentless root: mirror the live path's `?? targetElement` last resort so
  // an inactive-page root replace still parses against a real context.
  return buildModelContext(context, target);
}

export function writeHtml(
  context: RuntimeOperationContext,
  html: string,
  targetNodeId: string,
  mode: "insert-children" | "replace",
  options: Omit<HtmlParseOptions, "contextElement"> = {},
): DesignNode[] {
  const target = context.requireNode(targetNodeId);
  const contextElement = resolveContextElement(context, target, mode);
  const parsed = parseHtmlToNodes(html, { ...options, contextElement });
  const reusableIds = mode === "replace" ? collectNodeTreeIds([target]) : new Set<string>();
  const parsedIds = collectNodeTreeIds(parsed);
  for (const nodeId of parsedIds) {
    if (context.store.getNode(nodeId) && !reusableIds.has(nodeId)) {
      throw new Error(`Imported Leaf node id already exists: ${nodeId}`);
    }
  }
  if (mode === "replace" && parsed.length > 1) {
    const parent = context.store.getParent(targetNodeId);
    if (!parent || !isFlowLayoutDisplay(parent.styles.display)) {
      throw new Error(
        "Cannot replace a root or freeform child with multiple roots; wrap the replacement in one container to preserve spacing",
      );
    }
  }

  return context.applyMutation({ type: "write-html", mode, targetNodeId }, () => {
    if (mode === "insert-children") {
      for (const node of parsed) {
        target.children.push(node);
        context.store.registerNodeTree(node, target.id);
      }
    } else {
      const parentId = context.store.parentMap.get(targetNodeId);
      const siblings = parentId
        ? context.store.getNode(parentId)?.children
        : context.store.getRootSiblingsForNode(targetNodeId);
      const index = siblings?.indexOf(target) ?? -1;
      if (!siblings || index === -1) {
        throw new Error(`Cannot replace detached Leaf node: ${targetNodeId}`);
      }

      anchorReplacementsToTarget(parsed, target);
      const preservedScriptSessionStateIds = new Set(
        [...parsedIds].filter((nodeId) => reusableIds.has(nodeId)),
      );
      context.store.unregisterNodeTree(target, {
        preserveScriptSessionStateIds: preservedScriptSessionStateIds,
      });
      siblings.splice(index, 1, ...parsed);
      for (const node of parsed) {
        context.store.registerNodeTree(node, parentId);
      }
    }

    context.markMaterializing(parsed);
    return parsed;
  });
}

function collectNodeTreeIds(nodes: readonly DesignNode[]): Set<string> {
  const ids = new Set<string>();
  const pending = [...nodes];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (ids.has(node.id)) {
      throw new Error(`Duplicate Leaf node id in imported HTML: ${node.id}`);
    }
    ids.add(node.id);
    pending.push(...node.children);
  }
  return ids;
}
