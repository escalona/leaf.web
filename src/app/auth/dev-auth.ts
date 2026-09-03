import type { User } from "@workos-inc/authkit-react";
import {
  LEAF_WORKER_ROUTES,
  buildLeafWorkerRoutePath,
} from "../../core/shared/collaboration/worker-contract";
import { isLoopbackHostname } from "./workos-config";

export const DEV_AUTH_USER: User = Object.freeze({
  object: "user",
  id: "leaf-agent",
  email: "agent@leaf.local",
  emailVerified: true,
  profilePictureUrl: null,
  firstName: null,
  lastName: null,
  lastSignInAt: null,
  externalId: undefined,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

export const DEV_AUTH_ROOT_DOCUMENT_STORAGE_SCOPE = "user:leaf-agent";

export type DevAuthConfig =
  | { status: "error"; error: Error }
  | { status: "enabled"; mode: "local-only" }
  | { status: "enabled"; mode: "local-worker"; workerBaseUrl: string };

type DevAuthConfigInputs = {
  location?: Pick<Location, "hostname">;
  isDev?: boolean;
  authMode?: string;
  workerBaseUrl?: string;
};

export function resolveDevAuthConfig(inputs: DevAuthConfigInputs = {}): DevAuthConfig | null {
  const authMode = (inputs.authMode ?? import.meta.env.VITE_AUTH_MODE)?.trim().toLowerCase();
  if (authMode !== "dev") return null;

  const isDev = inputs.isDev ?? import.meta.env.DEV;
  const location = inputs.location ?? window.location;
  if (!isDev) {
    return devAuthError("VITE_AUTH_MODE=dev is only allowed in a development build.");
  }
  if (!isLoopbackHostname(location.hostname)) {
    return devAuthError("VITE_AUTH_MODE=dev is only allowed on a loopback hostname.");
  }

  const configuredWorker =
    "workerBaseUrl" in inputs ? inputs.workerBaseUrl : import.meta.env.VITE_WORKER_BASE_URL;
  const workerValue = configuredWorker?.trim();
  if (!workerValue) {
    return devAuthError(
      "VITE_WORKER_BASE_URL must be 'off' or an explicit loopback URL when using development auth.",
    );
  }
  if (workerValue.toLowerCase() === "off") {
    return { status: "enabled", mode: "local-only" };
  }

  let workerUrl: URL;
  try {
    workerUrl = new URL(workerValue);
  } catch {
    return devAuthError("VITE_WORKER_BASE_URL is not a valid URL.");
  }
  if (
    (workerUrl.protocol !== "http:" && workerUrl.protocol !== "https:") ||
    !isLoopbackHostname(workerUrl.hostname)
  ) {
    return devAuthError("Development auth requires an HTTP(S) loopback Worker URL.");
  }

  return {
    status: "enabled",
    mode: "local-worker",
    workerBaseUrl: workerUrl.href.replace(/\/+$/, ""),
  };
}

export async function fetchDevAccessToken(
  workerBaseUrl: string,
  fetchImplementation: typeof fetch = fetch,
) {
  const endpoint = `${workerBaseUrl.replace(/\/+$/, "")}${buildLeafWorkerRoutePath(
    "localDevSession",
    {},
  )}`;
  const response = await fetchImplementation(endpoint, {
    method: LEAF_WORKER_ROUTES.localDevSession.method,
  });
  if (!response.ok) {
    throw new Error(`Development session request failed with status ${response.status}.`);
  }

  const body: unknown = await response.json();
  const accessToken =
    body && typeof body === "object" && "accessToken" in body
      ? (body as { accessToken?: unknown }).accessToken
      : undefined;
  if (typeof accessToken !== "string" || !accessToken.trim()) {
    throw new Error("Development session response did not include an access token.");
  }
  return accessToken;
}

function devAuthError(message: string): DevAuthConfig {
  return { status: "error", error: new Error(message) };
}
