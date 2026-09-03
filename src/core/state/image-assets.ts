import type { ImageAssetRef, Size } from "../types";
import { MAX_NATIVE_DOCUMENT_ASSET_BYTES } from "../shared/asset-limits";
import { LEAF_WORKER_ROUTES } from "../shared/collaboration";
import { buildWorkerUrl, getConfiguredWorkerBaseUrl } from "./worker-endpoints";

/**
 * Native `.leaf` asset storage, present when a desktop window owns a document.
 * The desktop entry registers its native document API here at boot; core never
 * imports desktop code, and a browser session simply has no host.
 */
export interface NativeImageAssetHost {
  getState(): Promise<{ kind: "document"; documentId: string } | { kind: "home" }>;
  getAsset(assetId: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; mimeType: string } | null>;
  putAsset(input: { assetId: string; bytes: Uint8Array; mimeType: string }): Promise<void>;
  discardAssetIfUnreferenced(assetId: string): Promise<boolean>;
}

let nativeImageAssetHostProvider: (() => NativeImageAssetHost | null) | null = null;

/** Install (or clear) the provider of the window's native asset host. */
export function registerNativeImageAssetHost(provider: (() => NativeImageAssetHost | null) | null) {
  nativeImageAssetHostProvider = provider;
}

function getNativeImageAssetHost(): NativeImageAssetHost | null {
  return nativeImageAssetHostProvider?.() ?? null;
}

type StoredImageAssetRecord = ImageAssetRef & {
  blob: Blob;
};

export interface ImageAssetResolveContext {
  shouldResolveToOriginal?: boolean;
}

export interface UploadImageAssetOptions {
  assetId?: string;
  naturalSize: Size;
  sourceName?: string;
}

/**
 * An asset that renders immediately from the in-memory blob while its
 * durability work (IndexedDB/native persistence, shared upload) runs later.
 */
export interface StagedImageAsset {
  asset: ImageAssetRef;
  /** Run the durability pipeline. Safe to call once, after `asset` is referenced. */
  persist(abortSignal?: AbortSignal): Promise<ImageAssetRef>;
  /** Drop the staged blob when the asset never got referenced. */
  discard(): void;
}

export interface ImageAssetStore {
  upload(
    blob: Blob,
    options: UploadImageAssetOptions,
    abortSignal?: AbortSignal,
  ): Promise<ImageAssetRef>;
  /**
   * Optional fast path: cache the blob in memory and return a renderable local
   * ref without waiting for persistence. Stores without it upload eagerly.
   */
  stage?(blob: Blob, options: UploadImageAssetOptions): Promise<StagedImageAsset>;
  resolve(
    asset: ImageAssetRef,
    context?: ImageAssetResolveContext,
  ): Promise<string | null> | string | null;
}

const DATABASE_NAME = "leaf-image-assets";
const DATABASE_VERSION = 1;
const STORE_NAME = "image-assets";
const LOCAL_ASSET_PROTOCOL = "asset:";
const SHARED_ASSET_UPLOAD_METHOD =
  "PUT" satisfies (typeof LEAF_WORKER_ROUTES.assets.acceptedMethods)[number];

/**
 * Mirrors `MAX_IMAGE_ASSET_BYTES` in `worker/src/asset-store.ts`. The Worker
 * stays authoritative (a 413 is classified the same way); the client copy only
 * lets an oversize paste fail fast with a precise message instead of streaming
 * 25 MB to be refused.
 */
export const MAX_SHARED_IMAGE_ASSET_BYTES = 25 * 1024 * 1024;

export type ImageAssetUploadFailureReason = "too-large" | "rejected" | "transient";

/**
 * A shared-backend upload that did not land. `reason` separates rejections
 * that will never succeed (oversize bytes, a refused upload key) from outages
 * the stored-local-src retry can recover on a later load.
 */
export class ImageAssetUploadError extends Error {
  readonly reason: ImageAssetUploadFailureReason;
  readonly status?: number;

  constructor(message: string, reason: ImageAssetUploadFailureReason, status?: number) {
    super(message);
    this.name = "ImageAssetUploadError";
    this.reason = reason;
    this.status = status;
  }

