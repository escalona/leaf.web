/**
 * Environment-neutral protocol types for Leaf's normalized collaboration model.
 *
 * This module deliberately has no React, MobX, DOM, Worker, or persistence-engine imports so
 * the browser and Durable Object can share exactly one contract.
 */

import type { LeafCheckpointReference } from "./checkpoint";
import * as z from "zod";

export const LEAF_COLLABORATION_PROTOCOL_VERSION = 1 as const;
/**
 * v2 adds `rotation`, `locked`, `pageId`, and the snapshot `pages` list.
 * v3 adds the comment lane: the `commentRecords` command/patch and the snapshot
 * `comments` list. v2 data stays readable — a snapshot with no comment lane
 * reads as having none.
 * Generated-image provenance is an optional v3 node field. Older v3 records
 * hydrate it as null; version 4 remains reserved by the abandoned component-era
 * checkpoint envelope and is not a writable normalized-record version.
 */
export const LEAF_RECORD_SCHEMA_VERSION = 3 as const;
/**
 * Rolling deployments advertise an inclusive compatibility window instead of
 * assuming that matching bundle versions reached every client at once.
 */
export const LEAF_MIN_COLLABORATION_PROTOCOL_VERSION = 1 as const;
export const LEAF_MAX_COLLABORATION_PROTOCOL_VERSION = 1 as const;
export const LEAF_MIN_RECORD_SCHEMA_VERSION = 2 as const;
export const LEAF_MAX_RECORD_SCHEMA_VERSION = 3 as const;
export const LEAF_COLLABORATION_DEPLOYMENT_VERSION = "normalized-v3" as const;

/** The page a document with no explicit page list is normalized onto. */
export const LEAF_DEFAULT_PAGE_ID = "page-default";
export const LEAF_DEFAULT_PAGE_NAME = "Page 1";

/**
 * Upper bound on the page list, enforced everywhere it crosses a boundary:
 * the `setPages` patch, the Worker's snapshot and command schemas, and the
 * checkpoint directory chunk. Kept here so those four cannot drift apart.
 */
export const LEAF_MAX_DOCUMENT_PAGES = 1_000;

export interface LeafPageRecord {
  id: string;
  name: string;
  rank: string;
  /**
   * Colour painted behind the page's artboards (any CSS colour). Optional and
   * additive: absent means the default canvas colour, so v2/v3 snapshots,
   * checkpoints, and native documents without it read unchanged.
   */
  background?: string;
}

export const LEAF_MAX_PAGE_BACKGROUND_LENGTH = 64;

export function isLeafPageRecord(value: unknown): value is LeafPageRecord {
  return (
    isProtocolRecord(value) &&
    isProtocolId(value.id) &&
    typeof value.name === "string" &&
    typeof value.rank === "string" &&
    (value.background === undefined ||
      (typeof value.background === "string" &&
        value.background.length <= LEAF_MAX_PAGE_BACKGROUND_LENGTH))
  );
}

/**
 * The comment lane.
 *
 * Comment records travel with the document and sync through the same room as
 * design records, but they live alongside the canvas rather than inside it:
 * they are not nodes, hold no place in the node tree, and carry a pointer at
 * the canvas (an anchor) instead. Three record kinds share one id-keyed lane so
 * a reply or an emoji reaction is its own record with per-record
 * last-write-wins, never a contended array field on its parent.
 */
export type LeafCommentRecordKind = "thread" | "comment" | "reaction";

/** Total comment-lane records a document may hold. */
export const LEAF_MAX_COMMENT_RECORDS = 5_000;
/**
 * Serialized-size budget for the whole comment lane. The lane rides inside a
 * single checkpoint directory chunk, which the checkpoint store caps at 8 MB;
 * bounding the lane's bytes at write time is what keeps every future
 * checkpoint publishable.
 */
export const LEAF_MAX_COMMENT_LANE_BYTES = 6 * 1024 * 1024;
/** Comment-lane records one `commentRecords` command may touch. */
export const LEAF_MAX_COMMENT_RECORDS_PER_COMMAND = 200;
export const LEAF_MAX_COMMENT_TEXT_LENGTH = 10_000;
export const LEAF_MAX_COMMENT_NAME_LENGTH = 200;
/** Reaction emoji are bounded because the token is embedded in the record id. */
export const LEAF_MAX_COMMENT_EMOJI_LENGTH = 64;

