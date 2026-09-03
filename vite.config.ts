import tailwindcss from "@tailwindcss/vite";
import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { loadEnv } from "vite";
import { isLoopbackHostname } from "./src/core/shared/loopback-hostname.ts";
import { assertProductionBuildEnvironment } from "./src/core/shared/production-build-environment.ts";

const TEST_MAX_WORKERS = Math.max(1, Math.floor(availableParallelism() * 0.75));

function createContentSecurityPolicy(isDev: boolean) {
  const scriptSources = ["'self'", "leaf-script:"];
  if (isDev) scriptSources.push("'unsafe-inline'");

  const imageSources = ["'self'", "data:", "blob:", "https:", "leaf-script:"];
  const connectSources = ["'self'", "https:", "wss:", "leaf-script:"];

  if (isDev) {
    imageSources.push("http://localhost:*", "http://127.0.0.1:*");
    connectSources.push(
      "http://localhost:*",
      "http://127.0.0.1:*",
      "ws://localhost:*",
      "ws://127.0.0.1:*",
    );
  }

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    `script-src ${scriptSources.join(" ")}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    `img-src ${imageSources.join(" ")}`,
    `connect-src ${connectSources.join(" ")}`,
    "worker-src 'self' blob:",
  ].join("; ");
}

function getAgentPreflight() {
  const authMode = process.env.VITE_AUTH_MODE?.trim().toLowerCase();
  const workerBaseUrl = process.env.VITE_WORKER_BASE_URL?.trim();
  let error: string | null = null;

  if (authMode !== "dev") {
    error = "VITE_AUTH_MODE is not set to dev.";
  } else if (!workerBaseUrl) {
    error = "VITE_WORKER_BASE_URL is not configured.";
  } else if (workerBaseUrl.toLowerCase() !== "off") {
    try {
      const workerUrl = new URL(workerBaseUrl);
      if (
        !isLoopbackHostname(workerUrl.hostname) ||
        (workerUrl.protocol !== "http:" && workerUrl.protocol !== "https:")
      ) {
        error = "Development auth requires a loopback Worker URL.";
      }
    } catch {
      error = "VITE_WORKER_BASE_URL is invalid.";
    }
  }

  return {
    ready: error === null,
    authMode: authMode ?? null,
    error,
    user: "agent@leaf.local",
    workerBaseUrl: workerBaseUrl ?? null,
  };
}

function isLoopbackRequestHost(host: string | undefined) {
  if (!host) return false;
  try {
    return isLoopbackHostname(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

export default defineConfig(({ command, mode }) => {
  if (command === "build") {
    // A build substitutes `VITE_*` values into the bundle, so a loopback Worker
    // URL or development auth left in a local `.env` would ship inside the
    // packaged app. Refuse that here rather than discovering it in a DMG.
    assertProductionBuildEnvironment(loadEnv(mode, process.cwd(), "VITE_"));
    // Vite honours an inherited NODE_ENV, and a shell that exports
    // NODE_ENV=development turns every production build into React's
    // development build: dev-only JSX runtime, StrictMode double effects, and
    // the validation overhead on every render. A build is production.
    if (mode === "production" && process.env.NODE_ENV !== "production") {
      console.warn(
        `[leaf] NODE_ENV=${process.env.NODE_ENV ?? ""} inherited from the environment; building with NODE_ENV=production.`,
      );
      process.env.NODE_ENV = "production";
    }
  }

  return config;
});

const config = defineConfig({
  base: "./",
  build: {
    rolldownOptions: {
      // The desktop shell boots from its own entry so the browser bundle never
      // imports src/desktop. One build serves both the web deploy and the
      // desktop package (`pnpm release`), so both entries are always built;
      // `public/.assetsignore` keeps the desktop entry off the web deploy.
      // The public export ships without the desktop shell, so the desktop
      // entry is included only when its HTML is present.
      input: existsSync("desktop.html")
        ? { index: "index.html", desktop: "desktop.html" }
        : { index: "index.html" },
    },
  },
  // WebMCP requires an origin-keyed document. Make that explicit in local
  // development and preview so registration cannot inherit a site-keyed
  // agent cluster from an older tab.
  server: { headers: { "Origin-Agent-Cluster": "?1" } },
  preview: { headers: { "Origin-Agent-Cluster": "?1" } },
  plugins: [
    tailwindcss(),
    react(),
    {
      name: "leaf-content-security-policy",
      transformIndexHtml(_html, context) {
        return [
          {
            tag: "meta",
            attrs: {
              "http-equiv": "Content-Security-Policy",
              content: createContentSecurityPolicy(Boolean(context.server)),
            },
            injectTo: "head-prepend",
          },
        ];
      },
    },
    {
      name: "leaf-agent-preflight",
      configureServer(server) {
        server.middlewares.use("/__dev/preflight", (request, response, next) => {
          if (request.method !== "GET") {
            next();
            return;
          }
          if (
            process.env.VITE_AUTH_MODE?.trim().toLowerCase() !== "dev" ||
            !isLoopbackRequestHost(request.headers.host)
          ) {
            response.statusCode = 404;
            response.end("Not found.");
            return;
          }
          response.statusCode = 200;
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify(getAgentPreflight()));
        });
      },
    },
  ],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // Agent worktrees under .claude/ and .delta/ carry full repo copies; without the
    // exclusion their stale suites (including worker tests that need their
    // own harness) leak into every root run.
    exclude: [...configDefaults.exclude, "worker/**/*.test.ts", ".claude/**", ".delta/**"],
    // Test files run in isolated fork workers. Parallelize the hundreds of
    // independent environments while leaving at least one processor free on
    // multi-core hosts for CPU-heavy document suites and the operating system.
    maxWorkers: TEST_MAX_WORKERS,
  },
});
