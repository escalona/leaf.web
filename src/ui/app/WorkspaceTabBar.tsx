import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CloseIcon, FileIcon, GridIcon, PlusIcon } from "../icons";
import { observer } from "mobx-react-lite";
import {
  TITLE_BAR_HEIGHT,
  TRAFFIC_LIGHT_INSET_WIDTH,
  useMacOSInsetTitleBar,
} from "../../core/platform";
import type { AgentActivityState } from "../../core/state/agent-activity";
import { AgentWorkingBadge } from "../AgentWorkingBadge";
import { setInteractionPointerCapture } from "../viewport/pointer-utils";

export type WorkspaceTabBarTab = {
  tabId: string;
  label: string;
  isActive: boolean;
  /** The tab failed to open or its stream broke: edits are not reaching the server. */
  hasError: boolean;
  /**
   * The tab is editing its committed offline cache. Benign — edits sync on
   * reconnect — so it must never wear the error colour.
   */
  isOffline?: boolean;
  /** Plain-language explanation of the error/offline state for the tooltip. */
  statusDetail?: string;
  agentActivity?: AgentActivityState;
};

const TAB_ERROR_COLOR = "#b91c1c";
const TAB_OFFLINE_COLOR = "#b45309";

/** Gap between tabs in the strip; layout and drag math must agree on it. */
const TAB_STRIP_GAP = 4;
/** Horizontal distance before a press becomes a drag instead of a click. */
const DRAG_ACTIVATION_DISTANCE = 4;
const TAB_SHIFT_TRANSITION = "transform 160ms ease";
const TAB_SETTLE_TRANSITION = "transform 140ms ease";

type TabRect = { left: number; width: number };

type ActiveTabDrag = {
  tabId: string;
  sourceIndex: number;
  /** Horizontal displacement of the dragged tab from its resting slot. */
  dx: number;
  /** Final index the dragged tab currently targets. */
  targetIndex: number;
  /** How far displaced neighbors slide: dragged tab width plus the strip gap. */
  shift: number;
};

/** Post-drop glide of the dragged tab from its release point into its slot. */
type TabSettle = { tabId: string; dx: number; released: boolean };

type TabDragVisual = {
  transform?: string;
  transition?: string;
  lifted?: boolean;
};

type TabPointerDrag = {
  tabId: string;
  pointerId: number;
  startClientX: number;
  sourceIndex: number;
  /** Tab strip geometry captured at pointerdown; the strip does not scroll mid-drag. */
  rects: TabRect[];
  /** Tab ids at pointerdown; a mid-drag list change cancels the drag. */
  tabIds: string[];
  active: boolean;
  latest: { dx: number; targetIndex: number; slotLeft: number } | null;
};

/**
 * Browser-style strip of open file tabs shown in the desktop home window.
 * The dashboard behaves like a pinned home tab; file tabs stay open (and their
 * collaboration sessions stay live) while other tabs are foregrounded.
 *
 * Reordering is a pointer-driven horizontal drag like browser tabs:
 * the pressed tab tracks the cursor's x only (vertical motion is ignored, so
 * no ghost detaches from the cursor), neighbors flow around it, and on release
 * it glides into its slot.
 */
