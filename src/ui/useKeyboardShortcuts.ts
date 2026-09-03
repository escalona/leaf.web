import { action } from "mobx";
import { useEffect, useRef, type RefObject } from "react";
import { useEditorStore, type EditorStore } from "../core/state/EditorStore";
import {
  defineKeyboardShortcuts,
  dispatchKeyboardShortcuts,
  type KeyboardShortcut,
} from "../core/lib/keyboard-shortcuts";
import { NUDGE_LARGE_STEP, NUDGE_STEP } from "../core/editor/interaction/math";
import { nudgeSelection } from "./viewport/interaction-helpers";
import { deleteSelection, duplicateSelection } from "./viewport/selection-commands";
import { refreshSelectionAfterMount } from "./viewport/selection-refresh";
import { wrapSelectionInFrame } from "./viewport/wrap-selection";
import type { ToolMode } from "../core/types";
import {
  dispatchOpenImageGenerationDialogEvent,
  dispatchToggleShaderPickerEvent,
} from "./toolbar-events";
import { exportSelectionWithFeedback } from "./editor-feedback";
import { isImageGenerationAvailable } from "../core/editor/image-generation-client";
import {
  zoomInStep,
  zoomOutStep,
  zoomToFit,
  zoomToLevel,
  zoomToSelection,
} from "./viewport/zoom-commands";

type UseKeyboardShortcutsOptions = {
  viewportRef: RefObject<HTMLDivElement | null>;
  onEscape: () => void;
  onSpaceChange: (pressed: boolean) => void;
  /**
   * True while a pointer gesture is in flight, including the pointer-down to
   * first-move window before any drag offset exists. Shortcuts that
   * restructure the tree consult this: a gesture captures start positions and
   * drop targets at pointer down, and committing against a post-shortcut tree
   * would use stale state.
   */
  isPointerGestureActive: () => boolean;
};

/**
 * Whether the arrow-key burst currently owns an open history group.
 * `applyPositionDeltas` opens its own transaction per call, and nested pairs
 * collapse into the outer one, so holding this open across the burst is what
 * turns ~30 undo entries into one.
 */
type NudgeTransaction = { open: boolean };

type EditorKeyboardShortcutContext = {
  store: EditorStore;
  viewportRef: RefObject<HTMLDivElement | null>;
  nudgeTransaction: NudgeTransaction;
  onEscape: () => void;
  onSpaceChange: (pressed: boolean) => void;
  isPointerGestureActive: () => boolean;
};

type EditorKeyboardShortcut = KeyboardShortcut<EditorKeyboardShortcutContext> & {
  /**
   * Inert while a pointer gesture is in flight. A gesture captures start
   * positions, drop targets, and one open history transaction at pointer
   * down; a shortcut that restructures the tree, opens a dialog, or jumps
   * history underneath it would commit against stale state. The combo is
   * still claimed (and its default prevented) so the browser does not get it
   * either. Tool keys are deliberately not guarded: they cancel the gesture
   * first and then switch.
   */
  guardedDuringGesture?: boolean;
};

function defineEditorShortcuts(shortcuts: readonly EditorKeyboardShortcut[]) {
  return defineKeyboardShortcuts<EditorKeyboardShortcutContext>(
    shortcuts.map(({ guardedDuringGesture, ...shortcut }) =>
      guardedDuringGesture
        ? {
            ...shortcut,
            handler: (context, event) => {
              if (context.isPointerGestureActive()) return;
              shortcut.handler(context, event);
            },
          }
        : shortcut,
    ),
  );
}

function beginNudgeTransaction(store: EditorStore, nudgeTransaction: NudgeTransaction) {
  if (nudgeTransaction.open) return;
  nudgeTransaction.open = true;
  store.beginHistoryTransaction();
}

function endNudgeTransaction(store: EditorStore, nudgeTransaction: NudgeTransaction) {
  if (!nudgeTransaction.open) return;
  nudgeTransaction.open = false;
  store.endHistoryTransaction();
}

function navigateToAdjacentPage(store: EditorStore, offset: -1 | 1) {
  const activeIndex = store.pages.findIndex((page) => page.id === store.activePageId);
  const target = store.pages[activeIndex + offset];
  if (target) store.setActivePage(target.id);
}

