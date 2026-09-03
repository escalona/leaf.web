import type { CSSProperties } from "react";
import { useState } from "react";
import { observer } from "mobx-react-lite";
import { EyeIcon, EyeOffIcon } from "../icons";
import {
  PROPERTIES_PANEL_MAX_WIDTH,
  PROPERTIES_PANEL_MIN_WIDTH,
} from "../../core/editor/editor-layout";
import { useEditorStore } from "../../core/state/EditorStore";
import { AgentPresenceIndicator } from "../AgentPresenceIndicator";
import { FLOAT_SHADOW, FONT_STACK } from "../floating-styles";
import { CommentsPanel } from "../comments/CommentsPanel";
import { HistoryPanel } from "../history/HistoryPanel";
import { PanelResizeHandle } from "../PanelResizeHandle";
import { ToggleButton, Tooltip } from "../primitives";
import { InteractionPropertiesSection } from "./InteractionPropertiesSection";
import { NodeProperties } from "./NodeProperties";
import { PageSection } from "./sections/PageSection";
import { ZoomMenu } from "./ZoomMenu";

const DOCKED_STYLE: CSSProperties = {
  backgroundColor: "var(--leaf-surface)",
  borderLeft: "1px solid var(--leaf-border)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  flexShrink: 0,
  boxSizing: "border-box",
  position: "relative",
};

const FLOATING_STYLE: CSSProperties = {
  position: "absolute",
  top: 12,
  right: 12,
  bottom: 12,
  zIndex: 50,
  backgroundColor: "var(--leaf-surface)",
  border: "1px solid var(--leaf-border)",
  borderRadius: 12,
  boxShadow: FLOAT_SHADOW,
  fontFamily: FONT_STACK,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  boxSizing: "border-box",
};

const SCROLL_AREA_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  overflowX: "hidden",
  overflowY: "auto",
};

const TAB_BAR_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 2,
  padding: "8px 10px",
  borderBottom: "1px solid var(--leaf-border)",
  flexShrink: 0,
};

const PRESENCE_HEADER_STYLE: CSSProperties = {
  minHeight: 48,
  padding: "0 14px",
  display: "flex",
  alignItems: "center",
  flexShrink: 0,
};

const FLOATING_CONTROLS_STYLE: CSSProperties = {
  position: "absolute",
  top: 12,
  right: 12,
  zIndex: 50,
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: 4,
  backgroundColor: "var(--leaf-surface)",
  border: "1px solid var(--leaf-border)",
  borderRadius: 12,
  boxShadow: FLOAT_SHADOW,
  fontFamily: FONT_STACK,
};

const FLOATING_PRESENCE_STYLE: CSSProperties = {
  padding: "5px 0 5px 8px",
};

