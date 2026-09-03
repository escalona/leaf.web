import {
  LEAF_MAX_COMMENT_LANE_BYTES,
  LEAF_MAX_COMMENT_RECORDS,
  LEAF_MAX_DOCUMENT_PAGES,
  LEAF_RECORD_SCHEMA_VERSION,
  defaultLeafPages,
  isLeafCommentRecord,
  isLeafDocumentPatch,
  type LeafCanonicalPatch,
  type LeafCommentPatchEntry,
  type LeafCommentRecord,
  type LeafConditionalUndoPlan,
  type LeafNodeFieldValue,
  type LeafNodeRecord,
  type LeafPageRecord,
  type LeafPreparedHistoryTransition,
  type LeafPreparedTransaction,
  type LeafPropertyDelta,
  type LeafPropertyMutation,
  type LeafPropertyValue,
  type LeafRecordSnapshot,
  type LeafSemanticCommand,
  type LeafStyleValue,
} from "./protocol";
import { mergeLeafPages } from "./merge";

const RANK_RADIX = 36n;
const RANK_WIDTH = 16;
const RANK_MAX = RANK_RADIX ** BigInt(RANK_WIDTH) - 1n;
const RANK_STEP = RANK_RADIX ** 8n;
/**
 * Stride for open-ended prepends. Initial layouts start at `RANK_STEP`, so the
 * space below the first sibling is only `RANK_STEP` wide; a full-width stride
 * would fit once. The smaller stride still yields ~1.7 million sequential
 * prepends from a fresh layout before the guarded bisection fallback.
 */
const RANK_PREPEND_STEP = RANK_RADIX ** 4n;
const RANK_PATTERN = /^[0-9a-z]{16}$/;

export type LeafRecordMap = Map<string, LeafNodeRecord>;

type LeafRecordIndex = {
  childrenByParent: Map<string | null, Set<string>>;
  rankOwnersByParent: Map<string | null, Map<string, string>>;
};

const RECORD_INDEXES = new WeakMap<LeafRecordMap, LeafRecordIndex>();

/**
 * Document page list, attached to the record map rather than passed alongside it.
 *
 * Pages are document-level state, but every function in this module — prepare,
 * apply, undo, the Worker's commit path — is written against `(records,
 * patches)`. Hanging the list off the map the same way `RECORD_INDEXES` hangs
 * off it lets a `setPages` patch be prepared, applied, and rolled back through
 * those existing signatures instead of threading a page argument through all of
 * them. A map with no entry reads as the default single page, matching
 * `getLeafPages`.
 */
const RECORD_PAGES = new WeakMap<LeafRecordMap, LeafPageRecord[]>();

export function getLeafRecordMapPages(
  records: ReadonlyMap<string, LeafNodeRecord>,
): LeafPageRecord[] {
  return RECORD_PAGES.get(records as LeafRecordMap) ?? defaultLeafPages();
}

export function setLeafRecordMapPages(
  records: ReadonlyMap<string, LeafNodeRecord>,
  pages: readonly LeafPageRecord[],
) {
  RECORD_PAGES.set(records as LeafRecordMap, normalizeLeafPages(pages));
}

/**
 * Comment lane, attached to the record map the same way `RECORD_PAGES` is: the
 * lane is document-level state, and hanging it off the map lets a
 * `commentRecords` patch flow through the `(records, patches)` signatures of
 * prepare, apply, and undo without threading a comments argument through them.
 * A map with no entry reads as an empty lane.
 */
const RECORD_COMMENTS = new WeakMap<LeafRecordMap, ReadonlyMap<string, LeafCommentRecord>>();

const EMPTY_COMMENT_LANE: ReadonlyMap<string, LeafCommentRecord> = new Map();

export function getLeafRecordMapComments(
  records: ReadonlyMap<string, LeafNodeRecord>,
): ReadonlyMap<string, LeafCommentRecord> {
  return RECORD_COMMENTS.get(records as LeafRecordMap) ?? EMPTY_COMMENT_LANE;
}

export function setLeafRecordMapComments(
  records: ReadonlyMap<string, LeafNodeRecord>,
  comments: ReadonlyMap<string, LeafCommentRecord>,
) {
  RECORD_COMMENTS.set(records as LeafRecordMap, comments);
}

/**
 * Canonicalizes a comment-record list into the id-keyed lane map: structurally
 * valid records, unique ids matching their record's `id`, bounded lane size.
 */
export function normalizeLeafComments(
  comments: readonly LeafCommentRecord[] | undefined,
): Map<string, LeafCommentRecord> {
  const lane = new Map<string, LeafCommentRecord>();
  if (!comments) return lane;
  if (comments.length > LEAF_MAX_COMMENT_RECORDS) {
    throw new Error("Comment lane exceeds the document budget");
  }
  for (const record of comments) {
    if (!isLeafCommentRecord(record)) throw new Error("Comment record is invalid");
    if (lane.has(record.id)) throw new Error(`Duplicate comment record id: ${record.id}`);
    lane.set(record.id, cloneValue(record));
  }
  return lane;
}

/** Page lists are canonicalized before comparison, so this is order-sensitive by id/name/rank/background. */
function pageListsEqual(left: readonly LeafPageRecord[], right: readonly LeafPageRecord[]) {
  return (
    left.length === right.length &&
    left.every((page, index) => {
      const other = right[index]!;
      return (
        page.id === other.id &&
        page.name === other.name &&
        page.rank === other.rank &&
        page.background === other.background
      );
    })
  );
}

export function cloneLeafRecord(record: LeafNodeRecord): LeafNodeRecord {
  return {
    ...record,
    imageAsset: record.imageAsset ? { ...record.imageAsset } : null,
    imageGeneration: record.imageGeneration
      ? {
          ...record.imageGeneration,
          referenceNodeIds: [...record.imageGeneration.referenceNodeIds],
        }
      : null,
    styles: { ...record.styles },
  };
}

export function createLeafRecordMap(records: readonly LeafNodeRecord[]): LeafRecordMap {
  return createOwnedLeafRecordMap(records, true, true);
}

