import type { User } from "@workos-inc/authkit-react";
import { DEV_AUTH_USER, fetchDevAccessToken, resolveDevAuthConfig } from "../auth/dev-auth";
import { getWorkOSAuthConfig } from "../auth/workos-config";
import { getWorkerBaseUrlFromEnvironment } from "../../core/state/worker-endpoints";
import { LOCAL_ACCOUNT_ID } from "./app-bootstrap";

export type WorkOSAuthConfig = NonNullable<ReturnType<typeof getWorkOSAuthConfig>>;

/**
 * The runtime mode a fresh window boots into, before any account flow runs:
 * development auth, an explicit local-only build, or an account session that
 * the browser and desktop trees each drive through their own auth surface.
 */
export type StandardBoot =
  | { kind: "config-error"; error: unknown }
  | { kind: "dev"; accountId: string; authUser: User; getAccessToken?: () => Promise<string> }
  | { kind: "local"; accountId: string }
  | { kind: "account"; workOSConfig: WorkOSAuthConfig };

export function resolveStandardBoot(): StandardBoot {
  const devAuthConfig = resolveDevAuthConfig();
  if (devAuthConfig?.status === "error") {
    return { kind: "config-error", error: devAuthConfig.error };
  }
  if (devAuthConfig?.status === "enabled") {
    const getAccessToken =
      devAuthConfig.mode === "local-worker"
        ? () => fetchDevAccessToken(devAuthConfig.workerBaseUrl)
        : undefined;
    return { kind: "dev", accountId: DEV_AUTH_USER.id, authUser: DEV_AUTH_USER, getAccessToken };
  }

  // The build-time value, not the session one: a session already running in
  // local mode must still reach the account-aware tree, which is what offers
  // the way back to sign in.
  if (!getWorkerBaseUrlFromEnvironment()) {
    return { kind: "local", accountId: LOCAL_ACCOUNT_ID };
  }
  const workOSConfig = getWorkOSAuthConfig();
  if (!workOSConfig) {
    return {
      kind: "config-error",
      error: new Error("VITE_WORKOS_CLIENT_ID is required for sign in."),
    };
  }
  return { kind: "account", workOSConfig };
}
