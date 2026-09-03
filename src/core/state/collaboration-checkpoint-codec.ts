import {
  LEAF_MAX_CHECKPOINT_CHUNKS,
  LEAF_MAX_CHECKPOINT_MANIFEST_BYTES,
  LEAF_MAX_RECORD_SCHEMA_VERSION,
  LEAF_MIN_RECORD_SCHEMA_VERSION,
  LEAF_WORKER_ROUTES,
  LeafRecordDirectory,
  buildLeafWorkerRoutePath,
  parseLeafCheckpointDetail,
  parseLeafCheckpointDirectory,
  parseLeafCheckpointHeaderPage,
  parseLeafCheckpointManifest,
  resolveLeafCheckpointShardClosure,
  type LeafCheckpointDirectoryPayload,
  type LeafCheckpointManifest,
  type LeafCheckpointReference,
  type LeafNodeRecord,
  type LeafRecordHeader,
  type LeafRecordSnapshot,
  type LeafRoomIdentity,
} from "../shared/collaboration";
import { fetchWithGlobalReceiver } from "./global-fetch";

const MAX_CHECKPOINT_HEADER_BYTES = 64 * 1024 * 1024;
const MAX_PARALLEL_CHUNK_FETCHES = 4;
const LEGACY_COMPONENT_RECORD_SCHEMA_VERSION = 4;
const LEGACY_CHECKPOINT_PARSE_OPTIONS = { allowEmptyLegacyComponentSchema: true } as const;

/**
 * Pre-v3 checkpoints stay loadable; they simply carry no comment lane. The
 * abandoned v4 envelope is readable only through the guarded chunk parsers,
 * which reject component metadata and instance records rather than dropping
 * them.
 */
function isSupportedCheckpointSchema(schemaVersion: number) {
  return (
    (schemaVersion >= LEAF_MIN_RECORD_SCHEMA_VERSION &&
      schemaVersion <= LEAF_MAX_RECORD_SCHEMA_VERSION) ||
    schemaVersion === LEGACY_COMPONENT_RECORD_SCHEMA_VERSION
  );
}

export type LeafCheckpointLoadRequest = {
  accessToken: string;
  identity: LeafRoomIdentity;
  reference: LeafCheckpointReference;
  workerBaseUrl: string;
};

export type LeafCheckpointDirectoryLoadResult = {
  format: "sharded";
  manifest: LeafCheckpointManifest;
  shardDirectory: LeafCheckpointDirectoryPayload;
  headers: LeafRecordHeader[];
};

export type LeafCheckpointShardLoadRequest = {
  accessToken: string;
  identity: LeafRoomIdentity;
  manifest: LeafCheckpointManifest;
  shardDirectory: LeafCheckpointDirectoryPayload;
  requestedShardIds: string[];
  skipShardIds: string[];
  workerBaseUrl: string;
};

export type LeafCheckpointLoadedShard = { shardId: string; records: LeafNodeRecord[] };

export type LeafCheckpointShardLoadResult = {
  requestedShardIds: string[];
  resolvedShardIds: string[];
  shards: LeafCheckpointLoadedShard[];
};

export type LeafCheckpointLoadResult = {
  manifest: LeafCheckpointManifest;
  snapshot: LeafRecordSnapshot;
};

export type LeafCheckpointWorkerOperation =
  | { type: "directory"; request: LeafCheckpointLoadRequest }
  | { type: "shards"; request: LeafCheckpointShardLoadRequest };

export type LeafCheckpointWorkerResult =
  | LeafCheckpointDirectoryLoadResult
  | LeafCheckpointShardLoadResult;

