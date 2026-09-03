import { getFlexFlowChildren } from "../../core/editor/interaction/flex-insertion";
import { orientedBoxesIntersect, type OrientedBox } from "../../core/editor/interaction/math";
import type { EditorStore } from "../../core/state/EditorStore";
import type { DesignNode } from "../../core/types";
import { getNodeOrientedBox } from "../canvas-overlay/live-node-geometry";
import { refreshSelectionAfterMount } from "./selection-refresh";
import {
  getTopLevelDraggedIds,
  getTransformableSelectedIds,
  hasLockedAncestor,
  isNodeLocked,
} from "./selection-targets";

/**
 * Selection-wide commands that are not gestures: the keyboard shortcuts and the
 * context menu both call these so a duplicate, delete, lock, or reorder means
 * exactly one thing regardless of how it was invoked.
 */

export type ZOrderDirection = "back" | "backward" | "forward" | "front";

/** Duplicate the unlocked selection and select the copies. Returns the new ids. */
export function duplicateSelection(store: EditorStore): string[] {
  const sourceIds = getTransformableSelectedIds(store);
  if (sourceIds.length === 0) return [];

  store.beginHistoryTransaction();
  try {
    const duplicates = store.runtime.duplicateNodes(sourceIds.map((id) => ({ id })));
    const duplicateIds = duplicates.map((duplicate) => duplicate.newId);
    store.setSelectedIds(duplicateIds);
    // A duplicated flow child is not in the DOM yet, so the overlay has nothing
    // to measure on this pass. See refreshSelectionAfterMount.
    refreshSelectionAfterMount(store, duplicateIds);
    return duplicateIds;
  } finally {
    store.endHistoryTransaction();
  }
}

/** Delete the unlocked selection. Returns the deleted ids. */
export function deleteSelection(store: EditorStore): string[] {
  return store.runtime.deleteNodes(getTransformableSelectedIds(store));
}

/**
 * Patch every selected node in one history entry. Deliberately not filtered by
 * lock: unlocking is the one edit a locked node has to accept, and hiding a
 * locked layer is the same kind of non-geometric change.
 */
export function patchSelectedNodes(store: EditorStore, patch: Partial<DesignNode>): string[] {
  const ids = Array.from(store.selectedIds);
  if (ids.length === 0) return [];

  store.beginHistoryTransaction();
  try {
    for (const id of ids) store.runtime.updateNode(id, patch);
    return ids;
  } finally {
    store.endHistoryTransaction();
  }
}

/**
 * True when every selected node is locked in the sense the rest of the editor
 * enforces: by its own flag or by an ancestor's. Empty selects false.
 */
export function isSelectionLocked(store: EditorStore): boolean {
  const ids = Array.from(store.selectedIds);
  return ids.length > 0 && ids.every((id) => isNodeLocked(store, id));
}

/**
 * True when the selection's lock is not the selection's to change: a member is
 * locked from above, so neither setting nor clearing its own flag would alter
 * what the editor lets the user do with it.
 */
export function isSelectionLockInherited(store: EditorStore): boolean {
  const ids = Array.from(store.selectedIds);
  return ids.some((id) => hasLockedAncestor(store, id));
}

/** True when every selected node is hidden. Empty selects false. */
export function isSelectionHidden(store: EditorStore): boolean {
  const nodes = store.selectedNodes;
  return nodes.length > 0 && nodes.every((node) => node.visible === false);
}

type ReorderSlot = {
  /**
   * The node's position in the list that decides its paint order, in the index
   * space `moveNodeToParent` takes: the index the node ends up occupying once
   * it has been lifted out and put back.
   */
  index: number;
  /** The furthest index in that list the node can reach. */
  lastIndex: number;
  mode: "absolute" | "flow";
  node: DesignNode;
  parentId: string | undefined;
  /** Position in the raw children array; a stable tiebreak for equal indexes. */
  siblingIndex: number;
  /**
   * The list `index` indexes, when paint order is the plain sibling array — so
   * a single step can look at what it would actually pass. Null in flow mode,
   * where `index` counts only the flow children and the two spaces do not line
   * up.
   */
  siblings: DesignNode[] | null;
};

