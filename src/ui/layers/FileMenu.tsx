import { memo } from "react";
import { FLOAT_SHADOW, FONT_STACK } from "../floating-styles";
import { FileMenuTrigger } from "./FileMenuTrigger";
import { FileNameInput } from "./FileNameInput";
import { SidebarToggleButton } from "./SidebarToggleButton";

export const FileMenu = memo(function FileMenu({
  fileName,
  onReturnToDashboard,
  onRenameFile,
  onToggleSidebar,
  floating = false,
}: {
  fileName: string;
  onReturnToDashboard: () => void;
  onRenameFile: (name: string) => void;
  onToggleSidebar: () => void;
  floating?: boolean;
}) {
  return (
    <div
      style={
        floating
          ? {
              position: "absolute",
              top: 12,
              left: 12,
              zIndex: 50,
              width: 280,
              padding: "8px 10px",
              backgroundColor: "var(--leaf-surface)",
              border: "1px solid var(--leaf-border)",
              borderRadius: 12,
              boxShadow: FLOAT_SHADOW,
              fontFamily: FONT_STACK,
            }
          : { padding: "8px 10px", borderBottom: "1px solid var(--leaf-border)" }
      }
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "4px 4px",
        }}
      >
        <FileMenuTrigger onReturnToDashboard={onReturnToDashboard} />
        <FileNameInput fileName={fileName} onRenameFile={onRenameFile} />
        <SidebarToggleButton collapsed={floating} onClick={onToggleSidebar} />
      </div>
    </div>
  );
});
