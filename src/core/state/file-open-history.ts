/**
 * Per-account, device-local record of when files were last opened. Powers the
 * dashboard's Recents ordering: "recently opened by me" stays stable when a
 * teammate edits a shared file, which a shared updatedAt sort cannot promise.
 * The registry has no per-user open times, so this is deliberately local.
 *
 * The module doubles as an external store for React: components consume it
 * via useSyncExternalStore(subscribeToFileOpenHistory, () =>
 * getFileOpenHistorySnapshot(accountId)). Snapshots are cached per account so
 * repeated reads return a stable reference until a write (this tab or, via
 * the storage event, another tab) invalidates it.
 */

const STORAGE_KEY_PREFIX = "leaf-file-open-history-v1:";
const MAX_TRACKED_FILES = 200;

export type FileOpenHistory = Record<string, string>;

const listeners = new Set<() => void>();
const snapshotCache = new Map<string, FileOpenHistory>();
const EMPTY_HISTORY: FileOpenHistory = Object.freeze({});

/**
 * A signed-out/local session (accountId "") shares one "local" bucket. The
 * snapshot cache must key on the same normalized value as the storage-key
 * suffix: cross-tab storage events carry only the suffix, and invalidating
 * under a different key would leave this tab serving a stale snapshot.
 */
function accountKey(accountId: string) {
  return accountId || "local";
}

function storageKey(accountId: string) {
  return `${STORAGE_KEY_PREFIX}${accountKey(accountId)}`;
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function invalidateAndNotify(accountId?: string) {
  if (accountId === undefined) {
    snapshotCache.clear();
  } else {
    snapshotCache.delete(accountId);
  }
  for (const listener of listeners) listener();
}

function handleStorageEvent(event: StorageEvent) {
  // A write from another tab sharing this origin. Null key means clear().
  if (event.key !== null && !event.key.startsWith(STORAGE_KEY_PREFIX)) return;
  invalidateAndNotify(event.key?.slice(STORAGE_KEY_PREFIX.length));
}

export function subscribeToFileOpenHistory(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== "undefined") {
    window.addEventListener("storage", handleStorageEvent);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", handleStorageEvent);
    }
  };
}

/**
 * Stable-reference snapshot for useSyncExternalStore. Returns the same object
 * across renders until a write invalidates the account's cache entry.
 */
export function getFileOpenHistorySnapshot(accountId: string): FileOpenHistory {
  const cached = snapshotCache.get(accountKey(accountId));
  if (cached) return cached;
  const value = readFileOpenHistory(safeLocalStorage(), accountId);
  const snapshot = Object.keys(value).length === 0 ? EMPTY_HISTORY : value;
  snapshotCache.set(accountKey(accountId), snapshot);
  return snapshot;
}

export function readFileOpenHistory(storage: Storage | null, accountId: string): FileOpenHistory {
  if (!storage) return {};
  try {
    const raw = storage.getItem(storageKey(accountId));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const history: FileOpenHistory = {};
    for (const [fileId, openedAt] of Object.entries(parsed)) {
      if (typeof openedAt === "string" && !Number.isNaN(Date.parse(openedAt))) {
        history[fileId] = openedAt;
      }
    }
    return history;
  } catch {
    return {};
  }
}

export function recordFileOpened(
  storage: Storage | null,
  accountId: string,
  fileId: string,
  openedAt = new Date().toISOString(),
): void {
  if (!storage || !fileId) return;
  try {
    const history = readFileOpenHistory(storage, accountId);
    history[fileId] = openedAt;
    const entries = Object.entries(history)
      .sort(([, left], [, right]) => Date.parse(right) - Date.parse(left))
      .slice(0, MAX_TRACKED_FILES);
    storage.setItem(storageKey(accountId), JSON.stringify(Object.fromEntries(entries)));
    invalidateAndNotify(accountKey(accountId));
  } catch {
    // Quota or serialization failures cost only recency ordering.
  }
}