export function WorkspaceTabBar({
  tabs,
  dashboardActive,
  isCreatingFile,
  onSelectDashboard,
  onSelectTab,
  onCloseTab,
  onReorderTab,
  onCreateFile,
}: {
  tabs: WorkspaceTabBarTab[];
  dashboardActive: boolean;
  isCreatingFile: boolean;
  onSelectDashboard: () => void;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onReorderTab: (tabId: string, insertionIndex: number) => void;
  onCreateFile: () => void;
}) {
  const hasInsetTitleBar = useMacOSInsetTitleBar();
  const stripRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<TabPointerDrag | null>(null);
  const [drag, setDrag] = useState<ActiveTabDrag | null>(null);
  const [settle, setSettle] = useState<TabSettle | null>(null);
  const activeTabId = tabs.find((tab) => tab.isActive)?.tabId ?? null;

  const scrollActiveTabIntoView = useCallback(() => {
    if (!activeTabId) return;
    const strip = stripRef.current;
    const activeTab = strip?.querySelector<HTMLElement>(`[data-workspace-tab-id="${activeTabId}"]`);
    if (!strip || !activeTab) return;

    const stripRect = strip.getBoundingClientRect();
    const tabRect = activeTab.getBoundingClientRect();
    if (tabRect.left < stripRect.left) {
      strip.scrollLeft -= stripRect.left - tabRect.left;
    } else if (tabRect.right > stripRect.right) {
      strip.scrollLeft += tabRect.right - stripRect.right;
    }
  }, [activeTabId]);

  // A newly opened or programmatically selected tab may sit beyond the strip's
  // horizontal scrollport. Keep the active document's identity and close
  // affordance visible without disturbing pointer-driven tab reordering or
  // measuring a tab while its post-drop transform is still settling. This
  // effect is the flush mechanism for every state-backed press exit: clearing
  // drag/settle re-renders, re-runs it, and performs the deferred scroll after
  // drag transforms have left the DOM.
  useEffect(() => {
    if (!activeTabId || dragRef.current || drag || settle) return;
    scrollActiveTabIntoView();
  }, [activeTabId, drag, scrollActiveTabIntoView, settle]);

  const windowReleaseRef = useRef<(() => void) | null>(null);

  /**
   * The single exit path for a held press: detach the window-level release
   * listeners, clear the press/drag state, and settle the deferred
   * active-tab scroll. A press that never activated a drag leaves no state
   * change behind to re-render, so it flushes the scroll directly; an
   * activated drag's exit clears `drag` (and possibly starts `settle`), and
   * the activation effect above flushes once the transforms are gone.
   */
  const releasePress = useCallback(
    (pressed: TabPointerDrag | null) => {
      windowReleaseRef.current?.();
      windowReleaseRef.current = null;
      dragRef.current = null;
      setDrag(null);
      if (!pressed?.active) scrollActiveTabIntoView();
    },
    [scrollActiveTabIntoView],
  );
  useEffect(() => () => windowReleaseRef.current?.(), []);

  // The window-level release listeners outlive the render that attached them
  // (a press re-renders via onSelectTab immediately), so they dispatch through
  // a latest-ref rather than a per-render closure.
  const finishPressRef = useRef<(state: TabPointerDrag) => void>(() => {});

  useEffect(() => {
    const handleWindowResize = () => {
      if (dragRef.current || drag || settle) return;
      scrollActiveTabIntoView();
    };
    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, [drag, scrollActiveTabIntoView, settle]);

  // Two-phase settle: paint the residual offset first, then release it on the
  // next frame so the transition animates the tab into its final slot.
  useEffect(() => {
    if (!settle) return;
    if (!settle.released) {
      const raf = requestAnimationFrame(() => {
        setSettle((prev) => (prev && !prev.released ? { ...prev, released: true } : prev));
      });
      return () => cancelAnimationFrame(raf);
    }
    const timer = setTimeout(() => setSettle(null), 180);
    return () => clearTimeout(timer);
  }, [settle]);

  // The captured drag geometry describes the tab list at pointerdown. If the
  // list changes mid-drag (a tab closed via Cmd+W or a collaborator, a deep
  // link opening one), cancel rather than commit stale indices. This also
  // releases the drag when the dragged tab itself unmounts — its pointer
  // handlers can never fire again, which would otherwise leave dragRef set
  // forever (blocking all future drags) and neighbors visually shifted.
  useEffect(() => {
    const state = dragRef.current;
    if (!state) return;
    const unchanged =
      tabs.length === state.tabIds.length &&
      tabs.every((tab, index) => tab.tabId === state.tabIds[index]);
    if (unchanged) return;
    releasePress(state);
  }, [releasePress, tabs]);

  // Escape aborts an active drag without committing, matching the native
  // drag-and-drop behavior this pointer implementation replaced.
  const dragActive = drag !== null;
  useEffect(() => {
    if (!dragActive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      releasePress(dragRef.current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dragActive, releasePress]);

  const handleTabPointerDown = (tabId: string, event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || dragRef.current) return;
    if ((event.target as HTMLElement).closest("[data-tab-close]")) return;
    const strip = stripRef.current;
    const sourceIndex = tabs.findIndex((tab) => tab.tabId === tabId);
    if (!strip || sourceIndex === -1) return;

    const rects = Array.from(strip.querySelectorAll<HTMLElement>("[data-workspace-tab-id]")).map(
      (element): TabRect => {
        const bounds = element.getBoundingClientRect();
        return { left: bounds.left, width: bounds.width };
      },
    );
    if (rects.length !== tabs.length) return;

    dragRef.current = {
      tabId,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      sourceIndex,
      rects,
      tabIds: tabs.map((tab) => tab.tabId),
      active: false,
      latest: null,
    };
    // Capture may fail (jsdom, stale pointers); the drag still works as long
    // as the pointer stays over the strip. Without capture a release outside
    // the strip never reaches the element handlers, which would wedge the
    // press and disable active-tab visibility — window-level listeners
    // guarantee every press releases. The element handlers run first for
    // in-strip releases and clear dragRef, making these no-ops.
    setInteractionPointerCapture(event.currentTarget, event.pointerId);
    const onWindowPointerUp = (windowEvent: PointerEvent) => {
      const state = dragRef.current;
      if (!state || windowEvent.pointerId !== state.pointerId) return;
      finishPressRef.current(state);
    };
    const onWindowPointerCancel = (windowEvent: PointerEvent) => {
      const state = dragRef.current;
      if (!state || windowEvent.pointerId !== state.pointerId) return;
      releasePress(state);
    };
    window.addEventListener("pointerup", onWindowPointerUp);
    window.addEventListener("pointercancel", onWindowPointerCancel);
    windowReleaseRef.current = () => {
      window.removeEventListener("pointerup", onWindowPointerUp);
      window.removeEventListener("pointercancel", onWindowPointerCancel);
    };
    setSettle(null);
    // Like browser tabs, pressing a tab foregrounds it immediately;
    // dragging then reorders the already-active tab.
    onSelectTab(tabId);
  };

  const handleTabPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = dragRef.current;
    if (!state || event.pointerId !== state.pointerId) return;
    // Only the horizontal delta matters: dragging downward keeps the tab
    // sliding along the strip instead of detaching toward the cursor.
    const rawDx = event.clientX - state.startClientX;
    if (!state.active) {
      if (Math.abs(rawDx) < DRAG_ACTIVATION_DISTANCE) return;
      state.active = true;
    }

    const source = state.rects[state.sourceIndex]!;
    const first = state.rects[0]!;
    const last = state.rects[state.rects.length - 1]!;
    const minLeft = first.left;
    const maxLeft = Math.max(minLeft, last.left + last.width - source.width);
    const draggedLeft = Math.min(Math.max(source.left + rawDx, minLeft), maxLeft);

    // Pick the insertion slot whose resting left edge is nearest the dragged
    // tab. Slots are laid out from the remaining tabs' widths, so mixed-width
    // tabs still swap exactly when the dragged tab crosses them.
    let targetIndex = 0;
    let slotLeft = minLeft;
    let bestDistance = Number.POSITIVE_INFINITY;
    let edge = minLeft;
    for (let slot = 0; slot < state.rects.length; slot++) {
      const distance = Math.abs(edge - draggedLeft);
      if (distance < bestDistance) {
        bestDistance = distance;
        targetIndex = slot;
        slotLeft = edge;
      }
      const neighbor = state.rects[slot < state.sourceIndex ? slot : slot + 1];
      if (neighbor) edge += neighbor.width + TAB_STRIP_GAP;
    }

    const dx = draggedLeft - source.left;
    state.latest = { dx, targetIndex, slotLeft };
    setDrag((prev) =>
      prev && prev.dx === dx && prev.targetIndex === targetIndex
        ? prev
        : {
            tabId: state.tabId,
            sourceIndex: state.sourceIndex,
            dx,
            targetIndex,
            shift: source.width + TAB_STRIP_GAP,
          },
    );
  };

  const finishPress = (state: TabPointerDrag) => {
    if (!state.active || !state.latest) {
      // Selection changes while the pointer is down intentionally skip the
      // activation effect so drag geometry stays stable; releasePress flushes
      // that deferred visibility adjustment for the ref-only click exit.
      releasePress(state);
      return;
    }

    const { dx, targetIndex, slotLeft } = state.latest;
    const source = state.rects[state.sourceIndex]!;
    const residual = source.left + dx - slotLeft;
    releasePress(state);
    if (Math.abs(residual) > 0.5) {
      setSettle({ tabId: state.tabId, dx: residual, released: false });
    }
    if (targetIndex !== state.sourceIndex) {
      onReorderTab(state.tabId, targetIndex > state.sourceIndex ? targetIndex + 1 : targetIndex);
    }
  };
  useEffect(() => {
    finishPressRef.current = finishPress;
  });

  const handleTabPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = dragRef.current;
    if (!state || event.pointerId !== state.pointerId) return;
    finishPress(state);
  };

  const handleTabPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = dragRef.current;
    if (!state || event.pointerId !== state.pointerId) return;
    releasePress(state);
  };

  return (
    <div
      className={hasInsetTitleBar ? "app-titlebar" : undefined}
      role="tablist"
      aria-label="Open files"
      style={{
        display: "flex",
        alignItems: "center",
        gap: TAB_STRIP_GAP,
        height: hasInsetTitleBar ? TITLE_BAR_HEIGHT : 40,
        flexShrink: 0,
        padding: hasInsetTitleBar ? `0 8px 0 ${TRAFFIC_LIGHT_INSET_WIDTH}px` : "0 8px",
        backgroundColor: hasInsetTitleBar ? "#f1f1f2" : "#f4f4f5",
        borderBottom: hasInsetTitleBar ? "1px solid #dedee1" : "1px solid #e4e4e7",
        fontFamily: "Inter, system-ui, sans-serif",
        overflow: "hidden",
      }}
    >
      <TabButton
        active={dashboardActive}
        label="Dashboard"
        icon={<GridIcon size={12} style={{ flexShrink: 0 }} />}
        onSelect={onSelectDashboard}
        spacious={hasInsetTitleBar}
      />
      <div
        style={{
          width: 1,
          height: 18,
          backgroundColor: "#e4e4e7",
          flexShrink: 0,
          margin: "0 2px",
        }}
      />
      <div
        ref={stripRef}
        style={{
          display: "flex",
          alignItems: "center",
          gap: TAB_STRIP_GAP,
          flex: 1,
          minWidth: 0,
          // overflow-x:auto computes overflow-y to auto as well, so the
          // scrollport needs its own vertical paint room for tab shadows.
          paddingBlock: 6,
          overflowX: "auto",
          scrollbarWidth: "none",
        }}
      >
        {tabs.map((tab, index) => {
          let dragVisual: TabDragVisual | null = null;
          if (drag) {
            if (tab.tabId === drag.tabId) {
              dragVisual = { transform: `translateX(${drag.dx}px)`, lifted: true };
            } else {
              const shift =
                index > drag.sourceIndex && index <= drag.targetIndex
                  ? -drag.shift
                  : index < drag.sourceIndex && index >= drag.targetIndex
                    ? drag.shift
                    : 0;
              dragVisual = {
                transform: shift === 0 ? undefined : `translateX(${shift}px)`,
                transition: TAB_SHIFT_TRANSITION,
              };
            }
          } else if (settle && settle.tabId === tab.tabId) {
            dragVisual = settle.released
              ? { transform: "translateX(0px)", transition: TAB_SETTLE_TRANSITION, lifted: true }
              : { transform: `translateX(${settle.dx}px)`, lifted: true };
          }
          return (
            <TabButton
              key={tab.tabId}
              tabId={tab.tabId}
              active={tab.isActive}
              label={tab.label}
              hasError={tab.hasError}
              isOffline={tab.isOffline}
              statusDetail={tab.statusDetail}
              icon={
                tab.agentActivity ? (
                  <WorkspaceTabAgentIcon activity={tab.agentActivity} />
                ) : (
                  <FileIcon size={12} style={{ flexShrink: 0 }} />
                )
              }
              onSelect={() => onSelectTab(tab.tabId)}
              onClose={() => onCloseTab(tab.tabId)}
              reorderable
              dragVisual={dragVisual}
              onTabPointerDown={(event) => handleTabPointerDown(tab.tabId, event)}
              onTabPointerMove={handleTabPointerMove}
              onTabPointerUp={handleTabPointerUp}
              onTabPointerCancel={handleTabPointerCancel}
              spacious={hasInsetTitleBar}
            />
          );
        })}
      </div>
      <button
        type="button"
        onClick={onCreateFile}
        disabled={isCreatingFile}
        title="New file"
        aria-label="New file"
        style={{
          width: 28,
          height: 28,
          display: "grid",
          placeItems: "center",
          borderRadius: 6,
          border: "none",
          backgroundColor: "transparent",
          color: "#52525b",
          cursor: isCreatingFile ? "progress" : "default",
          flexShrink: 0,
        }}
      >
        <PlusIcon size={12} />
      </button>
    </div>
  );
}

