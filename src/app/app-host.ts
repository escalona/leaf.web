/**
 * What a hosting shell can plug into the workspace `App`. The browser passes
 * nothing; the desktop entry supplies native `.leaf` document actions and the
 * document-script runtime, so `src/app` never imports `src/desktop`.
 */
import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { EditorStore } from "../core/state/EditorStore";

export interface AppHostDocument {
  /** Runs before the host saves; the shell flushes pending edits first. */
  onSaveRequested(listener: () => Promise<void>): () => void;
  /**
   * Runs before the host closes the window. The listener resolves to the
   * release for the write barrier the shell took while draining sessions.
   */
  onCloseRequested(listener: () => Promise<() => void>): () => void;
  openDocument(): Promise<void>;
  createDocument(): Promise<void>;
  /** Unsaved-changes marker for the title strip. */
  subscribeDirty(listener: () => void): () => void;
  isDirty(): boolean;
}

export interface AppHost {
  /** Present in every desktop window; `null` or absent in the browser. */
  document?: AppHostDocument | null;
  /** Mounts the document-script runtime inside a native document's canvas. */
  renderDocumentScriptHost?: (store: EditorStore) => ReactNode;
}

const subscribeToNothing = () => () => {};
const neverDirty = () => false;

export function useHostDocumentDirty(host: AppHost | undefined): boolean {
  const document = host?.document ?? null;
  const store = useMemo(
    () =>
      document
        ? {
            subscribe: (listener: () => void) => document.subscribeDirty(listener),
            getSnapshot: () => document.isDirty(),
          }
        : { subscribe: subscribeToNothing, getSnapshot: neverDirty },
    [document],
  );
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
