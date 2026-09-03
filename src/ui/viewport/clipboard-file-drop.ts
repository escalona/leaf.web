import { runInAction } from "mobx";
import {
  classifyPastedContent,
  insertPastedContent,
} from "../../core/editor/clipboard/content-paste";
import { screenPoint } from "../../core/editor/interaction/coordinate-spaces";
import { layoutPastedImages, measureImageFile } from "../../core/editor/clipboard/image-paste";
import { isNativeDocumentWindow } from "../../core/platform";
import type { EditorStore } from "../../core/state/EditorStore";
import {
  describeImageAssetUploadFailure,
  discardUnreferencedNativeImageAsset,
  ImageAssetUploadError,
  isLocalAssetSrc,
  isSharedAssetBackendConfigured,
  stageImageAssetFromFile,
  type StagedImageAsset,
} from "../../core/state/image-assets";
import type { DesignNode, Point } from "../../core/types";
import { getCommonSelectedPasteParent } from "./clipboard-placement";
import { reportEditorError } from "../editor-feedback";

const NO_COPIED_IDS: ReadonlySet<string> = new Set<string>();

const TEXT_IMPORT_EXTENSIONS = /\.(html?|svg|txt|md|jsx?|tsx?)$/i;

/**
 * Background uploads run a few at a time: one connection per file thrashes on
 * large batches, while full parallelism contends for bandwidth and sockets.
 */
export const PASTE_PERSIST_CONCURRENCY = 4;

export function resolveStyleShortcutKey(event: KeyboardEvent): string {
  if (event.code === "KeyC" || event.code === "KeyV") {
    return event.code === "KeyC" ? "c" : "v";
  }
  return event.code ? "" : event.key.toLowerCase();
}

/** SVG and text-like files remain editable imports instead of opaque images. */
export function splitDroppedFiles(files: readonly File[]) {
  const imageFiles: File[] = [];
  const textFiles: File[] = [];

  for (const file of files) {
    const isMarkupOrText =
      file.type === "image/svg+xml" ||
      file.type.startsWith("text/") ||
      (file.type === "" && TEXT_IMPORT_EXTENSIONS.test(file.name));
    if (isMarkupOrText) textFiles.push(file);
    else if (file.type.startsWith("image/")) imageFiles.push(file);
  }

  return { imageFiles, textFiles };
}

/**
 * Paste images optimistically: nodes land on the canvas as soon as the files
 * are measured and staged in memory; persistence (IndexedDB and the shared
 * upload) runs afterwards. Assets are content-addressed, so peers resolve the
 * shared URL from the asset id once the background upload lands — no document
 * patch is needed. Native .leaf documents are the exception: they persist
 * before committing nodes so a save can never reference missing bytes.
 *
 * The returned `persisted` promise settles when every background persist has
 * finished; callers only need it for tests and teardown coordination.
 */
export async function pasteImages(
  files: File[],
  store: EditorStore,
  viewportEl: HTMLElement,
  dropPoint?: Point,
): Promise<{ persisted: Promise<void> }> {
  // The clipboard hands SVG files over as `image/*`, but rasterizing them
  // would lose what dropping the same file keeps: route them through the
  // markup importer exactly like the drop path does.
  const { imageFiles, textFiles } = splitDroppedFiles(files);
  if (textFiles.length > 0) {
    await insertMarkupFiles(textFiles, store, viewportEl, dropPoint);
  }
  if (imageFiles.length === 0) return { persisted: Promise.resolve() };

  runInAction(() => store.beginImagePaste());
  try {
    const result = await pasteImagesInner(imageFiles, store, viewportEl, dropPoint);
    // The indicator promises coverage of the whole persist window, not just
    // node placement — hold the counter until the background work settles.
    void result.persisted.finally(() => runInAction(() => store.endImagePaste()));
    return result;
  } catch (error) {
    runInAction(() => store.endImagePaste());
    throw error;
  }
}

function resolvePasteCanvasCenter(store: EditorStore, viewportEl: HTMLElement, dropPoint?: Point) {
  const rect = viewportEl.getBoundingClientRect();
  return dropPoint ?? store.screenToCanvas(screenPoint(rect.width / 2, rect.height / 2));
}