  get isPermanent() {
    return this.reason !== "transient";
  }
}

function classifyUploadStatus(status: number): ImageAssetUploadFailureReason {
  if (status === 413) return "too-large";
  if (status === 408 || status === 425 || status === 429 || status >= 500) return "transient";
  if (status >= 400) return "rejected";
  return "transient";
}

function formatMegabytes(bytes: number) {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * User-facing explanation for a failed shared upload. Permanent rejections
 * tell the user what to change; transient ones explain why peers cannot see
 * the image yet and that the upload retries on the next load.
 */
export function describeImageAssetUploadFailure(
  error: unknown,
  sourceName?: string | null,
): string {
  const label = sourceName ? `“${sourceName}”` : "The image";
  if (error instanceof ImageAssetUploadError) {
    if (error.reason === "too-large") {
      return `${label} is larger than the ${formatMegabytes(MAX_SHARED_IMAGE_ASSET_BYTES)} upload limit and was removed. Export a smaller version and paste it again.`;
    }
    if (error.reason === "rejected") {
      return `${label} was refused by the asset server (${error.status ?? "unknown error"}) and was removed.`;
    }
  }
  return `${label} could not be uploaded, so collaborators cannot see it yet. It stays on your canvas and the upload retries the next time this file opens.`;
}

const memoryAssetStore = new Map<string, StoredImageAssetRecord>();
const objectUrlCache = new Map<string, string>();
const nativeDocumentAssetCache = new Map<string, Set<string>>();

let databasePromise: Promise<IDBDatabase | null> | null = null;
let configuredImageAssetStore: ImageAssetStore | null = null;

function canUseIndexedDb() {
  return typeof indexedDB !== "undefined";
}

function getConfiguredAssetBaseUrl() {
  const workerBaseUrl = getConfiguredWorkerBaseUrl();
  const assetMountPath = LEAF_WORKER_ROUTES.assets.path.replace(/\/\*$/, "");
  return workerBaseUrl ? buildWorkerUrl(assetMountPath) : null;
}

function getConfiguredAssetUploadKey() {
  return import.meta.env.VITE_IMAGE_ASSET_UPLOAD_KEY || null;
}

export function buildLocalAssetSrc(assetId: string) {
  return `${LOCAL_ASSET_PROTOCOL}${assetId}`;
}

export function isLocalAssetSrc(src: string | null | undefined) {
  return typeof src === "string" && src.startsWith(LOCAL_ASSET_PROTOCOL);
}

function normalizeImageAssetRef(asset: ImageAssetRef): ImageAssetRef {
  return asset.src ? asset : { ...asset, src: buildLocalAssetSrc(asset.assetId) };
}

function getRemoteAssetUrl(assetId: string) {
  const baseUrl = getConfiguredAssetBaseUrl();
  return baseUrl ? `${baseUrl}/${encodeURIComponent(assetId)}` : null;
}

/**
 * Derive the public shared-asset URL for a content-addressed asset id, or null
 * when no shared backend is configured (local/offline sessions). Used by
 * surfaces like dashboard thumbnails that store only the asset id.
 */
export function getSharedAssetUrlForId(assetId: string): string | null {
  return getRemoteAssetUrl(assetId);
}

/** True when uploads go to a shared Worker backend (false in local/offline sessions). */
export function isSharedAssetBackendConfigured(): boolean {
  return getConfiguredAssetBaseUrl() !== null;
}

/**
 * Upload an ephemeral, content-addressed image (e.g. a dashboard thumbnail)
 * straight to the shared asset backend, bypassing the document asset pipeline:
 * no memory cache, no IndexedDB record, no native-document persistence.
 * Returns null when no shared backend is configured or the runtime cannot
 * produce a `sha256:` digest the Worker would accept. The `kind` is recorded
 * as upload metadata so ephemeral objects stay identifiable for cleanup jobs.
 */
export async function uploadEphemeralImageAsset(
  blob: Blob,
  options: {
    abortSignal?: AbortSignal;
    kind?: "thumbnail";
    skipIfAssetId?: string | null;
  } = {},
): Promise<{ assetId: string; src: string } | null> {
  if (!getConfiguredAssetBaseUrl()) return null;
  const assetId = await computeAssetId(blob);
  if (!assetId.startsWith("sha256:")) return null;
  // Content-addressed ids make unchanged captures free: same bytes, same id,
  // nothing to re-upload.
  if (options.skipIfAssetId === assetId) {
    return { assetId, src: getRemoteAssetUrl(assetId)! };
  }
  const src = await uploadToSharedBackend(assetId, blob, options.abortSignal, options.kind);
  return src ? { assetId, src } : null;
}

function revokeObjectUrl(assetId: string) {
  const existing = objectUrlCache.get(assetId);
  if (existing) {
    URL.revokeObjectURL(existing);
    objectUrlCache.delete(assetId);
  }
}

function cacheRecord(record: StoredImageAssetRecord) {
  memoryAssetStore.set(record.assetId, record);
}

function markNativeAssetPersisted(documentId: string, assetId: string) {
  let persistedAssetIds = nativeDocumentAssetCache.get(documentId);
  if (!persistedAssetIds) {
    persistedAssetIds = new Set();
    nativeDocumentAssetCache.set(documentId, persistedAssetIds);
  }
  persistedAssetIds.add(assetId);
}

function isNativeAssetPersisted(documentId: string, assetId: string) {
  return nativeDocumentAssetCache.get(documentId)?.has(assetId) ?? false;
}

function forgetNativeAsset(documentId: string, assetId: string) {
  const persistedAssetIds = nativeDocumentAssetCache.get(documentId);
  persistedAssetIds?.delete(assetId);
  if (persistedAssetIds?.size === 0) nativeDocumentAssetCache.delete(documentId);
}

function discardCachedRecord(assetId: string) {
  memoryAssetStore.delete(assetId);
  revokeObjectUrl(assetId);
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (!canUseIndexedDb()) return Promise.resolve(null);
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve) => {
    try {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: "assetId" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return databasePromise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function computeAssetId(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
    const bytes = Array.from(new Uint8Array(digest));
    const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `sha256:${hex}`;
  }

  let hash = 2166136261;
  for (const byte of new Uint8Array(buffer)) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return `fallback:${blob.size.toString(16)}:${(hash >>> 0).toString(16)}`;
}

function normalizeBlob(blob: Blob, mimeType: string) {
  if (blob.type === mimeType) return blob;
  return new Blob([blob], { type: mimeType });
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read blob as data URL."));
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Blob data URL reader returned a non-string result."));
    };
    reader.readAsDataURL(blob);
  });
}

