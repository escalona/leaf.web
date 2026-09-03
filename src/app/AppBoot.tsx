/**
 * Browser boot tree: picks the runtime mode (dev auth, account session, or
 * explicit local mode) and creates the `CollaborationApplicationRuntime` the
 * editor shell runs on. `src/app/main.tsx` only mounts this component; the
 * desktop shell has its own tree in `src/desktop/DesktopBoot.tsx`.
 */
import { useCallback, useState } from "react";
import { AuthKitProvider, useAuth } from "@workos-inc/authkit-react";
import { clearLocalModePreference, writeLocalModePreference } from "./auth/local-mode-preference";
import { getAuthReturnTo, readSafeAuthReturnTo } from "./auth/workos-config";
import { AppBootstrap, LOCAL_ACCOUNT_ID } from "./boot/app-bootstrap";
import { LoadingState, SignOnScreen } from "./boot/boot-states";
import { getPreferenceStorage, useLocalModeChoice } from "./boot/local-mode";
import { StandardRoot } from "./boot/StandardRoot";
import { readDisplayError } from "../core/shared/errors";

export function AppBoot() {
  return (
    <StandardRoot
      renderAccount={(boot) => (
        <AuthKitProvider
          clientId={boot.workOSConfig.clientId}
          apiHostname={boot.workOSConfig.apiHostname}
          devMode={boot.workOSConfig.devMode}
          redirectUri={boot.workOSConfig.redirectUri}
          onRedirectCallback={({ state }) => {
            // AuthKit leaves the URL on the callback route with its query
            // stripped; land where the sign-in started, or home.
            window.history.replaceState({}, "", readSafeAuthReturnTo(state) ?? "/");
          }}
        >
          <AuthenticatedAppBootstrap />
        </AuthKitProvider>
      )}
    />
  );
}

/**
 * This component and `DesktopAuthenticatedAppBootstrap` in
 * `src/desktop/DesktopBoot.tsx` look alike and are not. Every difference is
 * deliberate and adversarially reviewed; do not collapse one into the other
 * without new evidence.
 *
 * - Desktop bounds session restore at `SESSION_RESTORE_TIMEOUT_MS`, so a hanging
 *   WorkOS refresh reopens the cached workspace as "offline, signed in" (or
 *   falls through to sign-on when this window never restored an identity)
 *   instead of holding a spinner. The browser has no timeout: AuthKit owns
 *   loading for this document.
 * - The stored local-mode preference wins at boot on both, by different means —
 *   desktop skips the restore so nothing reaches WorkOS, the browser ignores a
 *   session AuthKit already holds.
 * - Explicit sign in clears that preference on completion for desktop, so an
 *   abandoned external flow leaves the user's files where they were; the browser
 *   clears the stored copy just before its redirect, because the redirect
 *   destroys this document, and restores it if the flow fails to start.
 * - `keepAuthenticatedOtherwise` guards the desktop case where a restore lands
 *   behind the sign-in spinner: abandoning the flow must not discard it.
 * - Only the browser short-circuits sign in on a held session. Desktop in local
 *   mode skipped its restore, so it has nothing to adopt.
 *
 * Unifying these behind a shared auth adapter was built and measured in August
 * 2026: per-platform code shrank 70 lines, the adapter contract and its glue
 * cost 112, net +42. The duplication is cheaper than the abstraction that
 * removes it.
 */
function AuthenticatedAppBootstrap() {
  const { getAccessToken, isLoading, organizationId, signIn, signOut, signUp, user } = useAuth();
  const [pendingRedirect, setPendingRedirect] = useState<"sign-in" | "sign-up" | null>(null);
  const [redirectError, setRedirectError] = useState<string | null>(null);
  const {
    chooseLocalMode,
    enabled: localMode,
    enabledRef: localModeRef,
    leaveLocalMode,
  } = useLocalModeChoice();

  // Clicking sign in is the only thing that leaves local mode. The browser flow
  // navigates away from this document, so the stored preference is cleared
  // before the redirect starts — nothing can run after it. The in-memory
  // choice, and with it the local workspace on screen, only flips once the
  // flow has actually started: a flow that fails to start restores the stored
  // preference and leaves the user's files where they were instead of
  // stranding them at sign-on. When a session is already present it simply
  // becomes the active one and no redirect is needed.
  const startBrowserAuthFlow = useCallback(
    async (
      kind: "sign-in" | "sign-up",
      start: (options: { state: { returnTo: string } }) => Promise<unknown>,
      failure: string,
    ) => {
      setPendingRedirect(kind);
      setRedirectError(null);
      const wasLocal = localModeRef.current;
      if (wasLocal) clearLocalModePreference(getPreferenceStorage());
      try {
        await start({ state: { returnTo: getAuthReturnTo() } });
        leaveLocalMode();
      } catch (error) {
        if (wasLocal && localModeRef.current) writeLocalModePreference(getPreferenceStorage());
        setPendingRedirect(null);
        setRedirectError(readDisplayError(error, failure));
      }
    },
    [leaveLocalMode, localModeRef],
  );

  const startSignIn = useCallback(async () => {
    if (user) {
      leaveLocalMode();
      return;
    }
    await startBrowserAuthFlow("sign-in", signIn, "Unable to start sign in.");
  }, [leaveLocalMode, signIn, startBrowserAuthFlow, user]);

  const startSignUp = useCallback(async () => {
    await startBrowserAuthFlow("sign-up", signUp, "Unable to start account creation.");
  }, [signUp, startBrowserAuthFlow]);

  const handleSignOut = useCallback(() => {
    signOut({ returnTo: window.location.origin });
  }, [signOut]);

  const provideAccessToken = useCallback(async () => {
    return await getAccessToken();
  }, [getAccessToken]);

  // The stored choice outranks a session AuthKit may already hold: an account
  // that was never signed out of is not a request to stop working locally.
  if (localMode) {
    return (
      <AppBootstrap accountId={LOCAL_ACCOUNT_ID} forceLocal onSignIn={() => void startSignIn()} />
    );
  }

  if (isLoading || pendingRedirect) {
    return <LoadingState title="Signing in…" />;
  }

  if (!user) {
    return (
      <SignOnScreen
        error={redirectError}
        onSignIn={startSignIn}
        onSignUp={startSignUp}
        onUseLocally={chooseLocalMode}
      />
    );
  }

  return (
    <AppBootstrap
      authUser={user}
      accountId={user.id}
      organizationId={organizationId}
      getAccessToken={provideAccessToken}
      onSignOut={handleSignOut}
    />
  );
}