function createOwnedLeafRecordMap(
  records: readonly LeafNodeRecord[],
  cloneRecords: boolean,
  initializeIndex: boolean,
): LeafRecordMap {
  const map = new Map<string, LeafNodeRecord>();
  for (const record of records) {
    if (map.has(record.id)) throw new Error(`Duplicate node id: ${record.id}`);
    map.set(record.id, cloneRecords ? cloneLeafRecord(record) : record);
  }
  validateGraph(map);
  if (initializeIndex) RECORD_INDEXES.set(map, buildRecordIndex(map));
  return map;
}

export function cloneLeafRecordMap(records: ReadonlyMap<string, LeafNodeRecord>): LeafRecordMap {
  const cloned = new Map([...records].map(([id, record]) => [id, cloneLeafRecord(record)]));
  RECORD_INDEXES.set(cloned, buildRecordIndex(cloned));
  return cloned;
}

export function createInitialLeafRank(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("Rank index must be non-negative");
  const rank = BigInt(index + 1) * RANK_STEP;
  if (rank >= RANK_MAX) throw new Error("Rank space exhausted");
  return formatRank(rank);
}

/**
 * Open-ended inserts — appends with no upper anchor and prepends with no lower
 * anchor — advance by a fixed `RANK_STEP` stride instead of bisecting toward
 * the end of the rank space. Bisection toward an open end halves the remaining
 * gap on every sequential insert and exhausts it after ~84 single appends;
 * striding keeps open-ended inserts bounded by the rank alphabet instead
 * (~2.8e12 at either end), and matches the spacing `createInitialLeafRank`
 * gives initial layouts. Inserts between two real neighbors still bisect, and
 * the last stride of headroom at each end falls back to guarded bisection.
 */
export function createLeafRankBetween(afterRank?: string, beforeRank?: string): string {
  const lower = afterRank === undefined ? 0n : parseRank(afterRank);
  const upper = beforeRank === undefined ? RANK_MAX : parseRank(beforeRank);
  if (lower >= upper) throw new Error("Rank anchors are out of order");
  if (upper - lower <= 1n) throw new Error("Rank space exhausted; rebalance is required");
  if (beforeRank === undefined && RANK_MAX - lower > 2n * RANK_STEP) {
    return formatRank(lower + RANK_STEP);
  }
  if (afterRank === undefined && upper > 2n * RANK_PREPEND_STEP) {
    return formatRank(upper - RANK_PREPEND_STEP);
  }
  return formatRank(lower + (upper - lower) / 2n);
}

/** Batch variant of `createLeafRankBetween`; open-ended batches stride the same way. */
export function createLeafRanksBetween(
  count: number,
  afterRank?: string,
  beforeRank?: string,
): string[] {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("Rank allocation count must be a positive safe integer");
  }
  const lower = afterRank === undefined ? 0n : parseRank(afterRank);
  const upper = beforeRank === undefined ? RANK_MAX : parseRank(beforeRank);
  if (lower >= upper) throw new Error("Rank anchors are out of order");
  const total = BigInt(count);
  if (beforeRank === undefined && RANK_MAX - lower > (total + 1n) * RANK_STEP) {
    return Array.from({ length: count }, (_, index) =>
      formatRank(lower + RANK_STEP * BigInt(index + 1)),
    );
  }
  if (afterRank === undefined && upper > (total + 1n) * RANK_PREPEND_STEP) {
    return Array.from({ length: count }, (_, index) =>
      formatRank(upper - RANK_PREPEND_STEP * BigInt(count - index)),
    );
  }
  const step = (upper - lower) / (total + 1n);
  if (step < 1n) throw new Error("Rank space exhausted; rebalance is required");
  return Array.from({ length: count }, (_, index) => formatRank(lower + step * BigInt(index + 1)));
}

export function prepareLeafTransaction(
  current: ReadonlyMap<string, LeafNodeRecord>,
  commands: readonly LeafSemanticCommand[],
): LeafPreparedTransaction {
  if (commands.length === 0) throw new Error("A transaction requires at least one command");
  // The editor emits one semantic command for nearly every hot-path edit. Avoid
  // copying the document for those operations; prepareCommand only reads the
  // input map and clones records it places in the resulting patches.
  if (commands.length === 1) return prepareCommand(current, commands[0]);

  // Multi-command transactions need a working view because later commands may
  // depend on earlier ones. Canonical application is copy-on-write, so a shallow
  // map is sufficient and keeps record payloads shared until they are touched.
  const working = new Map(current);
  RECORD_INDEXES.set(working, buildRecordIndex(working));
  // The working view has to carry the page list too, or a setPages command later
  // in the transaction would compare against the default page and fail. Same for
  // the comment lane.
  RECORD_PAGES.set(working, getLeafRecordMapPages(current));
  RECORD_COMMENTS.set(working, getLeafRecordMapComments(current));
  const forward: LeafCanonicalPatch[] = [];
  const inverseGroups: LeafCanonicalPatch[][] = [];
  const touched = new Set<string>();

  for (const command of commands) {
    const prepared = prepareCommand(working, command);
    applyLeafCanonicalPatches(working, prepared.forward);
    forward.push(...prepared.forward);
    inverseGroups.push(prepared.inverse);
    for (const id of prepared.touchedNodeIds) touched.add(id);
  }

  return {
    forward,
    inverse: inverseGroups.reverse().flat(),
    touchedNodeIds: [...touched],
  };
}

