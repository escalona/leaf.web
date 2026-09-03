import { leafRecordToHeader, type LeafRecordHeader } from "./directory";
import { LEAF_MAX_CHECKPOINT_CHUNKS } from "./checkpoint";
import { createLeafRecordMap, normalizeLeafPages, type LeafRecordMap } from "./model";
import {
  LEAF_MAX_COMMENT_RECORDS,
  LEAF_MAX_DOCUMENT_PAGES,
  LEAF_MAX_RECORD_SCHEMA_VERSION,
  LEAF_MIN_RECORD_SCHEMA_VERSION,
  LEAF_RECORD_SCHEMA_VERSION,
  getLeafComments,
  getLeafPages,
  isLeafCommentRecord,
  isLeafNodeRecord,
  isLeafPageRecord,
  type LeafCommentRecord,
  type LeafNodeRecord,
  type LeafPageRecord,
  type LeafRecordSnapshot,
} from "./protocol";

const LEGACY_COMPONENT_RECORD_SCHEMA_VERSION = 4;

export type LeafCheckpointParseOptions = {
  /**
   * Reads the abandoned v4 component-era envelope only when its component
   * lane is empty and every node still satisfies the current record schema.
   * This is deliberately checkpoint-local: v4 is not a writable protocol
   * version and component instances must never be discarded during decode.
   */
  allowEmptyLegacyComponentSchema?: boolean;
};

/**
 * Checkpoint payloads are readable across the record-schema compatibility
 * window: a pre-v3 checkpoint simply has no comment lane. New payloads always
 * stamp the current version.
 */
function isSupportedPayloadSchemaVersion(
  value: unknown,
  options?: LeafCheckpointParseOptions,
): value is number {
  return (
    Number.isSafeInteger(value) &&
    (((value as number) >= LEAF_MIN_RECORD_SCHEMA_VERSION &&
      (value as number) <= LEAF_MAX_RECORD_SCHEMA_VERSION) ||
      (options?.allowEmptyLegacyComponentSchema === true &&
        value === LEGACY_COMPONENT_RECORD_SCHEMA_VERSION))
  );
}

export const LEAF_SHARDED_CHECKPOINT_PAYLOAD_VERSION = 1 as const;
const DEFAULT_DETAIL_RECORDS = 1_000;
const DEFAULT_DETAIL_BYTES = 1_500_000;
const DEFAULT_HEADER_RECORDS = 2_000;
const DEFAULT_HEADER_BYTES = 500_000;

export type LeafCheckpointShardDescriptor = {
  chunkIndex: number;
  dependencyShardIds: string[];
  recordCount: number;
  shardId: string;
};

/** Re-exported under the checkpoint name so the directory bound cannot drift from the protocol's. */
export const LEAF_MAX_CHECKPOINT_PAGES = LEAF_MAX_DOCUMENT_PAGES;

export type LeafCheckpointDirectoryPayload = {
  headerPageCount: number;
  kind: "directory";
  /** Document page list. Detail shards only carry `record.pageId`. */
  pages: LeafPageRecord[];
  /** Comment lane. Absent on pre-v3 checkpoints; reads as empty. */
  comments?: LeafCommentRecord[];
  payloadVersion: typeof LEAF_SHARDED_CHECKPOINT_PAYLOAD_VERSION;
  schemaVersion: number;
  shards: LeafCheckpointShardDescriptor[];
};

export type LeafCheckpointHeaderPagePayload = {
  headers: LeafRecordHeader[];
  kind: "headers";
  pageIndex: number;
  payloadVersion: typeof LEAF_SHARDED_CHECKPOINT_PAYLOAD_VERSION;
  schemaVersion: number;
};

export type LeafCheckpointDetailPayload = {
  kind: "detail";
  payloadVersion: typeof LEAF_SHARDED_CHECKPOINT_PAYLOAD_VERSION;
  records: LeafNodeRecord[];
  schemaVersion: number;
  shardId: string;
};

export type LeafPreparedCheckpointChunk = {
  bytes: Uint8Array;
  kind: "detail" | "header";
  shardId?: string;
};

export type LeafCheckpointShardOptions = {
  detailByteLimit?: number;
  detailRecordLimit?: number;
  headerByteLimit?: number;
  headerRecordLimit?: number;
};