/**
 * Where a comment thread points.
 *
 * - `node`: `u`/`v` are normalized 0–1 within the node's own (unrotated) bounds,
 *   so the pin keeps its spot through move, resize, and rotation.
 * - `point`: a fixed canvas-space point on the thread's page.
 * - `region`: a canvas-space rect drawn around several things; the pin sits on
 *   the normalized corner (`pinX`/`pinY`) where the creating drag released.
 * - `page`: no spatial anchor; the thread surfaces only in lists.
 */
export type LeafCommentAnchor =
  | { type: "node"; nodeId: string; u: number; v: number }
  | { type: "point"; x: number; y: number }
  | { type: "region"; x: number; y: number; w: number; h: number; pinX: number; pinY: number }
  | { type: "page" };

export interface LeafCommentThreadRecord {
  id: string;
  kind: "thread";
  /** The page the thread lives on. */
  pageId: string;
  anchor: LeafCommentAnchor;
  /** Sync actor id of whoever started the thread. */
  createdBy: string;
  /** Display name denormalized at write time; the author may leave the workspace. */
  createdByName: string | null;
  createdAt: number;
  resolvedBy: string | null;
  resolvedAt: number | null;
}

export interface LeafCommentMessageRecord {
  id: string;
  kind: "comment";
  threadId: string;
  /** Denormalized from the thread so per-page reads need no join. */
  pageId: string;
  authorId: string;
  authorName: string | null;
  createdAt: number;
  /** Null until the comment is first edited. */
  editedAt: number | null;
  /** Plain text body. */
  body: string;
}

export interface LeafCommentReactionRecord {
  id: string;
  kind: "reaction";
  commentId: string;
  threadId: string;
  pageId: string;
  userId: string;
  userName: string | null;
  emoji: string;
  createdAt: number;
}

export type LeafCommentRecord =
  | LeafCommentThreadRecord
  | LeafCommentMessageRecord
  | LeafCommentReactionRecord;

/**
 * Reaction ids are derived, not random: one id per `(comment, user, emoji)`
 * triple, so re-reacting from two tabs converges as an upsert instead of
 * racing. The URI-encoding keeps the mapping injective when a component
 * contains `:`.
 */
export function createLeafCommentReactionId(
  commentId: string,
  userId: string,
  emoji: string,
): string {
  return `creaction_${encodeURIComponent(commentId)}:${encodeURIComponent(userId)}:${encodeURIComponent(emoji)}`;
}

export function isLeafCommentAnchor(value: unknown): value is LeafCommentAnchor {
  if (!isProtocolRecord(value)) return false;
  switch (value.type) {
    case "node":
      return (
        isProtocolId(value.nodeId) &&
        isFiniteProtocolNumber(value.u) &&
        isFiniteProtocolNumber(value.v)
      );
    case "point":
      return isFiniteProtocolNumber(value.x) && isFiniteProtocolNumber(value.y);
    case "region":
      return (
        isFiniteProtocolNumber(value.x) &&
        isFiniteProtocolNumber(value.y) &&
        isFiniteProtocolNumber(value.w) &&
        (value.w as number) >= 0 &&
        isFiniteProtocolNumber(value.h) &&
        (value.h as number) >= 0 &&
        isFiniteProtocolNumber(value.pinX) &&
        isFiniteProtocolNumber(value.pinY)
      );
    case "page":
      return true;
    default:
      return false;
  }
}

function isBoundedName(value: unknown): value is string | null {
  return (
    value === null || (typeof value === "string" && value.length <= LEAF_MAX_COMMENT_NAME_LENGTH)
  );
}

