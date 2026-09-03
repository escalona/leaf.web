import type { DesignNode } from "../../../core/types";
import type { SelectionProperties } from "../useSelectionProperties";

/**
 * Every inspector section takes the same props: the selection as one unit.
 *
 * Sections are self-gating — each decides from `props.nodes` whether it applies
 * and returns null if not — which is how the panel stays extensible without the
 * composer growing a condition per section.
 */
export interface SectionProps {
  props: SelectionProperties;
}

/** True when every selected node can carry a background/border/radius. */
export function isBoxLike(nodes: readonly DesignNode[]): boolean {
  return nodes.every(
    (node) =>
      node.type === "frame" ||
      node.type === "rectangle" ||
      node.type === "text" ||
      node.type === "image" ||
      node.type === "interactive-surface",
  );
}

export function everyType(nodes: readonly DesignNode[], type: DesignNode["type"]): boolean {
  return nodes.length > 0 && nodes.every((node) => node.type === type);
}
