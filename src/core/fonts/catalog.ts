/**
 * Google font preview data is generated offline and served as static assets.
 * This keeps a rich preview experience without treating large generated
 * datasets as handwritten app source.
 */
const FONT_METADATA_URL = "/font-data/v1/google-fonts-metadata.json";
const FONT_PREVIEW_DATA_URL = "/font-data/v1/google-font-previews.json";

type RawFontAxis = {
  tag: string;
  min: number;
  max: number;
  defaultValue: number;
};

export type RawFontMetadata = {
  variants: string[];
  axes?: RawFontAxis[];
};

type RawPreviewEntry = {
  x: number;
  y: number;
  w: number;
  ch: number;
  noPreview?: boolean;
};

export type RawPreviewData = {
  fonts: Record<string, RawPreviewEntry>;
};

type PreviewChunkDimensions = {
  width: number;
  height: number;
};

export interface FontAxis {
  tag: string;
  min: number;
  max: number;
  defaultValue: number;
}

export interface FontCatalogEntry {
  family: string;
  variants: string[];
  axes: FontAxis[];
  previewText: string;
  searchText: string;
  previewChunk: number | null;
  previewOffsetX: number;
  previewOffsetY: number;
  previewWidth: number;
  hasPreview: boolean;
}

type FontCatalogState = {
  entries: FontCatalogEntry[];
  byFamily: Map<string, FontCatalogEntry>;
  previewChunkDimensions: Map<number, PreviewChunkDimensions>;
};

let catalogState: FontCatalogState | null = null;
let catalogLoad: Promise<FontCatalogState> | null = null;

export const FONT_PREVIEW_SOURCE_ROW_HEIGHT = 32;
export const FONT_PREVIEW_DISPLAY_ROW_HEIGHT = 16;

function buildFontCatalogState(
  metadata: Record<string, RawFontMetadata>,
  previewData: RawPreviewData,
): FontCatalogState {
  const previewChunkDimensions = new Map<number, PreviewChunkDimensions>();

  for (const preview of Object.values(previewData.fonts)) {
    if (preview.noPreview || typeof preview.ch !== "number") continue;
    const current = previewChunkDimensions.get(preview.ch) ?? { width: 0, height: 0 };
    current.width = Math.max(current.width, preview.x + preview.w);
    current.height = Math.max(current.height, preview.y + FONT_PREVIEW_SOURCE_ROW_HEIGHT);
    previewChunkDimensions.set(preview.ch, current);
  }

  const entries = Object.entries(metadata)
    .map(([family, entry]) => {
      const preview = previewData.fonts[family];
      return {
        family,
        variants: entry.variants,
        axes: entry.axes ?? [],
        previewText: family,
        searchText: family.toLowerCase(),
        previewChunk: preview && !preview.noPreview ? preview.ch : null,
        previewOffsetX: preview?.x ?? 0,
        previewOffsetY: preview?.y ?? 0,
        previewWidth: preview?.w ?? 0,
        hasPreview: Boolean(preview && !preview.noPreview && preview.w > 0),
      };
    })
    .sort((a, b) => a.family.localeCompare(b.family));

  return {
    entries,
    byFamily: new Map(entries.map((entry) => [entry.family.toLowerCase(), entry])),
    previewChunkDimensions,
  };
}

async function fetchCatalogJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load generated font catalog asset: ${url}`);
  }
  return (await response.json()) as T;
}

export async function ensureGoogleFontCatalogLoaded(): Promise<void> {
  if (catalogState) return;

  if (!catalogLoad) {
    catalogLoad = Promise.all([
      fetchCatalogJson<Record<string, RawFontMetadata>>(FONT_METADATA_URL),
      fetchCatalogJson<RawPreviewData>(FONT_PREVIEW_DATA_URL),
    ])
      .then(([metadata, previewData]) => {
        const nextState = buildFontCatalogState(metadata, previewData);
        catalogState = nextState;
        return nextState;
      })
      .catch((error) => {
        catalogLoad = null;
        throw error;
      });
  }

  await catalogLoad;
}

export function isGoogleFontCatalogReady(): boolean {
  return catalogState !== null;
}

export function setGoogleFontCatalogForTests(
  metadata: Record<string, RawFontMetadata>,
  previewData: RawPreviewData,
): void {
  catalogState = buildFontCatalogState(metadata, previewData);
  catalogLoad = Promise.resolve(catalogState);
}

export function resetGoogleFontCatalogForTests(): void {
  catalogState = null;
  catalogLoad = null;
}

export function getGoogleFontCatalog(): FontCatalogEntry[] {
  return catalogState?.entries ?? [];
}

export function normalizeFontFamilyValue(value: string): string {
  return (
    value
      .split(",")[0]
      ?.trim()
      .replace(/^['"]|['"]$/g, "") || ""
  );
}

export function replacePrimaryFontFamily(fontFamilyValue: string, family: string): string {
  const fallbackFamilies = fontFamilyValue
    .split(",")
    .slice(1)
    .map((entry) => entry.trim())
    .filter(Boolean);

  return fallbackFamilies.length > 0 ? `${family}, ${fallbackFamilies.join(", ")}` : family;
}

export function getFontPreviewStack(family: string): string {
  return `"${family}", Inter, system-ui, sans-serif`;
}

export function getFontPreviewChunkUrl(chunk: number): string {
  return `/font-chunks/v1/font-chunk-${chunk}.avif`;
}

export function getFontPreviewChunkDimensions(chunk: number): PreviewChunkDimensions {
  return catalogState?.previewChunkDimensions.get(chunk) ?? { width: 0, height: 0 };
}

function compareSearchRank(query: string, family: string): number {
  const haystack = family.toLowerCase();
  if (haystack === query) return 0;
  if (haystack.startsWith(query)) return 1;
  if (haystack.split(/\s+/).some((part) => part.startsWith(query))) return 2;
  if (haystack.includes(query)) return 3;
  return 4;
}

export function getFontCatalogEntry(familyValue: string): FontCatalogEntry | undefined {
  const family = normalizeFontFamilyValue(familyValue).toLowerCase();
  return catalogState?.byFamily.get(family);
}

export function searchGoogleFontCatalog(
  query: string,
  limit = Number.POSITIVE_INFINITY,
  preferredFamily?: string,
): FontCatalogEntry[] {
  const entries = catalogState?.entries ?? [];
  const trimmedQuery = query.trim().toLowerCase();
  const preferred = preferredFamily?.toLowerCase();

  const matches = trimmedQuery
    ? entries
        .filter((entry) => entry.searchText.includes(trimmedQuery))
        .sort((a, b) => {
          const rankDiff =
            compareSearchRank(trimmedQuery, a.family) - compareSearchRank(trimmedQuery, b.family);
          if (rankDiff !== 0) return rankDiff;
          return a.family.localeCompare(b.family);
        })
    : entries;

  const results =
    trimmedQuery && preferred
      ? [...matches].sort((a, b) => {
          if (a.family.toLowerCase() === preferred) return -1;
          if (b.family.toLowerCase() === preferred) return 1;
          return 0;
        })
      : matches;

  return results.slice(0, limit);
}
