import type { ReactNode } from "react";
import { AppTitleBar } from "./AppTitleBar";

export function LoadingScreen({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "grid",
        placeItems: "center",
        width: "100%",
        height: "100%",
        fontFamily: "Inter, system-ui, sans-serif",
        color: "#18181b",
        background: "#fafafa",
        padding: 24,
      }}
    >
      <AppTitleBar />
      <div style={{ maxWidth: 460, textAlign: "center" }}>
        <div style={{ fontSize: 24, fontWeight: 600 }}>{title}</div>
        {detail ? (
          <div style={{ marginTop: 12, color: "#71717a", lineHeight: 1.6 }}>{detail}</div>
        ) : null}
        {action ? <div style={{ marginTop: 20 }}>{action}</div> : null}
      </div>
    </div>
  );
}
