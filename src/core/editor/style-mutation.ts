import { getNodeDefaults } from "../nodes/specs";
import type { DesignNode } from "../types";

type DimensionKey = "width" | "height";

/**
 * A style patch value. `null` is the removal sentinel: it deletes the key from
 * the styles map and resets any typed prop backing it to the node's default.
 * Without it there is no way to take a style back off a node, which is what
 * blocks per-entry visibility, unchecking clip content, and escaping an
 * imported `width: auto`.
 */
export type StyleValue = string | number | null;

export type StylePatch = Record<string, StyleValue>;

type StyleMutableNode = Pick<
  DesignNode,
  | "type"
  | "backgroundColor"
  | "borderRadius"
  | "borderColor"
  | "borderWidth"
  | "color"
  | "fontSize"
  | "fontFamily"
  | "fontWeight"
  | "width"
  | "height"
  | "x"
  | "y"
  | "styles"
>;

function hasStyleKey(node: StyleMutableNode, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(node.styles, key);
}

function setStyleKey(node: StyleMutableNode, key: string, value: string | number) {
  delete node.styles[key];
  node.styles[key] = value;
}

function getRenderedBorderStyleValue(
  node: StyleMutableNode,
  key: "borderColor" | "borderWidth",
): string | number | undefined {
  const override = node.styles[key];
  if (override !== undefined) return override;
  if (node.borderWidth <= 0 || node.styles.border !== undefined) return undefined;
  return key === "borderColor" ? node.borderColor : node.borderWidth;
}

function makeEquivalentCssValueDistinct(
  value: string | number,
  previous: string | number | undefined,
): string | number {
  if (value !== previous) return value;
  return typeof value === "number" ? `${value}px` : `${value} `;
}

const BORDER_WIDTH_CONFLICT_KEYS = [
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderBlockWidth",
  "borderInlineWidth",
  "borderBlockStartWidth",
  "borderBlockEndWidth",
  "borderInlineStartWidth",
  "borderInlineEndWidth",
] as const;

const BORDER_COLOR_CONFLICT_KEYS = [
  "borderTopColor",
  "borderRightColor",
  "borderBottomColor",
  "borderLeftColor",
  "borderBlockColor",
  "borderInlineColor",
  "borderBlockStartColor",
  "borderBlockEndColor",
  "borderInlineStartColor",
  "borderInlineEndColor",
] as const;

const BORDER_SIDE_SHORTHAND_KEYS = new Set([
  "border",
  "borderTop",
  "borderRight",
  "borderBottom",
  "borderLeft",
  "borderBlock",
  "borderInline",
  "borderBlockStart",
  "borderBlockEnd",
  "borderInlineStart",
  "borderInlineEnd",
]);

function hasAuthoredBorderPaintStyle(styles: Record<string, string | number>): boolean {
  return Object.keys(styles).some(
    (key) =>
      BORDER_SIDE_SHORTHAND_KEYS.has(key) ||
      (key.startsWith("border") && (key.endsWith("Color") || key.endsWith("Style"))),
  );
}

function hasAuthoredBorderGeometryStyle(styles: Record<string, string | number>): boolean {
  return Object.keys(styles).some(
    (key) =>
      BORDER_SIDE_SHORTHAND_KEYS.has(key) ||
      (key.startsWith("border") && (key.endsWith("Width") || key.endsWith("Style"))),
  );
}

function parsePixelDimension(value: string | number): number | null {
  if (typeof value === "number") return value;
  const trimmed = value.trim();
  return /^-?\d+(\.\d+)?(px)?$/.test(trimmed) ? parseFloat(trimmed) : null;
}

/** Longhands the `background` shorthand resets. */
const BACKGROUND_LONGHAND_KEYS = [
  "backgroundImage",
  "backgroundSize",
  "backgroundPosition",
  "backgroundRepeat",
  "backgroundAttachment",
  "backgroundOrigin",
  "backgroundClip",
  "backgroundBlendMode",
] as const;

