import { useState, type CSSProperties } from "react";
import { observer } from "mobx-react-lite";
import { readDisplayError } from "../../core/shared/errors";
import { useEditorStore } from "../../core/state/EditorStore";
import {
  getHistoryActorLabel,
  getHistoryKindLabel,
  getHistoryVersionLabel,
} from "./history-labels";

const HISTORY_SYNC_MESSAGE = "Wait for changes to finish syncing before previewing history.";
const HISTORY_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function formatHistoryTime(timestamp: number | null) {
  if (!timestamp) return "Unknown time";
  return HISTORY_TIME_FORMATTER.format(new Date(timestamp));
}

export const HistoryPanel = observer(function HistoryPanel() {
  const store = useEditorStore();
  const entries = [...store.historyEntries].reverse();
  const previewId = store.historyPreview?.id ?? null;
  const [previewError, setPreviewError] = useState<string | null>(null);
  const unavailableMessage = store.canPreviewHistory ? previewError : HISTORY_SYNC_MESSAGE;

  const previewVersion = (entryId: string) => {
    if (!store.canPreviewHistory) return;
    setPreviewError(null);
    try {
      store.previewHistoryVersion(entryId);
    } catch (error) {
      setPreviewError(readDisplayError(error, "Unable to preview this history version."));
    }
  };

  if (entries.length === 0) return <div style={emptyStateStyle}>No versions yet</div>;

  return (
    <div className="panel-scroll" style={listStyle}>
      {unavailableMessage ? (
        <div role={previewError ? "alert" : "status"} style={messageStyle}>
          {unavailableMessage}
        </div>
      ) : null}
      {entries.map((entry) => {
        const isPreview = previewId === entry.id;
        const label = getHistoryVersionLabel(entry);
        const meta = [
          getHistoryActorLabel(store, entry.actor),
          getHistoryKindLabel(entry.message),
          formatHistoryTime(entry.timestamp),
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <button
            key={entry.id}
            disabled={!store.canPreviewHistory}
            onClick={() => previewVersion(entry.id)}
            title={!store.canPreviewHistory ? HISTORY_SYNC_MESSAGE : undefined}
            // bg-transparent is load-bearing: without Preflight, a bare
            // <button> falls back to the UA's gray ButtonFace background.
            className={
              isPreview
                ? "bg-surface-sunken"
                : "bg-transparent transition-colors hover:bg-surface-sunken/60"
            }
            style={rowStyle(!store.canPreviewHistory)}
            type="button"
          >
            <span style={titleStyle}>{label}</span>
            <span style={metaStyle}>{meta}</span>
          </button>
        );
      })}
    </div>
  );
});

const listStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: "4px 0 16px",
};
const emptyStateStyle: CSSProperties = { color: "#a1a1aa", fontSize: 12, padding: 16 };
const titleStyle: CSSProperties = { color: "#18181b", fontSize: 12, fontWeight: 650 };
const metaStyle: CSSProperties = { color: "#a1a1aa", fontSize: 11 };
const messageStyle: CSSProperties = {
  margin: "4px 12px",
  padding: "8px 10px",
  borderRadius: "var(--leaf-radius-md)",
  background: "var(--leaf-surface-raised)",
  color: "var(--leaf-text-muted)",
  fontSize: 11,
  lineHeight: 1.4,
};
function rowStyle(disabled: boolean): CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 2,
    width: "100%",
    padding: "8px 16px",
    border: "none",
    textAlign: "left",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.55 : 1,
  };
}
