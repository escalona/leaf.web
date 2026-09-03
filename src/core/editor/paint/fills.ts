/**
 * A node's fill stack, derived from the CSS background properties it already
 * carries.
 *
 * Leaf stores paint as flat CSS, so the fill list is a *view* over
 * `backgroundColor` / `background` / `backgroundImage` rather than a sidecar
 * the panel maintains. That is the load-bearing property: a stack an agent
 * wrote with `write_html` is immediately editable layer by layer, and a stack
 * the panel wrote is still ordinary CSS to everything downstream.
 *
 * Ordering follows CSS: index 0 is the layer painted on top, and the last entry
 * is the bottom of the stack. A trailing solid fill collapses into
 * `background-color`, which is both the shortest correct output and the form
 * every other tool expects to find a flat colour in.
 *
 * The one thing flat CSS cannot express is a *hidden* layer, so hidden layers
 * are parked on a `--leaf-hidden-background-image` custom property carrying the
 * index they return to — the same convention the effects stack uses.
 */

import type { StylePatch } from "../style-mutation";
import { alphaOf, parseColor } from "./color";
import {
  createGradient,
  formatGradient,
  parseGradient,
  splitTopLevel,
  withGradientKind,
  type Gradient,
  type GradientKind,
} from "./gradient";

export type FillType = "solid" | "gradient" | "image";

interface FillBase {
  visible: boolean;
  /** `background-blend-mode` for this layer; absent means `normal`. */
  blendMode?: string;
}

export interface SolidFill extends FillBase {
  type: "solid";
  /** Authored colour text, kept verbatim so `var()` survives a round trip. */
  color: string;
}

export interface GradientFill extends FillBase {
  type: "gradient";
  gradient: Gradient;
}

export interface ImageFill extends FillBase {
  type: "image";
  url: string;
  /** `background-size`; the fill analogue of `object-fit`. */
  size?: string;
  /** `background-position`; the fill analogue of `object-position`. */
  position?: string;
  repeat?: string;
}

/**
 * A layer this model cannot decompose, kept verbatim.
 *
 * `image-set()`, `element()`, `-webkit-linear-gradient()` and a bare
 * `var(--brand-gradient)` are all legal paint an agent can write. Without a home
 * in the stack they would be invisible in the panel *and* erased by the next
 * edit, because writing the stack rewrites every key it owns. Carrying them as
 * raw CSS keeps a fill the panel cannot model from being destroyed by one.
 */
export interface RawFill extends FillBase {
  type: "raw";
  /** The authored paint CSS for this layer. */
  css: string;
  size?: string;
  position?: string;
  repeat?: string;
}

export type Fill = SolidFill | GradientFill | ImageFill | RawFill;

/** Layers that carry their own size/position/repeat rather than inheriting defaults. */
function auxOf(fill: Fill, key: "size" | "position" | "repeat"): string | undefined {
  return fill.type === "image" || fill.type === "raw" ? fill[key] : undefined;
}

/** Reads the effective value of a CSS key, i.e. `resolveNodeStyle` bound to a node. */
export type FillStyleReader = (key: string) => string | number | undefined;

export const HIDDEN_FILLS_KEY = "--leaf-hidden-background-image";

const IMAGE_FIT_DEFAULTS = { size: "cover", position: "50% 50%", repeat: "no-repeat" };

function readText(read: FillStyleReader, key: string): string {
  const value = read(key);
  if (value === undefined || value === null) return "";
  const text = String(value).trim();
  return text.toLowerCase() === "none" ? "" : text;
}

const splitLayers = (value: string) =>
  splitTopLevel(value, ",")
    .map((part) => part.trim())
    .filter(Boolean);

const splitWords = (value: string) =>
  splitTopLevel(value, " \t\n\r")
    .map((part) => part.trim())
    .filter(Boolean);

/**
 * The paint token inside a background layer.
 *
 * A `background` shorthand layer carries position, size and repeat around the
 * paint (`url(x) center / cover no-repeat`), so the paint has to be extracted
 * by a balanced scan rather than by matching the whole layer.
 */
