import type { CSSProperties } from "react";
import { useRef, useState } from "react";

export function FileNameInput({
  fileName,
  onRenameFile,
  style,
}: {
  fileName: string;
  onRenameFile: (name: string) => void;
  style?: CSSProperties;
}) {
  const [draftName, setDraftName] = useState<string | null>(null);
  const pendingName = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editing = draftName !== null;

  // The parent first echoes the optimistic rename and later may replace it with
  // an authoritative rollback or an external rename. Hold the committed value
  // until that echo lands so the input never flashes (or re-seeds) the stale name.
  if (pendingName.current === fileName) {
    pendingName.current = null;
  }
  const displayedName = draftName ?? pendingName.current ?? fileName;

  const commitRename = () => {
    const trimmed = displayedName.trim();
    if (trimmed && trimmed !== fileName) {
      pendingName.current = trimmed;
      onRenameFile(trimmed);
    }
    setDraftName(null);
  };

  const startEditing = () => {
    setDraftName(displayedName);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  };

  return (
    <input
      ref={inputRef}
      aria-label="File name"
      maxLength={255}
      value={displayedName}
      readOnly={!editing}
      onChange={(e) => setDraftName(e.target.value)}
      onClick={() => {
        if (!editing) startEditing();
      }}
      onBlur={commitRename}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.currentTarget.blur();
        }
        if (e.key === "Escape") {
          setDraftName(null);
        }
      }}
      style={{
        flex: 1,
        fontSize: 14,
        fontWeight: 500,
        fontFamily: "Inter, system-ui, sans-serif",
        color: "#18181b",
        border: editing ? "1.5px solid #3b82f6" : "1.5px solid transparent",
        borderRadius: 4,
        padding: "2px 6px",
        outline: "none",
        background: editing ? "#eff6ff" : "transparent",
        minWidth: 0,
        cursor: editing ? "text" : "default",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        ...style,
      }}
    />
  );
}