export function isLeafCommentRecord(value: unknown): value is LeafCommentRecord {
  if (!isProtocolRecord(value) || !isProtocolId(value.id)) return false;
  switch (value.kind) {
    case "thread":
      return (
        isProtocolId(value.pageId) &&
        isLeafCommentAnchor(value.anchor) &&
        isProtocolId(value.createdBy) &&
        isBoundedName(value.createdByName) &&
        isFiniteProtocolNumber(value.createdAt) &&
        (value.resolvedBy === null || isProtocolId(value.resolvedBy)) &&
        (value.resolvedAt === null || isFiniteProtocolNumber(value.resolvedAt))
      );
    case "comment":
      return (
        isProtocolId(value.threadId) &&
        isProtocolId(value.pageId) &&
        isProtocolId(value.authorId) &&
        isBoundedName(value.authorName) &&
        isFiniteProtocolNumber(value.createdAt) &&
        (value.editedAt === null || isFiniteProtocolNumber(value.editedAt)) &&
        typeof value.body === "string" &&
        value.body.length <= LEAF_MAX_COMMENT_TEXT_LENGTH
      );
    case "reaction":
      return (
        isProtocolId(value.commentId) &&
        isProtocolId(value.threadId) &&
        isProtocolId(value.pageId) &&
        isProtocolId(value.userId) &&
        isBoundedName(value.userName) &&
        typeof value.emoji === "string" &&
        value.emoji.length > 0 &&
        value.emoji.length <= LEAF_MAX_COMMENT_EMOJI_LENGTH &&
        isFiniteProtocolNumber(value.createdAt)
      );
    default:
      return false;
  }
}

export const LEAF_NODE_TYPES = [
  "frame",
  "text",
  "rectangle",
  "svg",
  "interactive-surface",
  "image",
  "path",
  "shader",
] as const;
export type LeafNodeType = (typeof LEAF_NODE_TYPES)[number];
export type LeafStyleValue = string | number;

export interface LeafImageAssetRef {
  assetId: string;
  src?: string;
  mimeType: string;
  byteLength: number;
  width: number;
  height: number;
  sourceName?: string;
}

export const LEAF_IMAGE_GENERATION_ASPECT_RATIOS = [
  "auto",
  "1:1",
  "3:2",
  "4:3",
  "16:9",
  "2:1",
  "3:1",
  "2:3",
  "3:4",
  "9:16",
  "1:2",
  "1:3",
] as const;
export type LeafImageGenerationAspectRatio = (typeof LEAF_IMAGE_GENERATION_ASPECT_RATIOS)[number];

/** Reproducible authorship context; provider bytes remain in the asset store. */
export interface LeafImageGenerationMetadata {
  prompt: string;
  modelId: string;
  aspectRatio: LeafImageGenerationAspectRatio;
  /** Missing means the provider's automatic background treatment. */
  background?: "opaque" | "transparent";
  target: "image" | "background";
  referenceNodeIds: string[];
  /** Optional so snapshots written before shared lifecycle state stay readable. */
  status?: "generating" | "ready" | "failed";
  error?: string;
  /** Request start (ms since epoch); optional and additive so older records stay readable. */
  startedAt?: number;
}

/** One design node without recursive children. Ordering is `(parentId, rank)`. */
export interface LeafNodeRecord {
  id: string;
  parentId: string | null;
  /** Which page this record's root ancestor lives on. */
  pageId: string;
  rank: string;
  type: LeafNodeType;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees clockwise about the node center. */
  rotation: number;
  visible: boolean;
  locked: boolean;
  backgroundColor: string;
  borderRadius: number;
  borderColor: string;
  borderWidth: number;
  content: string;
  imageAsset: LeafImageAssetRef | null;
  /** Optional so snapshots written before image-generation provenance stay readable. */
  imageGeneration?: LeafImageGenerationMetadata | null;
  fontSize: number;
  fontFamily: string;
  color: string;
  fontWeight: string;
  textAutoSize: boolean;
  isArtboard: boolean;
  styles: Record<string, LeafStyleValue>;
}

export function isLeafNodeRecord(value: unknown): value is LeafNodeRecord {
  if (!isProtocolRecord(value) || !isProtocolRecord(value.styles)) return false;
  return (
    isProtocolId(value.id) &&
    (value.parentId === null || isProtocolId(value.parentId)) &&
    isProtocolId(value.pageId) &&
    typeof value.rank === "string" &&
    /^[0-9a-z]{16}$/.test(value.rank) &&
    isLeafNodeType(value.type) &&
    typeof value.name === "string" &&
    isFiniteProtocolNumber(value.x) &&
    isFiniteProtocolNumber(value.y) &&
    isFiniteProtocolNumber(value.width) &&
    isFiniteProtocolNumber(value.height) &&
    isFiniteProtocolNumber(value.rotation) &&
    typeof value.visible === "boolean" &&
    typeof value.locked === "boolean" &&
    typeof value.backgroundColor === "string" &&
    isFiniteProtocolNumber(value.borderRadius) &&
    typeof value.borderColor === "string" &&
    isFiniteProtocolNumber(value.borderWidth) &&
    typeof value.content === "string" &&
    isLeafImageAssetRef(value.imageAsset) &&
    (value.imageGeneration === undefined ||
      value.imageGeneration === null ||
      isLeafImageGenerationMetadata(value.imageGeneration)) &&
    isFiniteProtocolNumber(value.fontSize) &&
    typeof value.fontFamily === "string" &&
    typeof value.color === "string" &&
    typeof value.fontWeight === "string" &&
    typeof value.textAutoSize === "boolean" &&
    typeof value.isArtboard === "boolean" &&
    Object.values(value.styles).every(
      (style) => typeof style === "string" || isFiniteProtocolNumber(style),
    )
  );
}

