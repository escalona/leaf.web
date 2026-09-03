import { PanelLeftIcon } from "../icons";

export function SidebarToggleButton({
  collapsed,
  onClick,
}: {
  collapsed: boolean;
  onClick: () => void;
}) {
  const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
  return (
    <button
      type="button"
      aria-label={label}
      title={`${label} (⇧⌘\\)`}
      onClick={onClick}
      style={{
        width: 26,
        height: 26,
        borderRadius: 5,
        display: "grid",
        placeItems: "center",
        border: "none",
        backgroundColor: "transparent",
        color: "#71717a",
        flexShrink: 0,
        padding: 0,
      }}
    >
      <PanelLeftIcon size={16} />
    </button>
  );
}
