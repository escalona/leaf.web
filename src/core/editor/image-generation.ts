import { runInAction } from "mobx";
import type { EditorStore } from "../state/EditorStore";
import type { GeneratedImageJob, ImageGenerationMetadata, Size } from "../types";

export type ImageGenerationAspectRatio =
  | "auto"
  | "1:1"
  | "3:2"
  | "4:3"
  | "16:9"
  | "2:1"
  | "3:1"
  | "2:3"
  | "3:4"
  | "9:16"
  | "1:2"
  | "1:3";

export type ImageGenerationApiSize = Size | "auto";

export type ImageGenerationBackground = "auto" | "opaque" | "transparent";

export interface ImageGenerationOption {
  ratio: ImageGenerationAspectRatio;
  group: "Square" | "Landscape" | "Portrait";
  apiSize: ImageGenerationApiSize;
}

export const DEFAULT_IMAGE_GENERATION_RATIO: ImageGenerationAspectRatio = "auto";
export const DEFAULT_IMAGE_GENERATION_BACKGROUND: ImageGenerationBackground = "auto";

const AUTO_IMAGE_GENERATION_FALLBACK_SIZE: Size = { width: 1024, height: 1024 };

export const IMAGE_GENERATION_OPTIONS: ImageGenerationOption[] = [
  { group: "Square", ratio: "auto", apiSize: "auto" },
  { group: "Square", ratio: "1:1", apiSize: { width: 1024, height: 1024 } },
  { group: "Landscape", ratio: "3:2", apiSize: { width: 1536, height: 1024 } },
  { group: "Landscape", ratio: "4:3", apiSize: { width: 1344, height: 1008 } },
  { group: "Landscape", ratio: "16:9", apiSize: { width: 1536, height: 864 } },
  { group: "Landscape", ratio: "2:1", apiSize: { width: 1536, height: 768 } },
  { group: "Landscape", ratio: "3:1", apiSize: { width: 1536, height: 512 } },
  { group: "Portrait", ratio: "2:3", apiSize: { width: 1024, height: 1536 } },
  { group: "Portrait", ratio: "3:4", apiSize: { width: 1008, height: 1344 } },
  { group: "Portrait", ratio: "9:16", apiSize: { width: 864, height: 1536 } },
  { group: "Portrait", ratio: "1:2", apiSize: { width: 768, height: 1536 } },
  { group: "Portrait", ratio: "1:3", apiSize: { width: 512, height: 1536 } },
];

export function getImageGenerationOption(ratio: ImageGenerationAspectRatio) {
  return (
    IMAGE_GENERATION_OPTIONS.find((option) => option.ratio === ratio) ?? IMAGE_GENERATION_OPTIONS[0]
  );
}

export function formatImageGenerationSize(size: ImageGenerationApiSize) {
  if (size === "auto") return "auto";
  return `${size.width}x${size.height}`;
}

export function getImageGenerationCanvasSize(
  size: ImageGenerationApiSize,
  maxLongEdge = 640,
): Size {
  const resolvedSize = size === "auto" ? AUTO_IMAGE_GENERATION_FALLBACK_SIZE : size;
  const scale = Math.min(1, maxLongEdge / Math.max(resolvedSize.width, resolvedSize.height));
  return {
    width: Math.max(1, Math.round(resolvedSize.width * scale)),
    height: Math.max(1, Math.round(resolvedSize.height * scale)),
  };
}

export function getGeneratedImageName(prompt: string) {
  const normalizedPrompt = prompt.trim().replace(/\s+/g, " ");
  if (!normalizedPrompt) return "Generated Image";
  return `${normalizedPrompt.slice(0, 48)}`;
}

export function getGeneratedImageResultName(prompt: string, count: number, index: number) {
  const baseName = getGeneratedImageName(prompt);
  return count === 1 ? baseName : `${baseName} ${index + 1}`;
}

// ─── Interrupted-generation reconciliation ───────────────────────────────────
//
// `ImageGenerationMetadata.status` syncs durably, but the request that will
// eventually flip it lives only in the tab that started it. A reload strands
// "generating" placeholders forever. The durable record schema is strict, so
// ownership is recorded tab-locally instead: `sessionStorage` survives a reload
// of the same tab and is never visible to other tabs or peers, so a peer can
// never fail a node another live client is still generating.

export const INTERRUPTED_IMAGE_GENERATION_MESSAGE = "Generation interrupted";

/**
 * A placeholder whose durable `startedAt` is older than this is failed by any
 * client, owned or not: no provider request survives that long, so the session
 * that started it is gone (a closed tab, a crashed peer) and nothing else will
 * ever finish the node. Generous enough that a slow but live request is never
 * failed under its owner.
 */
export const STALE_IMAGE_GENERATION_MS = 10 * 60 * 1000;
/** How often an open session re-checks for stale placeholders. */
export const STALE_IMAGE_GENERATION_RECHECK_MS = 60 * 1000;

const IMAGE_GENERATION_OWNERSHIP_KEY = "leaf:image-generation:owned";
/** Markers older than this are dropped so an abandoned tab store cannot grow. */
const IMAGE_GENERATION_OWNERSHIP_TTL_MS = 24 * 60 * 60 * 1000;

export type ImageGenerationOwnershipStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type OwnershipRecord = Record<string, number>;

function getDefaultOwnershipStorage(): ImageGenerationOwnershipStorage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function readOwnership(storage: ImageGenerationOwnershipStorage, now: number): OwnershipRecord {
  try {
    const raw = storage.getItem(IMAGE_GENERATION_OWNERSHIP_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record: OwnershipRecord = {};
    for (const [nodeId, startedAt] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) continue;
      if (now - startedAt > IMAGE_GENERATION_OWNERSHIP_TTL_MS) continue;
      record[nodeId] = startedAt;
    }
    return record;
  } catch {
    return {};
  }
}

