/**
 * CSS gradient parsing and formatting.
 *
 * A gradient reaches Leaf as a flat CSS string — an agent writes it through
 * `write_html` or `update_styles`, or it arrives with imported markup. For the
 * panel to offer stop-by-stop editing it has to decompose that string on
 * *read*, not just emit one on write; a structure the panel maintains privately
 * could never edit what somebody else authored.
 *
 * The gradient model:
 * `linear | radial | conic`, an interpolation colour space, and a stop list.
 * Geometry that could be stored as normalized vectors (centre, length, cross-axis) is
 * kept here as the authored CSS text instead, so a radial gradient survives a
 * round trip without us inventing values for parts the panel does not edit.
 */

import { formatColor, parseColor } from "./color";

export type GradientKind = "linear" | "radial" | "conic";

export interface GradientStop {
  /** Authored colour text, kept verbatim so `var()` and `color-mix()` survive. */
  color: string;
  /** 0–1 along the gradient line. */
  position: number;
}

export interface Gradient {
  kind: GradientKind;
  repeating: boolean;
  /**
   * Degrees. For `linear` this is the CSS gradient-line angle, where `to bottom`
   * is 180. For `conic` it is the `from` angle. Unused for `radial`.
   */
  angle: number;
  stops: GradientStop[];
  /** The `in <colour-space>` clause, e.g. `oklab`, when one was authored. */
  interpolation?: string;
  /** Radial shape and extent, e.g. `circle farthest-corner`. */
  shape?: string;
  /** The `at <position>` clause for radial and conic, e.g. `50% 50%`. */
  center?: string;
}

/**
 * Split on separators that are not nested inside parentheses or a string.
 *
 * Every colour function in a stop list carries commas (`rgba(0, 0, 0, .5)`), so
 * a naive split tears one stop into four. This is the same depth-aware split
 * the effects stack uses, duplicated here to keep the paint modules free of a
 * dependency on the effects module.
 */
