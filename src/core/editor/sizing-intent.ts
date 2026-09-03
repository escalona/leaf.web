import { isFlexLayoutDisplay } from "./layout-display";
import type { StylePatch } from "./style-mutation";
import type { DesignNode } from "../types";

export type SizingAxis = "width" | "height";

/**
 * How a dimension is authored, independent of what it currently measures.
 *
 * Sizing is an intent rather than a number:
 * the same 240px-wide node means something different when it is pinned at 240
 * than when it happens to fit its content. Everything here derives that intent
 * from the CSS the node actually carries, so an agent-authored `width: auto`
 * reads back as Fit instead of looking like an unset field.
 */
export type SizingIntent = "fixed" | "fit" | "fill" | "relative";

export interface SizingContext {
  node: DesignNode;
  axis: SizingAxis;
  /** The parent's resolved `display`, or undefined when the node is a canvas root. */
  parentDisplay?: string | number;
  /** The parent's resolved `flex-direction`. */
  parentFlexDirection?: string | number;
  hasParent: boolean;
}

export interface SizingIntentOptions {
  /** Pixel size to pin when switching to Fixed. Defaults to the model size. */
  fixedPx?: number;
  /** Authored value to write when switching to Relative. */
  relativeValue?: string;
}

const FIT_KEYWORDS = new Set(["auto", "fit-content", "min-content", "max-content"]);
const FILL_KEYWORDS = new Set(["100%", "stretch", "-webkit-fill-available"]);
const FIXED_LENGTH_PATTERN = /^-?(?:\d+|\d*\.\d+)(?:px)?$/;

const MAIN_AXIS_FILL = "1 1 0%";
const DEFAULT_RELATIVE_VALUE = "50%";

function normalize(value: string | number | undefined): string {
  return typeof value === "number" ? String(value) : (value ?? "").trim().toLowerCase();
}

function isFixedValue(value: string | number): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  return FIXED_LENGTH_PATTERN.test(value.trim());
}

function isFitValue(text: string): boolean {
  return FIT_KEYWORDS.has(text) || text.startsWith("fit-content(");
}

/** `flex: 2 0 auto`, `flex: auto`, `flexGrow: 1` — anything that grows to fill. */
function hasPositiveFlexGrow(styles: Record<string, string | number>): boolean {
  const grow = styles.flexGrow;
  if (grow !== undefined) return Number.parseFloat(String(grow)) > 0;

  const shorthand = normalize(styles.flex);
  if (!shorthand) return false;
  if (shorthand === "auto") return true;
  if (shorthand === "none" || shorthand === "initial") return false;
  return Number.parseFloat(shorthand) > 0;
}

function isFlexItem(context: SizingContext): boolean {
  return (
    context.hasParent &&
    isFlexLayoutDisplay(normalize(context.parentDisplay)) &&
    normalize(context.node.styles.position) !== "absolute"
  );
}

/** The axis a flex container distributes its children along. */
export function flexMainAxis(flexDirection: string | number | undefined): SizingAxis {
  return normalize(flexDirection).startsWith("column") ? "height" : "width";
}

function isMainAxis(context: SizingContext): boolean {
  return context.axis === flexMainAxis(context.parentFlexDirection);
}

/** The authored CSS for the axis, or the model pixel size when nothing is authored. */
export function authoredSize(context: SizingContext): string | number {
  return context.node.styles[context.axis] ?? context.node[context.axis];
}

export function classifySizing(context: SizingContext): SizingIntent {
  const { node, axis } = context;

  // Fill is read off the flex properties first: a node filling its parent's main
  // axis still carries `width: auto`, and reading the value first would call
  // that Fit.
  if (isFlexItem(context)) {
    if (isMainAxis(context) && hasPositiveFlexGrow(node.styles)) return "fill";
    if (!isMainAxis(context) && normalize(node.styles.alignSelf) === "stretch") return "fill";
  }

  const value = node.styles[axis];
  if (value === undefined || isFixedValue(value)) return "fixed";

  const text = normalize(value);
  if (isFitValue(text)) return "fit";
  if (FILL_KEYWORDS.has(text)) return "fill";
  return "relative";
}

/**
 * The intents worth offering for a node.
 *
 * Fill and Relative both resolve against a containing block, so they are
 * meaningless for a canvas root and are left out rather than offered and
 * silently ignored.
 */
export function allowedSizingIntents(context: SizingContext): SizingIntent[] {
  return context.hasParent ? ["fixed", "fit", "fill", "relative"] : ["fixed", "fit"];
}

/** Keys that would keep forcing Fill after the user picked something else. */
function fillResidueRemovals(context: SizingContext): StylePatch {
  if (!isFlexItem(context)) return {};
  const { styles } = context.node;
  const patch: StylePatch = {};

  if (isMainAxis(context)) {
    if (styles.flex !== undefined) patch.flex = null;
    if (styles.flexGrow !== undefined) patch.flexGrow = null;
    if (styles.flexBasis !== undefined) patch.flexBasis = null;
  } else if (normalize(styles.alignSelf) === "stretch") {
    // Only stretch is a fill signal; a deliberate `align-self: center` stays.
    patch.alignSelf = null;
  }

  return patch;
}

/**
 * The style patch that moves a dimension to an intent.
 *
 * Every non-Fixed intent writes something into the styles map rather than just
 * removing keys, because the renderer always emits the model pixel size first
 * (`buildBaseStyle`) — a removal alone would leave the node pinned.
 */
export function sizingIntentPatch(
  context: SizingContext,
  intent: SizingIntent,
  options: SizingIntentOptions = {},
): StylePatch {
  const { axis, node } = context;

  switch (intent) {
    case "fixed": {
      const px = options.fixedPx ?? node[axis];
      return { ...fillResidueRemovals(context), [axis]: Math.round(px) };
    }
    case "fit":
      return { ...fillResidueRemovals(context), [axis]: "fit-content" };
    case "relative":
      return {
        ...fillResidueRemovals(context),
        [axis]: options.relativeValue ?? DEFAULT_RELATIVE_VALUE,
      };
    case "fill": {
      if (isFlexItem(context)) {
        return isMainAxis(context)
          ? {
              flex: MAIN_AXIS_FILL,
              flexGrow: null,
              flexShrink: null,
              flexBasis: null,
              [axis]: "auto",
            }
          : { alignSelf: "stretch", [axis]: "auto" };
      }
      return { ...fillResidueRemovals(context), [axis]: "100%" };
    }
  }
}

export const SIZING_INTENT_LABELS: Record<SizingIntent, string> = {
  fixed: "Fixed",
  fit: "Fit",
  fill: "Fill",
  relative: "Relative",
};