const WorkspaceTabAgentIcon = observer(function WorkspaceTabAgentIcon({
  activity,
}: {
  activity: AgentActivityState;
}) {
  return activity.hasActiveAgents ? (
    <AgentWorkingBadge agent={activity.activeAgents[0]} size={18} />
  ) : (
    <FileIcon size={12} style={{ flexShrink: 0 }} />
  );
});

function TabButton({
  tabId,
  active,
  label,
  icon,
  hasError = false,
  isOffline = false,
  statusDetail,
  onSelect,
  onClose,
  reorderable = false,
  dragVisual = null,
  onTabPointerDown,
  onTabPointerMove,
  onTabPointerUp,
  onTabPointerCancel,
  spacious = false,
}: {
  tabId?: string;
  active: boolean;
  label: string;
  icon: React.ReactNode;
  hasError?: boolean;
  isOffline?: boolean;
  statusDetail?: string;
  onSelect: () => void;
  onClose?: () => void;
  reorderable?: boolean;
  dragVisual?: TabDragVisual | null;
  onTabPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onTabPointerMove?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onTabPointerUp?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onTabPointerCancel?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  spacious?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const lifted = dragVisual?.lifted ?? false;
  // Error outranks offline: a broken stream is the thing to fix first.
  const statusColor = hasError ? TAB_ERROR_COLOR : isOffline ? TAB_OFFLINE_COLOR : null;
  const statusLabel = hasError ? "Sync error" : isOffline ? "Offline" : null;
  const title = statusLabel
    ? `${label} — ${statusLabel}${statusDetail ? `: ${statusDetail}` : ""}`
    : label;
  const tabContent = (
    <>
      {icon}
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
    </>
  );
  const tabStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: spacious ? 32 : 28,
    minWidth: 0,
    maxWidth: 200,
    padding: onClose ? "0 4px 0 10px" : "0 10px",
    borderRadius: spacious ? 8 : 6,
    // The active tab reads as a raised white surface
    // — hairline border plus soft shadow — while text metrics stay
    // identical across states so tabs never shift when switching.
    border: active || lifted ? "1px solid #e4e4e7" : "1px solid transparent",
    backgroundColor:
      active || lifted ? "#ffffff" : hovered ? (spacious ? "#e5e5e7" : "#e9e9eb") : "transparent",
    boxShadow: lifted
      ? "0 2px 8px rgba(24, 24, 27, 0.18)"
      : active
        ? spacious
          ? "0 1px 2px rgba(24, 24, 27, 0.04)"
          : "0 1px 3px rgba(24, 24, 27, 0.04)"
        : "none",
    color: statusColor ?? (active ? "#18181b" : "#52525b"),
    transform: dragVisual?.transform,
    transition: dragVisual?.transition,
    position: "relative",
    zIndex: lifted ? 1 : undefined,
    flexShrink: 0,
    cursor: "default",
    userSelect: "none",
    touchAction: reorderable ? "none" : undefined,
  };

  if (!onClose) {
    return (
      <button
        type="button"
        className="app-no-drag"
        role="tab"
        aria-selected={active}
        tabIndex={active ? 0 : -1}
        data-workspace-tab-id={tabId}
        onClick={onSelect}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        title={title}
        style={{ ...tabStyle, fontSize: 12.5, fontWeight: 500 }}
      >
        {tabContent}
      </button>
    );
  }

  return (
    <div
      className="app-no-drag"
      role="presentation"
      data-workspace-tab-id={tabId}
      onPointerDown={onTabPointerDown}
      onPointerMove={onTabPointerMove}
      onPointerUp={onTabPointerUp}
      onPointerCancel={onTabPointerCancel}
      onLostPointerCapture={onTabPointerCancel}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      data-tab-status={hasError ? "error" : isOffline ? "offline" : undefined}
      style={tabStyle}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        tabIndex={active ? 0 : -1}
        onClick={onSelect}
        onPointerDown={(event) => {
          // Middle-click closes like a browser tab.
          if (event.button === 1 && onClose) {
            event.preventDefault();
            onClose();
          }
        }}
        title={title}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flex: 1,
          minWidth: 0,
          border: "none",
          background: "transparent",
          color: "inherit",
          fontSize: 12.5,
          fontWeight: 500,
          padding: 0,
          cursor: reorderable ? (lifted ? "grabbing" : "grab") : "default",
        }}
      >
        {tabContent}
      </button>
      <button
        type="button"
        data-tab-close
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        title="Close tab"
        aria-label={`Close ${label}`}
        style={{
          width: 18,
          height: 18,
          display: "grid",
          placeItems: "center",
          borderRadius: 4,
          border: "none",
          backgroundColor: "transparent",
          color: "inherit",
          opacity: active || hovered ? 0.7 : 0,
          flexShrink: 0,
        }}
      >
        <CloseIcon size={12} />
      </button>
    </div>
  );
}
