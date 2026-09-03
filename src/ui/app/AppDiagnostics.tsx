import { Suspense, lazy } from "react";
import type { SyncHealth } from "../../core/state/sync-health";

const ENABLE_DIAGNOSTICS =
  import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEV_TOOLBAR === "true";
const LazyDevToolbar = lazy(() =>
  import("../dev-toolbar/DevToolbar").then(({ DevToolbar }) => ({ default: DevToolbar })),
);

export function AppDiagnostics({
  networkIssue,
  peerCount,
  syncHealth,
}: {
  networkIssue: string | null;
  peerCount: number;
  syncHealth: SyncHealth;
}) {
  if (!ENABLE_DIAGNOSTICS) return null;

  return (
    <Suspense fallback={null}>
      <LazyDevToolbar syncHealth={syncHealth} peerCount={peerCount} networkIssue={networkIssue} />
    </Suspense>
  );
}