export const PropertiesPanel = observer(({ floating = false }: { floating?: boolean }) => {
  const store = useEditorStore();
  const selectedNodes = store.selectedNodes;
  const node = store.selectedNode;
  const interactionTargetId = store.activeInteractiveSurfaceId ?? store.selectedInteractionTargetId;
  const [activeTab, setActiveTab] = useState<"design" | "history">("design");
  // The comments pane is not a tab: it takes over the panel while the comment
  // tool is active and leaves with it, scoping the comments sidebar to the
  // comment tool.
  const visibleTab = store.isHistoryPreviewing
    ? "history"
    : store.activeTool === "comment"
      ? "comments"
      : store.activeInteractiveSurfaceId
        ? "design"
        : activeTab;
  const showingHistory = visibleTab === "history";
  const showingComments = visibleTab === "comments";
  const deactivateForInspectorTarget = (target: EventTarget | null) => {
    if (!store.activeInteractiveSurfaceId) return;
    if (target instanceof Element) {
      if (target.closest("[data-script-interaction-control]")) return;
      // Let tab clicks complete before their explicit handlers change mode.
      if (target.closest("[data-properties-panel-tab]")) return;
    }
    // Interacting with a Design control should keep Design selected after the
    // interaction mode exits; otherwise a previously selected History tab
    // immediately unmounts the control receiving this pointer/focus event.
    setActiveTab("design");
    store.deactivateInteractiveSurface();
  };

  const floatingContentHidden =
    floating &&
    !store.isHistoryPreviewing &&
    !showingHistory &&
    !showingComments &&
    ((!node && !interactionTargetId) || store.marqueeSelecting);
  if (floatingContentHidden) {
    // The zoom chip stays visible even when the panel itself has nothing to
    // show, so the zoom control is always present.
    return (
      <div data-floating-canvas-controls style={FLOATING_CONTROLS_STYLE}>
        {store.agentActivity.hasActiveAgents ? (
          <div data-floating-agent-presence style={FLOATING_PRESENCE_STYLE}>
            <AgentPresenceIndicator activity={store.agentActivity} />
          </div>
        ) : null}
        <ZoomMenu />
      </div>
    );
  }

  return (
    <div
      data-properties-panel
      onFocusCapture={(event) => deactivateForInspectorTarget(event.target)}
      onPointerDownCapture={(event) => deactivateForInspectorTarget(event.target)}
      style={{
        ...(floating ? FLOATING_STYLE : DOCKED_STYLE),
        width: store.propertiesPanelWidth,
        minWidth: store.propertiesPanelWidth,
      }}
    >
      {!floating && (
        <PanelResizeHandle
          edge="start"
          label="Resize properties panel"
          name="properties"
          min={PROPERTIES_PANEL_MIN_WIDTH}
          max={PROPERTIES_PANEL_MAX_WIDTH}
          value={store.propertiesPanelWidth}
          onResize={(next) => store.setPropertiesPanelWidth(next)}
        />
      )}
      {store.agentActivity.hasActiveAgents ? (
        <div data-properties-panel-presence style={PRESENCE_HEADER_STYLE}>
          <AgentPresenceIndicator activity={store.agentActivity} />
        </div>
      ) : null}
      {showingComments ? (
        <div style={TAB_BAR_STYLE}>
          <span style={COMMENTS_TITLE_STYLE}>Comments</span>
          <div style={COMMENTS_HEADER_ACTIONS_STYLE}>
            <Tooltip content={store.commentsHidden ? "Show pins on canvas" : "Hide pins on canvas"}>
              <ToggleButton
                aria-label="Hide comment pins on canvas"
                pressed={store.commentsHidden}
                onPressedChange={() => store.toggleCommentsHidden()}
              >
                {store.commentsHidden ? <EyeOffIcon size={12} /> : <EyeIcon size={12} />}
              </ToggleButton>
            </Tooltip>
            <ZoomMenu />
          </div>
        </div>
      ) : (
        <div style={TAB_BAR_STYLE}>
          <PanelTab
            active={visibleTab === "design"}
            disabled={store.isHistoryPreviewing}
            label="Design"
            onClick={() => {
              store.deactivateInteractiveSurface();
              setActiveTab("design");
            }}
          />
          <PanelTab
            active={showingHistory}
            label="History"
            onClick={() => {
              store.deactivateInteractiveSurface();
              setActiveTab("history");
            }}
          />
          <div style={{ marginLeft: "auto" }}>
            <ZoomMenu />
          </div>
        </div>
      )}
      {showingHistory ? (
        <HistoryPanel />
      ) : showingComments ? (
        <CommentsPanel />
      ) : (
        <>
          <InteractionPropertiesSection />
          <div className="panel-scroll" style={SCROLL_AREA_STYLE}>
            {selectedNodes.length > 0 ? (
              <NodeProperties nodes={selectedNodes} />
            ) : (
              <>
                <PageSection />
                <div style={emptyStateStyle}>Select an element to edit its properties</div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
});

function PanelTab({
  active,
  disabled = false,
  label,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      data-properties-panel-tab={label.toLowerCase()}
      disabled={disabled}
      onClick={onClick}
      style={{
        height: 28,
        padding: "0 10px",
        border: "none",
        borderRadius: 6,
        backgroundColor: active ? "var(--leaf-surface-sunken)" : "transparent",
        color: disabled ? "#d4d4d8" : active ? "var(--leaf-text)" : "var(--leaf-text-faint)",
        fontSize: 12,
        fontWeight: active ? 600 : 500,
        fontFamily: FONT_STACK,
      }}
      type="button"
    >
      {label}
    </button>
  );
}

const COMMENTS_TITLE_STYLE: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--leaf-text)",
  fontFamily: FONT_STACK,
  padding: "0 4px",
};

const COMMENTS_HEADER_ACTIONS_STYLE: CSSProperties = {
  marginLeft: "auto",
  display: "flex",
  alignItems: "center",
  gap: 4,
};

const emptyStateStyle: CSSProperties = {
  color: "var(--leaf-text-faint)",
  fontSize: 11,
  fontFamily: FONT_STACK,
  lineHeight: 1.4,
  padding: "0 12px",
};
