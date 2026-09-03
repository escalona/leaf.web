import { useEffect, useRef } from "react";
import {
  defineKeyboardShortcuts,
  dispatchKeyboardShortcuts,
} from "../../core/lib/keyboard-shortcuts";

export type WorkspaceTabShortcutsOptions = {
  /** The tab strip exists only in desktop home windows; disable cycling elsewhere. */
  enabled: boolean;
  /** Open tab ids in tab-strip order (excluding the dashboard). */
  tabIds: readonly string[];
  /** Active tab id, or null when the dashboard is foregrounded. */
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onSelectDashboard: () => void;
};

type TabShortcutContext = { options: WorkspaceTabShortcutsOptions };

/**
 * The dashboard is a pinned home tab at position 0, so cycling walks
 * [dashboard, ...tabs] with wraparound, matching the rendered tab strip.
 */
function cycleTab(options: WorkspaceTabShortcutsOptions, delta: -1 | 1) {
  const { tabIds, activeTabId, onSelectTab, onSelectDashboard } = options;
  const stopCount = tabIds.length + 1;
  if (stopCount <= 1) return;
  // An unknown active id resolves to -1 + 1 = 0, the dashboard position.
  const currentIndex = activeTabId === null ? 0 : tabIds.indexOf(activeTabId) + 1;
  const nextIndex = (currentIndex + delta + stopCount) % stopCount;
  if (nextIndex === 0) {
    onSelectDashboard();
  } else {
    onSelectTab(tabIds[nextIndex - 1]!);
  }
}

const TAB_SHORTCUTS = defineKeyboardShortcuts<TabShortcutContext>([
  {
    id: "workspace-tab-by-number",
    description: "Activate the Nth file tab, like Cmd+1…9 in a browser.",
    combos: Array.from({ length: 9 }, (_, digit) => ({
      accel: true,
      code: `Digit${digit + 1}`,
    })),
    preventDefault: true,
    when: ({ options }) => options.enabled && options.tabIds.length > 0,
    handler: ({ options }, event) => {
      const index = Number(event.code.slice("Digit".length)) - 1;
      const tabId = options.tabIds[index];
      if (tabId !== undefined) options.onSelectTab(tabId);
    },
  },
  {
    id: "workspace-tab-previous",
    description: "Activate the tab to the left, wrapping like browser tabs.",
    combos: { accel: true, shift: true, code: "BracketLeft" },
    preventDefault: true,
    when: ({ options }) => options.enabled && options.tabIds.length > 0,
    handler: ({ options }) => cycleTab(options, -1),
  },
  {
    id: "workspace-tab-next",
    description: "Activate the tab to the right, wrapping like browser tabs.",
    combos: { accel: true, shift: true, code: "BracketRight" },
    preventDefault: true,
    when: ({ options }) => options.enabled && options.tabIds.length > 0,
    handler: ({ options }) => cycleTab(options, 1),
  },
]);

/**
 * Browser-style tab shortcuts for the workspace tab strip: Cmd/Ctrl+Shift+[
 * moves left and Cmd/Ctrl+Shift+] moves right, wrapping across the pinned
 * dashboard tab, and Cmd/Ctrl+1…9 jumps straight to the Nth file tab.
 */
export function useWorkspaceTabShortcuts(options: WorkspaceTabShortcutsOptions) {
  // The tab snapshot changes identity on every controller emit; dispatch reads
  // the latest options through a ref so the window listener binds once.
  const optionsRef = useRef(options);

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Each crossing is a history-visible navigation (hash assignment or
      // pushState); a held combo must not flood the history stack.
      if (event.repeat) return;
      dispatchKeyboardShortcuts({
        event,
        eventType: "keydown",
        shortcuts: TAB_SHORTCUTS,
        context: { options: optionsRef.current },
      });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
