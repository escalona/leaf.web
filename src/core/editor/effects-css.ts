/**
 * Shadow and filter CSS as the source of truth for the effects panel.
 *
 * Leaf stores `boxShadow` / `filter` / `backdropFilter` as flat CSS strings, so
 * a stack editor has to parse what is already there rather than read a sidecar
 * it maintains itself. That is deliberate: an agent writes these through
 * `write_html` or `update_styles` and the panel must be able to edit the result
 * entry by entry, which a private sidecar could never do.
 *
 * The one thing a flat string cannot express is a *hidden* entry, so hidden
 * entries are parked on a `--leaf-hidden-*` custom property alongside the real
 * declaration, carrying the position they should return to. Parking rather than
 * adding a persisted field keeps this off both compatibility surfaces
 * (`PersistedEditorDocument` and `LeafRecordSnapshot`).
 */

export interface ShadowEntry {
  inset: boolean;
  /** Lengths stay as authored text so `2rem` or `calc(...)` survives a round trip. */
  offsetX: string;
  offsetY: string;
  blur: string;
  spread: string;
  /** Empty means the shadow inherits `currentColor`. */
  color: string;
}

export type FilterFunctionName =
  | "blur"
  | "brightness"
  | "contrast"
  | "grayscale"
  | "hue-rotate"
  | "invert"
  | "opacity"
  | "saturate"
  | "sepia"
  | "drop-shadow";

export interface FilterEntry {
  type: FilterFunctionName;
  /** The raw argument text, e.g. `4px`, `150%`, `0 2px 4px rgba(0,0,0,.2)`. */
  value: string;
}

export interface FilterFunctionSpec {
  label: string;
  defaultValue: string;
  unit: string;
  min?: number;
  max?: number;
  step?: number;
}

/**
 * Filter function metadata, including `opacity` and `drop-shadow`, which CSS
 * supports alongside the classic image filters.
 */
export const FILTER_FUNCTIONS: Record<FilterFunctionName, FilterFunctionSpec> = {
  blur: { label: "Blur", defaultValue: "4px", unit: "px", min: 0 },
  brightness: { label: "Brightness", defaultValue: "150%", unit: "%", min: 0, step: 10 },
  contrast: { label: "Contrast", defaultValue: "150%", unit: "%", min: 0, step: 10 },
  grayscale: { label: "Grayscale", defaultValue: "100%", unit: "%", min: 0, max: 100, step: 10 },
  "hue-rotate": { label: "Hue rotate", defaultValue: "90deg", unit: "deg", step: 15 },
  invert: { label: "Invert", defaultValue: "100%", unit: "%", min: 0, max: 100, step: 10 },
  opacity: { label: "Opacity", defaultValue: "50%", unit: "%", min: 0, max: 100, step: 10 },
  saturate: { label: "Saturation", defaultValue: "150%", unit: "%", min: 0, step: 10 },
  sepia: { label: "Sepia", defaultValue: "100%", unit: "%", min: 0, max: 100, step: 10 },
  "drop-shadow": { label: "Drop shadow", defaultValue: "0px 2px 4px rgba(0, 0, 0, 0.2)", unit: "" },
};

/** The new-shadow default. */
export function createShadowEntry(inset = false): ShadowEntry {
  return {
    inset,
    offsetX: "0px",
    offsetY: "2px",
    blur: "3px",
    spread: "0px",
    color: "rgba(0, 0, 0, 0.2)",
  };
}

export function createFilterEntry(type: FilterFunctionName): FilterEntry {
  return { type, value: FILTER_FUNCTIONS[type].defaultValue };
}

/**
 * Split on separators that are not nested inside parentheses or a string.
 *
 * Splitting a shadow list on bare commas tears `rgba(0, 0, 0, .2)` into four
 * pieces, which is the classic way this kind of parser goes wrong.
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

function normalizeCssList(css: string | number | undefined | null): string {
  if (css === undefined || css === null) return "";
  const text = String(css).trim();
  return text === "" || text.toLowerCase() === "none" ? "" : text;
}

const LENGTH_PATTERN =
  /^[+-]?(\d+\.?\d*|\.\d+)(px|rem|em|%|ch|ex|vw|vh|vmin|vmax|cm|mm|in|pt|pc|q)?$/i;

function isLengthToken(token: string): boolean {
  return LENGTH_PATTERN.test(token) || /^calc\(/i.test(token);
}

/** True when a length is zero regardless of unit, so it can be omitted. */
function isZeroLength(value: string): boolean {
  return Number.parseFloat(value) === 0;
}

/**
 * One shadow, or null when the value is not statically understood.
 *
 * Returning null rather than a best guess is what lets the panel fall back to a
 * raw text field instead of rewriting a `var()`-driven shadow into something
 * the author never wrote.
 */
export function parseShadowEntry(source: string): ShadowEntry | null {
  const tokens = splitWords(source);
  if (tokens.length === 0) return null;

  let inset = false;
  let color = "";
  const lengths: string[] = [];

  for (const token of tokens) {
    if (token.toLowerCase() === "inset") {
      if (inset) return null;
      inset = true;
      continue;
    }
    if (isLengthToken(token)) {
      lengths.push(token);
      continue;
    }
    if (color !== "") return null;
    color = token;
  }

  if (lengths.length < 2 || lengths.length > 4) return null;
  return {
    inset,
    offsetX: lengths[0]!,
    offsetY: lengths[1]!,
    blur: lengths[2] ?? "0px",
    spread: lengths[3] ?? "0px",
    color,
  };
}

