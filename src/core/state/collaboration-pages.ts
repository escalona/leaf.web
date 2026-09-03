/**
 * Translation between the editor's page projection and the canonical page list.
 *
 * `EditorStore.pages` owns the nodes and the per-page camera, which are editor
 * concerns; `LeafPageRecord` owns identity, name, order, and background colour,
 * which are document concerns. Order is expressed as an explicit rank on the wire and as array
 * position in the store, so the two directions here are where that conversion
 * happens — and the only place it should.
 */
import { createInitialLeafRank, type LeafPageRecord } from "../shared/collaboration";
import type { EditorStore } from "./EditorStore";
import type { EditorPage } from "../types";

/** The store's page list as canonical records, ranked by array position. */
export function collectStorePages(store: EditorStore): LeafPageRecord[] {
  return store.pages.map((page, index) => {
    const background = page.background?.trim();
    return background
      ? { id: page.id, name: page.name, rank: createInitialLeafRank(index), background }
      : { id: page.id, name: page.name, rank: createInitialLeafRank(index) };
  });
}

/** Order-sensitive; both sides are canonicalized before they get here. */
export function pageListsEqual(
  left: readonly LeafPageRecord[],
  right: readonly LeafPageRecord[],
): boolean {
  return (
    left.length === right.length &&
    left.every((page, index) => {
      const other = right[index]!;
      return (
        page.id === other.id &&
        page.name === other.name &&
        page.rank === other.rank &&
        page.background === other.background
      );
    })
  );
}

/**
 * Reconcile the store's page projection with a canonical list.
 *
 * Existing `EditorPage` objects are reused rather than rebuilt so their `nodes`
 * arrays and parked cameras survive a rename or reorder — rebuilding them would
 * drop every root on a background page. Nodes belonging to a page the list no
 * longer contains are left on the first page rather than discarded: the records
 * behind them are deleted by their own patches, and silently dropping live nodes
 * here would lose work if the two ever disagreed.
 */
export function applyPagesToStore(store: EditorStore, pages: readonly LeafPageRecord[]): void {
  if (pages.length === 0) return;

  const existing = new Map(store.pages.map((page) => [page.id, page]));
  const next: EditorPage[] = pages.map((page) => {
    const current = existing.get(page.id);
    if (!current) return { id: page.id, name: page.name, nodes: [], background: page.background };
    current.name = page.name;
    current.background = page.background;
    return current;
  });

  const keptIds = new Set(next.map((page) => page.id));
  const orphanedRoots = store.pages
    .filter((page) => !keptIds.has(page.id))
    .flatMap((page) => page.nodes);
  if (orphanedRoots.length > 0) next[0]!.nodes.push(...orphanedRoots);

  // Switch away from a removed active page BEFORE the list is replaced, while
  // the outgoing page is still in `store.pages`. `setActivePage` parks the
  // current camera onto the page being left — here, the one about to be
  // discarded, so the parked value is thrown away — and then restores the
  // destination's own camera. Replacing the list first would make `activePage`
  // resolve to the destination instead, parking the outgoing view onto it and
  // overwriting the camera the user left there.
  if (!keptIds.has(store.activePageId)) {
    store.setActivePage(next[0]!.id, { allowDuringPointerGesture: true });
  }
  store.pages = next;
  // A destination that is itself brand new was not in the old list, so the
  // switch above could not take. Nothing is parked on a page that has never
  // been visited, so completing it here loses nothing.
  if (!keptIds.has(store.activePageId)) {
    store.setActivePage(next[0]!.id, { allowDuringPointerGesture: true });
  }
}