/** Encodes a snapshot into a small directory, paged headers, and bounded detail shards. */
export function prepareLeafShardedCheckpoint(
  snapshot: LeafRecordSnapshot,
  options: LeafCheckpointShardOptions = {},
): LeafPreparedCheckpointChunk[] {
  if (snapshot.schemaVersion !== LEAF_RECORD_SCHEMA_VERSION) {
    throw new Error("Checkpoint snapshot schema is unsupported");
  }
  const records = createLeafRecordMap(snapshot.records);
  const detailRecordLimit = boundedLimit(
    options.detailRecordLimit,
    DEFAULT_DETAIL_RECORDS,
    1,
    2_000,
  );
  const detailByteLimit = boundedLimit(
    options.detailByteLimit,
    DEFAULT_DETAIL_BYTES,
    64 * 1024,
    7 * 1024 * 1024,
  );
  const headerRecordLimit = boundedLimit(
    options.headerRecordLimit,
    DEFAULT_HEADER_RECORDS,
    1,
    10_000,
  );
  const headerByteLimit = boundedLimit(
    options.headerByteLimit,
    DEFAULT_HEADER_BYTES,
    32 * 1024,
    900_000,
  );
  const ordered = preorder(records);
  const detailGroups = packRecords(ordered, detailRecordLimit, detailByteLimit);
  const shardByRecord = new Map<string, string>();
  detailGroups.forEach((group, index) => {
    const rootId = group[0]?.id ?? "empty";
    const shardId = `detail-${String(index).padStart(6, "0")}-${boundedShardSegment(rootId)}`;
    for (const record of group) shardByRecord.set(record.id, shardId);
  });
  const dependenciesByRecord = buildDependencies(records, shardByRecord);
  const headers = ordered.map((record) =>
    leafRecordToHeader(
      record,
      shardByRecord.get(record.id)!,
      dependenciesByRecord.get(record.id) ?? [],
    ),
  );
  const headerPages = packHeaders(headers, headerRecordLimit, headerByteLimit);
  const firstDetailChunkIndex = 1 + headerPages.length;
  const shardDescriptors = detailGroups.map((group, index) => {
    const shardId = shardByRecord.get(group[0]!.id)!;
    const dependencyShardIds = new Set<string>();
    for (const record of group) {
      for (const dependency of dependenciesByRecord.get(record.id) ?? []) {
        if (dependency !== shardId) dependencyShardIds.add(dependency);
      }
    }
    return {
      chunkIndex: firstDetailChunkIndex + index,
      dependencyShardIds: [...dependencyShardIds].sort(),
      recordCount: group.length,
      shardId,
    };
  });
  const pages = normalizeLeafPages(getLeafPages(snapshot));
  if (pages.length > LEAF_MAX_CHECKPOINT_PAGES) {
    throw new Error("Checkpoint page list exceeds the directory budget");
  }
  const comments = getLeafComments(snapshot);
  if (comments.length > LEAF_MAX_COMMENT_RECORDS) {
    throw new Error("Checkpoint comment lane exceeds the directory budget");
  }
  const directory: LeafCheckpointDirectoryPayload = {
    kind: "directory",
    payloadVersion: LEAF_SHARDED_CHECKPOINT_PAYLOAD_VERSION,
    schemaVersion: LEAF_RECORD_SCHEMA_VERSION,
    headerPageCount: headerPages.length,
    pages,
    comments,
    shards: shardDescriptors,
  };
  const chunks: LeafPreparedCheckpointChunk[] = [{ kind: "header", bytes: encodeJson(directory) }];
  headerPages.forEach((page, pageIndex) => {
    const payload: LeafCheckpointHeaderPagePayload = {
      kind: "headers",
      payloadVersion: LEAF_SHARDED_CHECKPOINT_PAYLOAD_VERSION,
      schemaVersion: LEAF_RECORD_SCHEMA_VERSION,
      pageIndex,
      headers: page,
    };
    chunks.push({ kind: "header", bytes: encodeJson(payload) });
  });
  detailGroups.forEach((group, index) => {
    const payload: LeafCheckpointDetailPayload = {
      kind: "detail",
      payloadVersion: LEAF_SHARDED_CHECKPOINT_PAYLOAD_VERSION,
      schemaVersion: LEAF_RECORD_SCHEMA_VERSION,
      shardId: shardDescriptors[index]!.shardId,
      records: group,
    };
    chunks.push({
      kind: "detail",
      shardId: payload.shardId,
      bytes: encodeJson(payload),
    });
  });
  if (chunks.length > LEAF_MAX_CHECKPOINT_CHUNKS) {
    throw new Error("Sharded checkpoint exceeds the manifest chunk limit");
  }
  return chunks;
}