/** Every shadow in a `box-shadow` / `text-shadow` list, skipping unparseable ones. */
export function parseBoxShadow(css: string | number | undefined | null): ShadowEntry[] {
  const text = normalizeCssList(css);
  if (text === "") return [];
  const entries: ShadowEntry[] = [];
  for (const part of splitCommas(text)) {
    const entry = parseShadowEntry(part);
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * Whether every shadow in the list round-trips. The panel only offers the stack
 * editor when this holds; otherwise editing would silently drop an entry.
 */
export function isShadowListParseable(css: string | number | undefined | null): boolean {
  const text = normalizeCssList(css);
  if (text === "") return true;
  return splitCommas(text).every((part) => parseShadowEntry(part) !== null);
}

export interface ShadowFormatOptions {
  /** `text-shadow` has no spread, so the length is dropped rather than emitted as `0`. */
  spread?: boolean;
  /** `text-shadow` and `drop-shadow()` have no inset keyword. */
  inset?: boolean;
}

export function formatShadowEntry(entry: ShadowEntry, options: ShadowFormatOptions = {}): string {
  const allowSpread = options.spread !== false;
  const allowInset = options.inset !== false;
  const parts: string[] = [];
  if (entry.inset && allowInset) parts.push("inset");
  parts.push(entry.offsetX, entry.offsetY, entry.blur);
  if (allowSpread && !isZeroLength(entry.spread)) parts.push(entry.spread);
  if (entry.color !== "") parts.push(entry.color);
  return parts.join(" ");
}

export function formatBoxShadow(
  entries: readonly ShadowEntry[],
  options: ShadowFormatOptions = {},
): string {
  return entries.map((entry) => formatShadowEntry(entry, options)).join(", ");
}

function isFilterFunctionName(name: string): name is FilterFunctionName {
  return Object.hasOwn(FILTER_FUNCTIONS, name);
}

const FILTER_CALL_PATTERN = /^([a-z-]+)\(([\s\S]*)\)$/i;

/** Every function in a `filter` / `backdrop-filter` list, skipping unknown ones. */
export function parseFilter(css: string | number | undefined | null): FilterEntry[] {
  const text = normalizeCssList(css);
  if (text === "") return [];
  const entries: FilterEntry[] = [];
  for (const token of splitWords(text)) {
    const match = FILTER_CALL_PATTERN.exec(token);
    if (!match) continue;
    const name = match[1]!.toLowerCase();
    if (!isFilterFunctionName(name)) continue;
    entries.push({ type: name, value: match[2]!.trim() });
  }
  return entries;
}

/** False when the list holds `url(#id)` or any function the panel cannot render. */
export function isFilterListParseable(css: string | number | undefined | null): boolean {
  const text = normalizeCssList(css);
  if (text === "") return true;
  return splitWords(text).every((token) => {
    const match = FILTER_CALL_PATTERN.exec(token);
    return match !== null && isFilterFunctionName(match[1]!.toLowerCase());
  });
}

export function formatFilter(entries: readonly FilterEntry[]): string {
  return entries.map((entry) => `${entry.type}(${entry.value})`).join(" ");
}

// --- Hidden entries ---------------------------------------------------------

export interface StackItem<T> {
  value: T;
  visible: boolean;
}

export interface ParkedItem<T> {
  /** Position in the merged list this entry returns to when shown again. */
  index: number;
  value: T;
}

/** The custom property that holds the hidden entries for a style key. */
export function hiddenStyleKey(styleKey: string): string {
  const kebab = styleKey.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
  return `--leaf-hidden-${kebab}`;
}

/**
 * Parked entries are `index / css` pairs. The slash keeps the index
 * unambiguous against a leading offset, and the top-level split leaves slashes
 * inside `rgb(0 0 0 / 20%)` alone.
 */
export function parseParkedEntries(css: string | number | undefined | null): ParkedItem<string>[] {
  const text = normalizeCssList(css);
  if (text === "") return [];
  const items: ParkedItem<string>[] = [];
  for (const part of splitCommas(text)) {
    const [head, ...rest] = splitTopLevel(part, "/");
    if (rest.length === 0) continue;
    const index = Number.parseInt(head!.trim(), 10);
    const source = rest.join("/").trim();
    if (!Number.isInteger(index) || index < 0 || source === "") continue;
    items.push({ index, value: source });
  }
  return items;
}

export function formatParkedEntries(items: readonly ParkedItem<string>[]): string {
  return items.map((item) => `${item.index} / ${item.value}`).join(", ");
}

/** Splice hidden entries back into the visible list at their recorded positions. */
export function mergeParked<T>(
  visible: readonly T[],
  parked: readonly ParkedItem<T>[],
): StackItem<T>[] {
  const items: StackItem<T>[] = visible.map((value) => ({ value, visible: true }));
  for (const item of [...parked].sort((a, b) => a.index - b.index)) {
    const index = Math.min(Math.max(item.index, 0), items.length);
    items.splice(index, 0, { value: item.value, visible: false });
  }
  return items;
}

export function splitParked<T>(items: readonly StackItem<T>[]): {
  visible: T[];
  parked: ParkedItem<T>[];
} {
  const visible: T[] = [];
  const parked: ParkedItem<T>[] = [];
  items.forEach((item, index) => {
    if (item.visible) visible.push(item.value);
    else parked.push({ index, value: item.value });
  });
  return { visible, parked };
}

/** Move an entry within a stack, returning a new array. */
export function moveStackItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= items.length) return [...items];
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(Math.min(Math.max(to, 0), next.length), 0, moved!);
  return next;
}
