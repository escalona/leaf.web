import { useCallback, useRef, useState } from "react";
import {
  clearLocalModePreference,
  readLocalModePreference,
  writeLocalModePreference,
} from "../auth/local-mode-preference";

/**
 * Owns the "keep working without an account" choice for one window.
 *
 * The choice outranks an account session that could be restored: a user who
 * declined the account flow keeps landing in the local runtime on every later
 * launch, and only an explicit sign in from the UI clears it. `enabledRef`
 * mirrors the state for the async restore path, which has to read the choice as
 * it stands when the session resolves rather than the one captured when the
 * request started.
 */
export function useLocalModeChoice() {
  const [enabled, setEnabled] = useState(() => readLocalModePreference(getPreferenceStorage()));
  const enabledRef = useRef(enabled);

  const chooseLocalMode = useCallback(() => {
    enabledRef.current = true;
    writeLocalModePreference(getPreferenceStorage());
    setEnabled(true);
  }, []);

  const leaveLocalMode = useCallback(() => {
    enabledRef.current = false;
    clearLocalModePreference(getPreferenceStorage());
    setEnabled(false);
  }, []);

  return { chooseLocalMode, enabled, enabledRef, leaveLocalMode };
}

export function getPreferenceStorage() {
  return typeof window === "undefined" ? null : window.localStorage;
}
