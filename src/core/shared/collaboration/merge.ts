/**
 * Three-way merge for the document page list.
 *
 * A `setPages` command carries the whole list, so a stale command re-prepared
 * against a list that moved on would otherwise revert every concurrent change
 * wholesale. When the command also carries the list the client edited FROM,
 * the authority can tell which pages the command actually touched and keep
 * the rest as it has them.
 *
 * Resolution is per page id, then per field:
 *
 * - A page present in `theirs` but not `base` was created by the command and
 *   is kept; a page present in `ours` but not `base` was created concurrently
 *   and is kept too.
 * - A page missing from either side that `base` still had was deleted on that
 *   side; the delete wins over any concurrent field change to the same page.
 * - For a page on both sides, each field takes the command's value when the
 *   command changed it from `base`, and the authority's value otherwise. That
 *   covers `name`, `rank` (order), and any field added to the record later.
 *
 * Ranks are opaque sort keys, so two concurrent reorders can leave two pages
 * on one rank; the caller's normalization breaks that tie by id. The result
 * is unsorted — callers normalize it, which also rejects duplicate ids and
 * enforces the page budget. A merge that would empty the list falls back to
 * `theirs`, the pre-merge last-write-wins outcome, because an empty list is
 * not a document.
 */
import { stableStringify } from "./canonical-json";
import type { LeafPageRecord } from "./protocol";

export function mergeLeafPages(
  base: readonly LeafPageRecord[],
  ours: readonly LeafPageRecord[],
  theirs: readonly LeafPageRecord[],
): LeafPageRecord[] {
  const baseById = new Map(base.map((page) => [page.id, page]));
  const oursById = new Map(ours.map((page) => [page.id, page]));
  const theirsById = new Map(theirs.map((page) => [page.id, page]));

  const merged: LeafPageRecord[] = [];
  const ids = [...oursById.keys(), ...[...theirsById.keys()].filter((id) => !oursById.has(id))];
  for (const id of ids) {
    const basePage = baseById.get(id);
    const ourPage = oursById.get(id);
    const theirPage = theirsById.get(id);
    if (!theirPage) {
      // Created concurrently on our side, or deleted by the command.
      if (!basePage && ourPage) merged.push({ ...ourPage });
      continue;
    }
    if (!ourPage) {
      // Created by the command, or deleted concurrently on our side.
      if (!basePage) merged.push({ ...theirPage });
      continue;
    }
    // Both created the same id independently: nothing to merge from, the
    // command's version wins the same way a stale whole-list write would.
    if (!basePage) {
      merged.push({ ...theirPage });
      continue;
    }
    merged.push(mergePageFields(basePage, ourPage, theirPage));
  }

  return merged.length > 0 ? merged : theirs.map((page) => ({ ...page }));
}

function mergePageFields(
  base: LeafPageRecord,
  ours: LeafPageRecord,
  theirs: LeafPageRecord,
): LeafPageRecord {
  const baseRecord: Record<string, unknown> = { ...base };
  const ourRecord: Record<string, unknown> = { ...ours };
  const theirRecord: Record<string, unknown> = { ...theirs };
  const keys = new Set([
    ...Object.keys(baseRecord),
    ...Object.keys(ourRecord),
    ...Object.keys(theirRecord),
  ]);
  const merged: Record<string, unknown> = { id: base.id };
  for (const key of keys) {
    if (key === "id") continue;
    const theirValue = theirRecord[key];
    const value = fieldValuesEqual(theirValue, baseRecord[key]) ? ourRecord[key] : theirValue;
    if (value !== undefined) merged[key] = value;
  }
  return merged as unknown as LeafPageRecord;
}

function fieldValuesEqual(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return stableStringify(left) === stableStringify(right);
}
