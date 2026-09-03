import { runInAction } from "mobx";
import type { AlignEdge, DistributeAxis } from "../../core/editor/interaction/math";
import {
  getCopiedStyles,
  copySelectionStyles,
  pasteSelectionStyles,
} from "../../core/editor/clipboard/style-clipboard";
import type { EditorStore } from "../../core/state/EditorStore";
import { exportSelectionWithFeedback } from "../editor-feedback";
import { resolveExportOptions } from "../export/node-export";
import { alignSelection, distributeSelection } from "../viewport/direct-manipulation";
import {
  canReorderSelection,
  createOrientedBoxReader,
  deleteSelection,
  duplicateSelection,
  isSelectionHidden,
  isSelectionLockInherited,
  isSelectionLocked,
  patchSelectedNodes,
  reorderSelection,
  type ZOrderDirection,
} from "../viewport/selection-commands";
import { getTransformableSelectedIds } from "../viewport/selection-targets";
import { refreshSelectionAfterMount } from "../viewport/selection-refresh";
import { wrapSelectionInFrame } from "../viewport/wrap-selection";

/**
 * The context menu's item list, built from the live selection.
 *
 * Every entry runs an operation that already exists behind a keyboard shortcut,
 * the align toolbar, the layers panel, or the inspector — the menu is a second
 * way to reach them, never a second implementation. Items that cannot apply to
 * the current selection stay visible and disabled so the menu keeps a stable
 * shape; a section with nothing applicable is dropped entirely.
 */

export type SelectionMenuItem = {
  id: string;
  label: string;
  shortcut?: string;
  danger?: boolean;
  disabled: boolean;
  run: () => void;
};

/** An entry is a submenu exactly when it carries the items to open. */
export type SelectionMenuEntry =
  | SelectionMenuItem
  | { id: string; label: string; disabled: boolean; items: SelectionMenuItem[] };

export type SelectionMenuSection = {
  id: string;
  entries: SelectionMenuEntry[];
};

const ALIGN_EDGES: Array<{ edge: AlignEdge; label: string }> = [
  { edge: "left", label: "Align left" },
  { edge: "horizontal-center", label: "Align horizontal centers" },
  { edge: "right", label: "Align right" },
  { edge: "top", label: "Align top" },
  { edge: "vertical-center", label: "Align vertical centers" },
  { edge: "bottom", label: "Align bottom" },
];

const DISTRIBUTE_AXES: Array<{ axis: DistributeAxis; label: string }> = [
  { axis: "horizontal", label: "Distribute horizontal spacing" },
  { axis: "vertical", label: "Distribute vertical spacing" },
];

const Z_ORDER_ITEMS: Array<{ direction: ZOrderDirection; label: string }> = [
  { direction: "front", label: "Bring to front" },
  { direction: "forward", label: "Bring forward" },
  { direction: "backward", label: "Send backward" },
  { direction: "back", label: "Send to back" },
];

