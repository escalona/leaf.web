/**
 * Translation between the editor's comment-lane projection and canonical
 * comment records.
 *
 * `EditorStore.commentRecords` mirrors the document's comment lane for overlay
 * and panel rendering; the canonical lane on the reference document stays the
 * source of truth. Both directions of that mirroring live here — and only here
 * — matching how `collaboration-pages` owns the page conversion.
 */
import {
  getLeafRecordMapComments,
  leafValuesEqual,
  type LeafCommentPatchEntry,
  type LeafCommentRecord,
  type LeafCommentRecordsCommand,
  type LeafNodeRecord,
} from "../shared/collaboration";
import type { EditorStore } from "./EditorStore";

/** Replaces the store's comment projection with the canonical lane. */
export function replaceStoreComments(
  store: EditorStore,
  records: readonly LeafCommentRecord[],
): void {
  store.commentRecords.clear();
  for (const record of records) store.commentRecords.set(record.id, structuredClone(record));
}

/** Applies one canonical comment patch's entries to the store projection. */
export function applyCommentEntriesToStore(
  store: EditorStore,
  entries: readonly LeafCommentPatchEntry[],
): void {
  for (const entry of entries) {
    if (entry.after) store.commentRecords.set(entry.id, structuredClone(entry.after));
    else store.commentRecords.delete(entry.id);
  }
}

/** Applies a local comment write (puts + deletes) to the store projection. */
export function applyCommentWritesToStore(
  store: EditorStore,
  puts: readonly LeafCommentRecord[],
  deletes: readonly string[],
): void {
  for (const put of puts) store.commentRecords.set(put.id, structuredClone(put));
  for (const id of deletes) store.commentRecords.delete(id);
}

/**
 * Filters a comment write down to the entries that change the canonical lane,
 * using the same equality `prepareCommand` uses. A fully redundant write — the
 * same reaction toggled from two tabs, a replayed delete — returns null so the
 * controller can drop it instead of letting prepare's "no effect" throw abort
 * the surrounding transaction group.
 */
export function effectiveCommentRecordsCommand(
  records: ReadonlyMap<string, LeafNodeRecord>,
  puts: readonly LeafCommentRecord[],
  deletes: readonly string[],
): LeafCommentRecordsCommand | null {
  const lane = getLeafRecordMapComments(records);
  const effectivePuts = puts.filter((put) => !leafValuesEqual(lane.get(put.id) ?? null, put));
  const effectiveDeletes = deletes.filter((id) => lane.has(id));
  if (effectivePuts.length === 0 && effectiveDeletes.length === 0) return null;
  return {
    type: "commentRecords",
    puts: structuredClone(effectivePuts),
    deletes: [...effectiveDeletes],
  };
}