function isLeafNodeType(value: unknown): value is LeafNodeType {
  return LEAF_NODE_TYPES.some((type) => type === value);
}

function isLeafImageAssetRef(value: unknown): value is LeafImageAssetRef | null {
  if (value === null) return true;
  if (!isProtocolRecord(value)) return false;
  return (
    typeof value.assetId === "string" &&
    (value.src === undefined || typeof value.src === "string") &&
    typeof value.mimeType === "string" &&
    isFiniteProtocolNumber(value.byteLength) &&
    isFiniteProtocolNumber(value.width) &&
    isFiniteProtocolNumber(value.height) &&
    (value.sourceName === undefined || typeof value.sourceName === "string")
  );
}

function isLeafImageGenerationMetadata(value: unknown): value is LeafImageGenerationMetadata {
  if (!isProtocolRecord(value)) return false;
  return (
    typeof value.prompt === "string" &&
    typeof value.modelId === "string" &&
    LEAF_IMAGE_GENERATION_ASPECT_RATIOS.some((ratio) => ratio === value.aspectRatio) &&
    (value.background === undefined ||
      value.background === "opaque" ||
      value.background === "transparent") &&
    (value.target === "image" || value.target === "background") &&
    Array.isArray(value.referenceNodeIds) &&
    value.referenceNodeIds.length <= 8 &&
    value.referenceNodeIds.every(isProtocolId) &&
    (value.status === undefined ||
      value.status === "generating" ||
      value.status === "ready" ||
      value.status === "failed") &&
    (value.error === undefined || typeof value.error === "string") &&
    (value.startedAt === undefined ||
      (typeof value.startedAt === "number" && Number.isFinite(value.startedAt)))
  );
}

function isProtocolRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isProtocolId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function isFiniteProtocolNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Fields a `patchFields` command may write.
 *
 * `parentId` and `rank` are deliberately absent — `moveRecord` owns those,
 * because changing them has to revalidate ancestry and rank uniqueness.
 * `pageId` is here rather than there: it carries no ordering, so moving a root
 * between pages is an ordinary field write paired with a `moveRecord` that
 * re-roots it.
 */
export const LEAF_NODE_FIELD_KEYS = [
  "type",
  "name",
  "pageId",
  "x",
  "y",
  "width",
  "height",
  "rotation",
  "visible",
  "locked",
  "backgroundColor",
  "borderRadius",
  "borderColor",
  "borderWidth",
  "content",
  "imageAsset",
  "imageGeneration",
  "fontSize",
  "fontFamily",
  "color",
  "fontWeight",
  "textAutoSize",
  "isArtboard",
] as const satisfies ReadonlyArray<keyof LeafNodeRecord>;

export type LeafNodeFieldKey = (typeof LEAF_NODE_FIELD_KEYS)[number];
export type LeafNodeFieldValue = LeafNodeRecord[LeafNodeFieldKey];

export interface LeafRecordSnapshot {
  schemaVersion: number;
  records: LeafNodeRecord[];
  /** Ordered pages. Always at least one. */
  pages: LeafPageRecord[];
  /**
   * Comment-lane records. Optional so pre-v3 snapshots (persisted caches,
   * native documents, fixtures) stay readable; absent reads as none via
   * `getLeafComments`.
   */
  comments?: LeafCommentRecord[];
}

export function defaultLeafPages(): LeafPageRecord[] {
  // Same 16-character shape as node ranks so page and node ordering sort with
  // one comparator, even though page ranks are not validated by that regex.
  return [{ id: LEAF_DEFAULT_PAGE_ID, name: LEAF_DEFAULT_PAGE_NAME, rank: "a000000000000000" }];
}

