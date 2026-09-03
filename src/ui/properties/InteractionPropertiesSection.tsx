import type { CSSProperties } from "react";
import { observer } from "mobx-react-lite";
import { useEditorStore } from "../../core/state/EditorStore";
import { FONT_STACK } from "../floating-styles";
import { Section } from "./PropertyControls";

export const InteractionPropertiesSection = observer(function InteractionPropertiesSection() {
  const store = useEditorStore();
  const isActive = store.activeInteractiveSurfaceId !== null;
  const targetId = store.activeInteractiveSurfaceId ?? store.selectedInteractionTargetId;
  if (!targetId) return null;

  const node = store.getNode(targetId);
  if (!node) return null;

  const behaviorLabel = store.domIndex.getElement(node)?.dataset.leafScriptBehaviorLabel?.trim();
  const label = behaviorLabel || node.name || "Interactive element";

  return (
    <div
      aria-live="polite"
      data-script-interaction-control={targetId}
      data-script-interaction-state={isActive ? "active" : "inactive"}
    >
      <Section bordered={false} title="Interaction">
        <div style={cardStyle}>
          <div style={statusRowStyle}>
            <span aria-hidden style={statusDotStyle(isActive)} />
            <div style={{ minWidth: 0 }}>
              <div style={statusTitleStyle}>
                {isActive ? "Interaction active" : "Interactive content"}
              </div>
              <div title={label} style={labelStyle}>
                {label}
              </div>
            </div>
          </div>
          <div style={actionRowStyle}>
            <button
              aria-label={isActive ? `Stop interacting with ${label}` : `Interact with ${label}`}
              onClick={() =>
                isActive
                  ? store.deactivateInteractiveSurface()
                  : store.activateInteraction(targetId)
              }
              style={buttonStyle(isActive)}
              type="button"
            >
              {isActive ? "Done" : "Interact"}
            </button>
            <span style={shortcutHintStyle}>
              {isActive ? (
                <>
                  <kbd style={keyStyle}>Esc</kbd> to edit
                </>
              ) : (
                <>
                  or press <kbd style={keyStyle}>Enter</kbd>
                </>
              )}
            </span>
          </div>
        </div>
      </Section>
    </div>
  );
});

const cardStyle: CSSProperties = {
  backgroundColor: "#f8fafc",
  border: "1px solid var(--leaf-border)",
  borderRadius: 8,
  padding: 10,
};

const statusRowStyle: CSSProperties = {
  alignItems: "flex-start",
  display: "flex",
  gap: 8,
  minWidth: 0,
};

const statusTitleStyle: CSSProperties = {
  color: "var(--leaf-text)",
  fontFamily: FONT_STACK,
  fontSize: 12,
  fontWeight: 600,
  lineHeight: "16px",
};

const labelStyle: CSSProperties = {
  color: "var(--leaf-text-muted)",
  fontFamily: FONT_STACK,
  fontSize: 11,
  lineHeight: "15px",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const actionRowStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: 8,
  marginTop: 10,
};

const shortcutHintStyle: CSSProperties = {
  color: "var(--leaf-text-muted)",
  fontFamily: FONT_STACK,
  fontSize: 10,
  lineHeight: "14px",
};

const keyStyle: CSSProperties = {
  backgroundColor: "var(--leaf-surface)",
  border: "1px solid var(--leaf-border-strong)",
  borderRadius: 4,
  boxShadow: "0 1px 0 rgba(0, 0, 0, 0.06)",
  color: "var(--leaf-text-secondary)",
  fontFamily: FONT_STACK,
  fontSize: 9,
  padding: "1px 4px",
};

function statusDotStyle(isActive: boolean): CSSProperties {
  return {
    backgroundColor: isActive ? "#22c55e" : "var(--leaf-accent)",
    borderRadius: "50%",
    flex: "0 0 auto",
    height: 7,
    marginTop: 4,
    width: 7,
  };
}

function buttonStyle(isActive: boolean): CSSProperties {
  return {
    alignItems: "center",
    backgroundColor: isActive ? "var(--leaf-surface)" : "var(--leaf-accent-hover)",
    border: isActive ? "1px solid var(--leaf-border-strong)" : "1px solid var(--leaf-accent-hover)",
    borderRadius: 6,
    color: isActive ? "var(--leaf-text)" : "var(--leaf-text-on-accent)",
    display: "inline-flex",
    fontFamily: FONT_STACK,
    fontSize: 11,
    fontWeight: 600,
    height: 26,
    justifyContent: "center",
    padding: "0 10px",
  };
}
