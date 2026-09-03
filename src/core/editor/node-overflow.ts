import type { DesignNode } from "../types";

/**
 * Resolve the per-axis overflow values a node's styles produce in the rendered
 * DOM.
 *
 * The renderer spreads `node.styles` into the element in insertion order, and
 * in CSSOM a later `overflow` shorthand resets earlier longhands (a semantic
 * style-mutation relies on for its delete-then-set ordering). Resolution must
 * therefore walk the styles map in order instead of giving longhands
 * unconditional precedence. Artboards mirror FrameRenderer, which forces
 * `overflow: hidden` after the spread whenever no shorthand is authored,
 * resetting any longhands regardless of what they said.
 */
export function resolveOverflowAxes(node: DesignNode): {
  x: string | undefined;
  y: string | undefined;
} {
  if (node.isArtboard && !node.styles.overflow) return { x: "hidden", y: "hidden" };
  let x: string | undefined;
  let y: string | undefined;
  for (const [key, raw] of Object.entries(node.styles)) {
    if (key !== "overflow" && key !== "overflowX" && key !== "overflowY") continue;
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (value === "") continue;
    if (key === "overflow") {
      const [shorthandX, shorthandY = shorthandX] = value.split(/\s+/, 2);
      x = shorthandX;
      y = shorthandY;
    } else if (key === "overflowX") {
      x = value;
    } else {
      y = value;
    }
  }
  return { x, y };
}

function isClippingOverflow(value: string | undefined): boolean {
  return value === "hidden" || value === "clip" || value === "auto" || value === "scroll";
}

/**
 * Whether the node's own effective CSS clips descendant paint on both axes.
 *
 * `content-visibility: auto` implies paint containment, which clips children
 * at the node's box even when its overflow is visible. Only nodes for which
 * this returns true may take the layout-skipping optimization, where
 * containment is visually inert; the same predicate keeps descendant culling
 * and containment agreeing on what the canvas paints.
 */
export function nodeClipsChildrenPaint(node: DesignNode): boolean {
  const { x, y } = resolveOverflowAxes(node);
  return isClippingOverflow(x) && isClippingOverflow(y);
}
