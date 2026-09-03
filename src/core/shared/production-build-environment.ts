/**
 * Refuses production builds that would bake development-only frontend
 * configuration into the bundle. `VITE_*` values are substituted at build
 * time, so a loopback Worker URL or the development auth mode left behind in a
 * local `.env` ships inside the packaged app and points it at nothing.
 */
import { isLoopbackHostname } from "./loopback-hostname.ts";

export function assertProductionBuildEnvironment(env: Record<string, string | undefined>) {
  if (env.VITE_AUTH_MODE?.trim().toLowerCase() === "dev") {
    throw new Error(
      "VITE_AUTH_MODE=dev is a development-only setting and cannot be built into a production bundle. Unset it (check .env) before building.",
    );
  }

  const workerBaseUrl = env.VITE_WORKER_BASE_URL?.trim();
  if (!workerBaseUrl || workerBaseUrl.toLowerCase() === "off") return;

  let hostname: string;
  try {
    hostname = new URL(workerBaseUrl).hostname;
  } catch {
    throw new Error(`VITE_WORKER_BASE_URL is not a valid URL: ${workerBaseUrl}`);
  }
  if (isLoopbackHostname(hostname)) {
    throw new Error(
      `VITE_WORKER_BASE_URL=${workerBaseUrl} points at a loopback Worker, which a production build would bake into the bundle. Unset it to use the hosted default (check .env), set the hosted Worker origin, or set it to "off" for a local-only build.`,
    );
  }
}