const PAINT_CALL = /(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(|url\s*\(/gi;

/** Parenthesis nesting at an offset, ignoring anything inside a string. */
function depthAt(text: string, offset: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = 0; index < offset; index += 1) {
    const char = text[index]!;
    if (quote) {
      if (char === quote && text[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
  }
  return depth;
}

function extractPaintToken(layer: string): string | null {
  const pattern = new RegExp(PAINT_CALL.source, "gi");
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(layer)) !== null) {
    // Only a paint at the top level of the layer is the layer's paint. The
    // `url()` inside `image-set(url(a) 1x, url(b) 2x)` is an argument, and
    // taking it would silently reduce the layer to its first image.
    if (depthAt(layer, match.index) !== 0) continue;
    // A match that starts mid-identifier is part of a longer function name:
    // `-webkit-linear-gradient(top, …)` is not a standard gradient, and reading
    // it as one strips the prefix and turns `top` into a colour stop.
    const preceding = layer[match.index - 1];
    if (preceding !== undefined && /[\w-]/.test(preceding)) continue;

    let depth = 0;
    for (let index = match.index; index < layer.length; index += 1) {
      const char = layer[index]!;
      if (char === "(") depth += 1;
      else if (char === ")") {
        depth -= 1;
        if (depth === 0) return layer.slice(match.index, index + 1);
      }
    }
    return layer.slice(match.index);
  }
  return null;
}

const URL_CALL = /^url\(\s*(["']?)([\s\S]*?)\1\s*\)$/i;

type FillPaint =
  | { type: "solid"; color: string }
  | { type: "gradient"; gradient: Gradient }
  | { type: "image"; url: string };

/**
 * The paint a layer carries, or null when it is a form this model cannot edit.
 *
 * Null is not "no paint" — the caller keeps the layer as a `RawFill` — so this
 * stays deliberately strict rather than guessing at a partial match.
 */
function parsePaint(layer: string): FillPaint | null {
  const text = layer.trim();
  if (text === "" || text.toLowerCase() === "none") return null;

  const paint = extractPaintToken(text);
  if (paint) {
    // Trailing text beside the paint means this is not a bare paint token, so
    // reading only the token would drop whatever sits next to it.
    if (text.replace(paint, "").trim() !== "") return null;
    const gradient = parseGradient(paint);
    if (gradient) return collapseSolidGradient(gradient);
    const url = URL_CALL.exec(paint);
    return url ? { type: "image", url: url[2]!.trim() } : null;
  }

  return parseColor(text) ? { type: "solid", color: text } : null;
}

/**
 * A gradient whose stops are all one colour is how a solid layer has to be
 * spelled inside `background-image`, so it reads back as the solid it is.
 */
function collapseSolidGradient(gradient: Gradient): FillPaint {
  const first = gradient.stops[0]!;
  const uniform = gradient.stops.every((stop) => stop.color === first.color);
  return uniform && gradient.stops.length > 1
    ? { type: "solid", color: first.color }
    : { type: "gradient", gradient };
}

const SIZE_KEYWORDS = new Set(["auto", "cover", "contain"]);
const REPEAT_KEYWORDS = new Set(["repeat", "repeat-x", "repeat-y", "no-repeat", "space", "round"]);
/** `background-attachment`, `background-origin` and `background-clip` values. */
const IGNORED_KEYWORDS = new Set([
  "scroll",
  "fixed",
  "local",
  "border-box",
  "padding-box",
  "content-box",
  "text",
]);
const LENGTH_VALUE =
  /^[+-]?(?:\d+\.?\d*|\.\d+)(?:%|px|r?em|ch|ex|vw|vh|vmin|vmax|cm|mm|in|pt|pc|q)?$/i;

interface LayerParts {
  paint: string | null;
  color?: string;
  size?: string;
  position?: string;
  repeat?: string;
}

/**
 * Pull a `background` shorthand layer apart.
 *
 * The shorthand carries position, size and repeat next to the paint
 * (`url(a.png) center / cover no-repeat`) and a colour in its final layer.
 * Reading only the paint and taking the aux values from the longhand lists —
 * which a shorthand-only node does not have — makes the panel show a fit the
 * node does not have and then write that fiction back, so the authored `cover`
 * disappears the first time anybody touches the section.
 */
function decomposeShorthandLayer(layer: string): LayerParts {
  const paint = extractPaintToken(layer);
  const rest = paint ? layer.replace(paint, " ") : layer;
  const parts: LayerParts = { paint };

  const [positionText = "", ...sizeText] = splitTopLevel(rest, "/");
  const loose = splitWords(positionText);

  if (sizeText.length > 0) {
    const sizeTokens = splitWords(sizeText.join("/"));
    const size: string[] = [];
    while (
      size.length < 2 &&
      sizeTokens.length > 0 &&
      (SIZE_KEYWORDS.has(sizeTokens[0]!.toLowerCase()) || LENGTH_VALUE.test(sizeTokens[0]!))
    ) {
      size.push(sizeTokens.shift()!);
    }
    if (size.length > 0) parts.size = size.join(" ");
    loose.push(...sizeTokens);
  }

  const position: string[] = [];
  for (const token of loose) {
    const lower = token.toLowerCase();
    if (REPEAT_KEYWORDS.has(lower)) parts.repeat = token;
    else if (IGNORED_KEYWORDS.has(lower)) continue;
    // Only the final layer may carry a colour, so the last one seen wins.
    else if (parseColor(token)) parts.color = token;
    else position.push(token);
  }
  if (position.length > 0) parts.position = position.join(" ");

  return parts;
}

/** CSS repeats a shorter aux list across the layers rather than padding it. */
function layerValue(list: string[], index: number): string | undefined {
  if (list.length === 0) return undefined;
  return list[index % list.length];
}

function withPaint(paint: FillPaint, extras: Omit<FillBase, "visible">): Fill {
  const base = { visible: true, ...extras };
  if (paint.type === "solid") return { ...base, type: "solid", color: paint.color };
  if (paint.type === "gradient") return { ...base, type: "gradient", gradient: paint.gradient };
  return { ...base, type: "image", url: paint.url };
}

/** Read the stack a node currently paints, top layer first. */
export function parseFills(read: FillStyleReader): Fill[] {
  const fills: Fill[] = [];

  const imageValue = readText(read, "backgroundImage");
  const shorthand = readText(read, "background");
  const source = imageValue !== "" ? imageValue : shorthand;
  const fromShorthand = imageValue === "" && shorthand !== "";

  const blendModes = splitLayers(readText(read, "backgroundBlendMode"));
  const sizes = splitLayers(readText(read, "backgroundSize"));
  const positions = splitLayers(readText(read, "backgroundPosition"));
  const repeats = splitLayers(readText(read, "backgroundRepeat"));

  let shorthandColor: string | undefined;
  const layers = source === "" ? [] : splitLayers(source);

  layers.forEach((layer, index) => {
    if (layer.trim().toLowerCase() === "none") return;

    // In the shorthand a bare colour is the background-color, not a layer, and
    // the aux values travel inside the layer instead of in parallel lists.
    const parts: LayerParts = fromShorthand ? decomposeShorthandLayer(layer) : { paint: layer };
    if (parts.color !== undefined) shorthandColor = parts.color;

    const paintText = parts.paint?.trim() ?? "";
    if (paintText === "") return;

    const blendMode = layerValue(blendModes, index);
    const extras = { blendMode: blendMode && blendMode !== "normal" ? blendMode : undefined };

    // A layer the model cannot decompose is kept verbatim rather than dropped:
    // dropping it would erase it on the next write.
    const paint = parsePaint(paintText);
    const fill: Fill = paint
      ? withPaint(paint, extras)
      : { type: "raw", css: paintText, visible: true, ...extras };

    if (fill.type === "image" || fill.type === "raw") {
      fill.size = fromShorthand ? parts.size : layerValue(sizes, index);
      fill.position = fromShorthand ? parts.position : layerValue(positions, index);
      fill.repeat = fromShorthand ? parts.repeat : layerValue(repeats, index);
    }
    fills.push(fill);
  });

  const color = shorthandColor ?? readText(read, "backgroundColor");
  // A fully transparent colour is the absence of a fill, not a fill of nothing.
  if (color !== "" && alphaOf(color) > 0) {
    fills.push({ type: "solid", color, visible: true });
  }

  return mergeHidden(fills, read);
}

// --- Hidden layers ----------------------------------------------------------

interface ParkedFill {
  index: number;
  fill: Fill;
}

/**
 * A parked layer is `index / <paint> | key=value …`. The slash separates the
 * index the way the effects stack does it, and the pipes carry the aux values a
 * hidden layer would otherwise lose because it has no slot in the real
 * `background-size` / `background-position` lists.
 */
function encodeParkedFill(parked: ParkedFill): string {
  const parts = [paintCss(parked.fill)];
  const fill = parked.fill;
  if (fill.blendMode) parts.push(`blend=${fill.blendMode}`);
  const size = auxOf(fill, "size");
  const position = auxOf(fill, "position");
  const repeat = auxOf(fill, "repeat");
  if (size) parts.push(`size=${size}`);
  if (position) parts.push(`position=${position}`);
  if (repeat) parts.push(`repeat=${repeat}`);
  return `${parked.index} / ${parts.join(" | ")}`;
}

function decodeParkedFill(entry: string): ParkedFill | null {
  const [head, ...rest] = splitTopLevel(entry, "/");
  if (rest.length === 0) return null;
  const index = Number.parseInt(head!.trim(), 10);
  if (!Number.isInteger(index) || index < 0) return null;

  const [paintText, ...attributes] = splitTopLevel(rest.join("/"), "|");
  const css = (paintText ?? "").trim();
  if (css === "") return null;

  const paint = parsePaint(css);
  // A parked layer the model cannot decompose stays raw, exactly as a visible
  // one does; otherwise hiding an `image-set()` would delete it.
  const fill: Fill = paint ? withPaint(paint, {}) : { type: "raw", css, visible: true };
  fill.visible = false;

  for (const attribute of attributes) {
    const separator = attribute.indexOf("=");
    if (separator === -1) continue;
    const key = attribute.slice(0, separator).trim();
    const value = attribute.slice(separator + 1).trim();
    if (value === "") continue;
    if (key === "blend") fill.blendMode = value;
    else if (
      (fill.type === "image" || fill.type === "raw") &&
      (key === "size" || key === "position" || key === "repeat")
    ) {
      fill[key] = value;
    }
  }
  return { index, fill };
}

function mergeHidden(visible: Fill[], read: FillStyleReader): Fill[] {
  const parked = splitLayers(readText(read, HIDDEN_FILLS_KEY))
    .map(decodeParkedFill)
    .filter((entry): entry is ParkedFill => entry !== null)
    .sort((a, b) => a.index - b.index);

  const fills = [...visible];
  for (const entry of parked) {
    fills.splice(Math.min(Math.max(entry.index, 0), fills.length), 0, entry.fill);
  }
  return fills;
}

// --- Writing ----------------------------------------------------------------

function quoteUrl(url: string): string {
  return `url("${url.replace(/["\\]/g, (char) => `\\${char}`)}")`;
}

/** The CSS for one layer, as it appears in `background-image`. */
export function paintCss(fill: Fill): string {
  if (fill.type === "raw") return fill.css;
  if (fill.type === "gradient") return formatGradient(fill.gradient);
  if (fill.type === "image") return quoteUrl(fill.url);
  // `background-image` has no solid form, so a solid layer above another layer
  // has to be spelled as a gradient between one colour and itself.
  return `linear-gradient(${fill.color}, ${fill.color})`;
}

/**
 * The style patch that makes a node paint exactly this stack.
 *
 * Every key the stack owns is present in the patch — set or `null` — so writing
 * a stack also clears whatever the previous one left behind. Without that,
 * dropping the last image fill would leave a stale `background-size` to
 * misalign the next one.
 */
export function formatFills(fills: readonly Fill[]): StylePatch {
  const visible: Fill[] = [];
  const parked: ParkedFill[] = [];
  fills.forEach((fill, index) => {
    if (fill.visible) visible.push(fill);
    else parked.push({ index, fill });
  });

  const layers = [...visible];
  // A trailing solid collapses into `background-color`, but only when it is not
  // blended: `background-blend-mode` aligns to the image layers, so a blended
  // colour has to stay a layer to keep its slot.
  const last = layers.at(-1);
  const color = last?.type === "solid" && !last.blendMode ? layers.pop() : undefined;
  const solidColor = color?.type === "solid" ? color.color : undefined;

  const blendModes = layers.map((fill) => fill.blendMode ?? "normal");
  const sizes = layers.map((fill) => auxOf(fill, "size") ?? "auto");
  const positions = layers.map((fill) => auxOf(fill, "position") ?? "0% 0%");
  const repeats = layers.map((fill) => auxOf(fill, "repeat") ?? "repeat");

  const emitAux = (values: string[], initial: string) =>
    values.some((value) => value !== initial) ? values.join(", ") : null;

  return {
    // The panel owns the longhands, so a shorthand left by an import would only
    // shadow them.
    background: null,
    backgroundColor: solidColor ?? "transparent",
    backgroundImage: layers.length > 0 ? layers.map(paintCss).join(", ") : null,
    backgroundBlendMode: emitAux(blendModes, "normal"),
    backgroundSize: emitAux(sizes, "auto"),
    backgroundPosition: emitAux(positions, "0% 0%"),
    backgroundRepeat: emitAux(repeats, "repeat"),
    [HIDDEN_FILLS_KEY]: parked.length > 0 ? parked.map(encodeParkedFill).join(", ") : null,
  };
}

// --- Stack editing ----------------------------------------------------------

export function createFill(type: FillType): Fill {
  if (type === "gradient") return { type: "gradient", gradient: createGradient(), visible: true };
  if (type === "image") {
    return { type: "image", url: "", visible: true, ...IMAGE_FIT_DEFAULTS };
  }
  // The new-fill colour.
  return { type: "solid", color: "#dddddd", visible: true };
}

/**
 * Retype a fill, carrying the colour across so switching solid → gradient
 * starts from what the user was already looking at rather than a grey ramp.
 */
export function convertFill(fill: Fill, type: FillType): Fill {
  if (fill.type === type) return fill;
  const { visible, blendMode } = fill;

  if (type === "solid") {
    const color = fill.type === "gradient" ? fill.gradient.stops[0]?.color : undefined;
    return { type: "solid", color: color ?? "#dddddd", visible, blendMode };
  }
  if (type === "gradient") {
    const base = createGradient();
    const gradient =
      fill.type === "solid"
        ? { ...base, stops: [{ color: fill.color, position: 0 }, ...base.stops.slice(1)] }
        : base;
    return { type: "gradient", gradient, visible, blendMode };
  }
  return { type: "image", url: "", ...IMAGE_FIT_DEFAULTS, visible, blendMode };
}

export function setGradientKind(fill: GradientFill, kind: GradientKind): GradientFill {
  return { ...fill, gradient: withGradientKind(fill.gradient, kind) };
}

/** Move a layer within the stack, returning a new array. */
export function moveFill(fills: readonly Fill[], from: number, to: number): Fill[] {
  if (from === to || from < 0 || from >= fills.length || to < 0 || to >= fills.length) {
    return [...fills];
  }
  const next = [...fills];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

export function replaceFill(fills: readonly Fill[], index: number, fill: Fill): Fill[] {
  return fills.map((existing, position) => (position === index ? fill : existing));
}

export function removeFill(fills: readonly Fill[], index: number): Fill[] {
  return fills.filter((_, position) => position !== index);
}

/** Whether two stacks paint the same thing, for the mixed-selection check. */
export function fillsEqual(a: readonly Fill[], b: readonly Fill[]): boolean {
  return JSON.stringify(formatFills(a)) === JSON.stringify(formatFills(b));
}
