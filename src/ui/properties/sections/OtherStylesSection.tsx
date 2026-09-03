import { observer } from "mobx-react-lite";
import { TrashIcon } from "../../icons";
import { IconButton, MixedTextInput, Section } from "../PropertyControls";
import { collectUnpanelledStyleKeys, readSelectionStyle } from "../selection-properties";
import type { SectionProps } from "./types";

/**
 * Every style on the selection without a dedicated control.
 *
 * This is the escape hatch that makes narrow panels defensible: an agent can
 * write any CSS it likes and a human can still see it, edit it, and take it
 * back off. Without this, agent-authored styles are invisible and permanent.
 */
export const OtherStylesSection = observer(({ props }: SectionProps) => {
  const { nodes, setStyles, removeStyles, buffered } = props;
  const keys = collectUnpanelledStyleKeys(nodes);
  if (keys.length === 0) return null;

  return (
    <Section title="Other styles">
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {keys.map((key) => (
          <div key={key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div
              style={{
                width: 88,
                flexShrink: 0,
                fontSize: 10,
                color: "var(--leaf-text-muted)",
                fontFamily: "ui-monospace, monospace",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={key}
            >
              {key}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <MixedTextInput
                value={readSelectionStyle(nodes, key)}
                monospace
                onChange={(next) => setStyles({ [key]: next })}
                {...buffered}
              />
            </div>
            <IconButton onClick={() => removeStyles([key])} title={`Remove ${key}`}>
              <TrashIcon size={12} />
            </IconButton>
          </div>
        ))}
      </div>
    </Section>
  );
});
