import type { DesignNode } from "../types";

const FIXED_LENGTH_PATTERN = /^-?(?:\d+|\d*\.\d+)(?:px)?$/;
const MODEL_GEOMETRY_UNSAFE_STYLES = [
  "transform",
  "translate",
  "rotate",
  "scale",
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
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "aspectRatio",
  "zoom",
] as const;

export function isFixedModelLength(value: unknown): value is number | string | undefined {
  return (
    value === undefined ||
    typeof value === "number" ||
    (typeof value === "string" && FIXED_LENGTH_PATTERN.test(value.trim()))
  );
}

export function getEffectiveModelDimension(modelValue: number, styleValue: unknown) {
  if (!isFixedModelLength(styleValue) || styleValue === undefined) return modelValue;
  const parsed = typeof styleValue === "number" ? styleValue : Number.parseFloat(styleValue);
  return Number.isFinite(parsed) ? parsed : modelValue;
}

export function hasUnsafeModelGeometry(node: DesignNode) {
  const { styles } = node;
  return (
    MODEL_GEOMETRY_UNSAFE_STYLES.some((key) => styles[key] !== undefined) ||
    (styles.boxSizing !== undefined && styles.boxSizing !== "border-box") ||
    !isFixedModelLength(styles.width) ||
    !isFixedModelLength(styles.height)
  );
}

/**
 * Whether any node in the placement chain depends on CSS flow, positioning,
 * or live sizing — geometry the model cannot predict, so positions for the
 * chain come from DOM measurement instead of model accumulation.
 */
export function nodeChainUsesLiveGeometry(
  node: DesignNode,
  tree: {
    isFlowChild(id: string): boolean;
    getParent(id: string): DesignNode | undefined;
  },
): boolean {
  let current: DesignNode | undefined = node;
  while (current) {
    if (tree.isFlowChild(current.id) || hasUnsafeModelGeometry(current)) return true;
    current = tree.getParent(current.id);
  }
  return false;
}