/**
 * Pages of a snapshot, falling back to a single default page.
 *
 * Tolerates a missing list rather than throwing: a snapshot can reach here from
 * a cache or a hand-built fixture, and an undefined read would surface as an
 * opaque "cannot read properties of undefined" at document-open time.
 */
export function getLeafPages(snapshot: Pick<LeafRecordSnapshot, "pages">): LeafPageRecord[] {
  const pages = snapshot.pages;
  return pages && pages.length > 0 ? pages : defaultLeafPages();
}

/** Comment lane of a snapshot; a pre-v3 snapshot with no lane reads as empty. */
export function getLeafComments(
  snapshot: Pick<LeafRecordSnapshot, "comments">,
): LeafCommentRecord[] {
  return snapshot.comments ?? [];
}

export type LeafFieldMutation = {
  type: "setField";
  field: LeafNodeFieldKey;
  value: LeafNodeFieldValue;
};

export type LeafStyleMutation =
  | { type: "setStyle"; key: string; value: LeafStyleValue }
  | { type: "deleteStyle"; key: string };

export type LeafPropertyMutation = LeafFieldMutation | LeafStyleMutation;

export interface LeafCreateRecordsCommand {
  type: "createRecords";
  records: LeafNodeRecord[];
}

export interface LeafPatchFieldsCommand {
  type: "patchFields";
  nodeId: string;
  mutations: LeafPropertyMutation[];
}

/**
 * Move/reorder intent names stable neighboring records. `afterId` is the lower
 * neighbor and `beforeId` is the upper neighbor. With neither, the node appends.
 */
export interface LeafMoveRecordCommand {
  type: "moveRecord";
  nodeId: string;
  parentId: string | null;
  afterId?: string;
  beforeId?: string;
}

export interface LeafDeleteSubtreeCommand {
  type: "deleteSubtree";
  nodeId: string;
}

/**
 * Replace the document page list.
 *
 * Document-level rather than node-scoped, because page identity, naming, and
 * order are not a projection of `record.pageId` — a page holding zero records
 * has to survive. The whole list travels rather than a per-page delta because
 * a reorder has no meaningful per-page expression, and the list is bounded by
 * `LEAF_MAX_DOCUMENT_PAGES`.
 *
 * The authority re-prepares this against its own list. Without `basePages`
 * that is last-write-wins over the whole list: B's rename of page two reverts
 * A's concurrent rename of page one, because the list travels whole. With
 * `basePages` — the list the client edited FROM, normally its replica's list
 * at edit time — the authority three-way merges when its list has moved on:
 * base = `basePages`, ours = the authority's list, theirs = `pages`, resolved
 * per page id and per field by `mergeLeafPages` in ./merge. A base equal to
 * the authority's list is a plain replace. The field is optional and additive:
 * clients that omit it keep the whole-list rule, and it is never journaled —
 * the canonical `setPages` patch still carries the authority's own `before`.
 */
export interface LeafSetPagesCommand {
  type: "setPages";
  pages: LeafPageRecord[];
  /** The list this edit was made against; see the interface comment. */
  basePages?: LeafPageRecord[];
}

/**
 * Upsert and delete comment-lane records.
 *
 * Document-level like `setPages`, but per-record rather than whole-list:
 * comments are append-heavy and concurrent — two people replying at once must
 * both land — so the authority re-prepares each entry against its own lane and
 * last-write-wins applies per record id instead of across the lane.
 */
export interface LeafCommentRecordsCommand {
  type: "commentRecords";
  puts: LeafCommentRecord[];
  deletes: string[];
}

export type LeafSemanticCommand =
  | LeafCreateRecordsCommand
  | LeafPatchFieldsCommand
  | LeafMoveRecordCommand
  | LeafDeleteSubtreeCommand
  | LeafSetPagesCommand
  | LeafCommentRecordsCommand;

export type LeafPresentValue = { present: true; value: LeafNodeFieldValue | LeafStyleValue };
export type LeafAbsentValue = { present: false };
export type LeafPropertyValue = LeafPresentValue | LeafAbsentValue;

/** A property precondition and its canonical accepted result. */
export type LeafPropertyDelta =
  | {
      target: "field";
      key: LeafNodeFieldKey;
      before: LeafPresentValue;
      after: LeafPresentValue;
    }
  | {
      target: "style";
      key: string;
      before: LeafPropertyValue;
      after: LeafPropertyValue;
    };