/** Import SVG/text files as editable nodes, staggered like dropped text files. */
async function insertMarkupFiles(
  files: File[],
  store: EditorStore,
  viewportEl: HTMLElement,
  dropPoint?: Point,
) {
  const canvasCenter = resolvePasteCanvasCenter(store, viewportEl, dropPoint);
  for (const [index, file] of files.entries()) {
    const content = classifyPastedContent({ text: await file.text() });
    if (!content) continue;
    runInAction(() => {
      store.beginHistoryTransaction();
      try {
        insertPastedContent(store, content, {
          canvasPoint: { x: canvasCenter.x + index * 24, y: canvasCenter.y + index * 24 },
        });
      } finally {
        store.endHistoryTransaction();
      }
    });
  }
}

async function pasteImagesInner(
  imageFiles: File[],
  store: EditorStore,
  viewportEl: HTMLElement,
  dropPoint?: Point,
): Promise<{ persisted: Promise<void> }> {
  const canvasCenter = resolvePasteCanvasCenter(store, viewportEl, dropPoint);
  // Asset ids are content-addressed, so an identical earlier paste shares a
  // staged record: only discard when no existing node references it.
  const discardStagedIfUnreferenced = (staged: StagedImageAsset) => {
    const assetId = staged.asset.assetId;
    const referenced = [...store.nodeMap.values()].some(
      (node) => node.imageAsset?.assetId === assetId,
    );
    if (!referenced) staged.discard();
  };
  const images = await settleClipboardImageUploads(
    imageFiles.map(async (file) => {
      const naturalSize = await measureImageFile(file);
      const staged = await stageImageAssetFromFile(file, naturalSize);
      return { staged, naturalSize, file };
    }),
    async ({ staged }) => discardStagedIfUnreferenced(staged),
  );
  const { positions, sizes } = layoutPastedImages(
    images.map((image) => image.naturalSize),
    canvasCenter,
  );
  const stagedAssets = images.map((image) => image.staged);

  // A native .leaf document embeds asset bytes at save time, so nodes must
  // never precede their bytes: persist before committing any node, and let a
  // persist failure (e.g. an oversize asset) fail the paste outright instead
  // of settling with a document that references bytes the archive lacks.
  //
  // The desktop shell exposes the native-document API in every window — the
  // dashboard and worker-backed files included — so API presence alone must
  // not select this path: a window without an open .leaf document has no
  // archive to protect, and gating its pastes on the shared upload turns any
  // worker outage into a total image-paste failure while other edits (riding
  // the already-open sync socket) keep working. The synchronous preload flag
  // is the gate rather than a getState() round-trip: an IPC hiccup must not
  // route a real .leaf window through the optimistic path, where a persist
  // failure is merely logged and a save could reference missing bytes.
  const isNativeDocument = isNativeDocumentWindow();
  if (isNativeDocument) {
    const errors = (await persistStagedAssets(stagedAssets)).flatMap(({ error }) =>
      error === undefined ? [] : [error],
    );
    if (errors.length > 0) {
      await Promise.allSettled(
        stagedAssets.map(async (staged) => {
          await discardUnreferencedNativeImageAsset(staged.asset.assetId);
          discardStagedIfUnreferenced(staged);
        }),
      );
      throw errors[0];
    }
  }

  const createdNodes: DesignNode[] = [];
  runInAction(() => {
    // Images nest where a node paste would: the selected frame — artboard or
    // plain — or the nearest unlocked frame above the selection.
    const pasteParent = getCommonSelectedPasteParent(store, NO_COPIED_IDS);
    // One transaction so undo removes the whole paste, not one image at a time.
    store.beginHistoryTransaction();
    try {
      images.forEach(({ staged, file }, index) => {
        const node = store.runtime.createImage(
          staged.asset,
          sizes[index],
          positions[index],
          file.name || `Pasted Image ${index + 1}`,
          pasteParent?.id,
        );
        createdNodes.push(node);
        store.selectNode(node.id, index > 0);
      });
    } finally {
      store.endHistoryTransaction();
    }
    store.setTool("select");
  });

  // Web sessions persist in the background. A transient failure keeps the
  // in-memory blob (the node still renders locally) and the stored local src
  // marks the record for the later-session upload retry in image-assets; the
  // user is told peers cannot see it yet. A permanent rejection (oversize
  // bytes, refused key) can never be retried into existence, so the node is
  // withdrawn — matching the native path, where the paste fails outright —
  // instead of leaving peers on a placeholder that never resolves.
  const persisted = isNativeDocument
    ? Promise.resolve()
    : persistStagedAssets(stagedAssets).then((outcomes) => {
        surfacePersistOutcomes(outcomes, createdNodes, store, discardStagedIfUnreferenced);
      });
  return { persisted };
}