export function applyLeafCanonicalPatches(
  current: LeafRecordMap,
  patches: readonly LeafCanonicalPatch[],
): void {
  if (patches.length === 0) return;
  // Property-only commits do not use ancestry or rank indexes, and a page patch
  // touches no records at all. Keeping the index lazy makes a copy-on-write
  // confirmed fork O(map size) to initialize and preserves O(fields) remote
  // edits afterwards.
  const index = patches.some((patch) => patch.type !== "patchFields" && !isLeafDocumentPatch(patch))
    ? getOrBuildRecordIndex(current)
    : undefined;
  const touchedIds = new Set<string>();
  for (const patch of patches) {
    if (isLeafDocumentPatch(patch)) continue;
    if (patch.type === "patchFields" || patch.type === "moveRecord") touchedIds.add(patch.nodeId);
    else for (const record of patch.records) touchedIds.add(record.id);
  }
  const before = new Map<string, LeafNodeRecord | null>();
  for (const id of touchedIds) {
    const record = current.get(id);
    before.set(id, record ? cloneLeafRecord(record) : null);
  }
  // Snapshot document-level lanes only when a patch can change them, so the
  // common record-only transaction pays nothing for pages or comments.
  const beforePages = patches.some((patch) => patch.type === "setPages")
    ? getLeafRecordMapPages(current)
    : null;
  const beforeComments = patches.some((patch) => patch.type === "commentRecords")
    ? getLeafRecordMapComments(current)
    : null;

  try {
    for (const patch of patches) applyPatch(current, patch, index);
  } catch (error) {
    // Restore only the transaction's write set. Canonical patches never mutate
    // parent records, so this is sufficient to preserve atomic application while
    // keeping property edits O(fields) instead of O(document size).
    for (const [id, record] of before) {
      if (record) current.set(id, record);
      else current.delete(id);
    }
    if (index) RECORD_INDEXES.set(current, buildRecordIndex(current));
    if (beforePages) setLeafRecordMapPages(current, beforePages);
    if (beforeComments) setLeafRecordMapComments(current, beforeComments);
    throw error;
  }
}

export function invertLeafCanonicalPatches(
  patches: readonly LeafCanonicalPatch[],
): LeafCanonicalPatch[] {
  return [...patches].reverse().map(invertPatch);
}

export function prepareLeafConditionalUndo(
  current: ReadonlyMap<string, LeafNodeRecord>,
  inverse: readonly LeafCanonicalPatch[],
): LeafConditionalUndoPlan {
  const canUseWriteSetDraft = current instanceof Map;
  const working = canUseWriteSetDraft ? (current as LeafRecordMap) : cloneLeafRecordMap(current);
  if (!canUseWriteSetDraft) {
    setLeafRecordMapPages(working, getLeafRecordMapPages(current));
    setLeafRecordMapComments(working, getLeafRecordMapComments(current));
  }
  const originalWriteSet = canUseWriteSetDraft ? capturePatchWriteSet(current, inverse) : null;
  // The draft applies to the live map, so a document-level patch in the inverse
  // has to be rolled back alongside the record write set.
  const originalPages =
    canUseWriteSetDraft && inverse.some((patch) => patch.type === "setPages")
      ? getLeafRecordMapPages(current)
      : null;
  const originalComments =
    canUseWriteSetDraft && inverse.some((patch) => patch.type === "commentRecords")
      ? getLeafRecordMapComments(current)
      : null;
  const accepted: LeafCanonicalPatch[] = [];
  const skipped: LeafConditionalUndoPlan["skipped"] = [];

  try {
    inverse.forEach((patch, patchIndex) => {
      const candidate = filterUndoPatch(working, patch, patchIndex, skipped);
      if (!candidate) return;
      try {
        applyLeafCanonicalPatches(working, [candidate]);
        accepted.push(candidate);
      } catch (error) {
        skipped.push({
          patchIndex,
          nodeId: patchNodeId(patch),
          reason: error instanceof Error ? error.message : "Undo precondition failed",
        });
      }
    });
  } finally {
    if (originalWriteSet) restorePatchWriteSet(working, originalWriteSet);
    if (originalPages) setLeafRecordMapPages(working, originalPages);
    if (originalComments) setLeafRecordMapComments(working, originalComments);
  }

  return { patches: accepted, skipped };
}

/**
 * Converts a journaled inverse into the bounded canonical transition that is
 * safe to apply to the current authority. Redo uses the same operation with the
 * inverse journaled by the preceding undo/redo transition.
 */
export function prepareLeafHistoryTransition(
  current: ReadonlyMap<string, LeafNodeRecord>,
  inverse: readonly LeafCanonicalPatch[],
): LeafPreparedHistoryTransition {
  const plan = prepareLeafConditionalUndo(current, inverse);
  return {
    forward: plan.patches,
    inverse: invertLeafCanonicalPatches(plan.patches),
    touchedNodeIds: collectLeafPatchNodeIds(plan.patches),
    skipped: plan.skipped,
  };
}

export function collectLeafPatchNodeIds(patches: readonly LeafCanonicalPatch[]): string[] {
  const ids = new Set<string>();
  for (const patch of patches) {
    if (isLeafDocumentPatch(patch)) continue;
    if (patch.type === "patchFields" || patch.type === "moveRecord") ids.add(patch.nodeId);
    else for (const record of patch.records) ids.add(record.id);
  }
  return [...ids];
}

/**
 * Canonicalizes a page list: unique ids, rank order, and never empty. An empty
 * or missing list normalizes to the single default page so a document always
 * has somewhere to put a root record.
 */
export function normalizeLeafPages(pages: readonly LeafPageRecord[] | undefined): LeafPageRecord[] {
  if (!pages || pages.length === 0) return defaultLeafPages();
  const seen = new Set<string>();
  const normalized = pages.map((page) => {
    if (!page.id) throw new Error("Page id is required");
    if (seen.has(page.id)) throw new Error(`Duplicate page id: ${page.id}`);
    seen.add(page.id);
    const background = page.background?.trim();
    return background
      ? { id: page.id, name: page.name, rank: page.rank, background }
      : { id: page.id, name: page.name, rank: page.rank };
  });
  return normalized.sort(
    (left, right) => left.rank.localeCompare(right.rank) || left.id.localeCompare(right.id),
  );
}

export class LeafReferenceDocument {
  readonly records: LeafRecordMap;

  /**
   * Page identity, naming, and order are document-level state rather than a
   * projection of `record.pageId`, so a page holding zero records survives a
   * snapshot round trip.
   *
   * The list lives on `RECORD_PAGES` keyed by `this.records` rather than in a
   * field, so a `setPages` patch applied through `apply()` — which only receives
   * the record map — is visible from `pages()` without a second write path.
   */
  constructor(
    records: readonly LeafNodeRecord[],
    ownership: "adopt" | "clone" | "fork" = "clone",
    pages?: readonly LeafPageRecord[],
    comments?: readonly LeafCommentRecord[],
  ) {
    this.records = createOwnedLeafRecordMap(records, ownership === "clone", ownership !== "fork");
    setLeafRecordMapPages(this.records, normalizeLeafPages(pages));
    setLeafRecordMapComments(this.records, normalizeLeafComments(comments));
  }