const TOOL_SHORTCUTS: Array<{ id: string; combo: string; tool: ToolMode }> = [
  { id: "tool-select", combo: "v", tool: "select" },
  { id: "tool-pan", combo: "h", tool: "pan" },
  { id: "tool-frame", combo: "f", tool: "frame" },
  { id: "tool-text", combo: "t", tool: "text" },
  { id: "tool-rectangle", combo: "r", tool: "rectangle" },
  { id: "tool-ink", combo: "i", tool: "ink" },
  { id: "tool-comment", combo: "c", tool: "comment" },
];

const NUDGE_DIRECTIONS: Array<{ id: string; code: string; dx: number; dy: number }> = [
  { id: "nudge-left", code: "ArrowLeft", dx: -1, dy: 0 },
  { id: "nudge-right", code: "ArrowRight", dx: 1, dy: 0 },
  { id: "nudge-up", code: "ArrowUp", dx: 0, dy: -1 },
  { id: "nudge-down", code: "ArrowDown", dx: 0, dy: 1 },
];

const NUDGE_SHORTCUTS = NUDGE_DIRECTIONS.map<EditorKeyboardShortcut>(({ id, code, dx, dy }) => ({
  id,
  description: "Nudge the selection by one pixel, or ten with Shift.",
  combos: { code, shift: "any" },
  preventDefault: true,
  guardedDuringGesture: true,
  when: ({ store }) => store.selectedIds.size > 0,
  handler: ({ store, nudgeTransaction }, event) => {
    // A held arrow key fires many keydowns and exactly one keyup, so a group
    // opened here and closed on release collapses the whole burst into a
    // single undo entry while discrete taps still land one entry each.
    beginNudgeTransaction(store, nudgeTransaction);
    const step = event.shiftKey ? NUDGE_LARGE_STEP : NUDGE_STEP;
    nudgeSelection(store, dx * step, dy * step);
  },
}));

/**
 * Close on release, whatever the modifiers are doing by then. This deliberately
 * carries no `when` predicate: clearing the selection mid-burst stops the
 * keydowns but the group still has to be closed or it leaks into later edits.
 */
const NUDGE_END_SHORTCUT: EditorKeyboardShortcut = {
  id: "nudge-end",
  description: "Close the coalesced nudge history group when the arrow key is released.",
  eventType: "keyup",
  combos: NUDGE_DIRECTIONS.map(({ code }) => ({
    code,
    alt: "any",
    ctrl: "any",
    meta: "any",
    shift: "any",
  })),
  allowInEditable: true,
  handler: ({ store, nudgeTransaction }) => {
    endNudgeTransaction(store, nudgeTransaction);
  },
};

function isCanvasInteractionActivationTarget(
  target: EventTarget | null,
  viewport: HTMLElement | null,
) {
  if (!(target instanceof Element)) return true;
  if (
    target.closest(
      'button, a[href], input, select, textarea, [role="button"], [role="link"], [contenteditable="true"]',
    )
  ) {
    return false;
  }
  return (
    target === document.body || target === document.documentElement || !!viewport?.contains(target)
  );
}

/**
 * Whether Enter would activate the selected scripted element. Text editing
 * yields to this: a text node that is itself an interaction target (or sits
 * under a behavior root) belongs to its script first.
 */
function interactionActivationApplies(
  { store, viewportRef }: EditorKeyboardShortcutContext,
  event: KeyboardEvent,
) {
  return (
    store.activeTool === "select" &&
    store.activeInteractiveSurfaceId === null &&
    store.selectedInteractionTargetId !== null &&
    isCanvasInteractionActivationTarget(event.target, viewportRef.current)
  );
}

