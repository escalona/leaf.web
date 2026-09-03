export type SyncHealthTone = "success" | "warning" | "danger";

export type SyncHealth = {
  tone: SyncHealthTone;
  title: string;
  detail: string;
};

export function getSyncHealth({
  hasActiveDocument,
  isOnline,
  peerCount,
  syncServerEnabled,
}: {
  hasActiveDocument: boolean;
  isOnline: boolean;
  peerCount: number;
  syncServerEnabled: boolean;
}): SyncHealth {
  if (!isOnline) {
    return {
      tone: "danger",
      title: "Offline",
      detail: "Changes stay local until the browser reconnects.",
    };
  }

  if (!syncServerEnabled) {
    return {
      tone: "warning",
      title: "Sync disabled",
      detail: "Realtime sync is turned off. Documents persist locally only.",
    };
  }

  if (!hasActiveDocument) {
    return {
      tone: "success",
      title: "Sync idle",
      detail: "No document is open. Sync connects when a file is opened.",
    };
  }

  if (peerCount === 0) {
    return {
      tone: "warning",
      title: "Sync disconnected",
      detail: "The app is not connected to a sync peer right now. Local edits are still saved.",
    };
  }

  return {
    tone: "success",
    title: "Sync connected",
    detail: peerCount === 1 ? "Connected to 1 sync peer." : `Connected to ${peerCount} sync peers.`,
  };
}

/**
 * The transport states a session can be in, as the workspace shell sees them.
 * Mirrors `WorkspaceTabTransportStatus`, restated here so this module stays
 * free of state-layer imports.
 */
export type ConnectionTransportStatus =
  | "idle"
  | "offline"
  | "connecting"
  | "bootstrapping"
  | "live"
  | "read-only"
  | "reconnecting"
  | "closed"
  | "error"
  | "local";

export type ConnectionStatus = {
  kind: "offline" | "reconnecting" | "read-only" | "error";
  tone: SyncHealthTone;
  /** Short label for the pill. */
  title: string;
  /** Plain-language explanation for the tooltip. */
  detail: string;
};

/**
 * What the production connection indicator shows, or `null` for "nothing":
 * healthy, still connecting, local-only, and no-document states all stay
 * silent so the pill only appears when the user's edits are not flowing the
 * way they expect.
 *
 * "Offline" is benign: edits keep landing in the committed cache and sync on
 * reconnect. "Error" is not: the stream broke and edits are not reaching the
 * server. The two must never read the same.
 */
export function getConnectionStatus({
  isOnline,
  runtimeMode,
  transportStatus,
}: {
  isOnline: boolean;
  runtimeMode: "local" | "network";
  transportStatus: ConnectionTransportStatus;
}): ConnectionStatus | null {
  if (runtimeMode !== "network") return null;

  if (transportStatus === "error") {
    return {
      kind: "error",
      tone: "danger",
      title: "Sync error",
      detail:
        "This file's connection broke. Recent edits may not reach the server until it reconnects.",
    };
  }

  if (transportStatus === "read-only") {
    return {
      kind: "read-only",
      tone: "warning",
      title: "View only",
      detail: "You can view this file but not edit it.",
    };
  }

  if (transportStatus === "reconnecting") {
    return {
      kind: "reconnecting",
      tone: "warning",
      title: "Reconnecting…",
      detail: "Edits are saved on this device and will sync once the connection is back.",
    };
  }

  if (transportStatus === "offline" || !isOnline) {
    return {
      kind: "offline",
      tone: "warning",
      title: "Offline",
      detail: "Edits are saved on this device and will sync when you're back online.",
    };
  }

  return null;
}
