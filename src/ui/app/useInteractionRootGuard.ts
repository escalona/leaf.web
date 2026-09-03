import { reaction } from "mobx";
import { useEffect } from "react";
import type { EditorStore } from "../../core/state/EditorStore";
import { getInteractionDeactivationReason } from "../../core/state/editor-interaction-state";

/**
 * Exit interaction mode the moment its root stops being usable: hidden or
 * locked (itself or through an ancestor), removed, or no longer holding the
 * selection. The store already checks the selection half on its own
 * mutation path; this reaction covers visibility and lock edits, which touch
 * plain node fields and never pass through it.
 */
export function useInteractionRootGuard(store: EditorStore) {
  useEffect(
    () =>
      reaction(
        () =>
          getInteractionDeactivationReason(store, (nodeId, ancestorId) =>
            store.isDescendant(nodeId, ancestorId),
          ),
        (reason) => {
          if (reason) store.deactivateInteractiveSurface();
        },
        { fireImmediately: true },
      ),
    [store],
  );
}