type ActiveNativeDocument = {
  document: NativeImageAssetHost;
  documentId: string;
};

/** The open native `.leaf` document, or null when this window has none. */
async function getActiveNativeDocument(): Promise<ActiveNativeDocument | null> {
  const nativeDocument = getNativeImageAssetHost();
  if (!nativeDocument) return null;
  const nativeState = await nativeDocument.getState();
  return nativeState.kind === "document"
    ? { document: nativeDocument, documentId: nativeState.documentId }
    : null;
}

async function storeRecord(
  record: StoredImageAssetRecord,
  activeNativeDocument?: ActiveNativeDocument | null,
): Promise<"native" | "browser" | null> {
  const nativeTarget =
    activeNativeDocument === undefined ? await getActiveNativeDocument() : activeNativeDocument;
  if (nativeTarget) {
    await persistRecordToNativeDocument(nativeTarget.document, nativeTarget.documentId, record);
    cacheRecord(record);
    return "native";
  }

  cacheRecord(record);
  const database = await openDatabase();
  if (!database) return null;

  try {
    const tx = database.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    await requestToPromise(store.put(record));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return "browser";
  } catch {
    // Keep the in-memory copy for the current session if IndexedDB write fails.
    return null;
  }
}

async function persistRecordToNativeDocument(
  nativeDocument: NativeImageAssetHost,
  documentId: string,
  record: StoredImageAssetRecord,
): Promise<void> {
  try {
    if (record.blob.size > MAX_NATIVE_DOCUMENT_ASSET_BYTES) {
      throw new Error(
        `Native document image assets cannot exceed ${MAX_NATIVE_DOCUMENT_ASSET_BYTES} bytes.`,
      );
    }
    await nativeDocument.putAsset({
      assetId: record.assetId,
      bytes: new Uint8Array(await record.blob.arrayBuffer()),
      mimeType: record.mimeType,
    });
  } catch (error) {
    throw new Error(`Failed to persist image asset ${record.assetId} in the native document.`, {
      cause: error,
    });
  }
  markNativeAssetPersisted(documentId, record.assetId);
}

