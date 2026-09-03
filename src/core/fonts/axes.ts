/**
 * Variable-font axis metadata for Google Fonts requests.
 *
 * Google's CSS APIs only ship a variable font when the request names every
 * axis it should leave open. Ask for `Source Serif 4` without naming `opsz`
 * and Google returns a static instance frozen at the family's default optical
 * size (14), which renders ~17% wider than the same text at `opsz 60`. The
 * fix is to build `css2` URLs from real axis metadata.
 *
 * Metadata comes from the generated Google Fonts catalog asset when it has
 * loaded (1900+ families, the local cache of the Google Fonts developer API).
 * Font loading starts before the picker ever mounts, so the families where a
 * pinned axis visibly distorts layout — everything with an `opsz` axis — are
 * also embedded here as a synchronous fallback.
 */
import {
  ensureGoogleFontCatalogLoaded,
  getFontCatalogEntry,
  isGoogleFontCatalogReady,
} from "./catalog";

export interface FontVariableAxis {
  tag: string;
  min: number;
  max: number;
}

export interface FontVariationMetadata {
  axes: FontVariableAxis[];
  /** Whether the family ships italic faces, which css2 expresses as `ital`. */
  hasItalic: boolean;
}

type EmbeddedEntry = {
  axes: [tag: string, min: number, max: number][];
  italic: boolean;
};

/**
 * Every Google family with an `opsz` axis, generated from the same metadata
 * the catalog asset carries. These are the families whose metrics are wrong
 * — not merely less adjustable — when the axis is left unnamed.
 */
