import { FolderOpenIcon, PlusIcon } from "../icons";

export function EmptyFilesState({
  onCreateFile,
  onOpenNativeFile,
  isCreatingFile,
}: {
  onCreateFile: () => void | Promise<void>;
  /** Present only in native-document mode, where the copy also offers Open. */
  onOpenNativeFile?: () => void | Promise<void>;
  isCreatingFile: boolean;
}) {
  const nativeDocuments = Boolean(onOpenNativeFile);
  return (
    <div
      style={{
        gridColumn: "1 / -1",
        borderRadius: 28,
        border: "1px solid #e4e4e7",
        background: "linear-gradient(145deg, #fafafa 0%, #f4f4f5 100%)",
        padding: 36,
        display: "grid",
        gap: 14,
        justifyItems: "start",
        boxShadow: "0 20px 60px rgba(0, 0, 0, 0.06)",
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: 12,
          display: "grid",
          placeItems: "center",
          background: "#f4f4f5",
          color: "#18181b",
        }}
      >
        <FolderOpenIcon size={16} />
      </div>
      <div style={{ fontSize: 24, fontWeight: 600, color: "#18181b" }}>No files yet</div>
      <div style={{ maxWidth: 420, lineHeight: 1.6, color: "#71717a" }}>
        {nativeDocuments
          ? "Create a portable .leaf file to start a new design, or open one already stored on this computer."
          : "Create a file to start a new canvas. Your files are saved to your account, so you can reopen them here from any device."}
      </div>
      <div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 10 }}>
        <button
          type="button"
          onClick={onCreateFile}
          disabled={isCreatingFile}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 18px",
            borderRadius: 999,
            border: "1px solid #e4e4e7",
            backgroundColor: "#18181b",
            color: "#fff",
            fontSize: 14,
            fontWeight: 700,
            cursor: isCreatingFile ? "progress" : "default",
          }}
        >
          <PlusIcon size={16} />
          {isCreatingFile ? "Creating file…" : "New file"}
        </button>
        {onOpenNativeFile ? (
          <button
            type="button"
            onClick={onOpenNativeFile}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
              padding: "12px 18px",
              borderRadius: 999,
              border: "1px solid #e4e4e7",
              backgroundColor: "#fff",
              color: "#18181b",
              fontSize: 14,
              fontWeight: 700,
            }}
          >
            <FolderOpenIcon size={16} />
            Open file
          </button>
        ) : null}
      </div>
    </div>
  );
}
