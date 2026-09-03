import { observer } from "mobx-react-lite";
import { TrashIcon } from "../../icons";
import { useEditorStore } from "../../../core/state/EditorStore";
import { FONT_STACK } from "../../floating-styles";
import type { SectionProps } from "./types";

export const ActionsSection = observer(({ props }: SectionProps) => {
  const store = useEditorStore();
  const { nodes } = props;

  return (
    <div style={{ padding: "8px 12px 12px" }}>
      <button
        type="button"
        onClick={() => store.runtime.deleteNodes(nodes.map((node) => node.id))}
        style={{
          width: "100%",
          height: 28,
          padding: 0,
          backgroundColor: "transparent",
          border: "1px solid #ececec",
          borderRadius: 6,
          color: "var(--leaf-text-muted)",
          fontSize: 12,
          fontFamily: FONT_STACK,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          transition: "all 0.15s",
        }}
        onMouseEnter={(event) => {
          event.currentTarget.style.borderColor = "var(--leaf-danger)";
          event.currentTarget.style.color = "var(--leaf-danger)";
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.borderColor = "#ececec";
          event.currentTarget.style.color = "var(--leaf-text-muted)";
        }}
      >
        <TrashIcon size={12} />
        Delete
      </button>
    </div>
  );
});