const EDITOR_SHORTCUTS = defineEditorShortcuts([
  {
    id: "zoom-in",
    description: "Zoom the canvas in around the viewport center.",
    combos: [
      { accel: true, key: "+", shift: "any" },
      { accel: true, code: "Equal", shift: "any" },
      { accel: true, code: "NumpadAdd" },
    ],
    allowInEditable: true,
    preventDefault: true,
    when: ({ viewportRef }) => viewportRef.current !== null,
    handler: ({ store, viewportRef }) => {
      zoomInStep(store, viewportRef.current);
    },
  },
  {
    id: "zoom-out",
    description: "Zoom the canvas out around the viewport center.",
    combos: [
      { accel: true, key: "-", shift: "any" },
      { accel: true, key: "_", shift: "any" },
      { accel: true, code: "Minus", shift: "any" },
      { accel: true, code: "NumpadSubtract" },
    ],
    allowInEditable: true,
    preventDefault: true,
    when: ({ viewportRef }) => viewportRef.current !== null,
    handler: ({ store, viewportRef }) => {
      zoomOutStep(store, viewportRef.current);
    },
  },
  {
    id: "zoom-reset",
    description: "Reset the canvas zoom to 100% around the viewport center.",
    combos: [
      { accel: true, key: "0" },
      { accel: true, code: "Digit0" },
      { accel: true, code: "Numpad0" },
    ],
    allowInEditable: true,
    preventDefault: true,
    when: ({ viewportRef }) => viewportRef.current !== null,
    handler: ({ store, viewportRef }) => {
      zoomToLevel(store, 1, viewportRef.current);
    },
  },
  {
    id: "zoom-to-100",
    description: "Zoom the canvas to 100% around the viewport center.",
    // Shift+0 is the conventional binding. Kept out of editable targets: there the
    // combo types ")" and must not be hijacked.
    combos: { code: "Digit0", shift: true },
    preventDefault: true,
    when: ({ viewportRef }) => viewportRef.current !== null,
    handler: ({ store, viewportRef }) => {
      zoomToLevel(store, 1, viewportRef.current);
    },
  },
  {
    id: "zoom-to-fit",
    description: "Fit all content of the active page in the viewport.",
    combos: { code: "Digit1", shift: true },
    preventDefault: true,
    when: ({ viewportRef }) => viewportRef.current !== null,
    handler: ({ store, viewportRef }) => {
      zoomToFit(store, viewportRef.current);
    },
  },
  {
    id: "zoom-to-selection",
    description: "Fit the current selection in the viewport.",
    combos: { code: "Digit2", shift: true },
    preventDefault: true,
    when: ({ store, viewportRef }) => viewportRef.current !== null && store.selectedIds.size > 0,
    handler: ({ store, viewportRef }) => {
      zoomToSelection(store, viewportRef.current);
    },
  },
  {
    id: "undo",
    description: "Undo the last editor change.",
    combos: { accel: true, key: "z" },
    preventDefault: true,
    guardedDuringGesture: true,
    handler: ({ store, nudgeTransaction }) => {
      // Undo force-closes any open group of its own, which would strand the
      // nudge flag as true and stop the next burst from ever grouping.
      endNudgeTransaction(store, nudgeTransaction);
      store.undo();
    },
  },
  {
    id: "redo",
    description: "Redo the next editor change.",
    combos: { accel: true, key: "z", shift: true },
    preventDefault: true,
    guardedDuringGesture: true,
    handler: ({ store, nudgeTransaction }) => {
      endNudgeTransaction(store, nudgeTransaction);
      store.redo();
    },
  },
  {
    id: "open-image-generation-dialog",
    description: "Open the image generation dialog.",
    combos: { accel: true, key: "i" },
    allowInEditable: true,
    preventDefault: true,
    guardedDuringGesture: true,
    handler: () => {
      if (isImageGenerationAvailable()) dispatchOpenImageGenerationDialogEvent();
    },
  },
  {
    id: "toggle-sidebar",
    description: "Toggle the layers sidebar.",
    combos: { accel: true, code: "Backslash", shift: true },
    allowInEditable: true,
    preventDefault: true,
    handler: ({ store }) => {
      store.toggleSidebar();
    },
  },
  {
    id: "select-all",
    description: "Select all top-level nodes on the canvas.",
    combos: { accel: true, key: "a" },
    preventDefault: true,
    guardedDuringGesture: true,
    handler: ({ store }) => {
      const enteredId = store.enteredContainerId;
      const scope = enteredId ? (store.getNode(enteredId)?.children ?? []) : store.nodes;
      store.setSelectedIds(scope.map((node) => node.id));
    },
  },
  {
    id: "previous-page",
    description: "Navigate to the previous page.",
    // macOS reports Fn+ArrowUp as PageUp; matching `key` also supports
    // keyboards with a dedicated Page Up key.
    combos: { key: "PageUp" },
    preventDefault: true,
    guardedDuringGesture: true,
    when: ({ store }) => store.pages.length > 1,
    handler: ({ store }) => {
      navigateToAdjacentPage(store, -1);
    },
  },
  {
    id: "next-page",
    description: "Navigate to the next page.",
    // macOS reports Fn+ArrowDown as PageDown; matching `key` also supports
    // keyboards with a dedicated Page Down key.
    combos: { key: "PageDown" },
    preventDefault: true,
    guardedDuringGesture: true,
    when: ({ store }) => store.pages.length > 1,
    handler: ({ store }) => {
      navigateToAdjacentPage(store, 1);
    },
  },
  {
    id: "space-pan-start",
    description: "Enter temporary pan mode while space is held.",
    combos: { code: "Space" },
    preventDefault: true,
    handler: ({ onSpaceChange }) => {
      onSpaceChange(true);
    },
  },
  {
    id: "space-pan-end",
    description: "Exit temporary pan mode when space is released.",
    eventType: "keyup",
    combos: { code: "Space" },
    allowInEditable: true,
    handler: ({ onSpaceChange }) => {
      onSpaceChange(false);
    },
  },
  ...TOOL_SHORTCUTS.map<EditorKeyboardShortcut>((shortcut) => ({
    id: shortcut.id,
    description: `Switch to the ${shortcut.tool} tool.`,
    combos: { key: shortcut.combo },
    // The toolbar is replaced by the preview banner while a history version
    // is shown; arming a tool the user cannot see would only set up a draw
    // gesture the document is going to refuse.
    when: ({ store }) => !store.isHistoryPreviewing,
    handler: ({ store, isPointerGestureActive, onEscape }) => {
      if (isPointerGestureActive()) onEscape();
      store.setTool(shortcut.tool);
    },
  })),
  {
    id: "toggle-shader-picker",
    description: "Toggle the shader picker.",
    combos: { key: "s" },
    guardedDuringGesture: true,
    handler: () => {
      dispatchToggleShaderPickerEvent();
    },
  },
  {
    id: "activate-selected-interaction",
    description: "Interact with the selected scripted element.",
    combos: [{ key: "Enter" }, { code: "NumpadEnter" }],
    preventDefault: true,
    guardedDuringGesture: true,
    when: interactionActivationApplies,
    handler: ({ store }) => {
      const targetId = store.selectedInteractionTargetId;
      if (targetId) store.activateInteraction(targetId);
    },
  },
  {
    id: "edit-selected-text",
    description: "Edit the selected text node.",
    combos: [{ key: "Enter" }, { code: "NumpadEnter" }],
    preventDefault: true,
    guardedDuringGesture: true,
    // Listed after the interaction shortcut so a scripted text node activates
    // rather than edits. Under the select tool Enter is also a button
    // activator elsewhere in the chrome, so it only edits when the key lands
    // on the canvas or the document body.
    when: (context, event) => {
      const { store, viewportRef } = context;
      if (store.selectedNode?.type !== "text") return false;
      if (store.activeTool === "text") return true;
      return (
        store.activeTool === "select" &&
        store.activeInteractiveSurfaceId === null &&
        !interactionActivationApplies(context, event) &&
        isCanvasInteractionActivationTarget(event.target, viewportRef.current)
      );
    },
    handler: ({ store }) => {
      const node = store.selectedNode;
      if (node?.type === "text") {
        store.setTool("select");
        store.beginTextEditing(node.id, { selection: { type: "all" } });
      }
    },
  },
  ...NUDGE_SHORTCUTS,
  NUDGE_END_SHORTCUT,
  {
    id: "export-selection",
    description: "Export the current selection as PNG files.",
    combos: { accel: true, shift: true, key: "e" },
    preventDefault: true,
    guardedDuringGesture: true,
    when: ({ store }) => store.selectedIds.size > 0,
    handler: ({ store }) => {
      // Fire and forget: rasterizing is async and the shortcut handler cannot
      // await without blocking the key dispatch loop.
      void exportSelectionWithFeedback(store);
    },
  },
  {
    id: "wrap-selection-in-frame",
    description: "Wrap the current selection in a new frame.",
    combos: { key: "f", shift: true },
    preventDefault: true,
    guardedDuringGesture: true,
    // The gesture guard covers the pointer-down to first-move window; the
    // offset check covers the deferred-commit window after the gesture ends,
    // when reparent state keyed to the pre-wrap tree is still pending.
    when: ({ store }) => store.selectedIds.size > 0 && store.dragCanvasOffset.size === 0,
    handler: ({ store, viewportRef }) => {
      const frame = wrapSelectionInFrame(store, viewportRef.current);
      // The frame is not in the DOM yet, so the overlay has nothing to measure
      // on this pass. See refreshSelectionAfterMount.
      if (frame) refreshSelectionAfterMount(store, [frame.id]);
    },
  },
  {
    id: "duplicate-selection",
    description: "Duplicate the current selection.",
    combos: { accel: true, key: "d" },
    preventDefault: true,
    guardedDuringGesture: true,
    when: ({ store }) => store.selectedIds.size > 0,
    handler: ({ store }) => {
      duplicateSelection(store);
    },
  },
  {
    id: "delete-selection",
    description: "Delete the current selection.",
    combos: [{ key: "Backspace" }, { key: "Delete" }],
    guardedDuringGesture: true,
    handler: ({ store }) => {
      deleteSelection(store);
    },
  },
  {
    id: "toggle-comments-hidden",
    description: "Show or hide comment pins.",
    combos: { key: "c", shift: true },
    handler: ({ store }) => {
      store.toggleCommentsHidden();
    },
  },
  {
    // Ahead of the general escape so comment surfaces close before the
    // selection or tool is touched. Steps back one level at a time: expanded
    // thread → stack card list → placement draft → nothing.
    id: "comment-escape",
    description: "Close the open comment thread, stack, or placement draft.",
    combos: { key: "Escape" },
    when: ({ store }) =>
      store.openCommentThreadId !== null ||
      store.pendingCommentDraft !== null ||
      store.openCommentStackKey !== null,
    handler: ({ store }) => {
      if (store.openCommentThreadId !== null) {
        store.setOpenCommentThread(null);
      } else if (store.openCommentStackKey !== null) {
        store.setOpenCommentStack(null);
      } else {
        store.setPendingCommentDraft(null);
      }
    },
  },
  {
    id: "escape",
    description: "Cancel the current transient interaction.",
    combos: { key: "Escape" },
    handler: ({ onEscape }) => {
      onEscape();
    },
  },
]);

