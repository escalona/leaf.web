import {
  LEAF_THUMBNAIL_ASSET_ID_PATTERN,
  LEAF_WORKER_ROUTES,
  buildLeafWorkerRoutePath,
  isLeafBranchDto,
  isLeafBranchSessionDto,
  isLeafFileDto,
  type LeafCollaborationRegistryRouteId,
  type LeafBranchDto,
  type LeafBranchSessionDto,
  type LeafFileDto,
  type LeafRecordSnapshot,
  type LeafWorkerRouteParameters,
} from "../shared/collaboration";
import {
  LEAF_SYNC_TOKEN_BATCH_LIMIT,
  LEAF_SYNC_TOKEN_DISPLAY_NAME_MAX_LENGTH,
} from "../shared/collaboration/worker-contract";
import { fetchWithGlobalReceiver } from "./global-fetch";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
// Branch session requests that arrive while one is already waiting share one
// request. The first request leaves at the end of the current task, so a lone
// request (an ordinary open, a token refresh) pays nothing; only a second
// request that finds it still waiting opens this window, because the callers
// that produce bursts (tab restores, cache warming) arrive across a few
// event-loop turns of IndexedDB work.
const BRANCH_SESSION_BATCH_WINDOW_MS = 10;

type PendingBranchSession = {
  branchId: string;
  fileId: string;
  reject: (error: unknown) => void;
  resolve: (session: LeafBranchSessionDto) => void;
};

export type CollaborationRegistryClientOptions = {
  fetcher?: typeof fetch;
  getAccessToken: () => Promise<string>;
  /**
   * The name presence peers see for this account. Read per request, so a
   * refreshed profile lands on the next branch session token.
   */
  getDisplayName?: () => string | null;
  requestTimeoutMs?: number;
  workerBaseUrl: string;
};

export class CollaborationRegistryRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    /** The Worker's machine-readable refusal code, when its response carried one. */
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "CollaborationRegistryRequestError";
  }
}

/**
 * The registry answered a client-id create with a file under other ids: a
 * Worker deployment that predates client-chosen ids ignored them and minted
 * its own. The file it created is carried so the caller can finish it.
 */
export class CollaborationRegistryIdMismatchError extends Error {
  constructor(readonly file: LeafFileDto) {
    super("The file registry created a file under different ids");
    this.name = "CollaborationRegistryIdMismatchError";
  }
}

