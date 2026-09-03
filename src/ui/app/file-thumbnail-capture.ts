import { capturePageScreenshot } from "../render/screenshot-capture";
import type { EditorStore } from "../../core/state/EditorStore";
import { dataUrlToBlob, uploadEphemeralImageAsset } from "../../core/state/image-assets";

/**
 * Dashboard thumbnails, captured from the live canvas while an editor is
 * mounted. The loop runs per open tab: an initial capture shortly after the
 * editor is ready, then periodic re-captures while the tab stays mounted.
 * Uploads are content-addressed, so an unchanged canvas costs one local hash;
 * the file PATCH is skipped whenever the asset id did not change. Cycles whose
 * content version matches the last successful capture skip the (heavyweight)
 * capture itself, with a periodic forced refresh as a safety net for edits
 * the version signal cannot see.
 *
 * Capture is skipped when the active page has no visible roots, when the
 * window is hidden, and on runtimes without a shared asset backend or
 * registry (local/offline) — the loop then stops for the tab's lifetime.
 * A document emptied of all visible content clears the stored thumbnail so
 * deleted designs stop rendering on the dashboard. Transient failures back
 * off exponentially; permanent rejections (missing permission, misconfigured
 * upload key) stop the loop.
 */

const INITIAL_CAPTURE_DELAY_MS = 3_000;
const RECAPTURE_INTERVAL_MS = 30_000;
/** A skipped cycle (inactive tab, hidden window, empty page) rechecks sooner. */
const SKIPPED_CYCLE_RECHECK_MS = 5_000;
/**
 * Recapture even with an unchanged content version after this many skipped
 * cycles: the version signal misses some mutations (undo, remote style-only
 * edits), and content-addressed dedupe keeps the forced pass cheap upstream.
 */
const FORCED_REFRESH_AFTER_UNCHANGED_CYCLES = 10;
/** Transient-failure backoff cap. */
const MAX_FAILURE_BACKOFF_MS = 10 * 60_000;
/**
 * After a downgrade to a lower capture scale, retry the preferred scale once
 * this many lowered-scale captures have landed: the original failure may have
 * been transient, and a document that shrank deserves the sharper capture
 * back. A page that is genuinely too large costs one failed probe per window.
 */
const RETRY_PREFERRED_SCALE_AFTER_CAPTURES = 5;
/**
 * Uploaded thumbnails are normalized to at most this width. Cards render the
 * whole page contain-fit at up to ~660 CSS px on 2x displays, so anything
 * much below ~1300 source pixels reads blurry.
 */
const THUMBNAIL_MAX_WIDTH_PX = 1600;
const THUMBNAIL_JPEG_QUALITY = 0.8;
/** Preferred capture scale; halved-down retry for very large pages. */
const CAPTURE_SCALES = [0.5, 0.1] as const;

export type FileThumbnailCaptureDependencies = {
  capturePage?: typeof capturePageScreenshot;
  uploadAsset?: typeof uploadEphemeralImageAsset;
  normalizeToJpegBlob?: (dataUrl: string, maxWidth: number, quality: number) => Promise<Blob>;
  initialDelayMs?: number;
  intervalMs?: number;
  isWindowHidden?: () => boolean;
};

export type FileThumbnailCaptureLoopOptions = FileThumbnailCaptureDependencies & {
  fileId: string;
  /**
   * The store of the tab's currently live editor session for the same
   * file/branch the loop was started for, or null once the tab closed or
   * switched branches — the loop stops and the next editor-ready event starts
   * a fresh one. A transport-level session replacement swaps the editor in
   * place without an editor-ready event, so implementations must resolve the
   * store through the tab, not a captured editor instance.
   */
  getMountedStore: () => EditorStore | null;
  /**
   * Cheap signature of the document content feeding the thumbnail. An
   * unchanged signature lets a cycle skip the capture entirely; omit to
   * capture every cycle.
   */
  getContentVersion?: () => string;
  /**
   * Whether the tab is the active, DOM-mounted editor right now. Background
   * tabs keep live sessions but no mounted canvas, so capture must wait.
   */
  isTabActive: () => boolean;
  /** The thumbnail currently stored on the file, if any, when the loop starts. */
  initialThumbnailAssetId?: string | null;
  setFileThumbnail: (fileId: string, thumbnailAssetId: string | null) => Promise<unknown>;
};

function pageHasVisibleRoots(page: EditorStore["pages"][number]): boolean {
  return page.nodes.some((node) => node.visible !== false);
}

function hasVisibleActivePageRoots(store: EditorStore): boolean {
  const page = store.pages.find((candidate) => candidate.id === store.activePageId);
  return !!page && pageHasVisibleRoots(page);
}

function documentHasVisibleRoots(store: EditorStore): boolean {
  return store.pages.some(pageHasVisibleRoots);
}

/**
 * 4xx rejections other than timeout/rate-limit shapes will keep failing on
 * every retry (viewer without file-update permission, misconfigured upload
 * key): re-running the capture pipeline against them is pure waste.
 */
function isPermanentThumbnailError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return (
    typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429
  );
}

/**
 * Decode a captured page raster and re-encode it as a bounded JPEG. Keeps
 * uploads small and stable regardless of how large the source page was.
 */
async function defaultNormalizeToJpegBlob(
  dataUrl: string,
  maxWidth: number,
  quality: number,
): Promise<Blob> {
  const sourceBlob = await dataUrlToBlob(dataUrl);
  const bitmap = await createImageBitmap(sourceBlob);
  try {
    const scale = Math.min(1, maxWidth / bitmap.width);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Thumbnail canvas context is unavailable.");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, width, height);
    const encoded = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality),
    );
    if (!encoded) throw new Error("Thumbnail encoding produced no image.");
    return encoded;
  } finally {
    bitmap.close();
  }
}