/**
 * Where a node sits in the list that decides its paint order, and how a move
 * back into that list has to be expressed. A flex flow child is ranked among
 * its flow siblings, because that is the list `moveNodeToParent` indexes in
 * flow mode; everything else is ranked among all siblings. Later is in front.
 */
function getReorderSlot(store: EditorStore, nodeId: string): ReorderSlot | null {
  const node = store.getNode(nodeId);
  if (!node) return null;

  const parent = store.getParent(nodeId);
  if (parent && store.isFlowChild(nodeId)) {
    const siblingIndex = parent.children.indexOf(node);
    if (siblingIndex === -1) return null;
    // A flow move is indexed against the flow children *other than* this one,
    // so that list is what ranks it. A hidden child is missing from the list
    // entirely — the renderer never places it, which is also how the
    // layers-panel drop moves one — but it still trails the visible siblings
    // ahead of it in the children array, and unlike a visible child it can
    // travel one slot further: past the last of them.
    const others = getFlexFlowChildren(parent.children, nodeId);
    const index = getFlexFlowChildren(parent.children.slice(0, siblingIndex)).length;
    return {
      index,
      lastIndex: others.length,
      mode: "flow",
      node,
      parentId: parent.id,
      siblingIndex,
      siblings: null,
    };
  }

  const siblings = parent ? parent.children : store.getRootSiblingsForNode(nodeId);
  const siblingIndex = siblings.indexOf(node);
  if (siblingIndex === -1) return null;
  return {
    index: siblingIndex,
    lastIndex: siblings.length - 1,
    mode: "absolute",
    node,
    parentId: parent?.id,
    siblingIndex,
    siblings,
  };
}

function getReorderCandidates(store: EditorStore) {
  return getTopLevelDraggedIds(store, getTransformableSelectedIds(store));
}

/**
 * Split the candidates into the lists that can actually contend for slots.
 * Only members of one list block each other, so a selection spanning parents —
 * or mixing flow and absolute children of one flex frame — restacks each list
 * on its own.
 */
function getReorderGroups(store: EditorStore, ids: readonly string[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const slot = getReorderSlot(store, id);
    if (!slot) continue;
    const key = `${slot.mode}:${slot.parentId ?? ""}`;
    const group = groups.get(key);
    if (group) group.push(id);
    else groups.set(key, [id]);
  }
  return Array.from(groups.values());
}

type ReorderMove = {
  id: string;
  index: number;
  mode: "absolute" | "flow";
  parentId: string | undefined;
};

/** A node's rotated canvas box, memoized for the length of one command. */
export type OrientedBoxReader = (node: DesignNode) => OrientedBox;

/**
 * Reads each node's rotated canvas box, once per node per command.
 *
 * A step consults every sibling between the group and the first one it touches,
 * and tests each of those against every member's box, so most of the list is
 * read several times; measuring a node that falls back to
 * `getBoundingClientRect` is not free enough to do that per read.
 */
export function createOrientedBoxReader(
  store: EditorStore,
  viewportEl: Element | null,
): OrientedBoxReader {
  const boxes = new Map<string, OrientedBox>();
  return (node: DesignNode): OrientedBox => {
    const cached = boxes.get(node.id);
    if (cached) return cached;
    const box = getNodeOrientedBox(node, store, viewportEl);
    boxes.set(node.id, box);
    return box;
  };
}

type ReorderEntry = { id: string; slot: ReorderSlot };

