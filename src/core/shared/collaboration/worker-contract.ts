/**
 * Shared HTTP contract for the collaboration Worker.
 *
 * Route patterns, methods, authentication boundaries, and CORS capabilities live
 * here so the browser client and Worker registration cannot independently invent
 * their own copies.
 */

/**
 * Branch sessions per `POST /sync-tokens` batch request. A launch restoring
 * several tabs, or the dashboard warming recent files, asks for all of its
 * descriptors in one request so the Worker answers them with one D1 read.
 */
export const LEAF_SYNC_TOKEN_BATCH_LIMIT = 32;
/**
 * Longest `displayName` a `/sync-tokens` request may bind into a branch
 * session. The Worker signs it into the token and labels the client's presence
 * cursor with it; it is cosmetic and client-asserted.
 */
export const LEAF_SYNC_TOKEN_DISPLAY_NAME_MAX_LENGTH = 120;

export const LEAF_WORKER_CORS_CONTRACT = {
  localDev: {
    mountPath: "/__dev/*",
    allowHeaders: ["Content-Type"],
    allowMethods: ["GET", "OPTIONS"],
  },
  auth: {
    mountPath: "/auth/*",
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "OPTIONS"],
  },
  files: {
    mountPath: "/files/*",
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "OPTIONS"],
    // Retain the established preflight surface even without a current terminal PUT route.
    compatibilityMethods: ["PUT"],
  },
  syncTokens: {
    mountPath: "/sync-tokens",
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["POST", "OPTIONS"],
  },
  sync: {
    mountPath: "/sync/*",
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "OPTIONS", "POST"],
    // Retain the established preflight surface while current sync clients use GET/WebSocket.
    compatibilityMethods: ["POST"],
  },
  presence: {
    mountPath: "/presence/*",
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "OPTIONS"],
  },
  assets: {
    mountPath: "/assets/*",
    allowHeaders: ["Content-Type", "If-None-Match", "X-Leaf-Asset-Key", "X-Leaf-Asset-Kind"],
    allowMethods: ["GET", "HEAD", "OPTIONS", "PUT"],
  },
  images: {
    mountPath: "/images/*",
    allowHeaders: ["Content-Type", "X-Leaf-Image-Generation-Key"],
    allowMethods: ["POST", "OPTIONS"],
  },
} as const;

export type LeafWorkerCorsGroup = keyof typeof LEAF_WORKER_CORS_CONTRACT;
export type LeafWorkerRouteMethod = "ALL" | "GET" | "HEAD" | "PATCH" | "POST" | "PUT";
export type LeafWorkerRouteAuth =
  | "public"
  | "loopback-dev"
  | "access-token"
  | "branch-token"
  | "method-dependent"
  | "optional-shared-key"
  | "required-shared-key";

type LeafWorkerConcreteRouteAuth = Exclude<LeafWorkerRouteAuth, "method-dependent">;

type LeafWorkerRouteContractBase = {
  /** Concrete client/CORS methods for an intentionally compatibility-preserving ALL registration. */
  acceptedMethods?: readonly Exclude<LeafWorkerRouteMethod, "ALL">[];
  cors: LeafWorkerCorsGroup | null;
  method: LeafWorkerRouteMethod;
  path: string;
};

type LeafWorkerRouteContract = LeafWorkerRouteContractBase &
  (
    | {
        auth: "method-dependent";
        authByMethod: Readonly<
          Partial<Record<Exclude<LeafWorkerRouteMethod, "ALL">, LeafWorkerConcreteRouteAuth>>
        >;
      }
    | {
        auth: LeafWorkerConcreteRouteAuth;
        authByMethod?: never;
      }
  );