/** Split on commas that are not inside parentheses. */
function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** Functions that produce a background *image* layer. */
const IMAGE_FUNCTION =
  /^(repeating-)?(linear|radial|conic)-gradient\(|^(url|image|image-set|cross-fade|element|paint)\(/i;

/**
 * Decompose a `background` shorthand into longhands, or null when it cannot be
 * done losslessly.
 *
 * Why bother: React cannot safely transition a style object between
 * `background` and `backgroundImage`. It expands the shorthand and then clears
 * the longhand it believes was removed, which wipes the paint and leaves the
 * node blank. If the styles map only ever holds longhands, that transition
 * cannot arise — so the common gradient and image cases are normalized here.
 *
 * Anything with positional or sizing components (`center / cover no-repeat`)
 * returns null and is stored verbatim instead. Splitting those correctly needs
 * a full shorthand parser, and guessing would corrupt the value.
 */
export function decomposeBackgroundShorthand(
  shorthand: string,
): { backgroundImage?: string; backgroundColor?: string } | null {
  const layers = splitTopLevel(shorthand);
  if (layers.length === 0) return null;

  const paints: string[] = [];
  let color: string | undefined;

  for (const [index, layer] of layers.entries()) {
    const isLast = index === layers.length - 1;
    let text = layer.trim();

    if (IMAGE_FUNCTION.test(text)) {
      // The final layer may carry the background colour after its image, as in
      // `linear-gradient(red, blue) #123456`.
      const imageEnd = findFunctionEnd(text);
      if (imageEnd < 0) return null;
      const rest = text.slice(imageEnd).trim();
      text = text.slice(0, imageEnd);
      if (rest !== "") {
        if (!isLast || !parseColorToken(rest)) return null;
        color = rest;
      }
      paints.push(text);
      continue;
    }
    if (text.toLowerCase() === "none") continue;

    // A bare colour is only legal in the final layer of the shorthand.
    if (isLast && parseColorToken(text)) {
      color = text;
      continue;
    }

    // Position/size/repeat/attachment components — not safely separable.
    return null;
  }

  const result: { backgroundImage?: string; backgroundColor?: string } = {};
  if (paints.length > 0) result.backgroundImage = paints.join(", ");
  if (color !== undefined) result.backgroundColor = color;
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Index just past the closing paren of the leading function call, or -1 when
 * the parens never balance. Needed because gradients nest colour functions.
 */
function findFunctionEnd(text: string): number {
  const open = text.indexOf("(");
  if (open < 0) return -1;
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

/**
 * Bare `background` idents that are *not* paint — repeat, attachment, sizing,
 * position, and the CSS-wide keywords.
 *
 * Why a deny-list and not an allow-list of colours: the allow-list would have to
 * enumerate all ~148 named colours plus the system colours (Canvas, CanvasText,
 * ButtonFace, AccentColor, Highlight, LinkText, GrayText, Field, Mark, ...), and
 * missing a single one silently demotes valid paint into the verbatim-shorthand
 * path — the visual regression the docstring above exists to prevent. The
 * non-colour idents, by contrast, are a closed set fixed by the shorthand grammar.
 */
const NON_COLOR_BACKGROUND_IDENTS = new Set([
  // background-repeat
  "repeat",
  "no-repeat",
  "repeat-x",
  "repeat-y",
  "space",
  "round",
  // background-attachment
  "scroll",
  "fixed",
  "local",
  // background-size
  "cover",
  "contain",
  "auto",
  // background-position
  "left",
  "right",
  "top",
  "bottom",
  "center",
  // background-clip / -origin
  "border-box",
  "padding-box",
  "content-box",
  "text",
  // background-image
  "none",
  // CSS-wide keywords
  "inherit",
  "initial",
  "unset",
  "revert",
  "revert-layer",
]);

/** True when the whole token is a single colour value. */
function parseColorToken(text: string): boolean {
  if (/^#[0-9a-f]{3,8}$/i.test(text)) return true;
  if (/^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)$/i.test(text)) return true;
  // A single bare keyword: `red`, `transparent`, `currentColor`. Anything the
  // shorthand grammar spends on a non-paint component is rejected so the caller
  // falls through to storing the shorthand verbatim rather than inventing a
  // `backgroundColor: repeat` the browser will drop.
  if (NON_COLOR_BACKGROUND_IDENTS.has(text.toLowerCase())) return false;
  return /^[a-z]+$/i.test(text);
}

const BORDER_RADIUS_CONFLICT_KEYS = [
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomLeftRadius",
  "borderBottomRightRadius",
  "borderStartStartRadius",
  "borderStartEndRadius",
  "borderEndStartRadius",
  "borderEndEndRadius",
] as const;

/** CSS absolute length units, as a multiplier onto px. */
export const ABSOLUTE_LENGTH_PX: Record<string, number> = {
  px: 1,
  pt: 96 / 72,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
};

const ROOT_FONT_SIZE_PX = 16;

/**
 * Resolve a CSS length to px, or null when it cannot be resolved statically.
 *
 * `em`, `%`, `calc()`, `var()`, `clamp()` and friends depend on layout context
 * we do not have here, so they resolve to null and the authored text is kept
 * verbatim in the styles map for the browser to work out.
 */
function resolveCssLengthPx(value: string | number): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const trimmed = value.trim().toLowerCase();
  const match = /^(-?\d*\.?\d+)([a-z%]*)$/.exec(trimmed);
  if (!match) return null;
  const magnitude = Number.parseFloat(match[1]);
  if (!Number.isFinite(magnitude)) return null;
  const unit = match[2];
  if (unit === "") return magnitude;
  if (unit === "rem") return magnitude * ROOT_FONT_SIZE_PX;
  const factor = ABSOLUTE_LENGTH_PX[unit];
  return factor === undefined ? null : magnitude * factor;
}

/**
 * Parse a value that is already plain CSS pixels — a finite number or a
 * `"12px"`/`"12"` string — to its numeric px magnitude, or null for anything
 * that needs unit resolution.
 */
export function parsePlainPixelLength(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const match = /^(-?\d*\.?\d+)(px)?$/i.exec(value.trim());
  if (!match) return null;
  const parsed = Number.parseFloat(match[1]!);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * True when a value is exactly what the typed px prop round-trips back to, so
 * collapsing it into that prop loses nothing. Anything else has to stay in the
 * styles map: `parseFloat("1.5rem")` is 1.5, and rendering that as 1.5px is a
 * silent 10x shrink.
 */
function isPlainPixelLength(value: string | number): boolean {
  return parsePlainPixelLength(value) !== null;
}

function clearConflictingStyleKeys(node: StyleMutableNode, key: string) {
  if (["color", "fontSize", "fontFamily", "fontWeight"].includes(key)) {
    delete node.styles[key];
  }
}

/**
 * Typed props that shadow a CSS key. Removing one of these has to reset the
 * prop as well as delete the styles entry, or the typed value keeps painting.
 */
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

type TypedStyleKey = (typeof TYPED_STYLE_KEYS)[number];

function isTypedStyleKey(key: string): key is TypedStyleKey {
  return (TYPED_STYLE_KEYS as readonly string[]).includes(key);
}

/** Keys a removal should sweep alongside the requested one. */
function relatedRemovalKeys(key: string): readonly string[] {
  if (key === "borderWidth") return BORDER_WIDTH_CONFLICT_KEYS;
  if (key === "borderColor") return BORDER_COLOR_CONFLICT_KEYS;
  if (key === "borderRadius") return BORDER_RADIUS_CONFLICT_KEYS;
  if (key === "border") return [...BORDER_WIDTH_CONFLICT_KEYS, ...BORDER_COLOR_CONFLICT_KEYS];
  return [];
}

/**
 * Take a style back off a node.
 *
 * Width and height are deliberately not reset to a default: dropping an
 * authored `width: auto` should leave the node at its current model size
 * (that is how a flow child escapes content sizing), not resize it.
 */
function removeStyleKey(node: StyleMutableNode, key: string) {
  delete node.styles[key];
  for (const related of relatedRemovalKeys(key)) delete node.styles[related];

  if (key === "border") {
    const defaults = getNodeDefaults(node.type);
    node.borderColor = String(defaults.borderColor ?? "transparent");
    node.borderWidth = Number(defaults.borderWidth ?? 0);
    return;
  }

  if (isTypedStyleKey(key)) {
    const defaults = getNodeDefaults(node.type);
    const fallback = defaults[key];
    if (fallback !== undefined) {
      (node as Record<string, unknown>)[key] = fallback;
    }
  }
}

export function applyStyleUpdate<T extends StyleMutableNode>(
  node: T,
  patch: StylePatch,
  ensureFontsLoaded?: (family: string) => void,
) {
  node.styles = { ...node.styles };

  // Removals run after the sets so a patch can replace-then-trim in one call,
  // and so the border post-passes below still see the values they set.
  const removedKeys: string[] = [];
  const styles: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) removedKeys.push(key);
    else styles[key] = value;
  }

  const hasBackgroundUpdate = Object.hasOwn(styles, "background");
  const hasBackgroundColorUpdate = Object.hasOwn(styles, "backgroundColor");
  const hasBorderUpdate = Object.hasOwn(styles, "border");
  const hasBorderColorUpdate = Object.hasOwn(styles, "borderColor");
  const hasBorderWidthUpdate = Object.hasOwn(styles, "borderWidth");
  const previousRenderedBorderColor = getRenderedBorderStyleValue(node, "borderColor");
  const previousRenderedBorderWidth = getRenderedBorderStyleValue(node, "borderWidth");
  const hadBorderColorOverride = hasStyleKey(node, "borderColor");
  const hadBorderWidthOverride = hasStyleKey(node, "borderWidth");
  const hadBorderColorConflicts = BORDER_COLOR_CONFLICT_KEYS.some((key) => hasStyleKey(node, key));
  const hadBorderWidthConflicts = BORDER_WIDTH_CONFLICT_KEYS.some((key) => hasStyleKey(node, key));
  const hasBorderColorConflictUpdate = BORDER_COLOR_CONFLICT_KEYS.some((key) =>
    Object.hasOwn(styles, key),
  );
  const hasBorderWidthConflictUpdate = BORDER_WIDTH_CONFLICT_KEYS.some((key) =>
    Object.hasOwn(styles, key),
  );
  const hasBorderShorthandUpdate = Object.keys(styles).some((key) =>
    BORDER_SIDE_SHORTHAND_KEYS.has(key),
  );

  for (const [key, value] of Object.entries(styles)) {
    switch (key) {
      case "backgroundColor":
        node.backgroundColor = String(value);
        if (
          hasStyleKey(node, "background") ||
          hasStyleKey(node, "backgroundColor") ||
          hasBackgroundUpdate
        ) {
          setStyleKey(node, "backgroundColor", String(value));
        } else {
          delete node.styles.backgroundColor;
        }
        break;
      case "background": {
        // Normalize to longhands rather than storing the shorthand — see
        // decomposeBackgroundShorthand. The shorthand also resets every
        // background longhand in CSS, so clear them first.
        for (const conflictKey of BACKGROUND_LONGHAND_KEYS) {
          if (!Object.hasOwn(styles, conflictKey)) delete node.styles[conflictKey];
        }
        delete node.styles.background;

        const decomposed = decomposeBackgroundShorthand(String(value));
        if (decomposed === null) {
          // Not safely separable — keep it verbatim rather than corrupt it.
          setStyleKey(node, "background", value);
          if (!hasBackgroundColorUpdate) {
            node.backgroundColor = "transparent";
            delete node.styles.backgroundColor;
          }
          break;
        }
        if (decomposed.backgroundImage !== undefined) {
          setStyleKey(node, "backgroundImage", decomposed.backgroundImage);
        }
        if (!hasBackgroundColorUpdate) {
          node.backgroundColor = decomposed.backgroundColor ?? "transparent";
          delete node.styles.backgroundColor;
        }
        break;
      }
      case "border":
        setStyleKey(node, "border", value);
        if (!hasBorderColorUpdate) {
          node.borderColor = "transparent";
          delete node.styles.borderColor;
        }
        if (!hasBorderWidthUpdate) {
          node.borderWidth = 0;
          delete node.styles.borderWidth;
        }
        break;
      case "borderRadius": {
        // A multi-corner shorthand ("8px 8px 0 0") has no single px value;
        // keep the authored text and leave the typed prop as the last uniform
        // radius we knew about.
        node.borderRadius = resolveCssLengthPx(value) ?? node.borderRadius;
        for (const conflictKey of BORDER_RADIUS_CONFLICT_KEYS) delete node.styles[conflictKey];
        if (hasStyleKey(node, key) || !isPlainPixelLength(value)) setStyleKey(node, key, value);
        else delete node.styles.borderRadius;
        break;
      }
      case "borderColor":
        node.borderColor = String(value);
        break;
      case "borderWidth":
        node.borderWidth = resolveCssLengthPx(value) ?? node.borderWidth;
        break;
      case "color":
        node.color = String(value);
        clearConflictingStyleKeys(node, key);
        break;
      case "fontSize":
        node.fontSize = resolveCssLengthPx(value) ?? node.fontSize;
        // `em`/`%`/`clamp()` sizes have to reach the browser verbatim; only a
        // plain px value is safe to collapse into the typed prop alone.
        if (isPlainPixelLength(value)) clearConflictingStyleKeys(node, key);
        else setStyleKey(node, key, value);
        break;
      case "fontFamily":
        node.fontFamily = String(value);
        clearConflictingStyleKeys(node, key);
        ensureFontsLoaded?.(String(value));
        break;
      case "fontWeight":
        node.fontWeight = String(value);
        clearConflictingStyleKeys(node, key);
        break;
      case "width":
      case "height": {
        const numeric = parsePixelDimension(value);
        if (numeric === null) node.styles[key] = value;
        else {
          node[key as DimensionKey] = numeric;
          delete node.styles[key];
        }
        break;
      }
      case "x":
        node.x = typeof value === "number" ? value : parseFloat(String(value)) || node.x;
        break;
      case "y":
        node.y = typeof value === "number" ? value : parseFloat(String(value)) || node.y;
        break;
      default:
        node.styles[key] = value;
    }
  }

  if (hasBorderWidthUpdate) {
    for (const key of BORDER_WIDTH_CONFLICT_KEYS) {
      delete node.styles[key];
    }
    const needsReactReapply =
      previousRenderedBorderWidth === styles.borderWidth &&
      (hadBorderWidthConflicts || hasBorderWidthConflictUpdate || hasBorderShorthandUpdate);
    if (
      hadBorderWidthOverride ||
      hasAuthoredBorderPaintStyle(node.styles) ||
      hasBorderUpdate ||
      needsReactReapply ||
      // A non-px width (em, %, var()) cannot survive in the typed prop alone.
      !isPlainPixelLength(styles.borderWidth)
    ) {
      // Keep the uniform width last so it overrides an authored border shorthand,
      // including when the requested width is zero. A changed shorthand can reset
      // an unchanged longhand in the DOM because React skips equal style values,
      // so use an equivalent representation to force that reapplication.
      setStyleKey(
        node,
        "borderWidth",
        needsReactReapply
          ? makeEquivalentCssValueDistinct(styles.borderWidth, previousRenderedBorderWidth)
          : styles.borderWidth,
      );
    } else {
      delete node.styles.borderWidth;
    }
  }

  if (hasBorderColorUpdate) {
    for (const key of BORDER_COLOR_CONFLICT_KEYS) {
      delete node.styles[key];
    }
    const requestedColor = String(styles.borderColor);
    const needsReactReapply =
      previousRenderedBorderColor === requestedColor &&
      (hadBorderColorConflicts || hasBorderColorConflictUpdate || hasBorderShorthandUpdate);
    if (
      hadBorderColorOverride ||
      hasAuthoredBorderGeometryStyle(node.styles) ||
      hasBorderUpdate ||
      needsReactReapply
    ) {
      // Keep the uniform color last so it overrides an authored border shorthand
      // while preserving the shorthand's width and style. Force React to reapply
      // an unchanged value after a shorthand or removed side-color mutation.
      setStyleKey(
        node,
        "borderColor",
        needsReactReapply
          ? makeEquivalentCssValueDistinct(requestedColor, previousRenderedBorderColor)
          : requestedColor,
      );
    } else {
      delete node.styles.borderColor;
    }
  }

  for (const key of removedKeys) removeStyleKey(node, key);
}

/** Convenience wrapper for the common "take these styles off" case. */
export function removeStyleKeys<T extends StyleMutableNode>(node: T, keys: string[]) {
  node.styles = { ...node.styles };
  for (const key of keys) removeStyleKey(node, key);
}