export async function loadImageAssetBlob(assetId: string): Promise<Blob | null> {
  const nativeDocument = getNativeImageAssetHost();
  let activeNativeDocument:
    | {
        document: NonNullable<typeof nativeDocument>;
        documentId: string;
      }
    | undefined;
  if (nativeDocument) {
    try {
      const nativeState = await nativeDocument.getState();
      if (nativeState.kind === "document") {
        activeNativeDocument = {
          document: nativeDocument,
          documentId: nativeState.documentId,
        };
      }
    } catch {
      // If state lookup fails, retain the browser fallback behavior.
    }
  }

  const memoryRecord = memoryAssetStore.get(assetId);
  if (memoryRecord) {
    if (activeNativeDocument && !isNativeAssetPersisted(activeNativeDocument.documentId, assetId)) {
      // Deliberately unguarded: a native window must not serve bytes it could
      // not ingest into the archive, or it renders what a save cannot embed.
      // Callers surface the rejection (the resolve hook shows the loading
      // placeholder instead of crashing on an unhandled rejection).
      await persistRecordToNativeDocument(
        activeNativeDocument.document,
        activeNativeDocument.documentId,
        memoryRecord,
      );
    }
    return memoryRecord.blob;
  }

  if (activeNativeDocument) {
    try {
      const asset = await activeNativeDocument.document.getAsset(assetId);
      if (asset) {
        const blob = new Blob([asset.bytes], { type: asset.mimeType });
        cacheRecord({
          assetId,
          blob,
          byteLength: blob.size,
          height: 0,
          mimeType: asset.mimeType,
          src: buildLocalAssetSrc(assetId),
          width: 0,
        });
        markNativeAssetPersisted(activeNativeDocument.documentId, assetId);
        return blob;
      }
      // Miss: fall through to IndexedDB — the asset may have been persisted
      // there by another window sharing this origin (e.g. the home window).
    } catch {
      // Native lookup failed — fall through to IndexedDB.
    }
  }

  const database = await openDatabase();
  if (!database) return null;

  let record: StoredImageAssetRecord | undefined;
  try {
    const tx = database.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    record = await requestToPromise(
      store.get(assetId) as IDBRequest<StoredImageAssetRecord | undefined>,
    );
  } catch {
    return null;
  }
  if (!record) return null;

  const normalizedRecord = {
    ...record,
    src: record.src || buildLocalAssetSrc(record.assetId),
  };
  if (activeNativeDocument && !isNativeAssetPersisted(activeNativeDocument.documentId, assetId)) {
    // Same deliberate strictness as the memory branch above.
    await persistRecordToNativeDocument(
      activeNativeDocument.document,
      activeNativeDocument.documentId,
      normalizedRecord,
    );
  }
  memoryAssetStore.set(assetId, normalizedRecord);
  if (!activeNativeDocument) void retrySharedUploadForStoredRecord(normalizedRecord);
  return normalizedRecord.blob;
}

const sharedUploadRetriesInFlight = new Set<string>();

/**
 * Re-attempt the shared upload for a stored record whose `src` is still local —
 * the durable marker that the original background upload never landed (it
 * failed, or the tab closed mid-persist). Peers derive the shared URL from the
 * content-addressed id, so until this succeeds they 404. Runs at most once per
 * asset per session; success rewrites the stored src so later sessions skip it.
 */
async function retrySharedUploadForStoredRecord(record: StoredImageAssetRecord): Promise<void> {
  if (!isLocalAssetSrc(record.src)) return;
  if (!getConfiguredAssetBaseUrl()) return;
  if (sharedUploadRetriesInFlight.has(record.assetId)) return;
  sharedUploadRetriesInFlight.add(record.assetId);
  try {
    const sharedSrc = await uploadToSharedBackend(record.assetId, record.blob);
    if (sharedSrc) await storeRecord({ ...record, src: sharedSrc });
  } catch (error) {
    // Leave the local marker in place so the next session retries again.
    sharedUploadRetriesInFlight.delete(record.assetId);
    console.error("Failed to re-upload image asset to the shared backend", error);
  }
}

