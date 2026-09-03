import { resolveNodeStyle } from "../../core/editor/style-resolution";
import type { DesignNode } from "../../core/types";

// Re-exported so inspector sections have one import for selection reads.
export { resolveNodeStyle };

/**
 * Sentinel for a property whose value differs across the selection, shown as
 * "Click to replace mixed …" so a control can
 * render an indeterminate state instead of silently showing the first node's
 * value and overwriting the rest on the next keystroke.
 */
export const MIXED = Symbol("mixed");
export type MaybeMixed<T> = T | typeof MIXED;

export function isMixed<T>(value: MaybeMixed<T>): value is typeof MIXED {
  return value === MIXED;
}

/** Collapse a per-node read into a single value or MIXED. */
export function aggregate<T>(nodes: readonly DesignNode[], read: (node: DesignNode) => T) {
  if (nodes.length === 0) return undefined as MaybeMixed<T | undefined>;
  const first = read(nodes[0]!);
  for (let index = 1; index < nodes.length; index += 1) {
    if (!Object.is(read(nodes[index]!), first)) return MIXED;
  }
  return first;
}

export function readSelectionStyle(
  nodes: readonly DesignNode[],
  key: string,
): MaybeMixed<string | number | undefined> {
  return aggregate(nodes, (node) => resolveNodeStyle(node, key));
}

export function readSelectionField<K extends keyof DesignNode>(
  nodes: readonly DesignNode[],
  key: K,
): MaybeMixed<DesignNode[K] | undefined> {
  return aggregate(nodes, (node) => node[key]);
}

/** CSS keys the inspector renders with a dedicated control. */
const PANELLED_STYLE_KEYS = new Set([
  "display",
  "flexDirection",
  "flexWrap",
  "alignItems",
  "justifyContent",
  "gap",
  "rowGap",
  "columnGap",
  "padding",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "width",
  "height",
  "position",
  "opacity",
  "mixBlendMode",
  "backgroundColor",
  "background",
  "backgroundImage",
  "borderRadius",
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomLeftRadius",
  "borderBottomRightRadius",
  "border",
  "borderWidth",
  "borderColor",
  "borderStyle",
  "outline",
  "outlineWidth",
  "outlineColor",
  "outlineStyle",
  "outlineOffset",
  "boxShadow",
  "filter",
  "backdropFilter",
  "color",
  "fontSize",
  "fontFamily",
  "fontWeight",
  "fontStyle",
  "lineHeight",
  "letterSpacing",
  "textAlign",
  "textTransform",
  "textDecoration",
  "textDecorationLine",
  "textDecorationColor",
  "textDecorationStyle",
  "textDecorationThickness",
  // Both spellings: the HTML importer camel-cases the leading dash of
  // `-webkit-text-stroke-width` into `WebkitTextStrokeWidth` (which is also
  // React's vendor-prefix convention), while CSSOM-style writes produce the
  // lowercase form. Listing one would leak the other into Other styles.
  "WebkitTextStrokeWidth",
  "WebkitTextStrokeColor",
  "webkitTextStrokeWidth",
  "webkitTextStrokeColor",
  "overflow",
  "objectFit",
  "objectPosition",
]);

export function isPanelledStyleKey(key: string) {
  return PANELLED_STYLE_KEYS.has(key);
}

/**
 * Every style key on the selection that has no dedicated control, so the
 * Other-styles section can surface (and delete) what an agent wrote.
 */
export function collectUnpanelledStyleKeys(nodes: readonly DesignNode[]): string[] {
  const keys = new Set<string>();
  for (const node of nodes) {
    for (const key of Object.keys(node.styles)) {
      if (!isPanelledStyleKey(key)) keys.add(key);
    }
  }
  return [...keys].sort();
}
