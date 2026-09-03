/**
 * Desktop home windows persist their open workspace tab set (file/branch
 * selections plus which one was active) to localStorage so a relaunch
 * restores the previous session, browser-style. Restoration is best-effort:
 * entries are validated structurally here and against the live directory by
 * `WorkspaceTabsController.restoreTabs`, so stale or foreign entries are
 * silently dropped rather than surfaced as errored tabs.
 */

export type PersistedWorkspaceTab = { branchId: string; fileId: string };

export type PersistedWorkspaceTabs = {
  /** Index into `tabs` of the previously active tab; null for the dashboard. */
  activeIndex: number | null;
  tabs: PersistedWorkspaceTab[];
};

/**
 * Runtime modes (network vs local/offline) list different files, and accounts
 * sharing a machine must not restore (or overwrite) each other's sessions;
 * scope the key by both, mirroring the account-scoped directory cache.
 */
export function workspaceTabsStorageKey(runtimeMode: string, accountId?: string) {
  const base = `leaf:workspace-tabs:v1:${runtimeMode}`;
  return accountId === undefined ? base : `${base}:${encodeURIComponent(accountId)}`;
}

export function readPersistedWorkspaceTabs(
  storage: Pick<Storage, "getItem">,
  key: string,
): PersistedWorkspaceTabs | null {
  let raw: string | null = null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const { activeIndex, tabs } = parsed as { activeIndex?: unknown; tabs?: unknown };
  if (!Array.isArray(tabs)) return null;
  const validTabs: PersistedWorkspaceTab[] = [];
  for (const entry of tabs) {
    if (entry === null || typeof entry !== "object") return null;
    const { branchId, fileId } = entry as { branchId?: unknown; fileId?: unknown };
    if (typeof branchId !== "string" || typeof fileId !== "string") return null;
    validTabs.push({ branchId, fileId });
  }

  const index =
    typeof activeIndex === "number" &&
    Number.isInteger(activeIndex) &&
    activeIndex >= 0 &&
    activeIndex < validTabs.length
      ? activeIndex
      : null;
  return { activeIndex: index, tabs: validTabs };
}

export function persistWorkspaceTabs(
  storage: Pick<Storage, "setItem">,
  key: string,
  value: PersistedWorkspaceTabs,
) {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage may be full or unavailable; persistence is best-effort.
  }
}