export interface LeafStructureValue {
  parentId: string | null;
  rank: string;
}

/**
 * Canonical patches carry their own compare-and-set preconditions. Applying the
 * complete list is atomic: either every `before` matches, or nothing changes.
 */
export type LeafCanonicalPatch =
  | {
      type: "createRecords";
      records: LeafNodeRecord[];
    }
  | {
      type: "patchFields";
      nodeId: string;
      deltas: LeafPropertyDelta[];
    }
  | {
      type: "moveRecord";
      nodeId: string;
      before: LeafStructureValue;
      after: LeafStructureValue;
    }
  | {
      type: "deleteRecords";
      records: LeafNodeRecord[];
    }
  | {
      type: "setPages";
      before: LeafPageRecord[];
      after: LeafPageRecord[];
    }
  | {
      type: "commentRecords";
      entries: LeafCommentPatchEntry[];
    };

/** One compare-and-set write in the comment lane. `null` means "absent". */
export interface LeafCommentPatchEntry {
  id: string;
  before: LeafCommentRecord | null;
  after: LeafCommentRecord | null;
}

export type LeafDocumentPatch = Extract<
  LeafCanonicalPatch,
  { type: "setPages" | "commentRecords" }
>;

/**
 * True when this patch carries no node ids.
 *
 * Every other patch names at least one record, and a lot of machinery — write-set
 * capture, the worker's touched-node materialization loop, transaction size
 * limits — is written against `patch.nodeId` or `patch.records`. Document-level
 * patches have neither, so those call sites branch on this rather than reading a
 * field that is not there.
 */
export function isLeafDocumentPatch(patch: LeafCanonicalPatch): patch is LeafDocumentPatch {
  return patch.type === "setPages" || patch.type === "commentRecords";
}

export interface LeafPreparedTransaction {
  forward: LeafCanonicalPatch[];
  inverse: LeafCanonicalPatch[];
  touchedNodeIds: string[];
}

export interface LeafPreparedHistoryTransition extends LeafPreparedTransaction {
  skipped: LeafSkippedUndo[];
}

export interface LeafSkippedUndo {
  patchIndex: number;
  nodeId: string | null;
  properties?: string[];
  reason: string;
}

export interface LeafConditionalUndoPlan {
  patches: LeafCanonicalPatch[];
  skipped: LeafSkippedUndo[];
}

export type LeafHelloMessage = {
  type: "hello";
  protocolVersion: number;
  schemaVersion: number;
  clientInstanceId: string;
  writeIntent: boolean;
  streamEpoch?: string;
  seenRevision?: number;
};

export type LeafDeploymentCompatibility = {
  deploymentVersion: string;
  maxProtocolVersion: number;
  maxSchemaVersion: number;
  minProtocolVersion: number;
  minSchemaVersion: number;
};

export const LEAF_COLLABORATION_COMPATIBILITY: LeafDeploymentCompatibility = {
  deploymentVersion: LEAF_COLLABORATION_DEPLOYMENT_VERSION,
  maxProtocolVersion: LEAF_MAX_COLLABORATION_PROTOCOL_VERSION,
  maxSchemaVersion: LEAF_MAX_RECORD_SCHEMA_VERSION,
  minProtocolVersion: LEAF_MIN_COLLABORATION_PROTOCOL_VERSION,
  minSchemaVersion: LEAF_MIN_RECORD_SCHEMA_VERSION,
};

type LeafTransactionEnvelope = {
  type: "transaction";
  protocolVersion: typeof LEAF_COLLABORATION_PROTOCOL_VERSION;
  schemaVersion: typeof LEAF_RECORD_SCHEMA_VERSION;
  streamEpoch: string;
  baseRevision: number;
  clientTxId: string;
  clientInstanceId: string;
  clientSequence: number;
  historyGroupId: string;
};

export type LeafUserTransactionMessage = LeafTransactionEnvelope & {
  kind: "user";
  commands: LeafSemanticCommand[];
};

/**
 * History transitions name an already accepted actor-owned history group. The
 * authority derives the conditional canonical patches from its journal; clients
 * never submit inverse patches directly.
 */
export type LeafHistoryTransactionMessage = LeafTransactionEnvelope & {
  kind: "undo" | "redo";
};

