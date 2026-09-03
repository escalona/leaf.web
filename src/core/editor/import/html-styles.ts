import { decomposeBackgroundShorthand } from "../style-mutation";

export const POSITION_OFFSET_KEYS = ["left", "top", "right", "bottom", "inset"] as const;

export interface HtmlStyleExtractionContext {
  flattenedPositionElements: WeakSet<Element>;
}

/**
 * Extract all inline styles from an element as a camelCase map.
 */
export function extractStyles(
  el: HTMLElement,
  context?: HtmlStyleExtractionContext,
): Record<string, string> {
  const result: Record<string, string> = {};
  const style = el.style;
  const flattened = context?.flattenedPositionElements.has(el) ?? false;
  for (let i = 0; i < style.length; i++) {
    const prop = style[i];
    if (flattened && POSITION_OFFSET_KEYS.includes(prop as (typeof POSITION_OFFSET_KEYS)[number])) {
      continue;
    }
    const value = style.getPropertyValue(prop);
    // CSSOM expands shorthands into longhands and may fill unspecified values
    // with `initial`; those declarations are not authored document intent.
    if (value && value !== "initial") {
      result[camelCase(prop)] = value;
    }
  }
  return result;
}

/**
 * Split extracted styles into typed DesignNode properties and the authored CSS map.
 */
export function splitStyles(styles: Record<string, string>): {
  typed: {
    backgroundColor?: string;
    borderRadius?: number;
    borderColor?: string;
    borderWidth?: number;
    color?: string;
    fontSize?: number;
    fontFamily?: string;
    fontWeight?: string;
  };
  cssMap: Record<string, string | number>;
} {
  const typed: Record<string, unknown> = {};
  const cssMap: Record<string, string | number> = {};

  for (const [key, value] of Object.entries(styles)) {
    if (key === "background") {
      const decomposed = decomposeBackgroundShorthand(value);
      if (decomposed !== null) {
        if (decomposed.backgroundImage !== undefined) {
          cssMap.backgroundImage = decomposed.backgroundImage;
        }
        if (decomposed.backgroundColor !== undefined && styles.backgroundColor === undefined) {
          cssMap.backgroundColor = decomposed.backgroundColor;
          typed.backgroundColor = decomposed.backgroundColor;
        }
        continue;
      }
    }

    cssMap[key] = value;

    switch (key) {
      case "backgroundColor":
        typed.backgroundColor = value;
        break;
      case "borderRadius":
        typed.borderRadius = parseFloat(value) || 0;
        break;
      case "borderColor":
        typed.borderColor = value;
        break;
      case "borderWidth":
        typed.borderWidth = parseFloat(value) || 0;
        break;
      case "color":
        typed.color = value;
        break;
      case "fontSize":
        typed.fontSize = parseFloat(value) || 16;
        break;
      case "fontFamily":
        typed.fontFamily = value;
        break;
      case "fontWeight":
        typed.fontWeight = value;
        break;
    }
  }

  return { typed: typed as ReturnType<typeof splitStyles>["typed"], cssMap };
}

export function camelCase(value: string): string {
  if (value.startsWith("--")) return value;
  return value.replace(/-([a-z])/g, (_, character: string) => character.toUpperCase());
}

export function truncateName(text: string): string {
  if (!text) return "";
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 30 ? `${clean.slice(0, 27)}...` : clean;
}
