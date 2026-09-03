/**
 * Dynamic Google Fonts loader.
 *
 * When a font family is referenced in a design node, this module checks
 * whether it's already available in the browser and, if not, attempts to
 * load it from Google Fonts by injecting an inline <style> with the
 * @font-face rules.
 *
 * We inject inline <style> (not <link> tags) so screenshot contexts can
 * use the CSS text directly without re-fetching font CSS from Google.
 */
import {
  buildFontAxisSpec,
  ensureFontAxisMetadataLoaded,
  resolveFontVariationMetadata,
} from "./axes";

// ─── Internal state ──────────────────────────────────────────────

/** Font families we've successfully loaded via Google Fonts */
const loadedFonts = new Set<string>();

/**
 * Font families whose last load attempt failed, with when it failed. A failure
 * is not permanent: a family is retried once the cooldown has passed, when the
 * browser reports it is back online, or when a caller explicitly asks. A
 * family that is genuinely absent from Google Fonts simply fails again.
 */
const unavailableFonts = new Map<string, number>();

/** How long a failed family stays unavailable before an ordinary request retries it. */
export const FONT_RETRY_COOLDOWN_MS = 30_000;

export type FontLoadState = "idle" | "loading" | "loaded" | "unavailable";

const loadStateListeners = new Set<() => void>();

function notifyLoadStateChanged(): void {
  for (const listener of loadStateListeners) listener();
}

/**
 * Subscribe to font load-state transitions (for `useSyncExternalStore`). The
 * listener is told that something changed; read the family of interest back
 * through `getFontLoadState`.
 */
export function subscribeToFontLoadState(listener: () => void): () => void {
  loadStateListeners.add(listener);
  return () => {
    loadStateListeners.delete(listener);
  };
}

/** The load state of one family as the UI should present it. */
export function getFontLoadState(family: string): FontLoadState {
  if (SKIP_FONTS.has(family) || loadedFonts.has(family)) return "loaded";
  if (pending.has(family)) return "loading";
  if (unavailableFonts.has(family)) return "unavailable";
  return "idle";
}

function markUnavailable(family: string): void {
  unavailableFonts.set(family, Date.now());
  ensureOnlineRetryListener();
}

let onlineRetryListenerInstalled = false;

/**
 * A family that failed while the network was down is retried the moment the
 * browser says it is back, without waiting for the next request. Installed on
 * the first failure so importing this module has no side effects.
 */
function ensureOnlineRetryListener(): void {
  if (onlineRetryListenerInstalled || typeof window === "undefined") return;
  onlineRetryListenerInstalled = true;
  window.addEventListener("online", () => {
    void retryUnavailableFonts();
  });
}

/**
 * Forget every recorded failure and request those families again. Returns
 * once the retries settle. Used by the `online` event and available to UI.
 */
export async function retryUnavailableFonts(): Promise<void> {
  const families = [...unavailableFonts.keys()];
  if (families.length === 0) return;
  unavailableFonts.clear();
  notifyLoadStateChanged();
  await Promise.all(families.map((family) => loadGoogleFont(family)));
}

/** Cached weight/style metadata per family */
const metadataCache = new Map<string, { weights: number[]; styles: string[] }>();

/** In-flight load promises so we don't duplicate requests */
const pending = new Map<string, Promise<boolean>>();

/** Families injected as inline Google Fonts CSS in this session */
const injectedGoogleFonts = new Set<string>();

/** Generic CSS keywords and system font stacks that never need loading */
const SKIP_FONTS = new Set([
  "system-ui",
  "sans-serif",
  "serif",
  "monospace",
  "cursive",
  "fantasy",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "ui-rounded",
  "-apple-system",
  "BlinkMacSystemFont",
  "inherit",
  "initial",
  "unset",
]);

type FontLoadNode = {
  fontFamily?: string;
  styles: Record<string, string | number>;
  children: readonly FontLoadNode[];
};

function canUseFontLoadingApi(): boolean {
  return typeof document !== "undefined" && Boolean(document.head && document.fonts);
}

function encodeFamilyForUrl(family: string): string {
  return encodeURIComponent(family).replace(/%20/g, "+");
}

export function buildGoogleFontsCssUrl(family: string): string {
  const encoded = encodeURIComponent(family);
  return `https://fonts.googleapis.com/css2?family=${encoded}&display=swap`;
}

