import { observer } from "mobx-react-lite";
import { EyeIcon, EyeOffIcon, LockIcon, LockOpenIcon } from "../../icons";
import { IconButton, Section } from "../PropertyControls";
import { isMixed } from "../selection-properties";
import { FONT_STACK } from "../../floating-styles";
import type { SectionProps } from "./types";

/** Name, type badge, and the per-node visibility and lock toggles. */
export const NameSection = observer(({ props }: SectionProps) => {
  const { nodes, primary, isMultiple, field, updateNodes, buffered } = props;

  const visible = field("visible");
  const locked = field("locked");
  const isHidden = !isMixed(visible) && visible === false;
  const isLocked = !isMixed(locked) && locked === true;

  return (
    <Section bordered={false}>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <input
          aria-label="Layer name"
          value={isMultiple ? `${nodes.length} selected` : primary.name}
          disabled={isMultiple}
          onChange={(event) => updateNodes({ name: event.target.value })}
          onFocus={buffered.onFocus}
          onBlur={buffered.onBlur}
          style={{
            flex: 1,
            minWidth: 0,
            height: 28,
            padding: "0 8px",
            backgroundColor: "transparent",
            border: "1px solid transparent",
            borderRadius: 6,
            color: isMultiple ? "var(--leaf-text-muted)" : "var(--leaf-text)",
            fontSize: 13,
            fontWeight: 600,
            fontFamily: FONT_STACK,
            outline: "none",
            boxSizing: "border-box",
          }}
          onMouseEnter={(event) => {
            if (!isMultiple) event.currentTarget.style.backgroundColor = "var(--leaf-surface-app)";
          }}
          onMouseLeave={(event) => (event.currentTarget.style.backgroundColor = "transparent")}
        />
        <IconButton
          onClick={() => updateNodes({ visible: isHidden })}
          title={isHidden ? "Show" : "Hide"}
        >
          {isHidden ? <EyeOffIcon size={12} /> : <EyeIcon size={12} />}
        </IconButton>
        <IconButton
          onClick={() => updateNodes({ locked: !isLocked })}
          title={isLocked ? "Unlock" : "Lock"}
        >
          {isLocked ? <LockIcon size={12} /> : <LockOpenIcon size={12} />}
        </IconButton>
      </div>
      {!isMultiple && (
        <div
          style={{
            fontSize: 10,
            color: "var(--leaf-text-faint)",
            marginTop: 2,
            marginLeft: 8,
            fontFamily: "ui-monospace, monospace",
          }}
        >
          {primary.isArtboard ? "artboard" : primary.type}
        </div>
      )}
    </Section>
  );
});
