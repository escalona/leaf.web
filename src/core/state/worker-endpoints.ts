export const DEFAULT_WORKER_BASE_URL = "https://sync.leafnode.app";
const DISABLED_WORKER_BASE_URL_VALUE = "off";

/**
 * Local mode promises that nothing leaves the device, and that promise has to
 * hold for every Worker consumer — image asset uploads and the AI routes as
 * much as the collaboration runtime. Rather than teach each consumer about the
 * mode, a renderer session that boots into local mode suppresses the origin
 * here, at the one place they all read it. `src/AppBoot.tsx` declares it on
 * every runtime construction, so entering the network runtime after sign in
 * restores the configured origin.
 */
let localModeSuppression = false;

export function setWorkerSuppressedForLocalMode(suppressed: boolean) {
  localModeSuppression = suppressed;
}

/** The Worker origin this renderer session may talk to, or null when it may not. */
export function getConfiguredWorkerBaseUrl() {
  return localModeSuppression ? null : getWorkerBaseUrlFromEnvironment();
}

/**
 * The build-time configuration alone. Boot routing asks this instead of
 * `getConfiguredWorkerBaseUrl` because "this build has no Worker" and "this
 * session declined to use one" lead to different screens.
 */
export function getWorkerBaseUrlFromEnvironment() {
  return isWorkerBaseUrlDisabled()
    ? null
    : (normalizeBaseUrl(import.meta.env.VITE_WORKER_BASE_URL) ?? DEFAULT_WORKER_BASE_URL);
}

function isWorkerBaseUrlDisabled() {
  const value = import.meta.env.VITE_WORKER_BASE_URL?.trim().toLowerCase();
  return value === DISABLED_WORKER_BASE_URL_VALUE;
}

export function buildWorkerUrl(path: string) {
  const baseUrl = getConfiguredWorkerBaseUrl();
  if (!baseUrl) return path;
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

function normalizeBaseUrl(value: string | undefined) {
  const trimmed = value?.trim();
  if (trimmed?.toLowerCase() === DISABLED_WORKER_BASE_URL_VALUE) return null;
  return trimmed ? trimmed.replace(/\/+$/, "") : null;
}
