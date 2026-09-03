export function SessionTransitionOverlay({
  fileName,
  showLabel,
}: {
  fileName: string;
  showLabel: boolean;
}) {
  return (
    <div
      // Chromium drag regions are window-level rects, so overlays covering the
      // title strip must opt out explicitly to swallow pointer input.
      className="app-no-drag"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 240,
        pointerEvents: "auto",
        display: "grid",
        alignItems: "start",
        justifyItems: "center",
        paddingTop: 28,
      }}
      aria-live="polite"
    >
      {showLabel ? (
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 14px",
            borderRadius: 999,
            border: "1px solid #e4e4e7",
            background: "rgba(255, 255, 255, 0.94)",
            color: "#18181b",
            fontSize: 12,
            fontWeight: 600,
            fontFamily: "Inter, system-ui, sans-serif",
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.08)",
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 999,
              background: "#18181b",
              opacity: 0.8,
            }}
          />
          <span
            style={{
              maxWidth: 320,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            Switching to {fileName}
          </span>
        </div>
      ) : null}
    </div>
  );
}
