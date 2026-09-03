import { useCallback, useEffect, useRef, useState } from "react";
import type { User } from "@workos-inc/authkit-react";
import { App } from "../App";
import type { AppHost } from "../app-host";
import { getAccountDisplayName } from "../../ui/files/FilesDashboardSidebar";
import {
  createCollaborationApplicationRuntime,
  type CollaborationApplicationRuntime,
  type CreateCollaborationApplicationRuntimeOptions,
} from "../../core/state/collaboration-app-runtime";
import {
  getConfiguredWorkerBaseUrl,
  setWorkerSuppressedForLocalMode,
} from "../../core/state/worker-endpoints";
import { ErrorState, LoadingState, returnToHome } from "./boot-states";

export const LOCAL_ACCOUNT_ID = "local";

/** The transport a host may substitute for `fetch` on Worker calls. */
export type RuntimeFetcher = CreateCollaborationApplicationRuntimeOptions["fetcher"];

type AppBootState =
  | { status: "loading" }
  /** `generation` counts runtime instances so the shell can be remounted per runtime. */
  | { status: "ready"; generation: number; runtime: CollaborationApplicationRuntime }
  | { status: "error"; error: unknown };

/**
 * Builds the `CollaborationApplicationRuntime` for one account and mounts the
 * workspace shell on it. Shared by the browser and desktop boot trees.
 */
export function AppBootstrap({
  accountId,
  authUser,
  autoOpenFirstFile,
  fetcher,
  forceLocal,
  getAccessToken,
  host,
  onSignIn,
  onSignOut,
  organizationId = null,
}: {
  accountId: string;
  authUser?: User | null;
  /** Land a first visit to an empty workspace in the editor; see `App`. */
  autoOpenFirstFile?: boolean;
  fetcher?: RuntimeFetcher;
  forceLocal?: boolean;
  getAccessToken?: () => Promise<string>;
  host?: AppHost;
  onSignIn?: () => void;
  onSignOut?: () => void | Promise<void>;
  organizationId?: string | null;
}) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<AppBootState>({ status: "loading" });
  const generationRef = useRef(0);
  // The label presence peers see for this account. Read through a ref so a
  // refreshed profile reaches the next sync token without rebuilding the
  // runtime, which would remount the whole shell.
  const authUserRef = useRef(authUser);
  authUserRef.current = authUser;
  const getDisplayName = useCallback(
    () => (authUserRef.current ? getAccountDisplayName(authUserRef.current) : null),
    [],
  );

  useEffect(() => {
    let runtime: CollaborationApplicationRuntime | null = null;

    setState({ status: "loading" });

    try {
      runtime = loadApplication(accountId, getAccessToken, {
        fetcher,
        forceLocal,
        getDisplayName,
        organizationId,
      });
      generationRef.current += 1;
      setState({ status: "ready", generation: generationRef.current, runtime });
    } catch (error) {
      setState({ status: "error", error });
    }

    return () => {
      if (runtime) void runtime.close();
    };
  }, [accountId, attempt, fetcher, forceLocal, getAccessToken, getDisplayName, organizationId]);

  if (state.status === "loading") {
    return <LoadingState />;
  }

  if (state.status === "error") {
    return (
      <ErrorState
        title="Unable to open your workspace"
        error={state.error}
        onRetry={() => setAttempt((value) => value + 1)}
        onBackToHome={returnToHome}
      />
    );
  }

  // Signing in from local mode swaps the runtime while this component stays
  // mounted. `App` binds its workspace tab controller and its
  // `window.leafCollaboration` context once per mount, so a new runtime needs a
  // new mount — otherwise the shell keeps driving the runtime just closed.
  return (
    <App
      key={state.generation}
      authUser={authUser}
      autoOpenFirstFile={autoOpenFirstFile}
      host={host}
      runtime={state.runtime}
      onSignIn={onSignIn}
      onSignOut={onSignOut}
    />
  );
}

function loadApplication(
  accountId: string,
  getAccessToken?: () => Promise<string>,
  options?: {
    fetcher?: RuntimeFetcher;
    forceLocal?: boolean;
    getDisplayName?: () => string | null;
    organizationId?: string | null;
  },
): CollaborationApplicationRuntime {
  // Declared on every construction so the whole renderer — image asset uploads
  // and the AI routes as much as this runtime — agrees on whether a Worker may
  // be reached at all. Local mode suppresses the origin; any other mode
  // restores it.
  setWorkerSuppressedForLocalMode(Boolean(options?.forceLocal));
  const workerBaseUrl = getConfiguredWorkerBaseUrl();
  if (!workerBaseUrl) {
    return createCollaborationApplicationRuntime({ accountId, mode: "local" });
  }
  if (!getAccessToken) throw new Error("Network collaboration requires authentication.");
  return createCollaborationApplicationRuntime({
    accountId,
    fetcher: options?.fetcher,
    getAccessToken,
    getDisplayName: options?.getDisplayName,
    mode: "network",
    organizationId: options?.organizationId ?? null,
    workerBaseUrl,
  });
}