  /** Takes ownership of a decoded immutable snapshot without cloning every record. */
  static adopt(
    records: readonly LeafNodeRecord[],
    pages?: readonly LeafPageRecord[],
    comments?: readonly LeafCommentRecord[],
  ) {
    return new LeafReferenceDocument(records, "adopt", pages, comments);
  }

  static fromSnapshot(snapshot: LeafRecordSnapshot, ownership: "adopt" | "clone" = "clone") {
    return new LeafReferenceDocument(
      snapshot.records,
      ownership,
      snapshot.pages,
      snapshot.comments,
    );
  }

  /** Forks the current state with copy-on-write record payloads. */
  fork() {
    return new LeafReferenceDocument(
      [...this.records.values()],
      "fork",
      this.pages(),
      this.comments(),
    );
  }

  snapshot(): LeafNodeRecord[] {
    return [...this.records.values()].map(cloneLeafRecord);
  }

  pages(): LeafPageRecord[] {
    return getLeafRecordMapPages(this.records).map((page) => ({ ...page }));
  }

  setPages(pages: readonly LeafPageRecord[]) {
    setLeafRecordMapPages(this.records, pages);
  }

  comments(): LeafCommentRecord[] {
    return [...getLeafRecordMapComments(this.records).values()].map((record) => cloneValue(record));
  }

  setComments(comments: readonly LeafCommentRecord[]) {
    setLeafRecordMapComments(this.records, normalizeLeafComments(comments));
  }

  recordSnapshot(): LeafRecordSnapshot {
    return {
      schemaVersion: LEAF_RECORD_SCHEMA_VERSION,
      records: this.snapshot(),
      pages: this.pages(),
      comments: this.comments(),
    };
  }

  prepare(commands: readonly LeafSemanticCommand[]) {
    return prepareLeafTransaction(this.records, commands);
  }

  apply(patches: readonly LeafCanonicalPatch[]) {
    applyLeafCanonicalPatches(this.records, patches);
  }

  commit(commands: readonly LeafSemanticCommand[]) {
    const prepared = this.prepare(commands);
    this.apply(prepared.forward);
    return prepared;
  }

  prepareUndo(inverse: readonly LeafCanonicalPatch[]) {
    return prepareLeafConditionalUndo(this.records, inverse);
  }
}

function prepareCommand(
  records: ReadonlyMap<string, LeafNodeRecord>,
  command: LeafSemanticCommand,
): LeafPreparedTransaction {
  switch (command.type) {
    case "createRecords": {
      if (command.records.length === 0) throw new Error("createRecords cannot be empty");
      const created = command.records.map(cloneLeafRecord);
      const index = getRecordIndex(records);
      rebaseCreatedSiblingRanks(records, created, index);
      validateCreatedRecords(records, created, index);
      return {
        forward: [{ type: "createRecords", records: created }],
        inverse: [{ type: "deleteRecords", records: created.map(cloneLeafRecord) }],
        touchedNodeIds: created.map((record) => record.id),
      };
    }
    case "setPages": {
      const before = getLeafRecordMapPages(records);
      const theirs = normalizeLeafPages(command.pages);
      // A command that names the list it was edited from is three-way merged
      // when that list has moved on, so two clients touching different pages
      // both land. Without a base (older clients) the whole list replaces.
      // Both authorities and the client's own rebase run this same branch,
      // which is what keeps an optimistic replica converging on the commit.
      const base = command.basePages ? normalizeLeafPages(command.basePages) : null;
      const after =
        base && !pageListsEqual(base, before)
          ? normalizeLeafPages(mergeLeafPages(base, before, theirs))
          : theirs;
      if (after.length > LEAF_MAX_DOCUMENT_PAGES) {
        throw new Error("Page list exceeds the document budget");
      }
      // A no-op page write is an error for the same reason an empty patchFields
      // is: it would journal a transaction that changes nothing, and the
      // controller's compaction relies on no-ops surfacing rather than being
      // silently dispatched.
      if (pageListsEqual(before, after)) throw new Error("setPages has no effect");
      return {
        forward: [{ type: "setPages", before, after }],
        inverse: [{ type: "setPages", before: after, after: before }],
        touchedNodeIds: [],
      };
    }
    case "commentRecords": {
      if (command.puts.length === 0 && command.deletes.length === 0) {
        throw new Error("commentRecords cannot be empty");
      }
      const lane = getLeafRecordMapComments(records);
      const entries: LeafCommentPatchEntry[] = [];
      const touchedIds = new Set<string>();
      for (const put of command.puts) {
        if (!isLeafCommentRecord(put)) throw new Error("Comment record is invalid");
        if (touchedIds.has(put.id)) throw new Error(`Duplicate comment write: ${put.id}`);
        touchedIds.add(put.id);
        const before = lane.get(put.id) ?? null;
        const after = cloneValue(put);
        // An identical re-put is a converged no-op (e.g. the same reaction
        // toggled from two tabs), not an error like an empty patchFields —
        // skip it and keep the entries that still change something.
        if (deepEqual(before, after)) continue;
        entries.push({ id: put.id, before: before ? cloneValue(before) : null, after });
      }
      for (const id of command.deletes) {
        if (touchedIds.has(id)) throw new Error(`Duplicate comment write: ${id}`);
        touchedIds.add(id);
        const before = lane.get(id);
        if (!before) continue;
        entries.push({ id, before: cloneValue(before), after: null });
      }
      if (entries.length === 0) throw new Error("commentRecords has no effect");
      const netGrowth = entries.filter((entry) => !entry.before && entry.after).length;
      if (lane.size + netGrowth > LEAF_MAX_COMMENT_RECORDS) {
        throw new Error("Comment lane exceeds the document budget");
      }
      // The whole lane checkpoints inside one byte-capped chunk, so its
      // serialized size is bounded at write time — the record-count budget
      // alone still admits a lane too large to publish.
      const prospectiveLane = new Map(lane);
      for (const entry of entries) {
        if (entry.after) prospectiveLane.set(entry.id, entry.after);
        else prospectiveLane.delete(entry.id);
      }
      let laneBytes = 0;
      const encoder = new TextEncoder();
      for (const record of prospectiveLane.values()) {
        laneBytes += encoder.encode(JSON.stringify(record)).byteLength + 1;
      }
      if (laneBytes > LEAF_MAX_COMMENT_LANE_BYTES) {
        throw new Error("Comment lane exceeds the byte budget");
      }
      return {
        forward: [{ type: "commentRecords", entries }],
        inverse: [
          {
            type: "commentRecords",
            entries: [...entries]
              .reverse()
              .map((entry) => ({ id: entry.id, before: entry.after, after: entry.before })),
          },
        ],
        touchedNodeIds: [],
      };
    }
    case "patchFields": {
      const record = records.get(command.nodeId);
      if (!record) throw new Error(`Node not found: ${command.nodeId}`);
      if (command.mutations.length === 0) throw new Error("patchFields cannot be empty");
      const staged = cloneLeafRecord(record);
      const deltas: LeafPropertyDelta[] = [];
      for (const mutation of command.mutations) {
        const delta = applyPropertyMutation(staged, mutation);
        if (delta) deltas.push(delta);
      }
      if (deltas.length === 0) throw new Error("patchFields has no effect");
      return {
        forward: [{ type: "patchFields", nodeId: record.id, deltas }],
        inverse: [
          {
            type: "patchFields",
            nodeId: record.id,
            deltas: [...deltas].reverse().map(invertDelta),
          },
        ],
        touchedNodeIds: [record.id],
      };
    }
    case "moveRecord": {
      const record = records.get(command.nodeId);
      if (!record) throw new Error(`Node not found: ${command.nodeId}`);
      if (command.parentId === command.nodeId) throw new Error("A node cannot parent itself");
      if (command.parentId && !records.has(command.parentId)) {
        throw new Error(`Parent not found: ${command.parentId}`);
      }
      let ancestor = command.parentId;
      while (ancestor) {
        if (ancestor === command.nodeId) throw new Error("Move would create a cycle");
        ancestor = records.get(ancestor)?.parentId ?? null;
      }
      const after = command.afterId
        ? requireSiblingRecord(records, command.afterId, command.parentId, record.id)
        : undefined;
      const before = command.beforeId
        ? requireSiblingRecord(records, command.beforeId, command.parentId, record.id)
        : undefined;
      if (after && before && compareRecords(after, before) >= 0) {
        throw new Error("Move anchors are out of order");
      }
      const effectiveAfter =
        after ??
        (!before
          ? selectChildren(records, command.parentId, getRecordIndex(records))
              .filter((candidate) => candidate.id !== record.id)
              .sort(compareRecords)
              .at(-1)
          : undefined);
      const rank = createLeafRankBetween(effectiveAfter?.rank, before?.rank);
      const beforeStructure = { parentId: record.parentId, rank: record.rank };
      const afterStructure = { parentId: command.parentId, rank };
      return {
        forward: [
          { type: "moveRecord", nodeId: record.id, before: beforeStructure, after: afterStructure },
        ],
        inverse: [
          { type: "moveRecord", nodeId: record.id, before: afterStructure, after: beforeStructure },
        ],
        touchedNodeIds: [record.id],
      };
    }
    case "deleteSubtree": {
      const root = records.get(command.nodeId);
      if (!root) throw new Error(`Node not found: ${command.nodeId}`);
      const deleted = collectSubtree(records, root.id, getRecordIndex(records));
      return {
        forward: [{ type: "deleteRecords", records: deleted.map(cloneLeafRecord) }],
        inverse: [{ type: "createRecords", records: deleted.map(cloneLeafRecord) }],
        touchedNodeIds: deleted.map((record) => record.id),
      };
    }
  }
}