export function isRetryableCollaborationRegistryError(error: unknown): boolean {
  return (
    (error instanceof CollaborationRegistryRequestError && error.retryable) ||
    error instanceof TypeError ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}

/** Authenticated client for file metadata and branch-bound session descriptors. */
export class CollaborationRegistryClient {
  private readonly fetcher: typeof fetch;
  private readonly requestTimeoutMs: number;
  // Branch session requests that arrived within the batching window and wait
  // for one `/sync-tokens` request to answer them all.
  private pendingBranchSessions: PendingBranchSession[] = [];
  private branchSessionFlush: ReturnType<typeof setTimeout> | null = null;
  private branchSessionWindowOpen = false;
  // Cleared when the Worker rejects the batch shape (a deployment that
  // predates it); every request then travels on its own.
  private branchSessionBatchingSupported = true;
  private readonly workerBaseUrl: string;

  constructor(private readonly options: CollaborationRegistryClientOptions) {
    this.fetcher = options.fetcher ?? fetchWithGlobalReceiver;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.workerBaseUrl = normalizeWorkerBaseUrl(options.workerBaseUrl);
  }

  private workspaceId: string | null = null;

  /**
   * The workspace id the registry last reported with a directory listing, so
   * a client whose directory is empty can still create its first file locally.
   */
  get lastKnownWorkspaceId() {
    return this.workspaceId;
  }

  async listFiles(): Promise<LeafFileDto[]> {
    const value = await this.request("listFiles", {});
    if (!isRecord(value) || !Array.isArray(value.files) || !value.files.every(isLeafFileDto)) {
      throw new Error("The file registry returned an invalid response");
    }
    if (typeof value.workspaceId === "string" && value.workspaceId.trim()) {
      this.workspaceId = value.workspaceId;
    }
    return value.files;
  }

  /**
   * Create a file. With `ids`, the client chooses the file and main-branch
   * ids so it can open and cache the document before this request answers;
   * the registry then creates exactly those rows or answers 409. The
   * workspace id the client cached the document under rides along so the
   * registry refuses (code `workspace_mismatch`) instead of creating the file
   * in a workspace the local cache does not name.
   */
  async createFile(
    name: string,
    ids?: { branchId: string; fileId: string; workspaceId?: string },
  ): Promise<LeafFileDto> {
    const normalizedName = name.trim();
    if (!normalizedName) throw new Error("A file name is required");
    if (ids) {
      assertStableId(ids.fileId, "file");
      assertStableId(ids.branchId, "branch");
      if (ids.workspaceId !== undefined) assertStableId(ids.workspaceId, "workspace");
    }
    const value = await this.request(
      "createFile",
      {},
      {
        body: JSON.stringify({
          name: normalizedName,
          ...(ids ? { branchId: ids.branchId, fileId: ids.fileId } : {}),
          ...(ids?.workspaceId !== undefined ? { workspaceId: ids.workspaceId } : {}),
        }),
      },
    );
    if (!isRecord(value) || !isLeafFileDto(value.file)) {
      throw new Error("The file registry returned an invalid file");
    }
    if (
      ids &&
      (value.file.fileId !== ids.fileId ||
        !value.file.branches.some((branch) => branch.branchId === ids.branchId))
    ) {
      throw new CollaborationRegistryIdMismatchError(value.file);
    }
    return value.file;
  }

  async getFile(fileId: string): Promise<LeafFileDto> {
    assertStableId(fileId, "file");
    const value = await this.request("getFile", { fileId });
    if (!isRecord(value) || !isLeafFileDto(value.file)) {
      throw new Error("The file registry returned an invalid file");
    }
    return value.file;
  }

  async renameFile(fileId: string, name: string): Promise<LeafFileDto> {
    assertStableId(fileId, "file");
    const normalizedName = name.trim();
    if (!normalizedName) throw new Error("A file name is required");
    const value = await this.request(
      "updateFile",
      { fileId },
      {
        body: JSON.stringify({ name: normalizedName }),
      },
    );
    if (!isRecord(value) || !isLeafFileDto(value.file) || value.file.fileId !== fileId) {
      throw new Error("The file registry returned an invalid file");
    }
    return value.file;
  }

  /**
   * Record a freshly uploaded dashboard thumbnail (a content-addressed
   * `sha256:` shared-asset id) against the file, or clear it with null (e.g.
   * after the document was emptied). Rides the file PATCH route; deliberately
   * does not touch the name.
   */
  async setFileThumbnail(fileId: string, thumbnailAssetId: string | null): Promise<LeafFileDto> {
    assertStableId(fileId, "file");
    if (thumbnailAssetId !== null && !LEAF_THUMBNAIL_ASSET_ID_PATTERN.test(thumbnailAssetId)) {
      throw new Error("The thumbnail asset id is invalid");
    }
    const value = await this.request(
      "updateFile",
      { fileId },
      {
        body: JSON.stringify({ thumbnailAssetId }),
      },
    );
    if (!isRecord(value) || !isLeafFileDto(value.file) || value.file.fileId !== fileId) {
      throw new Error("The file registry returned an invalid file");
    }
    return value.file;
  }

  async listBranches(fileId: string): Promise<LeafBranchDto[]> {
    assertStableId(fileId, "file");
    const value = await this.request("listBranches", { fileId });
    if (
      !isRecord(value) ||
      !Array.isArray(value.branches) ||
      !value.branches.every(isLeafBranchDto) ||
      value.branches.some((branch) => branch.fileId !== fileId)
    ) {
      throw new Error("The file registry returned invalid branches");
    }
    return value.branches;
  }

  /**
   * Initialize a main branch with its starter snapshot. `streamEpoch` asks a
   * fresh room to start on that epoch, so a client that already cached the
   * starter under it can resume with a hot tail instead of a snapshot swap;
   * a room that already exists keeps its own epoch, which the result reports.
   */
  async initializeBranch(
    fileId: string,
    branchId: string,
    snapshot: LeafRecordSnapshot,
    initializationId: string,
    streamEpoch?: string,
  ): Promise<{ revision: number; streamEpoch: string }> {
    assertStableId(fileId, "file");
    assertStableId(branchId, "branch");
    assertStableId(initializationId, "initialization");
    if (streamEpoch !== undefined) assertStableId(streamEpoch, "stream epoch");
    const value = await this.request(
      "initializeBranch",
      { branchId, fileId },
      {
        body: JSON.stringify({
          initializationId,
          snapshot,
          ...(streamEpoch === undefined ? {} : { streamEpoch }),
        }),
      },
    );
    if (
      !isRecord(value) ||
      value.fileId !== fileId ||
      value.branchId !== branchId ||
      !Number.isSafeInteger(value.revision) ||
      (value.revision as number) < 0 ||
      typeof value.streamEpoch !== "string" ||
      !value.streamEpoch
    ) {
      throw new Error("The collaboration service returned an invalid branch initialization");
    }
    return { revision: value.revision as number, streamEpoch: value.streamEpoch };
  }

  /**
   * A branch session descriptor. Requests that arrive together (a launch
   * restoring its tabs, the dashboard warming recent files) travel as one
   * batch request, which the Worker answers with a single database read; a
   * lone request goes out on its own, at the end of the task that made it.
   */
  issueBranchSession(fileId: string, branchId: string): Promise<LeafBranchSessionDto> {
    assertStableId(fileId, "file");
    assertStableId(branchId, "branch");
    return new Promise((resolve, reject) => {
      this.pendingBranchSessions.push({ branchId, fileId, reject, resolve });
      if (this.branchSessionFlush === null) {
        this.branchSessionFlush = setTimeout(() => void this.flushBranchSessions(), 0);
      } else if (!this.branchSessionWindowOpen) {
        clearTimeout(this.branchSessionFlush);
        this.branchSessionWindowOpen = true;
        this.branchSessionFlush = setTimeout(
          () => void this.flushBranchSessions(),
          BRANCH_SESSION_BATCH_WINDOW_MS,
        );
      }
    });
  }

  private async flushBranchSessions() {
    this.branchSessionFlush = null;
    this.branchSessionWindowOpen = false;
    const batch = this.pendingBranchSessions.splice(0, LEAF_SYNC_TOKEN_BATCH_LIMIT);
    if (this.pendingBranchSessions.length > 0) {
      this.branchSessionFlush = setTimeout(() => void this.flushBranchSessions(), 0);
    }
    if (batch.length === 0) return;
    if (batch.length === 1 || !this.branchSessionBatchingSupported) {
      await Promise.all(batch.map((pending) => this.settleBranchSession(pending)));
      return;
    }
    let value: unknown;
    try {
      value = await this.request(
        "issueBranchSession",
        {},
        {
          body: JSON.stringify({
            branches: batch.map(({ branchId, fileId }) => ({ branchId, fileId })),
            ...this.branchSessionDisplayNameField(),
          }),
        },
      );
    } catch (error) {
      if (!(error instanceof CollaborationRegistryRequestError) || error.status !== 400) {
        for (const pending of batch) pending.reject(error);
        return;
      }
      // A Worker that predates the batch shape strips `branches` and answers
      // 400, and so does a batch carrying a malformed id. Each request then
      // travels on its own; when every one of them is accepted, the shape was
      // the problem and this client stops batching against that Worker.
      const refusals = await Promise.all(batch.map((pending) => this.settleBranchSession(pending)));
      if (
        !refusals.some(
          (refusal) =>
            refusal instanceof CollaborationRegistryRequestError && refusal.status === 400,
        )
      ) {
        this.branchSessionBatchingSupported = false;
      }
      return;
    }
    const sessions = isRecord(value) && Array.isArray(value.sessions) ? value.sessions : null;
    if (!sessions || sessions.length !== batch.length) {
      const error = new Error("The collaboration service returned an invalid branch session batch");
      for (const pending of batch) pending.reject(error);
      return;
    }
    batch.forEach((pending, index) => {
      const entry: unknown = sessions[index];
      if (isRecord(entry) && isRecord(entry.error)) {
        const status = typeof entry.error.status === "number" ? entry.error.status : 403;
        pending.reject(
          new CollaborationRegistryRequestError(
            typeof entry.error.message === "string"
              ? entry.error.message
              : "The collaboration service refused this branch session",
            status,
            status >= 500,
            typeof entry.error.code === "string" ? entry.error.code : null,
          ),
        );
        return;
      }
      if (
        !isLeafBranchSessionDto(entry) ||
        entry.fileId !== pending.fileId ||
        entry.branchId !== pending.branchId
      ) {
        pending.reject(
          new Error("The collaboration service returned a session for another branch"),
        );
        return;
      }
      pending.resolve(entry);
    });
  }

  /** Answers one pending request on its own; returns the error it was refused with, if any. */
  private async settleBranchSession(pending: PendingBranchSession): Promise<unknown> {
    try {
      pending.resolve(await this.requestBranchSession(pending.fileId, pending.branchId));
      return null;
    } catch (error) {
      pending.reject(error);
      return error;
    }
  }

  private async requestBranchSession(
    fileId: string,
    branchId: string,
  ): Promise<LeafBranchSessionDto> {
    const value = await this.request(
      "issueBranchSession",
      {},
      {
        body: JSON.stringify({ fileId, branchId, ...this.branchSessionDisplayNameField() }),
      },
    );
    if (!isLeafBranchSessionDto(value)) {
      throw new Error("The collaboration service returned an invalid branch session");
    }
    if (value.fileId !== fileId || value.branchId !== branchId) {
      throw new Error("The collaboration service returned a session for another branch");
    }
    return value;
  }

  /**
   * The display name to bind into the next branch session, when the app knows
   * one. An older Worker strips the unknown field, so sending it is safe.
   */
  private branchSessionDisplayNameField(): { displayName?: string } {
    const displayName = this.options.getDisplayName?.()?.trim() ?? "";
    if (!displayName) return {};
    return { displayName: displayName.slice(0, LEAF_SYNC_TOKEN_DISPLAY_NAME_MAX_LENGTH) };
  }

  createSyncUrlProvider(fileId: string, branchId: string) {
    return async () => (await this.issueBranchSession(fileId, branchId)).syncServerUrl;
  }

  private async request<RouteId extends LeafCollaborationRegistryRouteId>(
    routeId: RouteId,
    parameters: LeafWorkerRouteParameters<RouteId>,
    init: Omit<RequestInit, "method"> = {},
    query?: URLSearchParams,
  ): Promise<unknown> {
    const accessToken = (await this.options.getAccessToken()).trim();
    if (!accessToken) throw new Error("An access token is required");
    const route = LEAF_WORKER_ROUTES[routeId];
    const queryString = query?.toString();
    const path = `${buildLeafWorkerRoutePath(routeId, parameters)}${
      queryString ? `?${queryString}` : ""
    }`;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), this.requestTimeoutMs);
    try {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${accessToken}`);
      if (init.body !== undefined) headers.set("Content-Type", "application/json");
      const response = await this.fetcher(`${this.workerBaseUrl}${path}`, {
        ...init,
        headers,
        method: route.method,
        signal: abort.signal,
      });
      const value = await readJson(response);
      if (!response.ok) {
        const message =
          isRecord(value) && typeof value.error === "string"
            ? value.error
            : `Collaboration request failed (${response.status})`;
        throw new CollaborationRegistryRequestError(
          message,
          response.status,
          isRecord(value) && value.retryable === true,
          isRecord(value) && typeof value.code === "string" ? value.code : null,
        );
      }
      return value;
    } catch (error) {
      if (error instanceof CollaborationRegistryRequestError) throw error;
      if (abort.signal.aborted) {
        throw new CollaborationRegistryRequestError("Collaboration request timed out", 0, true);
      }
      if (
        error instanceof TypeError ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        throw new CollaborationRegistryRequestError(
          error instanceof Error ? error.message : "Collaboration service is unavailable",
          0,
          true,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new Error("The collaboration service returned invalid JSON", { cause: error });
  }
}

function normalizeWorkerBaseUrl(value: string) {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!normalized) throw new Error("A collaboration Worker URL is required");
  const url = new URL(normalized);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The collaboration Worker URL must use HTTP or HTTPS");
  }
  return url.toString().replace(/\/+$/, "");
}

function assertStableId(value: string, kind: string) {
  if (!value.trim() || value.includes("/") || value.length > 256) {
    throw new Error(`The ${kind} id is invalid`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