export function parseLeafCheckpointDirectory(
  bytes: Uint8Array,
  options?: LeafCheckpointParseOptions,
) {
  const value = parseJson(bytes);
  if (
    !isRecord(value) ||
    value.kind !== "directory" ||
    value.payloadVersion !== LEAF_SHARDED_CHECKPOINT_PAYLOAD_VERSION ||
    !isSupportedPayloadSchemaVersion(value.schemaVersion, options) ||
    !Number.isSafeInteger(value.headerPageCount) ||
    (value.headerPageCount as number) < 1 ||
    (value.headerPageCount as number) >= LEAF_MAX_CHECKPOINT_CHUNKS ||
    !Array.isArray(value.shards) ||
    !Array.isArray(value.pages) ||
    value.pages.length < 1 ||
    value.pages.length > LEAF_MAX_CHECKPOINT_PAGES ||
    !value.pages.every(isLeafPageRecord) ||
    (value.comments !== undefined &&
      (!Array.isArray(value.comments) ||
        value.comments.length > LEAF_MAX_COMMENT_RECORDS ||
        !value.comments.every(isLeafCommentRecord))) ||
    (value.schemaVersion === LEGACY_COMPONENT_RECORD_SCHEMA_VERSION &&
      (!Array.isArray(value.components) || value.components.length !== 0))
  ) {
    throw new Error("Checkpoint directory payload is invalid");
  }
  const pages = normalizeLeafPages(value.pages as LeafPageRecord[]);
  const comments = structuredClone((value.comments as LeafCommentRecord[] | undefined) ?? []);
  if (new Set(comments.map((record) => record.id)).size !== comments.length) {
    throw new Error("Checkpoint directory contains duplicate comment ids");
  }
  const headerPageCount = value.headerPageCount as number;
  if (value.shards.length > LEAF_MAX_CHECKPOINT_CHUNKS - 1 - headerPageCount) {
    throw new Error("Checkpoint directory exceeds the manifest chunk limit");
  }
  const shards = value.shards.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.shardId !== "string" ||
      !entry.shardId ||
      entry.shardId.length > 256 ||
      !Number.isSafeInteger(entry.chunkIndex) ||
      (entry.chunkIndex as number) <= headerPageCount ||
      !Number.isSafeInteger(entry.recordCount) ||
      (entry.recordCount as number) < 1 ||
      (entry.recordCount as number) > 2_000 ||
      !Array.isArray(entry.dependencyShardIds) ||
      !entry.dependencyShardIds.every((id) => typeof id === "string" && !!id && id.length <= 256)
    ) {
      throw new Error("Checkpoint shard descriptor is invalid");
    }
    return {
      shardId: entry.shardId,
      chunkIndex: entry.chunkIndex as number,
      recordCount: entry.recordCount as number,
      dependencyShardIds: [...entry.dependencyShardIds] as string[],
    };
  });
  if (new Set(shards.map((entry) => entry.shardId)).size !== shards.length) {
    throw new Error("Checkpoint directory contains duplicate shard ids");
  }
  const shardIds = new Set(shards.map((entry) => entry.shardId));
  const expectedIndexes = new Set(
    Array.from({ length: shards.length }, (_, index) => 1 + headerPageCount + index),
  );
  for (const shard of shards) {
    if (!expectedIndexes.delete(shard.chunkIndex)) {
      throw new Error("Checkpoint directory detail indexes are invalid");
    }
    const dependencies = new Set(shard.dependencyShardIds);
    if (
      dependencies.size !== shard.dependencyShardIds.length ||
      dependencies.has(shard.shardId) ||
      [...dependencies].some((dependency) => !shardIds.has(dependency))
    ) {
      throw new Error("Checkpoint shard dependencies are invalid");
    }
  }
  if (expectedIndexes.size !== 0) {
    throw new Error("Checkpoint directory detail index coverage is incomplete");
  }
  return {
    kind: "directory",
    payloadVersion: LEAF_SHARDED_CHECKPOINT_PAYLOAD_VERSION,
    schemaVersion: value.schemaVersion,
    headerPageCount,
    pages,
    comments,
    shards,
  } satisfies LeafCheckpointDirectoryPayload;
}