/**
 * css2 URL that leaves every variable axis of the family open, so Google
 * serves the variable font instead of a static instance. Returns `null` for
 * families with no known variable axes — a range request 400s on those.
 *
 * Naming the axes is what makes optical sizing work: an unnamed `opsz` is
 * pinned at the family default, which renders Source Serif 4 at display sizes
 * far too wide because the browser can never reach `opsz 60`.
 */
export function buildGoogleFontsVariableCssUrl(family: string): string | null {
  const spec = buildFontAxisSpec(resolveFontVariationMetadata(family));
  if (!spec) return null;
  return `https://fonts.googleapis.com/css2?family=${encodeFamilyForUrl(family)}:${spec}&display=swap`;
}

/**
 * CSS API v1 URL requesting every weight and italic variant. Unlike css2,
 * the v1 API silently drops variants a family does not have, so one request
 * yields @font-face rules for all available faces without knowing which ones
 * exist. That tolerance is why it stays the fallback for static families and
 * for families missing from the axis metadata; it only ever serves static
 * instances, so variable families take the css2 path above.
 */
export function buildGoogleFontsAllVariantsCssUrl(family: string): string {
  const encoded = encodeFamilyForUrl(family);
  const weights = [100, 200, 300, 400, 500, 600, 700, 800, 900];
  const variants = [...weights, ...weights.map((w) => `${w}italic`)].join(",");
  return `https://fonts.googleapis.com/css?family=${encoded}:${variants}&display=swap`;
}

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Parse a CSS font-family value into individual family names.
 * e.g. `"'Playfair Display', Georgia, serif"` → `["Playfair Display", "Georgia", "serif"]`
 */
export function parseFontFamilies(value: string): string[] {
  return value
    .split(",")
    .map((f) => f.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

const NAMED_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];

function cacheMetadata(family: string, css: string): void {
  const weights = new Set<number>();
  const styles = new Set<string>();

  // Variable @font-face rules declare a range (`font-weight: 200 900`), so
  // report the named weights it covers rather than just its lower bound.
  for (const m of css.matchAll(/font-weight:\s*(\d+)(?:\s+(\d+))?/g)) {
    const from = parseInt(m[1], 10);
    const to = m[2] ? parseInt(m[2], 10) : from;
    weights.add(from);
    weights.add(to);
    for (const weight of NAMED_WEIGHTS) {
      if (weight > from && weight < to) weights.add(weight);
    }
  }
  for (const m of css.matchAll(/font-style:\s*(\w+)/g)) {
    styles.add(m[1]);
  }

  metadataCache.set(family, {
    weights: [...weights].sort((a, b) => a - b),
    styles: [...styles].sort(),
  });
}

// ─── Core loader ─────────────────────────────────────────────────

/**
 * Fetch one candidate stylesheet, reporting "not this one" for both a refusal
 * and a transport failure. A throw has to fall through to the next URL rather
 * than abort the family: the axis request is now the first one tried, and a
 * single failed request must not be what decides a font does not exist.
 */
async function fetchStylesheet(url: string): Promise<Response | null> {
  try {
    const res = await fetch(url);
    return res.ok ? res : null;
  } catch {
    return null;
  }
}

/**
 * Load a single font family from Google Fonts.
 * Returns `true` if the font is now available (loaded or was already present).
 *
 * A family whose last attempt failed is not requested again until
 * `FONT_RETRY_COOLDOWN_MS` has passed, unless `options.force` asks for an
 * immediate retry (the font picker's "retry" affordance does).
 */
export async function loadGoogleFont(
  family: string,
  options: { force?: boolean } = {},
): Promise<boolean> {
  if (loadedFonts.has(family)) return true;
  if (SKIP_FONTS.has(family)) return true;
  const failedAt = unavailableFonts.get(family);
  if (failedAt !== undefined) {
    if (!options.force && Date.now() - failedAt < FONT_RETRY_COOLDOWN_MS) return false;
    unavailableFonts.delete(family);
  }
  if (!canUseFontLoadingApi()) return false;

  // Deduplicate concurrent requests for the same family
  const inflight = pending.get(family);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      await ensureFontAxisMetadataLoaded();

      // Prefer the variable URL so axes such as `opsz` stay open and the
      // browser can size them optically; then the all-variants URL so every
      // available static weight/style loads; then the plain URL for the rare
      // family where the variant list request is rejected outright.
      const variableUrl = buildGoogleFontsVariableCssUrl(family);
      const res =
        (variableUrl ? await fetchStylesheet(variableUrl) : null) ??
        (await fetchStylesheet(buildGoogleFontsAllVariantsCssUrl(family))) ??
        (await fetchStylesheet(buildGoogleFontsCssUrl(family)));
      if (!res) {
        markUnavailable(family);
        return false;
      }

      const css = await res.text();
      cacheMetadata(family, css);

      // Inject as inline <style> so screenshot contexts have direct
      // access to the CSS text.
      if (!injectedGoogleFonts.has(family)) {
        const style = document.createElement("style");
        style.dataset.leafFont = family;
        style.textContent = css;
        document.head.appendChild(style);
        injectedGoogleFonts.add(family);
      }

      // Wait for at least the regular weight to become usable
      try {
        await document.fonts.load(`400 16px "${family}"`);
      } catch {
        // The <link> will still trigger a font swap
      }

      loadedFonts.add(family);
      return true;
    } catch {
      markUnavailable(family);
      return false;
    } finally {
      pending.delete(family);
      notifyLoadStateChanged();
    }
  })();

  pending.set(family, promise);
  notifyLoadStateChanged();
  return promise;
}

