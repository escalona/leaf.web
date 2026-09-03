/**
 * "Use Leaf locally" is a launch-time decision, not a build-time one: a user who
 * declines the account flow keeps landing in the local runtime on every later
 * launch. The choice persists to localStorage like the workspace tab set
 * (`src/state/workspace-tab-persistence.ts`), which the desktop home window
 * already relies on to survive a relaunch.
 *
 * The stored choice outranks a session that could be restored: only an explicit
 * sign in from the UI clears it. A session file left on disk therefore never
 * routes a user back into an account flow they already declined — it simply
 * waits for the sign in that may come.
 */

export const LOCAL_MODE_STORAGE_KEY = "leaf:local-mode:v1";

const ENABLED_VALUE = "enabled";

export function readLocalModePreference(storage: Pick<Storage, "getItem"> | null): boolean {
  try {
    return storage?.getItem(LOCAL_MODE_STORAGE_KEY) === ENABLED_VALUE;
  } catch {
    // Storage may be unavailable (private mode, blocked partition); treat an
    // unreadable preference as "not chosen" so sign-on still renders.
    return false;
  }
}

export function writeLocalModePreference(storage: Pick<Storage, "setItem"> | null) {
  try {
    storage?.setItem(LOCAL_MODE_STORAGE_KEY, ENABLED_VALUE);
  } catch {
    // Persistence is best-effort; local mode still applies for this launch.
  }
}

export function clearLocalModePreference(storage: Pick<Storage, "removeItem"> | null) {
  try {
    storage?.removeItem(LOCAL_MODE_STORAGE_KEY);
  } catch {
    // Nothing to recover: the next launch simply re-reads whatever is stored.
  }
}
