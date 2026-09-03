import type { DesignNode } from "../types";

export const PROGRESSIVE_INSERT_NODE_THRESHOLD = 250;
const PROGRESSIVE_DETAIL_GATE_SIZE = 60;

/**
 * Returns large frame boundaries from shallowest to deepest so a bulk create can
 * paint useful shells immediately and reveal expensive DOM subtrees over later
 * animation frames.
 */
export function collectProgressiveDetailGates(nodes: readonly DesignNode[]) {
  const gates: Array<{ depth: number; id: string }> = [];
  const visit = (node: DesignNode, depth: number): number => {
    let size = 1;
    for (const child of node.children) size += visit(child, depth + 1);
    if (node.type === "frame" && node.children.length > 0 && size >= PROGRESSIVE_DETAIL_GATE_SIZE) {
      gates.push({ depth, id: node.id });
    }
    return size;
  };
  for (const node of nodes) visit(node, 0);
  gates.sort((left, right) => left.depth - right.depth);
  return gates.map(({ id }) => id);
}
