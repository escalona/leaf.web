import { isLoopbackHostname } from "../../core/shared/loopback-hostname";

export { isLoopbackHostname };

export type WorkOSAuthConfig = {
  /** A WorkOS custom authentication domain (`auth.<app domain>`), when one is configured. */
  apiHostname?: string;
  clientId: string;
  devMode: boolean;
  redirectUri: string;
};

export function getWorkOSAuthConfig(
  location: Location = window.location,
  isDev = import.meta.env.DEV,
): WorkOSAuthConfig | null {
  const clientId = normalizeEnvValue(import.meta.env.VITE_WORKOS_CLIENT_ID);
  if (!clientId) return null;
  const apiHostname = normalizeEnvValue(import.meta.env.VITE_WORKOS_API_HOSTNAME);

  return {
    ...(apiHostname ? { apiHostname } : {}),
    clientId,
    // AuthKit's cookie mode keeps the session in an HttpOnly cookie on the
    // API host. That is a third-party cookie unless the host is a custom
    // authentication domain under the app's own domain, and a reload then
    // finds no session. Until one is configured, WorkOS documents dev mode
    // (the refresh token in browser storage) as the supported setup; a
    // loopback origin uses dev mode regardless.
    devMode:
      !apiHostname || isLocalDevelopmentLocation(location, isDev) || isLoopbackLocation(location),
    redirectUri: `${location.origin}/callback`,
  };
}

/**
 * Where a sign-in started from this page should land afterwards. The callback
 * route is where sign-in arrives, never where it returns to: a sign-in
 * started from it (after an earlier attempt failed there) goes home.
 */
export function getAuthReturnTo(location: Location = window.location) {
  if (isCallbackPath(location.pathname)) return "/";
  return `${location.pathname}${location.search}${location.hash}`;
}

export function readSafeAuthReturnTo(state: unknown) {
  if (!state || typeof state !== "object") return null;

  const returnTo = (state as { returnTo?: unknown }).returnTo;
  if (typeof returnTo !== "string") return null;
  if (!returnTo.startsWith("/") || returnTo.startsWith("//")) return null;
  if (isCallbackPath(returnTo)) return "/";

  return returnTo;
}

function isCallbackPath(path: string) {
  const pathname = path.split(/[?#]/, 1)[0]!;
  return pathname === "/callback" || pathname.startsWith("/callback/");
}

function normalizeEnvValue(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isLocalDevelopmentLocation(location: Location, isDev: boolean) {
  return isDev && isLoopbackLocation(location);
}

function isLoopbackLocation(location: Location) {
  return isLoopbackHostname(location.hostname);
}
