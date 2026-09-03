/**
 * Locally durable comment read receipts, per account. Comment ids are
 * globally unique, so one flat set per account covers every file and branch.
 * Receipts are presentation state — they never sync and losing them only
 * re-marks threads unread.
 */
const KEY_PREFIX = "leaf-comment-reads";
const MAX_PERSISTED_READS = 20_000;

function storageKey(accountId: string): string {
  return `${KEY_PREFIX}:${accountId}`;
}

export function loadCommentReads(accountId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(storageKey(accountId));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((value): value is string => typeof value === "string"));
    }
  } catch {
    // Unavailable or corrupt storage reads as "nothing read yet".
  }
  return new Set();
}

export function persistCommentReads(accountId: string, reads: ReadonlySet<string>): void {
  try {
    const values = [...reads];
    // Oldest-first trim; receipts are append-mostly so the tail is the recent end.
    const bounded = values.slice(Math.max(0, values.length - MAX_PERSISTED_READS));
    window.localStorage.setItem(storageKey(accountId), JSON.stringify(bounded));
  } catch {
    // Best-effort only.
  }
}
