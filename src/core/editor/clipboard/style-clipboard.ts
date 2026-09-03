/**
 * A style clipboard, separate from the node clipboard.
 *
 * Copying styles takes everything that paints a node — the `styles` map plus
 * the typed props behind it — and leaves geometry alone, so pasting appearance
 * onto another node never moves or resizes it.
 */
import { resolveNodeStyle } from "../style-resolution";
import { getNodeDefaults } from "../../nodes/specs";
import type { EditorStore } from "../../state/EditorStore";
import type { DesignNode } from "../../types";
import type { StylePatch } from "../style-mutation";

export interface CopiedStyles {
  version: 1;
  styles: Record<string, string | number>;
}

/** Typed props that shadow a CSS key, so a copy has to read through them. */
const TYPED_STYLE_KEYS = [
  "backgroundColor",
  "borderRadius",
  "borderColor",
  "borderWidth",
  "color",
  "fontSize",
  "fontFamily",
  "fontWeight",
] as const;

/**
 * Keys a style paste must not carry.
 *
 * Size and placement describe where a node is, not what it looks like; pasting
 * them would teleport and resize the target, which is never what the gesture
 * means. `margin` belongs here for the same reason — it moves the node within
 * its parent's flow.
 *
 * Layout keys are excluded on the same rationale one level down: `display`,
 * the flex/grid families, and `gap` decide where a node's *children* land and
 * how the node itself participates in its parent's layout. Carrying them means
 * pasting a plain rectangle's appearance onto an auto-layout frame silently
 * strips `display: flex` and collapses its children, and pasting a frame's
 * appearance onto a text node stamps `display: flex` onto text. Neither is
 * what "copy how this looks" means.
 *
 * `padding` deliberately stays transferable: it is part of a node's own box
 * and does not move the node or change how it participates in a layout.
 */
const NON_TRANSFERABLE_STYLE_KEYS = new Set([
  // Placement.
  "position",
  "left",
  "top",
  "right",
  "bottom",
  "inset",
  "insetBlock",
  "insetBlockStart",
  "insetBlockEnd",
  "insetInline",
  "insetInlineStart",
  "insetInlineEnd",
  "margin",
  "marginTop",
  "marginRight",
  "marginBottom",
  "marginLeft",
  "marginBlock",
  "marginBlockStart",
  "marginBlockEnd",
  "marginInline",
  "marginInlineStart",
  "marginInlineEnd",
  "float",
  "clear",
  // Size.
  "width",
  "height",
  "minWidth",
  "minHeight",
  "maxWidth",
  "maxHeight",
  "transform",
  "translate",
  "rotate",
  "scale",
  "zIndex",
  // Layout: how children are arranged, and how this node participates.
  "display",
  "flex",
  "flexDirection",
  "flexFlow",
  "flexWrap",
  "flexGrow",
  "flexShrink",
  "flexBasis",
  "justifyContent",
  "justifyItems",
  "justifySelf",
  "alignContent",
  "alignItems",
  "alignSelf",
  "placeContent",
  "placeItems",
  "placeSelf",
  "gap",
  "rowGap",
  "columnGap",
  "order",
  "gridTemplate",
  "gridTemplateColumns",
  "gridTemplateRows",
  "gridTemplateAreas",
  "gridAutoFlow",
  "gridAutoColumns",
  "gridAutoRows",
  "gridArea",
  "gridColumn",
  "gridRow",
]);

export function isTransferableStyleKey(key: string): boolean {
  return !NON_TRANSFERABLE_STYLE_KEYS.has(key);
}

/**
 * Every style key that makes a node look different from a fresh node of its
 * type.
 *
 * A typed prop still sitting at its type default is not an authored choice, so
 * carrying it would stamp a text node's font size onto a rectangle. Removal
 * resets a typed prop to that same default, so leaving it out of the patch and
 * nulling it are equivalent anyway.
 */
function collectRenderedStyleKeys(node: DesignNode): string[] {
  const defaults = getNodeDefaults(node.type);
  const keys = new Set<string>(Object.keys(node.styles));
  for (const key of TYPED_STYLE_KEYS) {
    if (!keys.has(key) && node[key] !== defaults[key]) keys.add(key);
  }
  return [...keys].filter(
    (key) => isTransferableStyleKey(key) && resolveNodeStyle(node, key) !== undefined,
  );
}

export function captureNodeStyles(node: DesignNode): CopiedStyles {
  const styles: Record<string, string | number> = {};
  for (const key of collectRenderedStyleKeys(node)) {
    const value = resolveNodeStyle(node, key);
    if (value !== undefined) styles[key] = value;
  }
  return { version: 1, styles };
}

/**
 * The patch that makes `target` look like the copied node.
 *
 * Keys the target renders but the source does not are removed rather than
 * left behind, so pasting a plain style onto a decorated node actually strips
 * the decoration instead of half-merging the two.
 */
export function buildStylePastePatch(copied: CopiedStyles, target: DesignNode): StylePatch {
  const patch: StylePatch = {};
  for (const [key, value] of Object.entries(copied.styles)) {
    if (isTransferableStyleKey(key)) patch[key] = value;
  }
  for (const key of collectRenderedStyleKeys(target)) {
    if (!Object.hasOwn(patch, key)) patch[key] = null;
  }
  return patch;
}

let copiedStyles: CopiedStyles | null = null;

export function getCopiedStyles(): CopiedStyles | null {
  return copiedStyles;
}

export function setCopiedStyles(styles: CopiedStyles | null): void {
  copiedStyles = styles;
}

/** Snapshot the primary selected node's appearance. Returns false when empty. */
export function copySelectionStyles(store: EditorStore): boolean {
  const source = store.selectedNodes[0];
  if (!source) return false;
  copiedStyles = captureNodeStyles(source);
  return true;
}

/** Apply the snapshot to every selected node in one history entry. */
export function pasteSelectionStyles(store: EditorStore): boolean {
  const copied = copiedStyles;
  const targets = store.selectedNodes;
  if (!copied || targets.length === 0) return false;

  store.runtime.updateStyles(
    targets.map((node) => ({
      nodeIds: [node.id],
      styles: buildStylePastePatch(copied, node),
    })),
  );
  return true;
}