/**
 * The moves one `forward` or `backward` step makes among absolutely placed
 * siblings, in the order they have to be applied.
 *
 * Absolutely placed siblings paint in list order and nothing else, so trading
 * places with a sibling that nothing in the selection covers changes no pixel:
 * a step that only did that would read as a dead command. So the scan walks the
 * sibling list from the back (`forward`) or the front (`backward`) treating the
 * selection as one travelling run. The run opens at the first member it meets,
 * carries on across further members *and* across every non-moving sibling the
 * selection does not cover, and closes at the first non-moving sibling that it
 * does. Every member gathered into that run lands on the closing sibling's
 * slot, keeping its order — the whole run hops the untouched siblings together.
 * A run that reaches the end of the list without meeting one moves nothing, the
 * same reading a group packed against the boundary gets. The scan then reopens,
 * so a selection split around an obstacle plans one run per stretch.
 *
 * Whether a sibling closes the run follows a union rule: it closes when it
 * overlaps *any* member's box, not only the box of
 * the member nearest it. Asking each member to find its own obstacle instead
 * would pin a member that has none while the rest of the group tried to pass
 * it, which both deadlocks the command and drags members across siblings they
 * never touch.
 *
 * Hidden siblings are neither obstacles nor step targets. They paint nothing,
 * so closing a run on one would spend the press on a change no one can see —
 * the same reason `getFlexFlowChildren` leaves hidden children out of the flow
 * list. The consequence is that `forward` and `backward` pass straight over
 * hidden layers: `front` and `back` are how a node is restacked relative to
 * one, and a hide, reorder, unhide round trip can land somewhere single
 * stepping never would have. A hidden *member* still carries its own box, since
 * the selection is what the user is deliberately acting on — which also means
 * a hidden member's box can be the sole overlap that moves its visible
 * companions, a press whose result only shows once the layer is shown again.
 *
 * `front` and `back` never come here — they are about the ends of the list, not
 * about what is in the way — and neither does flow mode, where the list *is*
 * the layout, so every step already moves the child on screen and skipping
 * would silently jump it several positions along the row.
 */
function planOverlapStep(
  entries: readonly ReorderEntry[],
  towardFront: boolean,
  readBox: OrientedBoxReader,
): ReorderMove[] {
  // One absolute group shares one parent, so one sibling array ranks all of it.
  const siblings = entries[0]?.slot.siblings;
  if (!siblings) return [];
  const parentId = entries[0]!.slot.parentId;

  const movingIds = new Set(entries.map((entry) => entry.id));
  const movingBoxes = entries.map((entry) => readBox(entry.slot.node));
  const closesTheRun = (sibling: DesignNode) =>
    sibling.visible !== false &&
    movingBoxes.some((box) => orientedBoxesIntersect(box, readBox(sibling)));

  const step = towardFront ? 1 : -1;
  const moves: ReorderMove[] = [];
  let runStart: number | null = null;
  for (let index = towardFront ? 0 : siblings.length - 1; siblings[index]; index += step) {
    const sibling = siblings[index]!;
    if (movingIds.has(sibling.id)) {
      runStart ??= index;
      continue;
    }
    if (runStart === null || !closesTheRun(sibling)) continue;
    // Every member lands on the closing sibling's own slot, taken in the order
    // that leaves the group the right way round: each move lifts a member from
    // behind that sibling and puts it back immediately beyond the members
    // already re-landed, so the sibling drifts one slot back per move and the
    // run reassembles on the far side of it.
    for (let member = runStart; member !== index; member += step) {
      const node = siblings[member]!;
      if (!movingIds.has(node.id)) continue;
      moves.push({ id: node.id, index, mode: "absolute", parentId });
    }
    runStart = null;
  }
  return moves;
}

/**
 * Where each member of one list lands, and in the order the moves have to be
 * applied.
 *
 * The group never turns itself inside out: members keep their relative order,
 * and one stops as soon as it would run past the end of the list or into a
 * member that has already stopped ahead of it. So a group packed against the
 * boundary plans nothing at all, and a group with one blocked member still
 * closes the others up behind it.
 *
 * That member-at-a-time walk is what `front`, `back`, and every flow-mode step
 * want, because each of those really is about reaching a slot. A `forward` or
 * `backward` step among absolutely placed siblings is about what the selection
 * is in front of instead, and `planOverlapStep` plans it as a whole.
 */