export function useKeyboardShortcuts({
  viewportRef,
  onEscape,
  onSpaceChange,
  isPointerGestureActive,
}: UseKeyboardShortcutsOptions) {
  const store = useEditorStore();
  const nudgeTransaction = useRef<NudgeTransaction>({ open: false });

  useEffect(() => {
    const context: EditorKeyboardShortcutContext = {
      store,
      viewportRef,
      nudgeTransaction: nudgeTransaction.current,
      onEscape,
      onSpaceChange,
      isPointerGestureActive,
    };

    const onKeyDown = action((event: KeyboardEvent) => {
      dispatchKeyboardShortcuts({
        event,
        eventType: "keydown",
        shortcuts: EDITOR_SHORTCUTS,
        context,
      });
    });

    const onKeyUp = (event: KeyboardEvent) => {
      dispatchKeyboardShortcuts({
        event,
        eventType: "keyup",
        shortcuts: EDITOR_SHORTCUTS,
        context,
      });
    };

    // A keyup that never arrives would hold the nudge group open forever, and an
    // open group keeps `canUndo` false and every local edit undispatched. The
    // window loses key events on an app switch, a tab change, and a native menu
    // or dialog taking focus, so close the group on all three rather than
    // trusting the release.
    const onLostKeyboard = () => endNudgeTransaction(store, context.nudgeTransaction);

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onLostKeyboard);
    document.addEventListener("visibilitychange", onLostKeyboard);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onLostKeyboard);
      document.removeEventListener("visibilitychange", onLostKeyboard);
      // Unmounting mid-burst means the keyup never lands, so close the group here.
      endNudgeTransaction(store, context.nudgeTransaction);
    };
  }, [isPointerGestureActive, onEscape, onSpaceChange, store, viewportRef]);
}