/** Loads only the manifest, shard directory, and complete header pages when possible. */
export async function fetchAndDecodeLeafCheckpointDirectory(
  request: LeafCheckpointLoadRequest,
  fetcher: typeof fetch = fetchWithGlobalReceiver,
  signal?: AbortSignal,
): Promise<LeafCheckpointDirectoryLoadResult> {
  validateLoadRequest(request);
  throwIfAborted(signal);
  const manifest = await fetchManifest(request, fetcher, signal);
  if (!isSupportedCheckpointSchema(manifest.schemaVersion)) {
    throw new Error("Checkpoint schema is unsupported");
  }
  if (manifest.chunks[0]?.kind !== "header") {
    throw new Error("Checkpoint sharded format must begin with a directory chunk");
  }
  const directoryBytes = await fetchChunk(request, manifest.chunks[0], fetcher, signal);
  const shardDirectory = parseLeafCheckpointDirectory(
    directoryBytes,
    LEGACY_CHECKPOINT_PARSE_OPTIONS,
  );
  validateShardedLayout(manifest, shardDirectory);
  const headerDescriptors = manifest.chunks.slice(1, 1 + shardDirectory.headerPageCount);
  const headerBytes = headerDescriptors.reduce((total, chunk) => total + chunk.byteLength, 0);
  if (headerBytes > MAX_CHECKPOINT_HEADER_BYTES) {
    throw new Error("Checkpoint headers exceed the bounded decode budget");
  }
  const pages = await mapConcurrent(
    headerDescriptors,
    MAX_PARALLEL_CHUNK_FETCHES,
    async (descriptor, index) => {
      const bytes = await fetchChunk(request, descriptor, fetcher, signal);
      const page = parseLeafCheckpointHeaderPage(bytes, LEGACY_CHECKPOINT_PARSE_OPTIONS);
      if (page.pageIndex !== index) throw new Error("Checkpoint header page index is invalid");
      if (page.schemaVersion !== manifest.schemaVersion) {
        throw new Error("Checkpoint header schema does not match its manifest");
      }
      return page;
    },
    signal,
  );
  const headers = pages.flatMap((page) => page.headers);
  const recordCount = shardDirectory.shards.reduce((total, shard) => total + shard.recordCount, 0);
  if (headers.length !== recordCount) {
    throw new Error("Checkpoint headers do not match the shard record count");
  }
  const directory = new LeafRecordDirectory(headers);
  const descriptors = new Map(shardDirectory.shards.map((shard) => [shard.shardId, shard]));
  for (const shard of shardDirectory.shards) {
    if (directory.getShardHeaders(shard.shardId).length !== shard.recordCount) {
      throw new Error(`Checkpoint header coverage is invalid for shard ${shard.shardId}`);
    }
  }
  for (const header of headers) {
    const descriptor = descriptors.get(header.detailShardId);
    if (
      !descriptor ||
      header.dependencyShardIds.some(
        (dependency) =>
          dependency === header.detailShardId ||
          !descriptor.dependencyShardIds.includes(dependency),
      )
    ) {
      throw new Error(`Checkpoint header shard identity is invalid for node ${header.id}`);
    }
  }
  return { format: "sharded", manifest, shardDirectory, headers };
}

/** Fetches selected detail shards and their transitive dependency closure. */
export async function fetchAndDecodeLeafCheckpointShards(
  request: LeafCheckpointShardLoadRequest,
  fetcher: typeof fetch = fetchWithGlobalReceiver,
  signal?: AbortSignal,
): Promise<LeafCheckpointShardLoadResult> {
  validateShardLoadRequest(request);
  throwIfAborted(signal);
  const manifest = parseLeafCheckpointManifest(request.manifest, request.identity);
  validateShardedLayout(manifest, request.shardDirectory);
  const requestedShardIds = [...new Set(request.requestedShardIds)];
  const resolvedShardIds = resolveLeafCheckpointShardClosure(
    request.shardDirectory,
    requestedShardIds,
  );
  const skip = new Set(request.skipShardIds);
  if ([...skip].some((shardId) => !resolvedShardIds.includes(shardId))) {
    throw new Error("Checkpoint skipped shard is outside the requested dependency closure");
  }
  const descriptors = new Map(request.shardDirectory.shards.map((shard) => [shard.shardId, shard]));
  const missing = resolvedShardIds.filter((shardId) => !skip.has(shardId));
  const shards = await mapConcurrent(
    missing,
    MAX_PARALLEL_CHUNK_FETCHES,
    async (shardId) => {
      const descriptor = descriptors.get(shardId)!;
      const manifestChunk = manifest.chunks[descriptor.chunkIndex];
      if (!manifestChunk || manifestChunk.kind !== "detail") {
        throw new Error(`Checkpoint shard ${shardId} has an invalid manifest index`);
      }
      const bytes = await fetchChunkFromManifest(
        request.workerBaseUrl,
        request.accessToken,
        request.identity,
        manifestChunk,
        fetcher,
        signal,
      );
      const detail = parseLeafCheckpointDetail(bytes, LEGACY_CHECKPOINT_PARSE_OPTIONS);
      if (detail.schemaVersion !== manifest.schemaVersion) {
        throw new Error("Checkpoint detail schema does not match its manifest");
      }
      if (detail.shardId !== shardId || detail.records.length !== descriptor.recordCount) {
        throw new Error(`Checkpoint detail identity is invalid for shard ${shardId}`);
      }
      return { shardId, records: detail.records };
    },
    signal,
  );
  const recordIds = new Set<string>();
  for (const shard of shards) {
    for (const record of shard.records) {
      if (recordIds.has(record.id))
        throw new Error(`Checkpoint detail duplicates node ${record.id}`);
      recordIds.add(record.id);
    }
  }
  return { requestedShardIds, resolvedShardIds, shards };
}

