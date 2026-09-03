import type { CSSProperties } from "react";
import { observer } from "mobx-react-lite";
import { useEditorStore } from "../../core/state/EditorStore";
import { getHistoryVersionLabel } from "./history-labels";

export const HistoryPreviewBanner = observer(function HistoryPreviewBanner() {
  const store = useEditorStore();
  const preview = store.historyPreview;
  if (!preview) return null;
  return (
    <div style={bannerStyle}>
      <span style={{ fontSize: 12, fontWeight: 650, whiteSpace: "nowrap" }}>
        {getHistoryVersionLabel(preview)}
      </span>
      <button onClick={() => store.exitHistoryPreview()} style={buttonStyle(false)} type="button">
        Current
      </button>
      <button
        onClick={() => store.restoreHistoryVersion(preview.id)}
        style={buttonStyle(true)}
        type="button"
      >
        Restore
      </button>
    </div>
  );
});

const bannerStyle: CSSProperties = {
  position: "absolute",
  top: 16,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 90,
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "7px 8px 7px 11px",
  borderRadius: 9,
  backgroundColor: "#18181b",
  color: "#fff",
  boxShadow: "0 12px 36px rgba(0,0,0,0.18)",
};
function buttonStyle(primary: boolean): CSSProperties {
  return {
    height: 26,
    padding: "0 10px",
    borderRadius: 7,
    border: primary ? "1px solid #fff" : "1px solid rgba(255,255,255,0.25)",
    backgroundColor: primary ? "#fff" : "transparent",
    color: primary ? "#18181b" : "#fff",
    fontSize: 11,
    fontWeight: 650,
  };
}