/**
 * Concurrent clients can legitimately choose the same insertion rank from the
 * same base revision. Preserve both semantic creates by appending the later
 * accepted sibling after the current authoritative siblings.
 */
function rebaseCreatedSiblingRanks(
  current: ReadonlyMap<string, LeafNodeRecord>,
  created: LeafNodeRecord[],
  index?: LeafRecordIndex,
) {
  const usedByParent = new Map<string | null, Set<string>>();
  const maxByParent = new Map<string | null, string>();
  const remember = (parentId: string | null, rank: string) => {
    let used = usedByParent.get(parentId);
    if (!used) {
      used = new Set();
      usedByParent.set(parentId, used);
    }
    used.add(rank);
    const max = maxByParent.get(parentId);
    if (!max || rank > max) maxByParent.set(parentId, rank);
  };
  const affectedParents = new Set(created.map((record) => record.parentId));
  if (index) {
    for (const parentId of affectedParents) {
      for (const rank of index.rankOwnersByParent.get(parentId)?.keys() ?? []) {
        remember(parentId, rank);
      }
    }
  } else {
    for (const record of current.values()) {
      if (affectedParents.has(record.parentId)) remember(record.parentId, record.rank);
    }
  }

  for (const record of created) {
    const used = usedByParent.get(record.parentId);
    if (used?.has(record.rank)) {
      record.rank = createLeafRankBetween(maxByParent.get(record.parentId), undefined);
    }
    remember(record.parentId, record.rank);
  }
}