export type LeafTransactionMessage = LeafUserTransactionMessage | LeafHistoryTransactionMessage;

export type LeafClientMessage = LeafHelloMessage | LeafTransactionMessage;

export type LeafCommitMessage = {
  type: "commit" | "rebase";
  protocolVersion: typeof LEAF_COLLABORATION_PROTOCOL_VERSION;
  /** Any version inside the documented compatibility window. */
  schemaVersion: number;
  streamEpoch: string;
  revision: number;
  clientTxId: string;
  actorId: string;
  historyGroupId: string;
  kind: "user" | "undo" | "redo";
  effectivePatches: LeafCanonicalPatch[];
  skipped?: LeafSkippedUndo[];
};

export type LeafServerMessage =
  | {
      type: "hello";
      protocolVersion: typeof LEAF_COLLABORATION_PROTOCOL_VERSION;
      /** Any version inside the documented compatibility window. */
      schemaVersion: number;
      streamEpoch: string;
      barrierRevision: number;
      checkpoint?: LeafCheckpointReference | null;
      /** Absent only for a pre-window v1 server during a rolling deployment. */
      compatibility?: LeafDeploymentCompatibility;
      retainedFromRevision: number;
    }
  | LeafCommitMessage
  | { type: "reject"; clientTxId?: string; code: string; message: string }
  | { type: "resync"; clientTxId?: string; requiredEpoch: string; reason: string };

export type LeafRoomIdentity = {
  branchId: string;
  fileId: string;
  workspaceId: string;
};

export type LeafRoomSnapshot = LeafRoomIdentity & {
  streamEpoch: string;
  revision: number;
  snapshot: LeafRecordSnapshot;
};

export type LeafCheckpointBootstrapResponse = LeafRoomIdentity & {
  type: "checkpoint";
  checkpoint: LeafCheckpointReference;
  streamEpoch: string;
  throughRevision: number;
  commits: LeafCommitMessage[];
  nextRevision: number | null;
};

export type LeafBootstrapResponse =
  | ({ type: "snapshot" } & LeafRoomSnapshot)
  | LeafCheckpointBootstrapResponse
  | {
      type: "tail";
      streamEpoch: string;
      throughRevision: number;
      commits: LeafCommitMessage[];
      nextRevision: number | null;
    };

const protocolIdSchema = z.string().min(1).max(512);
const protocolRevisionSchema = z.number().int().min(0);
const checkpointReferenceSchema = z
  .object({
    checkpointId: protocolIdSchema,
    manifestByteLength: z.number().int().positive(),
    manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
    revision: protocolRevisionSchema,
    streamEpoch: protocolIdSchema,
  })
  .strict();
const canonicalPatchSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("createRecords"), records: z.array(z.custom(isLeafNodeRecord)) }),
  z.object({
    type: z.literal("patchFields"),
    nodeId: protocolIdSchema,
    deltas: z.array(
      z.object({
        target: z.enum(["field", "style"]),
        key: protocolIdSchema,
        before: z.object({ present: z.boolean() }).passthrough(),
        after: z.object({ present: z.boolean() }).passthrough(),
      }),
    ),
  }),
  z.object({
    type: z.literal("moveRecord"),
    nodeId: protocolIdSchema,
    before: z.object({ parentId: protocolIdSchema.nullable(), rank: protocolIdSchema }),
    after: z.object({ parentId: protocolIdSchema.nullable(), rank: protocolIdSchema }),
  }),
  z.object({ type: z.literal("deleteRecords"), records: z.array(z.custom(isLeafNodeRecord)) }),
  z.object({
    type: z.literal("setPages"),
    before: z.array(z.custom(isLeafPageRecord)).min(1).max(LEAF_MAX_DOCUMENT_PAGES),
    after: z.array(z.custom(isLeafPageRecord)).min(1).max(LEAF_MAX_DOCUMENT_PAGES),
  }),
  z.object({
    type: z.literal("commentRecords"),
    entries: z
      .array(
        z.object({
          id: protocolIdSchema,
          before: z.custom(isLeafCommentRecord).nullable(),
          after: z.custom(isLeafCommentRecord).nullable(),
        }),
      )
      .min(1)
      .max(LEAF_MAX_COMMENT_RECORDS_PER_COMMAND),
  }),
]);
/**
 * Server-authored messages are readable across the documented compatibility
 * window: during a rolling deploy the other end may still stamp the previous
 * in-window schema version, and an exact-match literal here would kill the
 * session instead of reading it.
 */