// ─── Public API ──────────────────────────────────────────────────

export interface FontFamilyInfo {
  available: boolean;
  source: "system" | "google-fonts" | "local" | "not-found";
  weights?: number[];
  styles?: string[];
}

/**
 * Check availability of font families, automatically loading from Google
 * Fonts when possible. Returns detailed info including source and metadata.
 */
export async function getFontFamilyInfo(
  familyNames: string[],
): Promise<Record<string, FontFamilyInfo>> {
  const results: Record<string, FontFamilyInfo> = {};

  for (const name of familyNames) {
    if (SKIP_FONTS.has(name)) {
      results[name] = { available: true, source: "system" };
      continue;
    }

    // Try Google Fonts (also returns true for already-loaded fonts)
    const loaded = await loadGoogleFont(name);
    if (loaded) {
      const meta = metadataCache.get(name);
      results[name] = {
        available: true,
        source: meta || injectedGoogleFonts.has(name) ? "google-fonts" : "local",
        ...(meta && { weights: meta.weights, styles: meta.styles }),
      };
    } else {
      results[name] = { available: false, source: "not-found" };
    }
  }

  return results;
}

/**
 * Ensure all fonts in a CSS font-family value are loaded and ready for layout.
 * Callers that do not need readiness may intentionally ignore the promise.
 */
export async function ensureFontsLoaded(fontFamilyValue: string): Promise<void> {
  const families = parseFontFamilies(fontFamilyValue);
  await Promise.all(families.map((family) => loadGoogleFont(family)));
  await waitForDocumentFontsReady();
}

function collectFontFamiliesForNodeTree(
  nodes: readonly FontLoadNode[],
  families = new Set<string>(),
) {
  function walk(node: FontLoadNode) {
    if (node.fontFamily) {
      for (const f of parseFontFamilies(String(node.fontFamily))) families.add(f);
    }
    const stylesFont = node.styles.fontFamily;
    if (stylesFont !== undefined) {
      for (const f of parseFontFamilies(String(stylesFont))) families.add(f);
    }
    for (const child of node.children) walk(child);
  }

  for (const node of nodes) walk(node);
  return families;
}

async function waitForDocumentFontsReady(): Promise<void> {
  if (!canUseFontLoadingApi()) return;
  const fontFaceSet = document.fonts;
  await fontFaceSet.ready.catch(() => undefined);
}

/**
 * Walk a node tree and wait for all referenced font families to be requested.
 */
export async function preloadFontsForNodeTree(nodes: readonly FontLoadNode[]): Promise<void> {
  const families = collectFontFamiliesForNodeTree(nodes);

  await Promise.all([...families].map((family) => loadGoogleFont(family)));
  await waitForDocumentFontsReady();
}

/**
 * Walk a node tree and load all referenced font families.
 */
export function loadFontsForNodeTree(nodes: readonly FontLoadNode[]): void {
  void preloadFontsForNodeTree(nodes);
}

/** Get the list of font families currently loaded from Google Fonts. */
export function getLoadedGoogleFonts(): string[] {
  return [...loadedFonts];
}

export function resetFontLoaderStateForTests(): void {
  loadedFonts.clear();
  unavailableFonts.clear();
  metadataCache.clear();
  pending.clear();
  injectedGoogleFonts.clear();
  loadStateListeners.clear();
}
