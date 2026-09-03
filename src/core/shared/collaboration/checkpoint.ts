import type { LeafRoomIdentity } from "./protocol";

export const LEAF_CHECKPOINT_FORMAT_VERSION = 1 as const;
export const LEAF_MAX_CHECKPOINT_CHUNKS = 512;
export const LEAF_MAX_CHECKPOINT_CHUNK_BYTES = 8 * 1024 * 1024;
export const LEAF_MAX_CHECKPOINT_MANIFEST_BYTES = 1024 * 1024;

export type LeafCheckpointChunkKind = "dependency" | "detail" | "header" | "journal";

export type LeafCheckpointChunkDescriptor = {
  byteLength: number;
  index: number;
  key: string;
  kind: LeafCheckpointChunkKind;
  sha256: string;
};

export type LeafCheckpointManifest = LeafRoomIdentity & {
  checkpointId: string;
  chunks: LeafCheckpointChunkDescriptor[];
  createdAt: string;
  formatVersion: typeof LEAF_CHECKPOINT_FORMAT_VERSION;
  previousCheckpointId: string | null;
  revision: number;
  schemaVersion: number;
  streamEpoch: string;
};

export type LeafCheckpointReference = {
  checkpointId: string;
  manifestByteLength: number;
  manifestSha256: string;
  revision: number;
  streamEpoch: string;
};

export type LeafBranchCheckpointDescriptor = LeafRoomIdentity & LeafCheckpointReference;

export function parseLeafCheckpointManifest(
  value: unknown,
  expectedIdentity?: LeafRoomIdentity,
): LeafCheckpointManifest {
  if (!isRecord(value) || !Array.isArray(value.chunks)) {
    throw new Error("Checkpoint manifest is invalid");
  }
  const manifest = value as LeafCheckpointManifest;
  if (
    manifest.formatVersion !== LEAF_CHECKPOINT_FORMAT_VERSION ||
    !isBoundedId(manifest.checkpointId) ||
    !isBoundedId(manifest.workspaceId) ||
    !isBoundedId(manifest.fileId) ||
    !isBoundedId(manifest.branchId) ||
    !isBoundedId(manifest.streamEpoch) ||
    !Number.isSafeInteger(manifest.revision) ||
    manifest.revision < 0 ||
    !Number.isSafeInteger(manifest.schemaVersion) ||
    manifest.schemaVersion < 1 ||
    !Number.isFinite(Date.parse(manifest.createdAt)) ||
    (manifest.previousCheckpointId !== null && !isBoundedId(manifest.previousCheckpointId)) ||
    manifest.chunks.length < 1 ||
    manifest.chunks.length > LEAF_MAX_CHECKPOINT_CHUNKS
  ) {
    throw new Error("Checkpoint manifest is invalid");
  }
  if (
    expectedIdentity &&
    (manifest.workspaceId !== expectedIdentity.workspaceId ||
      manifest.fileId !== expectedIdentity.fileId ||
      manifest.branchId !== expectedIdentity.branchId)
  ) {
    throw new Error("Checkpoint manifest belongs to another branch");
  }
  const prefix = checkpointPrefix(manifest);
  for (let index = 0; index < manifest.chunks.length; index += 1) {
    const chunk = manifest.chunks[index];
    if (
      !chunk ||
      chunk.index !== index ||
      !Number.isSafeInteger(chunk.byteLength) ||
      chunk.byteLength < 1 ||
      chunk.byteLength > LEAF_MAX_CHECKPOINT_CHUNK_BYTES ||
      !isSha256(chunk.sha256) ||
      !isLeafCheckpointChunkKind(chunk.kind) ||
      chunk.key !== `${prefix}/chunks/${chunk.sha256}`
    ) {
      throw new Error("Checkpoint chunk descriptor is invalid");
    }
  }
  return structuredClone(manifest);
}

export function checkpointPrefix(identity: LeafRoomIdentity) {
  return [
    "v1",
    encodeURIComponent(identity.workspaceId),
    encodeURIComponent(identity.fileId),
    encodeURIComponent(identity.branchId),
  ].join("/");
}

function isLeafCheckpointChunkKind(value: unknown): value is LeafCheckpointChunkKind {
  return value === "dependency" || value === "detail" || value === "header" || value === "journal";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