function planGroupReorder(
  store: EditorStore,
  direction: ZOrderDirection,
  ids: readonly string[],
  readBox: OrientedBoxReader,
): ReorderMove[] {
  const entries = ids
    .map((id) => ({ id, slot: getReorderSlot(store, id) }))
    .filter((entry): entry is ReorderEntry => entry.slot !== null)
    .sort((a, b) => a.slot.index - b.slot.index || a.slot.siblingIndex - b.slot.siblingIndex);
  if (entries.length === 0) return [];

  const towardFront = direction === "front" || direction === "forward";
  // A single step among absolutely placed siblings is about what the group is
  // in front of, not about slots, so it is planned as one travelling run rather
  // than as a member-at-a-time walk toward the boundary.
  if (entries[0]!.slot.mode === "absolute" && (direction === "forward" || direction === "backward"))
    return planOverlapStep(entries, towardFront, readBox);

  // Resolved from the boundary inward, so each member already knows the
  // furthest slot still free — and applied in that same order, so a move never
  // reindexes a member still waiting for one.
  if (towardFront) entries.reverse();

  const moves: ReorderMove[] = [];
  let limit = towardFront ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  for (const { id, slot } of entries) {
    // A member that cannot step stays where it is, and its own slot becomes the
    // limit for the members behind it — the same reading the boundary gets.
    const target = towardFront
      ? Math.min(direction === "front" ? slot.lastIndex : slot.index + 1, slot.lastIndex, limit)
      : Math.max(direction === "back" ? 0 : slot.index - 1, 0, limit);
    limit = towardFront ? target - 1 : target + 1;
    if (target === slot.index) continue;
    moves.push({ id, index: target, mode: slot.mode, parentId: slot.parentId });
  }
  return moves;
}

/**
 * True when the direction would move at least one member of the selection.
 *
 * The same plan the command applies, read for emptiness — so for a single
 * node, `forward` goes dark with nothing overlapping ahead of it for exactly
 * the reason it goes dark at the front: there is no step to take. For a
 * multi-selection the union rule is coarser: a sibling that overlaps *any*
 * member closes the run for all of them, so a press can
 * be live even though the member it ends up moving never touches what it
 * passes.
 * `front` and `back` stay available in that case; the ends of the list are
 * still somewhere else to be.
 *
 * A caller asking about several directions at once — the context menu asks
 * about all four — can hand in one reader so the four readings share the
 * measurements instead of each rebuilding them.
 */
export function canReorderSelection(
  store: EditorStore,
  direction: ZOrderDirection,
  viewportEl: Element | null = document.querySelector("[data-viewport]"),
  readBox: OrientedBoxReader = createOrientedBoxReader(store, viewportEl),
): boolean {
  return getReorderGroups(store, getReorderCandidates(store)).some(
    (ids) => planGroupReorder(store, direction, ids, readBox).length > 0,
  );
}

/**
 * Restack the unlocked selection through the same `moveNodeToParent` path the
 * layers-panel drop uses, keeping each node's parent and canvas position.
 * Returns the ids that actually moved.
 */
export function reorderSelection(
  store: EditorStore,
  direction: ZOrderDirection,
  viewportEl: Element | null = document.querySelector("[data-viewport]"),
): string[] {
  const groups = getReorderGroups(store, getReorderCandidates(store));
  if (groups.length === 0) return [];

  // Geometry is read once for the whole command: restacking moves nothing on
  // canvas, so a box measured for the first group is still the box the second
  // group would measure.
  const readBox = createOrientedBoxReader(store, viewportEl);
  const moved: string[] = [];
  store.beginHistoryTransaction();
  try {
    for (const ids of groups) {
      // Planned immediately before it is applied: a group sharing a children
      // array with an already-restacked one has been reindexed by it.
      for (const move of planGroupReorder(store, direction, ids, readBox)) {
        const node = store.getNode(move.id);
        if (!node) continue;
        const canvasPosition = store.getCanvasPosition(move.id) ?? { x: node.x, y: node.y };
        store.runtime.moveNodeToParent(move.id, canvasPosition, move.parentId, {
          index: move.index,
          mode: move.mode,
        });
        moved.push(move.id);
      }
    }
  } finally {
    store.endHistoryTransaction();
  }
  return moved;
}