export const LEAF_WORKER_ROUTES = {
  health: {
    auth: "public",
    cors: null,
    method: "ALL",
    path: "/health",
  },
  localDevSession: {
    auth: "loopback-dev",
    cors: "localDev",
    method: "GET",
    path: "/__dev/session/agent",
  },
  localDevPreflight: {
    auth: "loopback-dev",
    cors: "localDev",
    method: "GET",
    path: "/__dev/preflight",
  },
  authMe: {
    auth: "access-token",
    cors: "auth",
    method: "GET",
    path: "/auth/me",
  },
  createFile: {
    auth: "access-token",
    cors: "files",
    method: "POST",
    path: "/files",
  },
  listFiles: {
    auth: "access-token",
    cors: "files",
    method: "GET",
    path: "/files",
  },
  getFile: {
    auth: "access-token",
    cors: "files",
    method: "GET",
    path: "/files/:fileId",
  },
  updateFile: {
    auth: "access-token",
    cors: "files",
    method: "PATCH",
    path: "/files/:fileId",
  },
  listBranches: {
    auth: "access-token",
    cors: "files",
    method: "GET",
    path: "/files/:fileId/branches",
  },
  getBranch: {
    auth: "access-token",
    cors: "files",
    method: "GET",
    path: "/files/:fileId/branches/:branchId",
  },
  initializeBranch: {
    auth: "access-token",
    cors: "files",
    method: "POST",
    path: "/files/:fileId/branches/:branchId/initialize",
  },
  publishCheckpoint: {
    auth: "access-token",
    cors: "files",
    method: "POST",
    path: "/files/:fileId/branches/:branchId/checkpoints",
  },
  getCheckpointManifest: {
    auth: "access-token",
    cors: "files",
    method: "GET",
    path: "/files/:fileId/branches/:branchId/checkpoints/:checkpointId/manifest",
  },
  getCheckpointChunk: {
    auth: "access-token",
    cors: "files",
    method: "GET",
    path: "/files/:fileId/branches/:branchId/checkpoint-chunks/:chunkHash",
  },
  issueBranchSession: {
    auth: "access-token",
    cors: "syncTokens",
    method: "POST",
    path: "/sync-tokens",
  },
  branchBootstrap: {
    auth: "branch-token",
    cors: "sync",
    method: "GET",
    path: "/sync/:branchId/bootstrap",
  },
  documentSocket: {
    acceptedMethods: ["GET"],
    auth: "branch-token",
    cors: "sync",
    method: "ALL",
    path: "/sync/:branchId",
  },
  presenceSocket: {
    acceptedMethods: ["GET"],
    auth: "branch-token",
    cors: "presence",
    method: "ALL",
    path: "/presence/:branchId",
  },
  assets: {
    acceptedMethods: ["GET", "HEAD", "PUT"],
    auth: "method-dependent",
    authByMethod: {
      GET: "public",
      HEAD: "public",
      PUT: "required-shared-key",
    },
    cors: "assets",
    method: "ALL",
    path: "/assets/*",
  },
  createImage: {
    auth: "optional-shared-key",
    cors: "images",
    method: "POST",
    path: "/images/generations",
  },
  editImage: {
    auth: "optional-shared-key",
    cors: "images",
    method: "POST",
    path: "/images/edits",
  },
} as const satisfies Record<string, LeafWorkerRouteContract>;

export type LeafWorkerRouteId = keyof typeof LEAF_WORKER_ROUTES;

export const LEAF_COLLABORATION_REGISTRY_ROUTE_IDS = [
  "listFiles",
  "createFile",
  "getFile",
  "updateFile",
  "listBranches",
  "initializeBranch",
  "issueBranchSession",
] as const satisfies readonly LeafWorkerRouteId[];

export type LeafCollaborationRegistryRouteId =
  (typeof LEAF_COLLABORATION_REGISTRY_ROUTE_IDS)[number];

type RouteParameterNames<Path extends string> =
  Path extends `${string}:${infer Parameter}/${infer Rest}`
    ? Parameter | RouteParameterNames<`/${Rest}`>
    : Path extends `${string}:${infer Parameter}`
      ? Parameter
      : never;

export type LeafWorkerRouteParameters<RouteId extends LeafWorkerRouteId> = {
  [Parameter in RouteParameterNames<(typeof LEAF_WORKER_ROUTES)[RouteId]["path"]>]: number | string;
};

export function buildLeafWorkerRoutePath<RouteId extends LeafWorkerRouteId>(
  routeId: RouteId,
  parameters: LeafWorkerRouteParameters<RouteId>,
) {
  const route = LEAF_WORKER_ROUTES[routeId];
  return route.path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (_match, parameter: string) => {
    const value = (parameters as Record<string, number | string>)[parameter];
    if (value === undefined) {
      throw new Error(`Missing Worker route parameter: ${parameter}`);
    }
    return encodeURIComponent(String(value));
  });
}