export function parseLeafCheckpointHeaderPage(
  bytes: Uint8Array,
  options?: LeafCheckpointParseOptions,
) {
  const value = parseJson(bytes);
  if (
    !isRecord(value) ||
    value.kind !== "headers" ||
    value.payloadVersion !== LEAF_SHARDED_CHECKPOINT_PAYLOAD_VERSION ||
    !isSupportedPayloadSchemaVersion(value.schemaVersion, options) ||
    !Number.isSafeInteger(value.pageIndex) ||
    (value.pageIndex as number) < 0 ||
    !Array.isArray(value.headers) ||
    value.headers.length > 10_000 ||
    !value.headers.every(isLeafRecordHeader)
  ) {
    throw new Error("Checkpoint header page is invalid");
  }
  const headerIds = new Set((value.headers as LeafRecordHeader[]).map((header) => header.id));
  if (headerIds.size !== value.headers.length) {
    throw new Error("Checkpoint header page contains duplicate node ids");
  }
  return {
    kind: "headers",
    payloadVersion: LEAF_SHARDED_CHECKPOINT_PAYLOAD_VERSION,
    schemaVersion: value.schemaVersion as number,
    pageIndex: value.pageIndex as number,
    headers: structuredClone(value.headers) as LeafRecordHeader[],
  } satisfies LeafCheckpointHeaderPagePayload;
}

export function parseLeafCheckpointDetail(bytes: Uint8Array, options?: LeafCheckpointParseOptions) {
  const value = parseJson(bytes);
  if (
    !isRecord(value) ||
    value.kind !== "detail" ||
    value.payloadVersion !== LEAF_SHARDED_CHECKPOINT_PAYLOAD_VERSION ||
    !isSupportedPayloadSchemaVersion(value.schemaVersion, options) ||
    typeof value.shardId !== "string" ||
    !value.shardId ||
    value.shardId.length > 256 ||
    !Array.isArray(value.records) ||
    value.records.length > 2_000
  ) {
    throw new Error("Checkpoint detail payload is invalid");
  }
  if (!value.records.every(isLeafNodeRecord)) {
    throw new Error("Checkpoint detail contains an invalid record");
  }
  if (new Set(value.records.map((record) => record.id)).size !== value.records.length) {
    throw new Error("Checkpoint detail contains duplicate node ids");
  }
  const records = value.records;
  return {
    kind: "detail",
    payloadVersion: LEAF_SHARDED_CHECKPOINT_PAYLOAD_VERSION,
    schemaVersion: value.schemaVersion as number,
    shardId: value.shardId,
    records: structuredClone(records),
  } satisfies LeafCheckpointDetailPayload;
}

/** Resolves requested detail shards plus their transitive dependency closure. */
export function resolveLeafCheckpointShardClosure(
  directory: LeafCheckpointDirectoryPayload,
  requestedShardIds: readonly string[],
) {
  const descriptors = new Map(directory.shards.map((shard) => [shard.shardId, shard]));
  const closure = new Set<string>();
  const pending = [...new Set(requestedShardIds)];
  while (pending.length) {
    const shardId = pending.pop()!;
    const descriptor = descriptors.get(shardId);
    if (!descriptor) throw new Error(`Checkpoint shard is not present: ${shardId}`);
    if (closure.has(shardId)) continue;
    closure.add(shardId);
    pending.push(...descriptor.dependencyShardIds);
  }
  return [...closure].sort(
    (left, right) => descriptors.get(left)!.chunkIndex - descriptors.get(right)!.chunkIndex,
  );
}

function packRecords(records: readonly LeafNodeRecord[], recordLimit: number, byteLimit: number) {
  const groups: LeafNodeRecord[][] = [];
  let current: LeafNodeRecord[] = [];
  let bytes = 256;
  for (const record of records) {
    const recordBytes = new TextEncoder().encode(JSON.stringify(record)).byteLength + 1;
    if (recordBytes + 256 > byteLimit) {
      throw new Error(`Checkpoint record ${record.id} exceeds the detail shard budget`);
    }
    if (current.length && (current.length >= recordLimit || bytes + recordBytes > byteLimit)) {
      groups.push(current);
      current = [];
      bytes = 256;
    }
    current.push(record);
    bytes += recordBytes;
  }
  if (current.length) groups.push(current);
  return groups;
}

function packHeaders(headers: readonly LeafRecordHeader[], recordLimit: number, byteLimit: number) {
  const pages: LeafRecordHeader[][] = [];
  let current: LeafRecordHeader[] = [];
  let bytes = 256;
  for (const header of headers) {
    const headerBytes = new TextEncoder().encode(JSON.stringify(header)).byteLength + 1;
    if (headerBytes + 256 > byteLimit) {
      throw new Error(`Checkpoint header ${header.id} exceeds the header page budget`);
    }
    if (current.length && (current.length >= recordLimit || bytes + headerBytes > byteLimit)) {
      pages.push(current);
      current = [];
      bytes = 256;
    }
    current.push(header);
    bytes += headerBytes;
  }
  if (current.length) pages.push(current);
  if (pages.length === 0) pages.push([]);
  return pages;
}