export function splitTopLevel(value: string, separators: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote) {
      current += char;
      if (char === quote && value[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && separators.includes(char)) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

const splitCommas = (value: string) =>
  splitTopLevel(value, ",")
    .map((part) => part.trim())
    .filter(Boolean);

const splitWords = (value: string) =>
  splitTopLevel(value, " \t\n\r")
    .map((part) => part.trim())
    .filter(Boolean);

/** The `to <side>` table, as gradient-line degrees. */
const SIDE_ANGLES: Record<string, number> = {
  "to top": 0,
  "to right": 90,
  "to bottom": 180,
  "to left": 270,
  "to top right": 45,
  "to right top": 45,
  "to bottom right": 135,
  "to right bottom": 135,
  "to bottom left": 225,
  "to left bottom": 225,
  "to top left": 315,
  "to left top": 315,
};

const ANGLE_PATTERN = /^([+-]?(?:\d+\.?\d*|\.\d+))(deg|grad|rad|turn)?$/i;

function parseAngleToken(token: string): number | null {
  const match = ANGLE_PATTERN.exec(token.trim());
  if (!match) return null;
  const magnitude = Number.parseFloat(match[1]!);
  if (!Number.isFinite(magnitude)) return null;
  switch (match[2]?.toLowerCase()) {
    case "turn":
      return magnitude * 360;
    case "grad":
      return magnitude * 0.9;
    case "rad":
      return (magnitude * 180) / Math.PI;
    default:
      return magnitude;
  }
}

const GRADIENT_CALL = /^(repeating-)?(linear|radial|conic)-gradient\(([\s\S]*)\)$/i;

/** The `in <space>` clause CSS Color 4 allows in a gradient prelude. */
const INTERPOLATION_CLAUSE =
  /\bin\s+([a-z][\w-]*(?:\s+(?:shorter|longer|increasing|decreasing)\s+hue)?)/i;

function takeInterpolation(prelude: string): { rest: string; interpolation?: string } {
  const match = INTERPOLATION_CLAUSE.exec(prelude);
  if (!match) return { rest: prelude };
  return {
    rest: (prelude.slice(0, match.index) + prelude.slice(match.index + match[0].length)).trim(),
    interpolation: match[1]!.trim().replace(/\s+/g, " ").toLowerCase(),
  };
}

const LENGTH_TOKEN =
  /^[+-]?(?:\d+\.?\d*|\.\d+)(?:%|px|r?em|ch|ex|vw|vh|vmin|vmax|cm|mm|in|pt|pc|q|deg|grad|rad|turn)?$/i;

/**
 * Whether the first argument is a prelude rather than the first colour stop.
 *
 * The distinction matters because `linear-gradient(color-mix(in oklab, …), …)`
 * has an `in oklab` inside its *first stop*; keying off the head token's shape
 * rather than searching the whole argument keeps that from being mistaken for
 * an interpolation clause.
 */
function isPrelude(kind: GradientKind, head: string): boolean {
  const text = head.trim().toLowerCase();
  if (text === "") return false;
  if (/^in\s/.test(text)) return true;
  if (kind === "linear") {
    if (/^to\s/.test(text)) return true;
    const first = splitWords(text)[0] ?? "";
    return /(deg|grad|rad|turn)$/i.test(first) && parseAngleToken(first) !== null;
  }
  if (kind === "conic") return /^(from|at)\s/.test(text);
  if (/^(at\s|circle\b|ellipse\b|closest-|farthest-)/.test(text)) return true;
  // `radial-gradient(120px 80px, …)` — an explicit size with no keyword.
  const tokens = splitWords(text);
  return tokens.length <= 2 && tokens.every((token) => LENGTH_TOKEN.test(token));
}

function parsePositionToken(token: string, kind: GradientKind): number | null {
  const text = token.trim();
  if (text.endsWith("%")) {
    const percent = Number.parseFloat(text);
    return Number.isFinite(percent) ? percent / 100 : null;
  }
  if (kind === "conic") {
    const angle = parseAngleToken(text);
    if (angle !== null && /(deg|grad|rad|turn)$/i.test(text)) return angle / 360;
  }
  // A bare zero is unambiguous; any other length depends on the painted box,
  // so it falls through to even distribution rather than a fabricated ratio.
  return Number.parseFloat(text) === 0 ? 0 : null;
}

interface RawStop {
  color: string;
  position: number | null;
}

function parseStopList(args: string[], kind: GradientKind): GradientStop[] {
  const raw: RawStop[] = [];

  for (const arg of args) {
    const tokens = splitWords(arg);
    if (tokens.length === 0) continue;
    // A lone length is a colour hint (a midpoint), which this model does not
    // carry; dropping it is better than reading it as a colour.
    if (tokens.length === 1 && LENGTH_TOKEN.test(tokens[0]!)) continue;

    const positions: (number | null)[] = [];
    while (tokens.length > 1 && positions.length < 2 && LENGTH_TOKEN.test(tokens.at(-1)!)) {
      positions.unshift(parsePositionToken(tokens.pop()!, kind));
    }
    const color = tokens.join(" ");
    if (color === "") continue;
    // A colour is always a single token — `red`, `#fff`, `rgb(…)`, `var(--x)`
    // (the split is depth-aware, so a function stays whole). More than one means
    // the stop carried a position form this model cannot read, e.g.
    // `red calc(50% - 10px)`. Bailing keeps the caller from rewriting the offset
    // into the colour and emitting nonsense.
    if (tokens.length > 1) return [];
    if (positions.length === 0) raw.push({ color, position: null });
    // A double-position stop is shorthand for two stops of the same colour.
    else for (const position of positions) raw.push({ color, position });
  }

  if (raw.length === 0) return [];
  return raw.map((stop, index) => ({
    color: stop.color,
    position: stop.position ?? distributePosition(raw, index),
  }));
}

/** CSS spreads unpositioned stops evenly between their positioned neighbours. */
function distributePosition(stops: readonly RawStop[], index: number): number {
  if (index === 0) return 0;
  if (index === stops.length - 1) return 1;

  let beforeIndex = 0;
  let beforePosition = 0;
  for (let scan = index - 1; scan >= 0; scan -= 1) {
    const position = stops[scan]!.position;
    if (position !== null) {
      beforeIndex = scan;
      beforePosition = position;
      break;
    }
  }

  let afterIndex = stops.length - 1;
  let afterPosition = 1;
  for (let scan = index + 1; scan < stops.length; scan += 1) {
    const position = stops[scan]!.position;
    if (position !== null) {
      afterIndex = scan;
      afterPosition = position;
      break;
    }
  }

  const span = afterIndex - beforeIndex;
  if (span <= 0) return beforePosition;
  return beforePosition + ((afterPosition - beforePosition) / span) * (index - beforeIndex);
}

/** A gradient, or null when the value is not a gradient this model understands. */
export function parseGradient(css: string | number | undefined | null): Gradient | null {
  if (css === undefined || css === null) return null;
  const match = GRADIENT_CALL.exec(String(css).trim());
  if (!match) return null;

  const repeating = match[1] !== undefined;
  const kind = match[2]!.toLowerCase() as GradientKind;
  const args = splitCommas(match[3]!);
  if (args.length === 0) return null;

  const gradient: Gradient = { kind, repeating, angle: kind === "linear" ? 180 : 0, stops: [] };
  let stopArgs = args;

  if (isPrelude(kind, args[0]!)) {
    stopArgs = args.slice(1);
    const { rest, interpolation } = takeInterpolation(args[0]!);
    if (interpolation) gradient.interpolation = interpolation;
    const prelude = rest.trim();

    if (kind === "linear" && prelude !== "") {
      const normalized = prelude.toLowerCase().replace(/\s+/g, " ");
      gradient.angle = normalized.startsWith("to ")
        ? (SIDE_ANGLES[normalized] ?? 180)
        : (parseAngleToken(prelude) ?? 180);
    } else if (kind === "radial") {
      const atIndex = prelude.search(/\bat\s/i);
      const shape = (atIndex === -1 ? prelude : prelude.slice(0, atIndex)).trim();
      if (shape !== "") gradient.shape = shape;
      if (atIndex !== -1) {
        const center = prelude
          .slice(atIndex)
          .replace(/^at\s+/i, "")
          .trim();
        if (center !== "") gradient.center = center;
      }
    } else if (kind === "conic") {
      let remainder = prelude;
      const from = /\bfrom\s+(\S+)/i.exec(remainder);
      if (from) {
        gradient.angle = parseAngleToken(from[1]!) ?? 0;
        remainder = remainder.replace(from[0], " ");
      }
      const at = /\bat\s+([\s\S]+)$/i.exec(remainder.trim());
      if (at) gradient.center = at[1]!.trim().replace(/\s+/g, " ");
    }
  }

  gradient.stops = parseStopList(stopArgs, kind);
  // A gradient this model can edit has at least two stops. One means the stop
  // list was a form it cannot decompose — `linear-gradient(to right,
  // var(--tw-gradient-stops))`, where a single custom property stands in for the
  // whole list — and reformatting that would append a position to the `var()`
  // and emit invalid CSS. Returning null lets the caller preserve it verbatim.
  return gradient.stops.length < 2 ? null : gradient;
}

export function isGradientCss(css: string | number | undefined | null): boolean {
  return css !== undefined && css !== null && GRADIENT_CALL.test(String(css).trim());
}

/** Trim float noise without turning integers into `1.00`. */
function formatNumber(value: number): string {
  return String(Number(value.toFixed(2)));
}

function formatPrelude(gradient: Gradient): string {
  const interpolation = gradient.interpolation ? `in ${gradient.interpolation}` : "";
  if (gradient.kind === "linear") {
    return [interpolation, `${formatNumber(normalizeAngle(gradient.angle))}deg`]
      .filter(Boolean)
      .join(" ");
  }
  if (gradient.kind === "radial") {
    return [gradient.shape, gradient.center ? `at ${gradient.center}` : "", interpolation]
      .filter(Boolean)
      .join(" ");
  }
  const angle = normalizeAngle(gradient.angle);
  return [
    interpolation,
    angle === 0 ? "" : `from ${formatNumber(angle)}deg`,
    gradient.center ? `at ${gradient.center}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function normalizeAngle(angle: number): number {
  if (!Number.isFinite(angle)) return 0;
  return ((angle % 360) + 360) % 360;
}

export function formatGradient(gradient: Gradient): string {
  const name = `${gradient.repeating ? "repeating-" : ""}${gradient.kind}-gradient`;
  const stops = gradient.stops
    .map((stop) => `${stop.color} ${formatNumber(clamp01(stop.position) * 100)}%`)
    .join(", ");
  const prelude = formatPrelude(gradient);
  return `${name}(${prelude === "" ? "" : `${prelude}, `}${stops})`;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));

/** The default stop pair for a new gradient. */
export function createGradient(kind: GradientKind = "linear"): Gradient {
  return {
    kind,
    repeating: false,
    angle: kind === "linear" ? 180 : 0,
    interpolation: undefined,
    stops: [
      { color: "#dddddd", position: 0 },
      { color: "#a4a4a4", position: 1 },
    ],
  };
}

/**
 * Switch a gradient's kind while keeping the parts that still mean something.
 *
 * The angle is a gradient-line direction for `linear` and a rotation offset for
 * `conic`; radial has neither, so the geometry a kind cannot express is dropped
 * rather than carried as a value the panel would then show as authored.
 */
export function withGradientKind(gradient: Gradient, kind: GradientKind): Gradient {
  if (gradient.kind === kind) return gradient;
  return {
    ...gradient,
    kind,
    angle: kind === "radial" ? 0 : gradient.angle,
    shape: kind === "radial" ? gradient.shape : undefined,
    center: kind === "linear" ? undefined : gradient.center,
  };
}

/** Insert a stop, keeping the list sorted by position. */
export function insertGradientStop(gradient: Gradient, stop: GradientStop): Gradient {
  const stops = [...gradient.stops, stop].sort((a, b) => a.position - b.position);
  return { ...gradient, stops };
}

/**
 * The colour the ramp shows at a position, so inserting a stop by clicking the
 * bar does not visibly change the gradient. Falls back to the neighbouring
 * stop's authored text when either side is not a statically known colour.
 */
export function sampleGradientColor(gradient: Gradient, position: number): string {
  const stops = [...gradient.stops].sort((a, b) => a.position - b.position);
  if (stops.length === 0) return "#000000";

  const target = clamp01(position);
  const afterIndex = stops.findIndex((stop) => stop.position >= target);
  if (afterIndex === -1) return stops.at(-1)!.color;
  if (afterIndex === 0) return stops[0]!.color;

  const before = stops[afterIndex - 1]!;
  const after = stops[afterIndex]!;
  const span = after.position - before.position;
  const ratio = span <= 0 ? 0 : (target - before.position) / span;

  const from = parseColor(before.color);
  const to = parseColor(after.color);
  if (!from || !to) return before.color;
  return formatColor({
    r: from.r + (to.r - from.r) * ratio,
    g: from.g + (to.g - from.g) * ratio,
    b: from.b + (to.b - from.b) * ratio,
    a: from.a + (to.a - from.a) * ratio,
  });
}
