import { useSyncExternalStore } from "react";

export type DeferredModuleSnapshot<T> = {
  /** The module's export once its chunk has been evaluated; null until then. */
  value: T | null;
  /** Why the last load failed. Cleared when the next load starts. */
  error: unknown;
};

export type DeferredModule<T> = {
  /**
   * Start the load unless one is in flight or the value is already here.
   * Never rejects: a failure is state, reported through the snapshot, so
   * fire-and-forget preloads need no handler.
   */
  load(): Promise<void>;
  read(): DeferredModuleSnapshot<T>;
  subscribe(listener: () => void): () => void;
};

/**
 * A lazily imported chunk held as plain state rather than behind a Suspense
 * boundary. Once a boundary has shown its fallback, React holds the resolved
 * content back until 300 ms after that fallback painted (its retry throttle),
 * which left a launch surface idle for a quarter second between the chunk
 * arriving and its first frame. Rendering the loading state ourselves and
 * swapping in the value when it lands commits at normal priority, so the
 * chunk paints as soon as it is evaluated.
 *
 * A failed load is state too: subscribers are told, `error` carries the
 * cause, and the next `load()` tries again instead of pinning the rejection.
 */
export function createDeferredModule<T>(
  importModule: () => Promise<T>,
  onLoaded?: (value: T) => void,
): DeferredModule<T> {
  let snapshot: DeferredModuleSnapshot<T> = { value: null, error: null };
  let inFlight: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  const publish = (next: DeferredModuleSnapshot<T>) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  return {
    load() {
      if (snapshot.value !== null) return Promise.resolve();
      if (inFlight) return inFlight;
      if (snapshot.error !== null) publish({ value: null, error: null });
      inFlight = importModule().then(
        (value) => {
          inFlight = null;
          onLoaded?.(value);
          publish({ value, error: null });
        },
        (error: unknown) => {
          inFlight = null;
          publish({ value: null, error: error ?? new Error("The module failed to load.") });
        },
      );
      return inFlight;
    },
    read: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The current snapshot of a deferred module, re-rendering when it changes. */
export function useDeferredModule<T>(module: DeferredModule<T>): DeferredModuleSnapshot<T> {
  return useSyncExternalStore(module.subscribe, module.read, module.read);
}