const supportedSchemaVersionSchema = z
  .number()
  .int()
  .min(LEAF_MIN_RECORD_SCHEMA_VERSION)
  .max(LEAF_MAX_RECORD_SCHEMA_VERSION);
const commitMessageSchema = z
  .object({
    type: z.enum(["commit", "rebase"]),
    protocolVersion: z.literal(LEAF_COLLABORATION_PROTOCOL_VERSION),
    schemaVersion: supportedSchemaVersionSchema,
    streamEpoch: protocolIdSchema,
    revision: protocolRevisionSchema,
    clientTxId: protocolIdSchema,
    actorId: protocolIdSchema,
    historyGroupId: protocolIdSchema,
    kind: z.enum(["user", "undo", "redo"]),
    effectivePatches: z.array(canonicalPatchSchema),
    skipped: z
      .array(
        z.object({
          patchIndex: protocolRevisionSchema,
          nodeId: protocolIdSchema.nullable(),
          properties: z.array(z.string()).optional(),
          reason: z.string(),
        }),
      )
      .optional(),
  })
  .strict();
const compatibilitySchema = z
  .object({
    deploymentVersion: z.string(),
    maxProtocolVersion: z.number().int().positive(),
    maxSchemaVersion: z.number().int().positive(),
    minProtocolVersion: z.number().int().positive(),
    minSchemaVersion: z.number().int().positive(),
  })
  .strict();
const serverMessageSchema = z.union([
  z
    .object({
      type: z.literal("hello"),
      protocolVersion: z.literal(LEAF_COLLABORATION_PROTOCOL_VERSION),
      schemaVersion: supportedSchemaVersionSchema,
      streamEpoch: protocolIdSchema,
      barrierRevision: protocolRevisionSchema,
      checkpoint: checkpointReferenceSchema.nullable().optional(),
      compatibility: compatibilitySchema.optional(),
      retainedFromRevision: protocolRevisionSchema,
    })
    .strict(),
  commitMessageSchema,
  z
    .object({
      type: z.literal("reject"),
      clientTxId: protocolIdSchema.optional(),
      code: protocolIdSchema,
      message: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("resync"),
      clientTxId: protocolIdSchema.optional(),
      requiredEpoch: protocolIdSchema,
      reason: z.string(),
    })
    .strict(),
]);
const bootstrapResponseSchema = z.union([
  z
    .object({
      type: z.literal("snapshot"),
      branchId: protocolIdSchema,
      fileId: protocolIdSchema,
      workspaceId: protocolIdSchema,
      streamEpoch: protocolIdSchema,
      revision: protocolRevisionSchema,
      snapshot: z.object({
        schemaVersion: supportedSchemaVersionSchema,
        records: z.array(z.custom(isLeafNodeRecord)),
        pages: z.array(z.custom(isLeafPageRecord)),
        comments: z.array(z.custom(isLeafCommentRecord)).max(LEAF_MAX_COMMENT_RECORDS).optional(),
      }),
    })
    .strict(),
  z
    .object({
      type: z.literal("checkpoint"),
      branchId: protocolIdSchema,
      fileId: protocolIdSchema,
      workspaceId: protocolIdSchema,
      checkpoint: checkpointReferenceSchema,
      streamEpoch: protocolIdSchema,
      throughRevision: protocolRevisionSchema,
      commits: z.array(commitMessageSchema),
      nextRevision: protocolRevisionSchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("tail"),
      streamEpoch: protocolIdSchema,
      throughRevision: protocolRevisionSchema,
      commits: z.array(commitMessageSchema),
      nextRevision: protocolRevisionSchema.nullable(),
    })
    .strict(),
]);

export function parseLeafServerMessage(value: unknown): LeafServerMessage {
  const parsed = serverMessageSchema.safeParse(value);
  if (!parsed.success) throw new Error("Document sync sent an invalid message");
  return parsed.data as LeafServerMessage;
}

export function parseLeafBootstrapResponse(value: unknown): LeafBootstrapResponse {
  const parsed = bootstrapResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("Document sync sent an invalid bootstrap response");
  return parsed.data as LeafBootstrapResponse;
}