function validateShardedLayout(
  manifest: LeafCheckpointManifest,
  directory: LeafCheckpointDirectoryPayload,
) {
  if (!isSupportedCheckpointSchema(manifest.schemaVersion)) {
    throw new Error("Checkpoint schema is unsupported");
  }
  if (manifest.schemaVersion !== directory.schemaVersion) {
    throw new Error("Checkpoint directory schema does not match its manifest");
  }
  // A published manifest may carry journal (and future dependency) chunks past
  // the snapshot layout — the Worker appends externally durable journal pages
  // after the directory, header, and detail chunks. The snapshot layout check
  // therefore anchors header/detail chunks exactly and only requires that no
  // header or detail chunk exists outside the shard directory's map.
  const snapshotChunkCount = 1 + directory.headerPageCount + directory.shards.length;
  if (
    manifest.chunks.length < snapshotChunkCount ||
    manifest.chunks.length > LEAF_MAX_CHECKPOINT_CHUNKS
  ) {
    throw new Error("Checkpoint manifest does not match its shard directory");
  }
  for (let index = 0; index <= directory.headerPageCount; index += 1) {
    if (manifest.chunks[index]?.kind !== "header") {
      throw new Error("Checkpoint header chunk indexes are invalid");
    }
  }
  const detailChunkIndexes = new Set<number>();
  for (const shard of directory.shards) {
    if (manifest.chunks[shard.chunkIndex]?.kind !== "detail") {
      throw new Error(`Checkpoint detail chunk index is invalid for shard ${shard.shardId}`);
    }
    detailChunkIndexes.add(shard.chunkIndex);
  }
  manifest.chunks.forEach((chunk, index) => {
    if (chunk.kind === "header" && index > directory.headerPageCount) {
      throw new Error("Checkpoint header chunk indexes are invalid");
    }
    if (chunk.kind === "detail" && !detailChunkIndexes.has(index)) {
      throw new Error("Checkpoint manifest does not match its shard directory");
    }
  });
}

