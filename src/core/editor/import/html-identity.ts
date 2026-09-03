import type { DesignNode } from "../../types";
import type { HtmlParseContext } from "./html-parse-context";

const AUTHORED_NODE_ID_ATTRIBUTE = "data-leaf-node-id";
const AUTHORED_NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function getAuthoredNodeId(element: Element): string | undefined {
  if (!element.hasAttribute(AUTHORED_NODE_ID_ATTRIBUTE)) return undefined;
  const nodeId = element.getAttribute(AUTHORED_NODE_ID_ATTRIBUTE) ?? "";
  if (!AUTHORED_NODE_ID_PATTERN.test(nodeId)) {
    throw new Error(
      `${AUTHORED_NODE_ID_ATTRIBUTE} must match [A-Za-z0-9][A-Za-z0-9._:-]{0,127}: ${JSON.stringify(nodeId)}`,
    );
  }
  return nodeId;
}

export function collectAuthoredNodeIds(
  roots: readonly HTMLElement[],
  context: HtmlParseContext,
): Set<string> {
  const authoredNodeIds = new Set<string>();
  const pending: Element[] = [...roots];

  while (pending.length > 0) {
    const element = pending.pop()!;
    const authoredId = getAuthoredNodeId(element);
    if (authoredId) {
      if (authoredNodeIds.has(authoredId)) {
        throw new Error(`Duplicate Leaf node id in imported HTML: ${authoredId}`);
      }

      const tagName = element.tagName.toLowerCase();
      if (
        tagName === "script" ||
        tagName === "style" ||
        tagName === "br" ||
        tagName === "template"
      ) {
        throw new Error(
          `Cannot preserve ${AUTHORED_NODE_ID_ATTRIBUTE} ${JSON.stringify(authoredId)} on <${tagName}>; move it to a renderable containing element.`,
        );
      }

      const owningSvg = element.parentElement?.closest("svg");
      if (owningSvg) {
        throw new Error(
          `Cannot preserve ${AUTHORED_NODE_ID_ATTRIBUTE} ${JSON.stringify(authoredId)} on <${tagName}> inside <svg>; assign it to the owning <svg> element instead.`,
        );
      }

      authoredNodeIds.add(authoredId);
      for (
        let ancestor = element.parentElement;
        ancestor && !context.identityBearingAncestors.has(ancestor);
        ancestor = ancestor.parentElement
      ) {
        context.identityBearingAncestors.add(ancestor);
      }
    }

    pending.push(...Array.from(element.children));
    if (element instanceof HTMLTemplateElement) {
      pending.push(...Array.from(element.content.children));
    }
  }

  return authoredNodeIds;
}

export function assertUniqueParsedNodeIds(nodes: readonly DesignNode[]): Set<string> {
  const seen = new Set<string>();
  const pending = [...nodes];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (seen.has(node.id)) {
      throw new Error(`Duplicate Leaf node id in imported HTML: ${node.id}`);
    }
    seen.add(node.id);
    pending.push(...node.children);
  }
  return seen;
}

export function assertAuthoredNodeIdsPreserved(
  authoredNodeIds: ReadonlySet<string>,
  parsedNodeIds: ReadonlySet<string>,
): void {
  for (const authoredId of authoredNodeIds) {
    if (!parsedNodeIds.has(authoredId)) {
      throw new Error(
        `Could not preserve ${AUTHORED_NODE_ID_ATTRIBUTE} ${JSON.stringify(authoredId)} as a Leaf node; move it to a renderable element that can be imported independently.`,
      );
    }
  }
}