function preorder(records: ReadonlyMap<string, LeafNodeRecord>) {
  const children = new Map<string | null, LeafNodeRecord[]>();
  for (const record of records.values()) {
    const entries = children.get(record.parentId) ?? [];
    entries.push(record);
    children.set(record.parentId, entries);
  }
  for (const entries of children.values()) {
    entries.sort(
      (left, right) => left.rank.localeCompare(right.rank) || left.id.localeCompare(right.id),
    );
  }
  const ordered: LeafNodeRecord[] = [];
  const visit = (record: LeafNodeRecord) => {
    ordered.push(record);
    for (const child of children.get(record.id) ?? []) visit(child);
  };
  for (const root of children.get(null) ?? []) visit(root);
  return ordered;
}

function buildDependencies(records: LeafRecordMap, shardByRecord: ReadonlyMap<string, string>) {
  const dependencies = new Map<string, Set<string>>();
  const children = new Map<string | null, LeafNodeRecord[]>();
  for (const record of records.values()) {
    const entries = children.get(record.parentId) ?? [];
    entries.push(record);
    children.set(record.parentId, entries);
  }
  const flowSubtreeShards = new Map<string, Set<string>>();
  const nearestFlowByRecord = new Map<string, string | null>();
  const assignFlow = (record: LeafNodeRecord, inheritedFlow: string | null) => {
    const nearestFlow = isFlowContainer(record) ? record.id : inheritedFlow;
    nearestFlowByRecord.set(record.id, nearestFlow);
    if (nearestFlow) {
      const shards = flowSubtreeShards.get(nearestFlow) ?? new Set<string>();
      shards.add(shardByRecord.get(record.id)!);
      flowSubtreeShards.set(nearestFlow, shards);
    }
    for (const child of children.get(record.id) ?? []) assignFlow(child, nearestFlow);
  };
  for (const root of children.get(null) ?? []) assignFlow(root, null);
  for (const record of records.values()) {
    const ownShard = shardByRecord.get(record.id)!;
    const entry = dependencies.get(record.id) ?? new Set<string>();
    let parentId = record.parentId;
    while (parentId) {
      const parentShard = shardByRecord.get(parentId);
      if (parentShard && parentShard !== ownShard) entry.add(parentShard);
      parentId = records.get(parentId)?.parentId ?? null;
    }
    const flowId = nearestFlowByRecord.get(record.id);
    for (const flowShard of flowId ? (flowSubtreeShards.get(flowId) ?? []) : []) {
      if (flowShard !== ownShard) entry.add(flowShard);
    }
    dependencies.set(record.id, entry);
  }
  return new Map([...dependencies].map(([id, values]) => [id, [...values].sort()]));
}

function isFlowContainer(record: LeafNodeRecord) {
  return record.styles.display === "flex" || record.styles.display === "grid";
}

function isLeafRecordHeader(value: unknown): value is LeafRecordHeader {
  if (!isRecord(value) || !isRecord(value.bounds)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 512 &&
    (value.parentId === null ||
      (typeof value.parentId === "string" && value.parentId.length > 0)) &&
    typeof value.rank === "string" &&
    /^[0-9a-z]{16}$/.test(value.rank) &&
    ["frame", "text", "rectangle", "svg", "interactive-surface", "image"].includes(
      String(value.type),
    ) &&
    typeof value.name === "string" &&
    typeof value.visible === "boolean" &&
    typeof value.isArtboard === "boolean" &&
    typeof value.detailShardId === "string" &&
    value.detailShardId.length > 0 &&
    value.detailShardId.length <= 256 &&
    Array.isArray(value.dependencyShardIds) &&
    value.dependencyShardIds.every(
      (dependency) =>
        typeof dependency === "string" && dependency.length > 0 && dependency.length <= 256,
    ) &&
    Number.isFinite(value.bounds.x) &&
    Number.isFinite(value.bounds.y) &&
    Number.isFinite(value.bounds.width) &&
    Number.isFinite(value.bounds.height) &&
    (value.bounds.width as number) >= 0 &&
    (value.bounds.height as number) >= 0
  );
}

function boundedLimit(value: number | undefined, fallback: number, min: number, max: number) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new Error("Checkpoint shard limit is invalid");
  }
  return result;
}

function boundedShardSegment(value: string) {
  return encodeURIComponent(value).slice(0, 96);
}

function encodeJson(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value));
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new Error("Checkpoint chunk is not valid JSON", { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