type PersistOutcome = { staged: StagedImageAsset; error?: unknown; sharedUploadLanded: boolean };

function surfacePersistOutcomes(
  outcomes: readonly PersistOutcome[],
  createdNodes: readonly DesignNode[],
  store: EditorStore,
  discardStagedIfUnreferenced: (staged: StagedImageAsset) => void,
) {
  const withdrawnNodeIds: string[] = [];
  const withdrawnAssets: StagedImageAsset[] = [];
  const messages = new Set<string>();
  for (const { staged, error, sharedUploadLanded } of outcomes) {
    const sourceName = staged.asset.sourceName;
    if (error instanceof ImageAssetUploadError && error.isPermanent) {
      console.error("Shared upload refused the pasted image asset", error);
      messages.add(describeImageAssetUploadFailure(error, sourceName));
      for (const node of createdNodes) {
        const live = store.getNode(node.id);
        if (live?.imageAsset?.assetId === staged.asset.assetId) withdrawnNodeIds.push(node.id);
      }
      withdrawnAssets.push(staged);
      continue;
    }
    if (error) {
      console.error("Failed to persist pasted image asset", error);
      messages.add(describeImageAssetUploadFailure(error, sourceName));
      continue;
    }
    if (!sharedUploadLanded) {
      messages.add(describeImageAssetUploadFailure(null, sourceName));
    }
  }

  if (withdrawnNodeIds.length > 0) {
    runInAction(() => {
      store.runtime.deleteNodes(withdrawnNodeIds);
    });
    for (const staged of withdrawnAssets) discardStagedIfUnreferenced(staged);
  }
  for (const message of messages) reportEditorError(message, store);
}

/**
 * Run the staged assets' durability pipelines with bounded concurrency. One
 * failed persist never disturbs its batch siblings; every outcome is returned
 * so each caller decides whether a failure fails the paste (native) or is
 * surfaced and retried later (web). `sharedUploadLanded` is false when the
 * persisted ref still carries a local src while a shared backend is
 * configured — the durable marker for a transient upload failure.
 */
async function persistStagedAssets(staged: readonly StagedImageAsset[]): Promise<PersistOutcome[]> {
  let nextIndex = 0;
  const outcomes: PersistOutcome[] = [];
  const sharedBackendConfigured = isSharedAssetBackendConfigured();
  const workers = Array.from(
    { length: Math.min(PASTE_PERSIST_CONCURRENCY, staged.length) },
    async () => {
      while (nextIndex < staged.length) {
        const current = staged[nextIndex];
        nextIndex += 1;
        try {
          const persistedAsset = await current.persist();
          outcomes.push({
            staged: current,
            sharedUploadLanded: !sharedBackendConfigured || !isLocalAssetSrc(persistedAsset.src),
          });
        } catch (error) {
          outcomes.push({ staged: current, error, sharedUploadLanded: false });
        }
      }
    },
  );
  await Promise.all(workers);
  return outcomes;
}

export async function settleClipboardImageUploads<T>(
  uploads: Array<Promise<T>>,
  discard: (value: Awaited<T>) => Promise<void>,
): Promise<Array<Awaited<T>>> {
  const settled = await Promise.allSettled(uploads);
  const completed: Array<Awaited<T>> = [];
  let failure: unknown;
  let failed = false;
  for (const result of settled) {
    if (result.status === "fulfilled") completed.push(result.value);
    else if (!failed) {
      failed = true;
      failure = result.reason;
    }
  }
  if (!failed) return completed;
  await Promise.allSettled(completed.map(discard));
  throw failure;
}