function applyPatch(
  records: LeafRecordMap,
  patch: LeafCanonicalPatch,
  index: LeafRecordIndex | undefined,
) {
  switch (patch.type) {
    case "createRecords": {
      validateCreatedRecords(records, patch.records, index);
      for (const record of patch.records) {
        const cloned = cloneLeafRecord(record);
        records.set(record.id, cloned);
        addRecordToIndex(index!, cloned);
      }
      return;
    }
    case "patchFields": {
      const record = records.get(patch.nodeId);
      if (!record) throw new Error(`Node not found: ${patch.nodeId}`);
      const next = cloneLeafRecord(record);
      for (const delta of patch.deltas) {
        if (!propertyMatches(next, delta.target, delta.key, delta.before)) {
          throw new Error(`Field precondition failed: ${patch.nodeId}.${delta.key}`);
        }
        writeProperty(next, delta.target, delta.key, delta.after);
      }
      records.set(patch.nodeId, next);
      return;
    }
    case "moveRecord": {
      const record = records.get(patch.nodeId);
      if (!record) throw new Error(`Node not found: ${patch.nodeId}`);
      if (record.parentId !== patch.before.parentId || record.rank !== patch.before.rank) {
        throw new Error(`Structure precondition failed: ${patch.nodeId}`);
      }
      validateMoveResult(records, patch.nodeId, patch.after, index!);
      const next = cloneLeafRecord(record);
      next.parentId = patch.after.parentId;
      next.rank = patch.after.rank;
      removeRecordFromIndex(index!, record);
      records.set(patch.nodeId, next);
      addRecordToIndex(index!, next);
      return;
    }
    case "deleteRecords": {
      const deletedIds = new Set(patch.records.map((record) => record.id));
      for (const expected of patch.records) {
        const record = records.get(expected.id);
        if (!record || !deepEqual(record, expected)) {
          throw new Error(`Delete precondition failed: ${expected.id}`);
        }
      }
      for (const deletedId of deletedIds) {
        for (const childId of index!.childrenByParent.get(deletedId) ?? []) {
          if (!deletedIds.has(childId)) {
            throw new Error(`Delete would orphan node: ${childId}`);
          }
        }
      }
      for (const expected of patch.records) {
        removeRecordFromIndex(index!, expected);
        records.delete(expected.id);
      }
      return;
    }
    case "setPages": {
      const current = getLeafRecordMapPages(records);
      if (!pageListsEqual(current, patch.before)) {
        throw new Error("Page list precondition failed");
      }
      setLeafRecordMapPages(records, patch.after);
      return;
    }
    case "commentRecords": {
      const lane = getLeafRecordMapComments(records);
      for (const entry of patch.entries) {
        const current = lane.get(entry.id) ?? null;
        if (!deepEqual(current, entry.before)) {
          throw new Error(`Comment precondition failed: ${entry.id}`);
        }
      }
      // Write a fresh map so a snapshotted lane reference stays a valid
      // rollback target for the atomic-application guarantee above.
      const next = new Map(lane);
      for (const entry of patch.entries) {
        if (entry.after) next.set(entry.id, cloneValue(entry.after));
        else next.delete(entry.id);
      }
      if (next.size > LEAF_MAX_COMMENT_RECORDS) {
        throw new Error("Comment lane exceeds the document budget");
      }
      setLeafRecordMapComments(records, next);
    }
  }
}

function filterUndoPatch(
  records: LeafRecordMap,
  patch: LeafCanonicalPatch,
  patchIndex: number,
  skipped: LeafConditionalUndoPlan["skipped"],
): LeafCanonicalPatch | null {
  if (patch.type === "patchFields") {
    const record = records.get(patch.nodeId);
    if (!record) {
      skipped.push({ patchIndex, nodeId: patch.nodeId, reason: "Node no longer exists" });
      return null;
    }
    const deltas = patch.deltas.filter((delta) => {
      const matches = propertyMatches(record, delta.target, delta.key, delta.before);
      if (!matches) {
        skipped.push({
          patchIndex,
          nodeId: patch.nodeId,
          properties: [`${delta.target}:${delta.key}`],
          reason: "Property changed after the original transaction",
        });
      }
      return matches;
    });
    return deltas.length ? { ...patch, deltas } : null;
  }
  if (patch.type === "moveRecord") {
    const record = records.get(patch.nodeId);
    if (!record || record.parentId !== patch.before.parentId || record.rank !== patch.before.rank) {
      skipped.push({
        patchIndex,
        nodeId: patch.nodeId,
        reason: "Structure changed after the original transaction",
      });
      return null;
    }
    return patch;
  }
  if (patch.type === "setPages") {
    // Undoing a page change is all-or-nothing: there is no per-page delta to
    // filter down to, so a list that moved on since the original transaction
    // just drops the patch rather than clobbering the newer arrangement.
    if (!pageListsEqual(getLeafRecordMapPages(records), patch.before)) {
      skipped.push({
        patchIndex,
        nodeId: null,
        reason: "Page list changed after the original transaction",
      });
      return null;
    }
    return patch;
  }
  if (patch.type === "commentRecords") {
    // Comment entries are independent compare-and-set writes, so filter
    // per-record like patchFields rather than all-or-nothing.
    const lane = getLeafRecordMapComments(records);
    const entries = patch.entries.filter((entry) => {
      const matches = deepEqual(lane.get(entry.id) ?? null, entry.before);
      if (!matches) {
        skipped.push({
          patchIndex,
          nodeId: null,
          properties: [`comment:${entry.id}`],
          reason: "Comment changed after the original transaction",
        });
      }
      return matches;
    });
    return entries.length ? { ...patch, entries } : null;
  }
  if (patch.type === "deleteRecords") {
    const matches = patch.records.every((expected) => {
      const record = records.get(expected.id);
      return !!record && deepEqual(record, expected);
    });
    if (!matches) {
      skipped.push({
        patchIndex,
        nodeId: patch.records[0]?.id ?? null,
        reason: "Created content received later edits",
      });
      return null;
    }
    return patch;
  }
  const ids = new Set(patch.records.map((record) => record.id));
  const canRestore = patch.records.every(
    (record) =>
      !records.has(record.id) &&
      (record.parentId === null || ids.has(record.parentId) || records.has(record.parentId)),
  );
  if (!canRestore) {
    skipped.push({
      patchIndex,
      nodeId: patch.records[0]?.id ?? null,
      reason: "Deleted content cannot be restored at its original parent",
    });
    return null;
  }
  return patch;
}

function applyPropertyMutation(
  record: LeafNodeRecord,
  mutation: LeafPropertyMutation,
): LeafPropertyDelta | null {
  if (mutation.type === "setField") {
    const before = cloneValue(record[mutation.field]) as LeafNodeFieldValue;
    const after = cloneValue(mutation.value) as LeafNodeFieldValue;
    if (deepEqual(before, after)) return null;
    (record[mutation.field] as LeafNodeFieldValue) = after;
    return {
      target: "field",
      key: mutation.field,
      before: { present: true, value: before },
      after: { present: true, value: after },
    };
  }
  const present = Object.hasOwn(record.styles, mutation.key);
  const before: LeafPropertyValue = present
    ? { present: true, value: record.styles[mutation.key] }
    : { present: false };
  const after: LeafPropertyValue =
    mutation.type === "setStyle" ? { present: true, value: mutation.value } : { present: false };
  if (deepEqual(before, after)) return null;
  writeProperty(record, "style", mutation.key, after);
  return { target: "style", key: mutation.key, before, after };
}

