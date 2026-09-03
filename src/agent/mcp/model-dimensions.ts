import type { EditorStore } from "../../core/state/EditorStore";
import type { DesignNode } from "../../core/types";

// ─── Camera-independent measurement ──────────────────────────────

export type DimensionKey = "width" | "height";

const DIMENSION_CONSTRAINT_KEYS: Record<DimensionKey, readonly string[]> = {
  width: ["minWidth", "maxWidth"],
  height: ["minHeight", "maxHeight"],
};

/** `display` values that stop the renderer's inline width/height from sizing the box. */
const BOX_SUPPRESSING_DISPLAY_VALUES = new Set(["none", "contents", "inline"]);

/**
 * A stored number the renderer can actually hand to CSS. Negative and
 * non-finite lengths are invalid declarations: the browser drops them and sizes
 * the box from content instead, so they have to be measured rather than echoed.
 */
export function toRenderablePixels(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function parsePixelDimension(value: string): number | null {
  const match = /^\s*(-?\d+(?:\.\d+)?)px\s*$/.exec(value);
  return match ? toRenderablePixels(Number(match[1])) : null;
}

/** The stored dimension as a number, or null when it only resolves during layout. */
export function getModelDimension(node: DesignNode, key: DimensionKey): number | null {
  const styleValue = node.styles[key];
  if (styleValue === undefined) return toRenderablePixels(node[key]);
  if (typeof styleValue === "number") return toRenderablePixels(styleValue);
  return parsePixelDimension(styleValue);
}

/** The authored non-pixel dimension (`auto`, `100%`, `fit-content`), if any. */
export function getAuthoredDimension(node: DesignNode, key: DimensionKey): string | null {
  const styleValue = node.styles[key];
  if (typeof styleValue !== "string") return null;
  return parsePixelDimension(styleValue) === null ? styleValue : null;
}

/**
 * True when the renderer writes this node's stored dimension straight into its
 * inline style, so the model number is exactly what the DOM would report.
 *
 * `buildBaseStyle` sets `box-sizing: border-box` plus `width`/`height` from the
 * model, so an absolutely placed node with a definite dimension needs no DOM
 * read at all — which keeps a document-wide report from dragging every subtree
 * into layout. Flow children are resized by flex/grid, string dimensions only
 * resolve during layout, and authored min/max, `box-sizing`, `zoom`, or
 * box-suppressing `display` decouple the rendered box from the stored number.
 */
export function isModelSizedDimension(
  store: EditorStore,
  node: DesignNode,
  key: DimensionKey,
): boolean {
  if (getModelDimension(node, key) === null) return false;
  if (store.isFlowChild(node.id)) return false;

  const { styles } = node;
  if (styles.boxSizing !== undefined && styles.boxSizing !== "border-box") return false;
  if (styles.zoom !== undefined) return false;
  if (typeof styles.display === "string" && BOX_SUPPRESSING_DISPLAY_VALUES.has(styles.display)) {
    return false;
  }
  return DIMENSION_CONSTRAINT_KEYS[key].every((constraint) => styles[constraint] === undefined);
}

/**
 * Authored style keys that move a root's rendered box away from its stored
 * rect without changing its dimensions. The renderer places roots with
 * `left:0; top:0` plus a position translate, so an authored inset offset or
 * margin shifts the rendered box, and a nondefault `transform-origin` changes
 * the AABB of a model-rotated root.
 */
const PLACEMENT_STYLE_KEYS = new Set(["left", "top", "right", "bottom", "transformOrigin"]);

function hasPlacementAffectingStyles(styles: DesignNode["styles"]): boolean {
  for (const key of Object.keys(styles)) {
    if (PLACEMENT_STYLE_KEYS.has(key)) return true;
    if (key.startsWith("inset") || key.startsWith("margin")) return true;
  }
  return false;
}

/**
 * True when a root's rendered canvas AABB is derivable from model fields
 * alone: both dimensions are model-sized, no authored CSS transform or
 * placement-affecting style decouples the rendered box from the stored rect,
 * and no in-flight drag offset moves the rendered element. Model `rotation`
 * stays derivable — stored-AABB math is rotation-aware.
 */
export function rootHasModelDerivableCanvasAabb(store: EditorStore, node: DesignNode): boolean {
  const { styles } = node;
  if (styles.transform !== undefined || styles.scale !== undefined) return false;
  if (styles.translate !== undefined || styles.rotate !== undefined) return false;
  if (hasPlacementAffectingStyles(styles)) return false;
  // A remote peer's drag preview or a local drag offset renders as an extra
  // translate the stored rect knows nothing about.
  if (store.remoteDragPreviews.has(node.id) || store.dragCanvasOffset.has(node.id)) return false;
  // Stored-AABB math uses the typed rect, while the renderer lets an authored
  // pixel style win. HTML import can leave the two disagreeing (a measured
  // typed rect beside the authored CSS width), and then only a live
  // measurement reports the rendered box.
  for (const key of ["width", "height"] as const) {
    if (!isModelSizedDimension(store, node, key)) return false;
    if (getModelDimension(node, key) !== toRenderablePixels(node[key])) return false;
  }
  return true;
}