function getCachedObjectUrl(assetId: string) {
  return objectUrlCache.get(assetId) ?? null;
}

async function resolveLocalObjectUrl(assetId: string): Promise<string | null> {
  const cached = getCachedObjectUrl(assetId);
  if (cached) return cached;

  const blob = await loadImageAssetBlob(assetId);
  if (!blob) return null;

  const url = URL.createObjectURL(blob);
  objectUrlCache.set(assetId, url);
  return url;
}

async function uploadToSharedBackend(
  assetId: string,
  blob: Blob,
  abortSignal?: AbortSignal,
  kind?: "thumbnail",
): Promise<string | null> {
  const assetBaseUrl = getConfiguredAssetBaseUrl();
  if (!assetBaseUrl) return null;

  const uploadUrl = `${assetBaseUrl}/${encodeURIComponent(assetId)}`;
  const uploadKey = getConfiguredAssetUploadKey();
  const headers: Record<string, string> = {};
  if (blob.type) headers["Content-Type"] = blob.type;
  if (uploadKey) headers["X-Leaf-Asset-Key"] = uploadKey;
  if (kind) headers["X-Leaf-Asset-Kind"] = kind;

  const response = await fetch(uploadUrl, {
    method: SHARED_ASSET_UPLOAD_METHOD,
    body: blob,
    signal: abortSignal,
    headers,
  });

  if (!response.ok) {
    // Carry the HTTP status so callers can tell permanent rejections
    // (oversize bytes, missing/wrong upload key) from transient failures.
    throw new ImageAssetUploadError(
      `Failed to upload asset ${assetId}: ${response.status} ${response.statusText}`,
      classifyUploadStatus(response.status),
      response.status,
    );
  }

  try {
    const contentType = response.headers.get("Content-Type") || "";
    if (contentType.includes("application/json")) {
      const payload = (await response.json()) as { src?: string };
      if (payload.src) return payload.src;
    }
  } catch {
    // Ignore malformed response bodies and fall back to derived URL.
  }

  return getRemoteAssetUrl(assetId) ?? uploadUrl;
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

class DefaultImageAssetStore implements ImageAssetStore {
  async stage(blob: Blob, options: UploadImageAssetOptions): Promise<StagedImageAsset> {
    const mimeType = blob.type || "application/octet-stream";
    const normalizedBlob = normalizeBlob(blob, mimeType);
    const assetId = options.assetId ?? (await computeAssetId(normalizedBlob));
    const localAsset = normalizeImageAssetRef({
      assetId,
      src: buildLocalAssetSrc(assetId),
      mimeType,
      byteLength: normalizedBlob.size,
      width: options.naturalSize.width,
      height: options.naturalSize.height,
      sourceName: options.sourceName,
    });
    cacheRecord({ ...localAsset, blob: normalizedBlob });
    return {
      asset: localAsset,
      persist: (abortSignal?: AbortSignal) =>
        this.persistStaged(localAsset, normalizedBlob, abortSignal),
      discard: () => discardCachedRecord(assetId),
    };
  }

  async upload(blob: Blob, options: UploadImageAssetOptions, abortSignal?: AbortSignal) {
    const staged = await this.stage(blob, options);
    try {
      return await staged.persist(abortSignal);
    } catch (error) {
      // Eager uploads promise all-or-nothing: a failed persist must not leave
      // a memory-only blob behind. (The optimistic paste path calls persist
      // directly and deliberately keeps the blob so the node still renders.)
      staged.discard();
      throw error;
    }
  }

  private async persistStaged(
    localAsset: ImageAssetRef,
    normalizedBlob: Blob,
    abortSignal?: AbortSignal,
  ): Promise<ImageAssetRef> {
    const activeNativeDocument = await getActiveNativeDocument();
    // Bytes the shared backend will refuse are not worth an IndexedDB write
    // either: nothing could ever retry them into existence. The staged memory
    // copy stays so an already-committed node keeps rendering until its
    // caller withdraws it. Native documents never upload, so they are exempt.
    if (
      !activeNativeDocument &&
      getConfiguredAssetBaseUrl() &&
      normalizedBlob.size > MAX_SHARED_IMAGE_ASSET_BYTES
    ) {
      throw new ImageAssetUploadError(
        `Asset ${localAsset.assetId} exceeds the ${MAX_SHARED_IMAGE_ASSET_BYTES}-byte shared upload limit.`,
        "too-large",
        413,
      );
    }

    const localPersistence = await storeRecord(
      { ...localAsset, blob: normalizedBlob },
      activeNativeDocument,
    );
    const persistedLocally = localPersistence !== null;
    if (localPersistence === "native") return localAsset;

    // A failed persist throws but keeps the staged in-memory blob: the
    // optimistic paste path commits nodes before persisting, so discarding
    // here would destroy the only copy of bytes a committed node still
    // renders. Eager callers that want all-or-nothing (upload) discard in
    // their own catch.
    //
    // Transient failures resolve with the local ref (the stored local src is
    // the retry marker). Permanent rejections throw: no later retry can land
    // them, so silently returning a local ref would leave peers polling a URL
    // that never fills in.
    let sharedSrc: string | null = null;
    try {
      sharedSrc = await uploadToSharedBackend(localAsset.assetId, normalizedBlob, abortSignal);
    } catch (error) {
      if (
        isAbortError(error) ||
        !persistedLocally ||
        (error instanceof ImageAssetUploadError && error.isPermanent)
      ) {
        throw error;
      }
    }

    if (sharedSrc) {
      const sharedAsset = {
        ...localAsset,
        src: sharedSrc,
      };
      // The stored src doubles as the upload marker: rewriting it records that
      // the shared upload landed, so later sessions don't re-upload. A record
      // whose stored src is still local is retried by
      // retrySharedUploadForStoredRecord when it is next loaded.
      if (persistedLocally) {
        await storeRecord({ ...sharedAsset, blob: normalizedBlob });
      } else {
        cacheRecord({ ...sharedAsset, blob: normalizedBlob });
      }
      return sharedAsset;
    }

    if (!persistedLocally) {
      throw new Error("Failed to persist image asset locally and no shared upload succeeded.");
    }

    return localAsset;
  }

  async resolve(asset: ImageAssetRef, context?: ImageAssetResolveContext) {
    const normalizedAsset = normalizeImageAssetRef(asset);
    const localBlob = await loadImageAssetBlob(normalizedAsset.assetId);
    if (localBlob) {
      if (context?.shouldResolveToOriginal) {
        return await blobToDataUrl(localBlob);
      }

      const localUrl = await resolveLocalObjectUrl(normalizedAsset.assetId);
      if (localUrl) return localUrl;
    }
    if (isLocalAssetSrc(normalizedAsset.src)) {
      // Original resolution promises a data: URL (or null): callers like the
      // AI image reference and screenshot capture cannot use a remote URL
      // that may still 404 or taint a canvas.
      if (context?.shouldResolveToOriginal) return null;
      // No local bytes (a peer that never saw the paste, or a fresh session
      // before IndexedDB warms). Assets are content-addressed, so derive the
      // shared URL from the id instead of giving up — it becomes valid the
      // moment the uploader's background persist lands.
      return getRemoteAssetUrl(normalizedAsset.assetId);
    }
    return normalizedAsset.src ?? null;
  }
}

export function configureImageAssetStore(store: ImageAssetStore) {
  configuredImageAssetStore = store;
}

function getImageAssetStore(): ImageAssetStore {
  if (!configuredImageAssetStore) {
    configuredImageAssetStore = new DefaultImageAssetStore();
  }
  return configuredImageAssetStore;
}

export async function uploadImageAsset(
  blob: Blob,
  options: UploadImageAssetOptions,
  abortSignal?: AbortSignal,
): Promise<ImageAssetRef> {
  return await getImageAssetStore().upload(blob, options, abortSignal);
}

export function getCachedImageAssetUrl(asset: ImageAssetRef | null | undefined): string | null {
  if (!asset) return null;
  const cached = getCachedObjectUrl(asset.assetId);
  if (cached) return cached;

  const normalizedAsset = normalizeImageAssetRef(asset);
  if (!isLocalAssetSrc(normalizedAsset.src)) {
    return normalizedAsset.src ?? null;
  }

  return null;
}

export async function resolveImageAssetUrl(
  asset: ImageAssetRef | null | undefined,
  context?: ImageAssetResolveContext,
): Promise<string | null> {
  if (!asset) return null;
  return await getImageAssetStore().resolve(asset, context);
}

export async function uploadImageAssetFromFile(
  file: File,
  naturalSize: Size,
  abortSignal?: AbortSignal,
): Promise<ImageAssetRef> {
  return await uploadImageAsset(file, { naturalSize, sourceName: file.name }, abortSignal);
}

/**
 * Stage a pasted/dropped file so its node can render immediately from memory;
 * call `persist()` afterwards to run the normal durability pipeline. Falls
 * back to an eager upload for configured stores without staging support.
 */
export async function stageImageAssetFromFile(
  file: File,
  naturalSize: Size,
): Promise<StagedImageAsset> {
  const store = getImageAssetStore();
  const options: UploadImageAssetOptions = { naturalSize, sourceName: file.name };
  if (store.stage) return await store.stage(file, options);
  const asset = await store.upload(file, options);
  return { asset, persist: async () => asset, discard: () => {} };
}

/** True for URLs served by the configured shared asset backend. */
export function isSharedAssetUrl(url: string): boolean {
  const baseUrl = getConfiguredAssetBaseUrl();
  return !!baseUrl && url.startsWith(`${baseUrl}/`);
}

export async function discardUnreferencedNativeImageAsset(assetId: string): Promise<boolean> {
  const nativeDocument = getNativeImageAssetHost();
  if (!nativeDocument) return false;
  const state = await nativeDocument.getState();
  if (state.kind !== "document") return false;
  const discarded = await nativeDocument.discardAssetIfUnreferenced(assetId);
  if (discarded) {
    forgetNativeAsset(state.documentId, assetId);
    discardCachedRecord(assetId);
  }
  return discarded;
}

function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes as Uint8Array<ArrayBuffer>;
}

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  if (!dataUrl.startsWith("data:")) throw new Error("Invalid data URL");

  const separatorIndex = dataUrl.indexOf(",");
  if (separatorIndex === -1) throw new Error("Invalid data URL");

  const metadata = dataUrl.slice(5, separatorIndex);
  const payload = dataUrl.slice(separatorIndex + 1);
  const segments = metadata.split(";");
  const normalizedSegments = segments.map((segment) => segment.toLowerCase());
  const [firstSegment = "", ...remainingSegments] = segments;
  const hasExplicitMimeType =
    firstSegment.length > 0 &&
    firstSegment.toLowerCase() !== "base64" &&
    !firstSegment.includes("=");
  const mimeType = hasExplicitMimeType ? firstSegment : "application/octet-stream";
  const parameters = (hasExplicitMimeType ? remainingSegments : segments).filter(
    (segment) => segment.length > 0 && segment.toLowerCase() !== "base64",
  );
  const blobType = [mimeType, ...parameters].join(";");
  const isBase64 = normalizedSegments.includes("base64");

  if (isBase64) {
    const decodedBytes = decodeBase64(payload.replace(/\s+/g, ""));
    return new Blob([decodedBytes], { type: blobType });
  }

  return new Blob([decodeURIComponent(payload)], { type: blobType });
}

export async function uploadImageAssetFromDataUrl(
  dataUrl: string,
  naturalSize: Size,
  sourceName?: string,
  abortSignal?: AbortSignal,
): Promise<ImageAssetRef> {
  const blob = await dataUrlToBlob(dataUrl);
  return await uploadImageAsset(blob, { naturalSize, sourceName }, abortSignal);
}

export function resetImageAssetStateForTests(): void {
  for (const assetId of objectUrlCache.keys()) {
    revokeObjectUrl(assetId);
  }
  memoryAssetStore.clear();
  objectUrlCache.clear();
  nativeDocumentAssetCache.clear();
  sharedUploadRetriesInFlight.clear();
  databasePromise = null;
  configuredImageAssetStore = null;
}
