import { runInAction } from "mobx";
import type { EditorStore } from "../../core/state/EditorStore";

/**
 * Re-assert a selection once its nodes have mounted.
 *
 * Selection chrome for a flow child is measured from the DOM, because its
 * position comes from CSS layout rather than the model. But a node created by
 * paste or duplicate is inserted and selected in the same React pass, and the
 * overlay renders before that node's ref is attached — so its first pass finds
 * no element and falls back to the node's parent-relative `(0, 0)`, drawing the
 * marquee at the canvas origin instead of around the new node.
 *
 * Setting the same ids again on the next frame replaces the observable set,
 * which re-runs the overlay at a point where the element exists.
 */
export function refreshSelectionAfterMount(store: EditorStore, nodeIds: readonly string[]) {
  if (nodeIds.length === 0) return;
  if (typeof requestAnimationFrame !== "function") return;

  requestAnimationFrame(() => {
    // The user may have clicked elsewhere in the meantime; only refresh a
    // selection that is still exactly the one that was just created.
    const stillSelected =
      store.selectedIds.size === nodeIds.length &&
      nodeIds.every((nodeId) => store.selectedIds.has(nodeId));
    if (!stillSelected) return;
    if (nodeIds.some((nodeId) => !store.getNode(nodeId))) return;
    runInAction(() => store.setSelectedIds([...nodeIds]));
  });
}