export function buildSelectionMenu(
  store: EditorStore,
  // The element align, distribute, framing, and z-order measure against. Read
  // from the document rather than threaded through props so the layers-panel
  // menu resolves the same canvas the canvas menu does.
  viewportEl: Element | null = document.querySelector("[data-viewport]"),
): SelectionMenuSection[] {
  if (store.selectedIds.size === 0) return [];

  const editableCount = getTransformableSelectedIds(store).length;
  const hasEditable = editableCount > 0;
  const locked = isSelectionLocked(store);
  const lockInherited = isSelectionLockInherited(store);
  const hidden = isSelectionHidden(store);
  // One set of measurements for the four z-order readings below. Each asks
  // whether a step would show, and the two single-step directions walk the
  // sibling list to answer; measuring per direction would repeat that inside a
  // single observer render.
  const readBox = createOrientedBoxReader(store, viewportEl);

  const sections: SelectionMenuSection[] = [
    {
      id: "style",
      entries: [
        {
          id: "copy-style",
          label: "Copy style",
          shortcut: "⌘⌥C",
          disabled: false,
          run: () => {
            copySelectionStyles(store);
          },
        },
        {
          id: "paste-style",
          label: "Paste style",
          shortcut: "⌘⌥V",
          disabled: !hasEditable || getCopiedStyles() === null,
          run: () => {
            runInAction(() => {
              store.beginHistoryTransaction();
              try {
                pasteSelectionStyles(store);
              } finally {
                store.endHistoryTransaction();
              }
            });
          },
        },
      ],
    },
    {
      id: "edit",
      entries: [
        {
          id: "duplicate",
          label: "Duplicate",
          shortcut: "⌘D",
          disabled: !hasEditable,
          run: () => {
            runInAction(() => duplicateSelection(store));
          },
        },
        {
          id: "frame-selection",
          label: "Frame selection",
          shortcut: "⇧F",
          disabled: !hasEditable,
          run: () => {
            runInAction(() => {
              const frame = wrapSelectionInFrame(store, viewportEl);
              if (frame) refreshSelectionAfterMount(store, [frame.id]);
            });
          },
        },
        {
          id: "export-png",
          label: `Export as ${resolveExportOptions(store.selectedNodes).format.toUpperCase()}`,
          shortcut: "⌘⇧E",
          disabled: false,
          // Rasterizing is async; the menu closes on select and reports
          // failures the same way the shortcut does. Format and scale come
          // from the export panel's shared preferences.
          run: () => void exportSelectionWithFeedback(store),
        },
      ],
    },
    {
      id: "order",
      entries: Z_ORDER_ITEMS.map(({ direction, label }) => ({
        id: `z-${direction}`,
        label,
        disabled: !canReorderSelection(store, direction, viewportEl, readBox),
        // Deliberately not the shared reader: the boxes it holds were measured
        // when the menu rendered, and the command runs after the user has read
        // the menu and clicked.
        run: () => {
          runInAction(() => reorderSelection(store, direction, viewportEl));
        },
      })),
    },
    {
      id: "arrange",
      entries: [
        {
          id: "align",
          label: "Align",
          disabled: editableCount < 2,
          items: [
            ...ALIGN_EDGES.map(({ edge, label }) => ({
              id: `align-${edge}`,
              label,
              disabled: editableCount < 2,
              run: () => {
                runInAction(() => alignSelection(store, viewportEl, edge));
              },
            })),
            ...DISTRIBUTE_AXES.map(({ axis, label }) => ({
              id: `distribute-${axis}`,
              label,
              // Distributing needs the two outer nodes plus something to place
              // between them, which is the same floor the align toolbar uses.
              disabled: editableCount < 3,
              run: () => {
                runInAction(() => distributeSelection(store, viewportEl, axis));
              },
            })),
          ],
        },
      ],
    },
    {
      id: "state",
      entries: [
        {
          id: "toggle-lock",
          label: locked ? "Unlock" : "Lock",
          // A lock a node inherits is not the node's to release: the flag lives
          // on an ancestor, and clearing this one's would change nothing the
          // user can see. The frame that owns the lock is where Unlock applies.
          disabled: lockInherited,
          run: () => {
            runInAction(() => patchSelectedNodes(store, { locked: !locked }));
          },
        },
        {
          id: "toggle-visibility",
          label: hidden ? "Show" : "Hide",
          disabled: false,
          run: () => {
            runInAction(() => patchSelectedNodes(store, { visible: hidden }));
          },
        },
      ],
    },
    {
      id: "danger",
      entries: [
        {
          id: "delete",
          label: "Delete",
          shortcut: "⌫",
          danger: true,
          disabled: !hasEditable,
          run: () => {
            runInAction(() => deleteSelection(store));
          },
        },
      ],
    },
  ];

  // A section whose every entry is disabled carries no information — a fully
  // locked selection would otherwise show four dead reorder rows above the one
  // Unlock item that actually applies to it.
  return sections.filter((section) => section.entries.some((entry) => !entry.disabled));
}