const EMBEDDED_VARIABLE_FONT_AXES: Record<string, EmbeddedEntry> = {
  Ballet: { axes: [["opsz", 16, 72]], italic: false },
  "Big Shoulders": {
    axes: [
      ["wght", 100, 900],
      ["opsz", 10, 72],
    ],
    italic: false,
  },
  "Big Shoulders Inline": {
    axes: [
      ["wght", 100, 900],
      ["opsz", 10, 72],
    ],
    italic: false,
  },
  "Big Shoulders Stencil": {
    axes: [
      ["wght", 100, 900],
      ["opsz", 10, 72],
    ],
    italic: false,
  },
  "Bodoni Moda": {
    axes: [
      ["wght", 400, 900],
      ["opsz", 6, 96],
    ],
    italic: true,
  },
  "Bodoni Moda SC": {
    axes: [
      ["wght", 400, 900],
      ["opsz", 6, 96],
    ],
    italic: true,
  },
  "Bricolage Grotesque": {
    axes: [
      ["wght", 200, 800],
      ["wdth", 75, 100],
      ["opsz", 12, 96],
    ],
    italic: false,
  },
  "DM Sans": {
    axes: [
      ["wght", 100, 1000],
      ["opsz", 9, 40],
    ],
    italic: true,
  },
  Fraunces: {
    axes: [
      ["wght", 100, 900],
      ["SOFT", 0, 100],
      ["WONK", 0, 1],
      ["opsz", 9, 144],
    ],
    italic: true,
  },
  "Google Sans Flex": {
    axes: [
      ["wght", 1, 1000],
      ["wdth", 25, 151],
      ["slnt", -10, 0],
      ["GRAD", 0, 100],
      ["ROND", 0, 100],
      ["opsz", 6, 144],
    ],
    italic: false,
  },
  "Hedvig Letters Serif": { axes: [["opsz", 12, 24]], italic: false },
  Imbue: {
    axes: [
      ["wght", 100, 900],
      ["opsz", 10, 100],
    ],
    italic: false,
  },
  Inter: {
    axes: [
      ["wght", 100, 900],
      ["opsz", 14, 32],
    ],
    italic: true,
  },
  Jaro: { axes: [["opsz", 6, 72]], italic: false },
  Literata: {
    axes: [
      ["wght", 200, 900],
      ["opsz", 7, 72],
    ],
    italic: true,
  },
  "Material Symbols": {
    axes: [
      ["wght", 100, 700],
      ["FILL", 0, 1],
      ["GRAD", -50, 200],
      ["ROND", 0, 100],
      ["opsz", 20, 48],
    ],
    italic: false,
  },
  "Material Symbols Outlined": {
    axes: [
      ["wght", 100, 700],
      ["FILL", 0, 1],
      ["GRAD", -50, 200],
      ["opsz", 20, 48],
    ],
    italic: false,
  },
  "Material Symbols Rounded": {
    axes: [
      ["wght", 100, 700],
      ["FILL", 0, 1],
      ["GRAD", -50, 200],
      ["opsz", 20, 48],
    ],
    italic: false,
  },
  "Material Symbols Sharp": {
    axes: [
      ["wght", 100, 700],
      ["FILL", 0, 1],
      ["GRAD", -50, 200],
      ["opsz", 20, 48],
    ],
    italic: false,
  },
  Merriweather: {
    axes: [
      ["wght", 300, 900],
      ["wdth", 87, 112],
      ["opsz", 18, 144],
    ],
    italic: true,
  },
  "Montagu Slab": {
    axes: [
      ["wght", 100, 700],
      ["opsz", 16, 144],
    ],
    italic: false,
  },
  Newsreader: {
    axes: [
      ["wght", 200, 800],
      ["opsz", 6, 72],
    ],
    italic: true,
  },
  "Nunito Sans": {
    axes: [
      ["wght", 200, 1000],
      ["wdth", 75, 125],
      ["YTLC", 440, 540],
      ["opsz", 6, 12],
    ],
    italic: true,
  },
  "Pathway Extreme": {
    axes: [
      ["wght", 100, 900],
      ["wdth", 75, 100],
      ["opsz", 8, 144],
    ],
    italic: true,
  },
  Piazzolla: {
    axes: [
      ["wght", 100, 900],
      ["opsz", 8, 30],
    ],
    italic: true,
  },
  Playfair: {
    axes: [
      ["wght", 300, 900],
      ["wdth", 87.5, 112.5],
      ["opsz", 5, 1200],
    ],
    italic: true,
  },
  "Roboto Flex": {
    axes: [
      ["wght", 100, 1000],
      ["wdth", 25, 151],
      ["slnt", -10, 0],
      ["GRAD", -200, 150],
      ["XOPQ", 27, 175],
      ["XTRA", 323, 603],
      ["YOPQ", 25, 135],
      ["YTAS", 649, 854],
      ["YTDE", -305, -98],
      ["YTFI", 560, 788],
      ["YTLC", 416, 570],
      ["YTUC", 528, 760],
      ["opsz", 8, 144],
    ],
    italic: false,
  },
  "Roboto Serif": {
    axes: [
      ["wght", 100, 900],
      ["wdth", 50, 150],
      ["GRAD", -50, 100],
      ["opsz", 8, 144],
    ],
    italic: true,
  },
  "Source Serif 4": {
    axes: [
      ["wght", 200, 900],
      ["opsz", 8, 60],
    ],
    italic: true,
  },
  Texturina: {
    axes: [
      ["wght", 100, 900],
      ["opsz", 12, 72],
    ],
    italic: true,
  },
  "TikTok Sans": {
    axes: [
      ["wght", 300, 900],
      ["wdth", 75, 150],
      ["slnt", -6, 0],
      ["opsz", 12, 36],
    ],
    italic: false,
  },
  Truculenta: {
    axes: [
      ["wght", 100, 900],
      ["wdth", 75, 125],
      ["opsz", 12, 72],
    ],
    italic: false,
  },
};

const embeddedByLowercaseFamily = new Map(
  Object.entries(EMBEDDED_VARIABLE_FONT_AXES).map(([family, entry]) => [
    family.toLowerCase(),
    entry,
  ]),
);

function isCustomAxisTag(tag: string): boolean {
  return tag.toUpperCase() === tag;
}

/**
 * Google rejects a css2 request whose axis tags are out of order: registered
 * lowercase axes first, then custom uppercase axes, each group alphabetical.
 */
