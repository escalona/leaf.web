import type { ConnectionStatus } from "../../core/state/sync-health";

const TONE_COLORS = {
  success: { dot: "#16a34a", text: "#166534" },
  warning: { dot: "#d97706", text: "#92400e" },
  danger: { dot: "#dc2626", text: "#991b1b" },
} as const;

/**
 * The one piece of connection chrome that ships to users: a small pill in the
 * bottom-left corner that exists only while the session is offline, read-only,
 * reconnecting, or broken. A healthy session renders nothing at all — the
 * absence is the signal — and the pill explains itself on hover rather than
 * spending screen on a sentence.
 */
export function ConnectionStatusIndicator({ status }: { status: ConnectionStatus | null }) {
  if (!status) return null;
  const colors = TONE_COLORS[status.tone];
  return (
    <div
      role="status"
      aria-live="polite"
      data-connection-status={status.kind}
      title={status.detail}
      style={{
        position: "fixed",
        left: 12,
        bottom: 12,
        zIndex: 40,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: 24,
        padding: "0 10px 0 8px",
        borderRadius: 999,
        border: "1px solid rgba(24, 24, 27, 0.08)",
        backgroundColor: "rgba(255, 255, 255, 0.92)",
        boxShadow: "0 1px 3px rgba(24, 24, 27, 0.08)",
        color: colors.text,
        fontFamily: "Inter, system-ui, sans-serif",
        fontSize: 11.5,
        fontWeight: 500,
        lineHeight: 1,
        userSelect: "none",
        pointerEvents: "auto",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          backgroundColor: colors.dot,
          flexShrink: 0,
        }}
      />
      {status.title}
    </div>
  );
}
