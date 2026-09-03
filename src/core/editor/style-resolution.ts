import type { DesignNode } from "../types";

/**
 * The style precedence the renderer uses, as a standalone rule.
 *
 * This lives in the editor layer rather than beside the inspector because the
 * clipboard, serialization, and any future export path all need the same
 * answer to "what does this node actually render for this property", and
 * `src/editor` must not depend on `src/components`.
 */

/** Typed props that shadow a CSS key of the same name. */
const TYPED_STYLE_FALLBACKS = {
  backgroundColor: "backgroundColor",
  borderRadius: "borderRadius",
  borderColor: "borderColor",
  borderWidth: "borderWidth",
  color: "color",
  fontSize: "fontSize",
  fontFamily: "fontFamily",
  fontWeight: "fontWeight",
} as const satisfies Record<string, keyof DesignNode>;

/**
 * The value a node actually renders for a CSS key.
 *
 * The styles map wins over the typed prop, matching
 * `components/node-renderer/node-renderer-style.ts`. Reading through this
 * rather than off `node.styles` directly is what lets a control show the real
 * current value for a node an agent authored via HTML.
 */
export function resolveNodeStyle(node: DesignNode, key: string): string | number | undefined {
  const authored = node.styles[key];
  if (authored !== undefined) return authored;

  const typedKey = TYPED_STYLE_FALLBACKS[key as keyof typeof TYPED_STYLE_FALLBACKS];
  if (typedKey === undefined) return undefined;

  const typed = node[typedKey];
  if (typed === undefined || typed === null) return undefined;
  // `transparent` and a zero border read as "unset" so a control shows its
  // placeholder rather than a value the user never chose.
  if (typed === "transparent") return undefined;
  if ((key === "borderWidth" || key === "borderRadius") && typed === 0) return undefined;
  return typed as string | number;
}