function writeProperty(
  record: LeafNodeRecord,
  target: "field" | "style",
  key: string,
  value: LeafPropertyValue,
) {
  if (target === "field") {
    if (!value.present) throw new Error("Node fields cannot be deleted");
    (record as unknown as Record<string, unknown>)[key] = cloneValue(value.value);
  } else if (value.present) {
    record.styles[key] = value.value as LeafStyleValue;
  } else {
    delete record.styles[key];
  }
}

function propertyMatches(
  record: LeafNodeRecord,
  target: "field" | "style",
  key: string,
  expected: LeafPropertyValue,
) {
  if (target === "field") {
    return (
      expected.present &&
      deepEqual((record as unknown as Record<string, unknown>)[key], expected.value)
    );
  }
  const present = Object.hasOwn(record.styles, key);
  return expected.present ? present && deepEqual(record.styles[key], expected.value) : !present;
}

function invertPatch(patch: LeafCanonicalPatch): LeafCanonicalPatch {
  switch (patch.type) {
    case "createRecords":
      return { type: "deleteRecords", records: patch.records.map(cloneLeafRecord) };
    case "deleteRecords":
      return { type: "createRecords", records: patch.records.map(cloneLeafRecord) };
    case "moveRecord":
      return { ...patch, before: patch.after, after: patch.before };
    case "patchFields":
      return {
        ...patch,
        deltas: [...patch.deltas].reverse().map(invertDelta),
      };
    case "setPages":
      return { type: "setPages", before: patch.after, after: patch.before };
    case "commentRecords":
      return {
        type: "commentRecords",
        entries: [...patch.entries]
          .reverse()
          .map((entry) => ({ id: entry.id, before: entry.after, after: entry.before })),
      };
  }
}

function invertDelta(delta: LeafPropertyDelta): LeafPropertyDelta {
  return { ...delta, before: delta.after, after: delta.before } as LeafPropertyDelta;
}

function collectSubtree(
  records: ReadonlyMap<string, LeafNodeRecord>,
  rootId: string,
  index?: LeafRecordIndex,
) {
  const result: LeafNodeRecord[] = [];
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift()!;
    const record = records.get(id);
    if (!record) continue;
    result.push(record);
    const children = selectChildren(records, id, index).sort(compareRecords);
    queue.push(...children.map((child) => child.id));
  }
  return result;
}

function validateCreatedRecords(
  records: ReadonlyMap<string, LeafNodeRecord>,
  created: readonly LeafNodeRecord[],
  index?: LeafRecordIndex,
) {
  if (created.length === 0) throw new Error("createRecords cannot be empty");
  const createdById = new Map<string, LeafNodeRecord>();
  const affectedParents = new Set<string | null>();
  for (const record of created) {
    if (!record.id || createdById.has(record.id) || records.has(record.id)) {
      throw new Error(`Node id already exists: ${record.id}`);
    }
    parseRank(record.rank);
    createdById.set(record.id, record);
    affectedParents.add(record.parentId);
  }

  const siblingRanks = new Set<string>();
  if (!index) {
    for (const record of records.values()) {
      if (affectedParents.has(record.parentId)) {
        siblingRanks.add(siblingRankKey(record.parentId, record.rank));
      }
    }
  }
  for (const record of created) {
    if (
      record.parentId !== null &&
      !records.has(record.parentId) &&
      !createdById.has(record.parentId)
    ) {
      throw new Error(`Parent not found: ${record.parentId}`);
    }
    const rankKey = siblingRankKey(record.parentId, record.rank);
    if (
      siblingRanks.has(rankKey) ||
      index?.rankOwnersByParent.get(record.parentId)?.has(record.rank)
    ) {
      throw new Error(`Duplicate sibling rank: ${record.rank}`);
    }
    siblingRanks.add(rankKey);
  }

  const visitState = new Map<string, 1 | 2>();
  for (const record of created) {
    if (visitState.get(record.id) === 2) continue;
    const path: string[] = [];
    let currentId: string | null = record.id;
    while (currentId && createdById.has(currentId)) {
      const state = visitState.get(currentId);
      if (state === 1) throw new Error("Document tree contains a cycle");
      if (state === 2) break;
      visitState.set(currentId, 1);
      path.push(currentId);
      currentId = createdById.get(currentId)?.parentId ?? null;
    }
    for (const id of path) visitState.set(id, 2);
  }
}

function validateMoveResult(
  records: ReadonlyMap<string, LeafNodeRecord>,
  nodeId: string,
  structure: { parentId: string | null; rank: string },
  index?: LeafRecordIndex,
) {
  parseRank(structure.rank);
  if (structure.parentId === nodeId) throw new Error("A node cannot parent itself");
  if (structure.parentId !== null && !records.has(structure.parentId)) {
    throw new Error(`Parent not found: ${structure.parentId}`);
  }
  let ancestor = structure.parentId;
  while (ancestor) {
    if (ancestor === nodeId) throw new Error("Move would create a cycle");
    ancestor = records.get(ancestor)?.parentId ?? null;
  }
  const rankOwner = index?.rankOwnersByParent.get(structure.parentId)?.get(structure.rank);
  if (rankOwner && rankOwner !== nodeId) {
    throw new Error(`Duplicate sibling rank: ${structure.rank}`);
  }
  if (!index) {
    for (const sibling of records.values()) {
      if (
        sibling.id !== nodeId &&
        sibling.parentId === structure.parentId &&
        sibling.rank === structure.rank
      ) {
        throw new Error(`Duplicate sibling rank: ${structure.rank}`);
      }
    }
  }
}

function siblingRankKey(parentId: string | null, rank: string) {
  return `${parentId === null ? "\u0001" : `\u0002${parentId}`}\u0000${rank}`;
}

function buildRecordIndex(records: ReadonlyMap<string, LeafNodeRecord>): LeafRecordIndex {
  const index: LeafRecordIndex = {
    childrenByParent: new Map(),
    rankOwnersByParent: new Map(),
  };
  for (const record of records.values()) addRecordToIndex(index, record);
  return index;
}

