/**
 * Colour parsing and formatting for the inspector.
 *
 * The panel has to round-trip whatever an agent wrote via `write_html`, so this
 * parses the CSS colour forms that actually show up in imported markup rather
 * than only the 6-digit hex an `<input type="color">` can represent. Anything
 * it cannot parse is preserved verbatim instead of being coerced.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0–1. */
  a: number;
}

const NAMED_COLORS: Record<string, string> = {
  transparent: "#00000000",
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  yellow: "#ffff00",
  orange: "#ffa500",
  purple: "#800080",
  gray: "#808080",
  grey: "#808080",
  silver: "#c0c0c0",
  maroon: "#800000",
  olive: "#808000",
  lime: "#00ff00",
  aqua: "#00ffff",
  cyan: "#00ffff",
  teal: "#008080",
  navy: "#000080",
  fuchsia: "#ff00ff",
  magenta: "#ff00ff",
  pink: "#ffc0cb",
  brown: "#a52a2a",
  beige: "#f5f5dc",
  ivory: "#fffff0",
  gold: "#ffd700",
  indigo: "#4b0082",
  violet: "#ee82ee",
  tan: "#d2b48c",
  crimson: "#dc143c",
  salmon: "#fa8072",
  khaki: "#f0e68c",
  turquoise: "#40e0d0",
  lavender: "#e6e6fa",
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const clamp255 = (value: number) => clamp(Math.round(value), 0, 255);

function expandShortHex(hex: string): string {
  return hex
    .split("")
    .map((char) => char + char)
    .join("");
}

/** Parse a CSS colour to RGBA, or null when the form is not statically known. */
export function parseColor(input: string | number | undefined | null): Rgba | null {
  if (input === undefined || input === null) return null;
  const value = String(input).trim().toLowerCase();
  if (value === "") return null;

  const named = NAMED_COLORS[value];
  if (named) return parseColor(named);

  if (value.startsWith("#")) {
    let hex = value.slice(1);
    if (hex.length === 3 || hex.length === 4) hex = expandShortHex(hex);
    if (hex.length !== 6 && hex.length !== 8) return null;
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    return {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16),
      a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
    };
  }

  const functional = /^(rgba?|hsla?)\(([^)]+)\)$/.exec(value);
  if (!functional) return null;

  // Both comma and space syntax are legal and both appear in imported markup.
  const parts = functional[2]!
    .replace(/\//g, " ")
    .split(/[\s,]+/)
    .filter(Boolean);
  if (parts.length < 3) return null;

  const alpha = parts.length >= 4 ? parseAlpha(parts[3]!) : 1;
  if (alpha === null) return null;

  if (functional[1]!.startsWith("rgb")) {
    const channels = parts.slice(0, 3).map((part) => parseChannel(part));
    if (channels.some((channel) => channel === null)) return null;
    return {
      r: clamp255(channels[0]!),
      g: clamp255(channels[1]!),
      b: clamp255(channels[2]!),
      a: alpha,
    };
  }

  const hue = Number.parseFloat(parts[0]!);
  const saturation = Number.parseFloat(parts[1]!) / 100;
  const lightness = Number.parseFloat(parts[2]!) / 100;
  if (![hue, saturation, lightness].every(Number.isFinite)) return null;
  return { ...hslToRgb(hue, saturation, lightness), a: alpha };
}

function parseChannel(part: string): number | null {
  const numeric = Number.parseFloat(part);
  if (!Number.isFinite(numeric)) return null;
  return part.endsWith("%") ? (numeric / 100) * 255 : numeric;
}

function parseAlpha(part: string): number | null {
  const numeric = Number.parseFloat(part);
  if (!Number.isFinite(numeric)) return null;
  return clamp(part.endsWith("%") ? numeric / 100 : numeric, 0, 1);
}

export function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const hue = ((h % 360) + 360) % 360;
  const chroma = (1 - Math.abs(2 * l - 1)) * clamp(s, 0, 1);
  const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = l - chroma / 2;
  const [r, g, b] =
    hue < 60
      ? [chroma, second, 0]
      : hue < 120
        ? [second, chroma, 0]
        : hue < 180
          ? [0, chroma, second]
          : hue < 240
            ? [0, second, chroma]
            : hue < 300
              ? [second, 0, chroma]
              : [chroma, 0, second];
  return {
    r: clamp255((r + match) * 255),
    g: clamp255((g + match) * 255),
    b: clamp255((b + match) * 255),
  };
}

const toHexPair = (value: number) => clamp255(value).toString(16).padStart(2, "0");

/** 6-digit hex, for the native colour input which cannot represent alpha. */
export function toHex6(color: Rgba): string {
  return `#${toHexPair(color.r)}${toHexPair(color.g)}${toHexPair(color.b)}`;
}

/**
 * Format back to CSS, preferring the shortest lossless form. Opaque colours
 * stay hex so a round trip through the panel does not rewrite every
 * `#ffffff` in a document into `rgba(255, 255, 255, 1)`.
 */
export function formatColor(color: Rgba): string {
  if (color.a >= 1) return toHex6(color);
  if (color.a <= 0) return "transparent";
  const alpha = Number(color.a.toFixed(3));
  return `rgba(${clamp255(color.r)}, ${clamp255(color.g)}, ${clamp255(color.b)}, ${alpha})`;
}

/**
 * Replace only the alpha of an existing colour, keeping its authored form when
 * the change is a no-op so the document is not churned needlessly.
 */
export function withAlpha(input: string | number | undefined | null, alpha: number): string {
  const parsed = parseColor(input);
  if (!parsed) return String(input ?? "");
  return formatColor({ ...parsed, a: clamp(alpha, 0, 1) });
}

/** Alpha of a colour, defaulting to fully opaque for unparseable input. */
export function alphaOf(input: string | number | undefined | null): number {
  return parseColor(input)?.a ?? 1;
}
