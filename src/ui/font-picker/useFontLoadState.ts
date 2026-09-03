import { useSyncExternalStore } from "react";
import {
  getFontLoadState,
  subscribeToFontLoadState,
  type FontLoadState,
} from "../../core/fonts/loader";

/** The loader's state for one family, re-rendering on every transition. */
export function useFontLoadState(family: string | null | undefined): FontLoadState {
  return useSyncExternalStore(
    subscribeToFontLoadState,
    () => (family ? getFontLoadState(family) : "idle"),
    () => (family ? getFontLoadState(family) : "idle"),
  );
}