function getRecordIndex(records: ReadonlyMap<string, LeafNodeRecord>) {
  return RECORD_INDEXES.get(records as LeafRecordMap);
}

function getOrBuildRecordIndex(records: LeafRecordMap) {
  const existing = RECORD_INDEXES.get(records);
  if (existing) return existing;
  const index = buildRecordIndex(records);
  RECORD_INDEXES.set(records, index);
  return index;
}

function addRecordToIndex(index: LeafRecordIndex, record: LeafNodeRecord) {
  const children = index.childrenByParent.get(record.parentId) ?? new Set<string>();
  children.add(record.id);
  index.childrenByParent.set(record.parentId, children);
  const ranks = index.rankOwnersByParent.get(record.parentId) ?? new Map<string, string>();
  ranks.set(record.rank, record.id);
  index.rankOwnersByParent.set(record.parentId, ranks);
}

function removeRecordFromIndex(index: LeafRecordIndex, record: LeafNodeRecord) {
  const children = index.childrenByParent.get(record.parentId);
  children?.delete(record.id);
  if (children?.size === 0) index.childrenByParent.delete(record.parentId);
  const ranks = index.rankOwnersByParent.get(record.parentId);
  if (ranks?.get(record.rank) === record.id) ranks.delete(record.rank);
  if (ranks?.size === 0) index.rankOwnersByParent.delete(record.parentId);
}

function selectChildren(
  records: ReadonlyMap<string, LeafNodeRecord>,
  parentId: string | null,
  index?: LeafRecordIndex,
) {
  if (!index) {
    return [...records.values()].filter((candidate) => candidate.parentId === parentId);
  }
  const children: LeafNodeRecord[] = [];
  for (const id of index.childrenByParent.get(parentId) ?? []) {
    const record = records.get(id);
    if (record) children.push(record);
  }
  return children;
}

function validateGraph(records: ReadonlyMap<string, LeafNodeRecord>) {
  const siblingRanks = new Set<string>();
  for (const record of records.values()) {
    if (!record.id) throw new Error("Node id is required");
    parseRank(record.rank);
    if (record.parentId !== null && !records.has(record.parentId)) {
      throw new Error(`Parent not found: ${record.parentId}`);
    }
    const siblingKey = siblingRankKey(record.parentId, record.rank);
    if (siblingRanks.has(siblingKey)) throw new Error(`Duplicate sibling rank: ${record.rank}`);
    siblingRanks.add(siblingKey);
  }

  const visitState = new Map<string, 1 | 2>();
  for (const record of records.values()) {
    if (visitState.get(record.id) === 2) continue;
    const path: string[] = [];
    let currentId: string | null = record.id;
    while (currentId) {
      const state = visitState.get(currentId);
      if (state === 1) throw new Error("Document tree contains a cycle");
      if (state === 2) break;
      visitState.set(currentId, 1);
      path.push(currentId);
      currentId = records.get(currentId)?.parentId ?? null;
    }
    for (const id of path) visitState.set(id, 2);
  }
}

function requireSiblingRecord(
  records: ReadonlyMap<string, LeafNodeRecord>,
  id: string,
  parentId: string | null,
  excludedId: string,
) {
  const record = records.get(id);
  if (!record || record.id === excludedId || record.parentId !== parentId) {
    throw new Error(`Move anchor ${id} is not a child of ${parentId ?? "root"}`);
  }
  return record;
}

function compareRecords(left: LeafNodeRecord, right: LeafNodeRecord) {
  return left.rank.localeCompare(right.rank) || left.id.localeCompare(right.id);
}

function parseRank(rank: string) {
  if (!RANK_PATTERN.test(rank)) throw new Error(`Invalid rank: ${rank}`);
  let value = 0n;
  for (const character of rank) {
    value = value * RANK_RADIX + BigInt(parseInt(character, 36));
  }
  return value;
}

function formatRank(value: bigint) {
  if (value <= 0n || value >= RANK_MAX) throw new Error("Rank is outside the valid range");
  return value.toString(36).padStart(RANK_WIDTH, "0");
}

function patchNodeId(patch: LeafCanonicalPatch) {
  if (isLeafDocumentPatch(patch)) return null;
  if (patch.type === "patchFields" || patch.type === "moveRecord") return patch.nodeId;
  return patch.records[0]?.id ?? null;
}

function capturePatchWriteSet(
  records: ReadonlyMap<string, LeafNodeRecord>,
  patches: readonly LeafCanonicalPatch[],
) {
  const originals = new Map<string, LeafNodeRecord | null>();
  for (const patch of patches) {
    if (isLeafDocumentPatch(patch)) continue;
    const ids =
      patch.type === "patchFields" || patch.type === "moveRecord"
        ? [patch.nodeId]
        : patch.records.map((record) => record.id);
    for (const id of ids) {
      if (!originals.has(id)) originals.set(id, records.get(id) ?? null);
    }
  }
  return originals;
}

function restorePatchWriteSet(
  records: LeafRecordMap,
  originals: ReadonlyMap<string, LeafNodeRecord | null>,
) {
  const index = getOrBuildRecordIndex(records);
  for (const id of originals.keys()) {
    const current = records.get(id);
    if (current) removeRecordFromIndex(index, current);
  }
  for (const [id, original] of originals) {
    if (original) {
      records.set(id, original);
      addRecordToIndex(index, original);
    } else {
      records.delete(id);
    }
  }
}

/**
 * Structural equality with the exact semantics `prepareCommand` uses for its
 * no-op detection, exported so callers can pre-filter redundant writes without
 * tripping the "has no effect" throw.
 */
export function leafValuesEqual(left: unknown, right: unknown): boolean {
  return deepEqual(left, right);
}

function cloneValue<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cloneValue) as T;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      cloneValue(child),
    ]),
  ) as T;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]))
    );
  }
  const leftEntries = Object.entries(left as Record<string, unknown>);
  const rightRecord = right as Record<string, unknown>;
  return (
    leftEntries.length === Object.keys(rightRecord).length &&
    leftEntries.every(
      ([key, value]) => Object.hasOwn(rightRecord, key) && deepEqual(value, rightRecord[key]),
    )
  );
}