async function fetchManifest(
  request: LeafCheckpointLoadRequest,
  fetcher: typeof fetch,
  signal?: AbortSignal,
) {
  const url = workerRoute(
    request.workerBaseUrl,
    buildLeafWorkerRoutePath("getCheckpointManifest", {
      branchId: request.identity.branchId,
      checkpointId: request.reference.checkpointId,
      fileId: request.identity.fileId,
    }),
  );
  const response = await fetcher(url, {
    headers: { Authorization: `Bearer ${request.accessToken}` },
    method: LEAF_WORKER_ROUTES.getCheckpointManifest.method,
    signal,
  });
  if (!response.ok) throw new Error(`Checkpoint manifest request failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (
    bytes.byteLength !== request.reference.manifestByteLength ||
    bytes.byteLength > LEAF_MAX_CHECKPOINT_MANIFEST_BYTES
  ) {
    throw new Error("Checkpoint manifest byte length does not match its reference");
  }
  await assertSha256(bytes, request.reference.manifestSha256, "manifest");
  const manifest = parseLeafCheckpointManifest(
    parseJson(bytes, "Checkpoint manifest is not valid JSON"),
    request.identity,
  );
  if (
    manifest.checkpointId !== request.reference.checkpointId ||
    manifest.streamEpoch !== request.reference.streamEpoch ||
    manifest.revision !== request.reference.revision
  ) {
    throw new Error("Checkpoint manifest does not match its authoritative reference");
  }
  return manifest;
}

async function fetchChunk(
  request: LeafCheckpointLoadRequest,
  descriptor: LeafCheckpointManifest["chunks"][number],
  fetcher: typeof fetch,
  signal?: AbortSignal,
) {
  return await fetchChunkFromManifest(
    request.workerBaseUrl,
    request.accessToken,
    request.identity,
    descriptor,
    fetcher,
    signal,
  );
}

async function fetchChunkFromManifest(
  workerBaseUrl: string,
  accessToken: string,
  identity: LeafRoomIdentity,
  descriptor: LeafCheckpointManifest["chunks"][number],
  fetcher: typeof fetch,
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  const url = workerRoute(
    workerBaseUrl,
    buildLeafWorkerRoutePath("getCheckpointChunk", {
      branchId: identity.branchId,
      chunkHash: descriptor.sha256,
      fileId: identity.fileId,
    }),
  );
  const response = await fetcher(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    method: LEAF_WORKER_ROUTES.getCheckpointChunk.method,
    signal,
  });
  if (!response.ok) throw new Error(`Checkpoint chunk request failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== descriptor.byteLength) {
    throw new Error(`Checkpoint chunk ${descriptor.index} byte length is invalid`);
  }
  await assertSha256(bytes, descriptor.sha256, `chunk ${descriptor.index}`);
  return bytes;
}

async function mapConcurrent<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  mapper: (value: Input, index: number) => Promise<Output>,
  signal?: AbortSignal,
) {
  const results: Output[] = Array.from({ length: values.length });
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      throwIfAborted(signal);
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function validateLoadRequest(request: LeafCheckpointLoadRequest) {
  if (
    !request.accessToken.trim() ||
    !request.identity.workspaceId ||
    !request.identity.fileId ||
    !request.identity.branchId ||
    !request.reference.checkpointId ||
    request.reference.manifestByteLength <= 0 ||
    request.reference.manifestByteLength > LEAF_MAX_CHECKPOINT_MANIFEST_BYTES ||
    !/^[0-9a-f]{64}$/.test(request.reference.manifestSha256) ||
    !Number.isSafeInteger(request.reference.revision) ||
    request.reference.revision < 0 ||
    !request.reference.streamEpoch ||
    request.reference.checkpointId.length > 512 ||
    request.workerBaseUrl.length > 2_048
  ) {
    throw new Error("Checkpoint load request is invalid");
  }
  validateWorkerUrl(request.workerBaseUrl);
}

function validateShardLoadRequest(request: LeafCheckpointShardLoadRequest) {
  if (
    !request.accessToken.trim() ||
    !isIdentity(request.identity) ||
    request.requestedShardIds.length > LEAF_MAX_CHECKPOINT_CHUNKS ||
    request.skipShardIds.length > LEAF_MAX_CHECKPOINT_CHUNKS ||
    [...request.requestedShardIds, ...request.skipShardIds].some(
      (shardId) => !shardId || shardId.length > 256,
    )
  ) {
    throw new Error("Checkpoint shard load request is invalid");
  }
  validateWorkerUrl(request.workerBaseUrl);
}

function workerRoute(workerBaseUrl: string, path: string) {
  return `${workerBaseUrl.replace(/\/+$/, "")}${path}`;
}

async function assertSha256(bytes: Uint8Array, expected: string, label: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer),
  );
  const actual = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (actual !== expected) throw new Error(`Checkpoint ${label} checksum is invalid`);
}

function parseJson(bytes: Uint8Array, message: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new Error(message, { cause: error });
  }
}

function validateWorkerUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Checkpoint Worker URL must use HTTP or HTTPS");
  }
}

function isIdentity(value: LeafRoomIdentity) {
  return !!value.workspaceId && !!value.fileId && !!value.branchId;
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("Checkpoint load aborted", "AbortError");
}