function writeOwnership(storage: ImageGenerationOwnershipStorage, record: OwnershipRecord) {
  try {
    if (Object.keys(record).length === 0) {
      storage.removeItem(IMAGE_GENERATION_OWNERSHIP_KEY);
      return;
    }
    storage.setItem(IMAGE_GENERATION_OWNERSHIP_KEY, JSON.stringify(record));
  } catch {
    // Storage quota or privacy mode: ownership simply is not remembered.
  }
}

/** Record that this tab started generating into the given placeholder nodes. */
export function markImageGenerationsOwned(
  nodeIds: readonly string[],
  options: { storage?: ImageGenerationOwnershipStorage | null; now?: number } = {},
) {
  const storage = options.storage === undefined ? getDefaultOwnershipStorage() : options.storage;
  if (!storage || nodeIds.length === 0) return;
  const now = options.now ?? Date.now();
  const record = readOwnership(storage, now);
  for (const nodeId of nodeIds) record[nodeId] = now;
  writeOwnership(storage, record);
}

/** Forget ownership once a generation reaches a terminal state. */
export function clearImageGenerationOwnership(
  nodeIds: readonly string[],
  options: { storage?: ImageGenerationOwnershipStorage | null; now?: number } = {},
) {
  const storage = options.storage === undefined ? getDefaultOwnershipStorage() : options.storage;
  if (!storage || nodeIds.length === 0) return;
  const record = readOwnership(storage, options.now ?? Date.now());
  for (const nodeId of nodeIds) delete record[nodeId];
  writeOwnership(storage, record);
}

/** Node ids this tab started generating for, oldest first. */
export function listOwnedImageGenerations(
  options: { storage?: ImageGenerationOwnershipStorage | null; now?: number } = {},
): string[] {
  const storage = options.storage === undefined ? getDefaultOwnershipStorage() : options.storage;
  if (!storage) return [];
  return Object.entries(readOwnership(storage, options.now ?? Date.now()))
    .sort(([, left], [, right]) => left - right)
    .map(([nodeId]) => nodeId);
}

export interface InterruptedGenerationCandidate {
  id: string;
  imageGeneration?: ImageGenerationMetadata | null;
}

/**
 * Pure selection of the placeholders this tab owns whose request is gone: the
 * node still says "generating" but no live job in this session will finish it.
 * Nodes owned by other tabs or peers are never returned; nodes that already
 * reached a terminal state are returned under `settled` so their marker can be
 * dropped.
 */
export function findInterruptedImageGenerations(
  ownedNodeIds: readonly string[],
  getNode: (nodeId: string) => InterruptedGenerationCandidate | undefined,
  liveJobs: ReadonlyMap<string, { status: GeneratedImageJob["status"] }>,
  stale: {
    /** Every node in the document; those with a stale `startedAt` are failed too. */
    candidates?: Iterable<InterruptedGenerationCandidate>;
    now?: number;
    staleAfterMs?: number;
  } = {},
): { interrupted: string[]; settled: string[] } {
  const interrupted: string[] = [];
  const settled: string[] = [];
  for (const nodeId of ownedNodeIds) {
    const node = getNode(nodeId);
    if (!node) continue;
    const status = node.imageGeneration?.status;
    if (status !== "generating") {
      settled.push(nodeId);
      continue;
    }
    if (liveJobs.get(nodeId)?.status === "generating") continue;
    interrupted.push(nodeId);
  }
  if (stale.candidates) {
    const now = stale.now ?? Date.now();
    const staleAfterMs = stale.staleAfterMs ?? STALE_IMAGE_GENERATION_MS;
    for (const node of stale.candidates) {
      const generation = node.imageGeneration;
      if (generation?.status !== "generating") continue;
      if (typeof generation.startedAt !== "number") continue;
      if (now - generation.startedAt < staleAfterMs) continue;
      if (liveJobs.get(node.id)?.status === "generating") continue;
      if (!interrupted.includes(node.id)) interrupted.push(node.id);
    }
  }
  return { interrupted, settled };
}

/**
 * Flip orphaned "generating" placeholders to a failed state: the ones this tab
 * marked as its own whose request is gone, plus any node whose durable
 * `startedAt` is stale enough that no session can still be working on it.
 * Safe to call whenever the document changes; returns the ids it failed.
 */
export function reconcileInterruptedImageGenerations(
  store: Pick<
    EditorStore,
    | "getNode"
    | "nodeMap"
    | "generatedImageJobs"
    | "runtime"
    | "beginHistoryTransaction"
    | "endHistoryTransaction"
  >,
  options: {
    storage?: ImageGenerationOwnershipStorage | null;
    now?: number;
    staleAfterMs?: number;
  } = {},
): string[] {
  const owned = listOwnedImageGenerations(options);
  const { interrupted, settled } = findInterruptedImageGenerations(
    owned,
    (nodeId) => store.getNode(nodeId),
    store.generatedImageJobs,
    { candidates: store.nodeMap.values(), now: options.now, staleAfterMs: options.staleAfterMs },
  );
  if (interrupted.length > 0) {
    runInAction(() => {
      store.beginHistoryTransaction();
      try {
        for (const nodeId of interrupted) {
          const node = store.getNode(nodeId);
          if (!node?.imageGeneration) continue;
          store.runtime.updateNode(nodeId, {
            imageGeneration: {
              ...node.imageGeneration,
              status: "failed",
              error: INTERRUPTED_IMAGE_GENERATION_MESSAGE,
            },
          });
        }
      } finally {
        store.endHistoryTransaction();
      }
    });
  }
  clearImageGenerationOwnership([...interrupted, ...settled], options);
  return interrupted;
}