export function sortFontAxisTags(tags: readonly string[]): string[] {
  return [...tags].sort((a, b) => {
    if (isCustomAxisTag(a) !== isCustomAxisTag(b)) return isCustomAxisTag(a) ? 1 : -1;
    return a.toLowerCase().localeCompare(b.toLowerCase());
  });
}

function normalizeAxes(axes: readonly { tag: string; min: number; max: number }[]): {
  tag: string;
  min: number;
  max: number;
}[] {
  const byTag = new Map<string, FontVariableAxis>();

  for (const axis of axes) {
    // `ital` is not a range in css2 — it is the `0,`/`1,` tuple prefix.
    if (typeof axis?.tag !== "string" || !axis.tag || axis.tag === "ital") continue;
    if (!Number.isFinite(axis.min) || !Number.isFinite(axis.max)) continue;
    byTag.set(axis.tag, { tag: axis.tag, min: axis.min, max: axis.max });
  }

  const sorted = sortFontAxisTags([...byTag.keys()]);
  return sorted.map((tag) => byTag.get(tag)!);
}

function hasItalicVariant(variants: readonly string[] | undefined): boolean {
  return Array.isArray(variants) && variants.some((variant) => variant?.endsWith?.("i") === true);
}

let catalogUnreachable = false;

/**
 * Best-effort catalog warm-up before axis resolution. The embedded table
 * covers the families that matter when the asset is unreachable, so a failed
 * load must not stop a font from loading at all.
 */
export async function ensureFontAxisMetadataLoaded(): Promise<void> {
  if (catalogUnreachable || isGoogleFontCatalogReady()) return;

  try {
    await ensureGoogleFontCatalogLoaded();
  } catch {
    // The catalog retries on the next call after a failure, and font loading
    // asks for it once per family. Where the generated asset is not served at
    // all — desktop builds, offline sessions — that would put two doomed
    // requests in front of every font. Give up after the first miss and let
    // the embedded table, which covers every family whose metrics depend on an
    // open axis, answer for the rest of the session.
    catalogUnreachable = true;
  }
}

export function resetFontAxisMetadataStateForTests(): void {
  catalogUnreachable = false;
}

/**
 * Resolve the variable axes of a family, or `null` when the family is static
 * or unknown. A `null` result means callers must keep requesting named
 * weights instead of axis ranges — Google 400s on a range request for a
 * family that has no variable font.
 */
export function resolveFontVariationMetadata(family: string): FontVariationMetadata | null {
  if (isGoogleFontCatalogReady()) {
    const entry = getFontCatalogEntry(family);
    const axes = entry ? normalizeAxes(entry.axes) : [];
    // A catalog entry that yields no usable axis is treated like a missing one
    // so a truncated or re-generated asset cannot silently un-vary a family the
    // embedded table still knows about. Families the embedded table never had
    // fall through to `null` either way, which is the static-font answer.
    if (axes.length > 0) return { axes, hasItalic: hasItalicVariant(entry?.variants) };
  }

  const embedded = embeddedByLowercaseFamily.get(family.trim().toLowerCase());
  if (!embedded) return null;

  return {
    axes: normalizeAxes(embedded.axes.map(([tag, min, max]) => ({ tag, min, max }))),
    hasItalic: embedded.italic,
  };
}

function formatAxisRange(axis: FontVariableAxis): string {
  return `${axis.min}..${axis.max}`;
}

/**
 * Build the css2 axis specifier, e.g. `ital,opsz,wght@0,8..60,200..900;1,8..60,200..900`.
 * Returns `null` when there is nothing variable to ask for.
 */
export function buildFontAxisSpec(metadata: FontVariationMetadata | null): string | null {
  if (!metadata || metadata.axes.length === 0) return null;

  const tags = metadata.axes.map((axis) => axis.tag).join(",");
  const ranges = metadata.axes.map(formatAxisRange).join(",");

  return metadata.hasItalic ? `ital,${tags}@0,${ranges};1,${ranges}` : `${tags}@${ranges}`;
}