/**
 * Start the per-tab capture loop. Returns a cancel function; the loop also
 * stops itself once the tab's editor is no longer mounted, the runtime
 * cannot store thumbnails, or persistence rejects permanently.
 */
export function startFileThumbnailCaptureLoop(
  options: FileThumbnailCaptureLoopOptions,
): () => void {
  const capturePage = options.capturePage ?? capturePageScreenshot;
  const uploadAsset = options.uploadAsset ?? uploadEphemeralImageAsset;
  const normalizeToJpegBlob = options.normalizeToJpegBlob ?? defaultNormalizeToJpegBlob;
  const isWindowHidden = options.isWindowHidden ?? (() => document.visibilityState === "hidden");
  const initialDelayMs = options.initialDelayMs ?? INITIAL_CAPTURE_DELAY_MS;
  const intervalMs = options.intervalMs ?? RECAPTURE_INTERVAL_MS;

  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastPatchedAssetId: string | null = options.initialThumbnailAssetId ?? null;
  let lastCapturedContentVersion: string | null = null;
  let unchangedCycles = 0;
  let consecutiveFailures = 0;
  // A page too large for the preferred scale fails deterministically; start
  // later cycles at the scale that last succeeded instead of re-failing.
  let preferredScaleIndex = 0;
  // Successful captures taken at a lowered scale since the last time the
  // preferred scale was attempted; drives the periodic re-probe.
  let capturesAtLoweredScale = 0;

  const scheduleNext = (delay: number) => {
    if (cancelled) return;
    timer = setTimeout(() => void runCycle(), delay);
  };

  const handleFailure = (error: unknown) => {
    if (isPermanentThumbnailError(error)) {
      console.warn("Dashboard thumbnail updates stopped: the backend rejected them", error);
      return;
    }
    consecutiveFailures += 1;
    console.warn("Dashboard thumbnail update failed", error);
    scheduleNext(Math.min(intervalMs * 2 ** consecutiveFailures, MAX_FAILURE_BACKOFF_MS));
  };

  /** Throws the last scale's error when every scale fails. */
  const captureAtBestScale = async (store: EditorStore): Promise<string> => {
    const startIndex =
      preferredScaleIndex > 0 && capturesAtLoweredScale >= RETRY_PREFERRED_SCALE_AFTER_CAPTURES
        ? 0
        : preferredScaleIndex;
    let lastError: unknown = null;
    for (let index = startIndex; index < CAPTURE_SCALES.length; index += 1) {
      try {
        const capture = await capturePage(store, store.activePageId, CAPTURE_SCALES[index]!, false);
        preferredScaleIndex = index;
        capturesAtLoweredScale = index === 0 || startIndex === 0 ? 0 : capturesAtLoweredScale + 1;
        return `data:${capture.mimeType};base64,${capture.data}`;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  };

  const runCycle = async () => {
    if (cancelled) return;
    const store = options.getMountedStore();
    if (!store) return;
    // A fully emptied document must stop advertising its deleted content.
    // Clearing needs no mounted canvas, so it runs before the active/hidden
    // gate — a backgrounded tab or hidden window still clears.
    if (lastPatchedAssetId !== null && !documentHasVisibleRoots(store)) {
      try {
        await options.setFileThumbnail(options.fileId, null);
        lastPatchedAssetId = null;
        lastCapturedContentVersion = null;
        consecutiveFailures = 0;
      } catch (error) {
        handleFailure(error);
        return;
      }
      scheduleNext(Math.min(intervalMs, SKIPPED_CYCLE_RECHECK_MS));
      return;
    }
    if (!options.isTabActive() || isWindowHidden()) {
      scheduleNext(Math.min(intervalMs, SKIPPED_CYCLE_RECHECK_MS));
      return;
    }
    if (!hasVisibleActivePageRoots(store)) {
      // An empty active page alongside populated ones keeps the last capture.
      scheduleNext(Math.min(intervalMs, SKIPPED_CYCLE_RECHECK_MS));
      return;
    }
    // Read before capturing: edits landing mid-capture change the version and
    // re-trigger on the next cycle instead of being lost.
    const contentVersion = options.getContentVersion?.() ?? null;
    if (
      contentVersion !== null &&
      contentVersion === lastCapturedContentVersion &&
      unchangedCycles < FORCED_REFRESH_AFTER_UNCHANGED_CYCLES
    ) {
      unchangedCycles += 1;
      scheduleNext(intervalMs);
      return;
    }
    try {
      const dataUrl = await captureAtBestScale(store);
      if (cancelled) return;
      const blob = await normalizeToJpegBlob(
        dataUrl,
        THUMBNAIL_MAX_WIDTH_PX,
        THUMBNAIL_JPEG_QUALITY,
      );
      const uploaded = await uploadAsset(blob, {
        kind: "thumbnail",
        skipIfAssetId: lastPatchedAssetId,
      });
      // No shared backend: captures can never land, stop for this tab.
      if (!uploaded) return;
      if (!cancelled && uploaded.assetId !== lastPatchedAssetId) {
        await options.setFileThumbnail(options.fileId, uploaded.assetId);
        lastPatchedAssetId = uploaded.assetId;
      }
      lastCapturedContentVersion = contentVersion;
      unchangedCycles = 0;
      consecutiveFailures = 0;
    } catch (error) {
      handleFailure(error);
      return;
    }
    scheduleNext(intervalMs);
  };

  scheduleNext(initialDelayMs);
  return () => {
    cancelled = true;
    if (timer !== null) clearTimeout(timer);
  };
}
