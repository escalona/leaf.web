import {
  LEAF_RECORD_SCHEMA_VERSION,
  LeafRecordDirectory,
  resolveLeafCheckpointShardClosure,
  type LeafCheckpointDirectoryPayload,
  type LeafCheckpointManifest,
  type LeafCheckpointReference,
  type LeafCommentRecord,
  type LeafNodeRecord,
  type LeafPageRecord,
  type LeafRoomIdentity,
} from "../shared/collaboration";
import {
  fetchAndDecodeLeafCheckpointDirectory,
  fetchAndDecodeLeafCheckpointShards,
  type LeafCheckpointDirectoryLoadResult,
  type LeafCheckpointLoadRequest,
  type LeafCheckpointLoadResult,
  type LeafCheckpointShardLoadRequest,
  type LeafCheckpointShardLoadResult,
  type LeafCheckpointWorkerOperation,
  type LeafCheckpointWorkerResult,
} from "./collaboration-checkpoint-codec";
import { fetchWithGlobalReceiver } from "./global-fetch";

type CheckpointWorkerResponse =
  | { id: string; ok: true; result: LeafCheckpointWorkerResult }
  | { id: string; ok: false; error: string };

type CheckpointWorker = Pick<Worker, "addEventListener" | "postMessage" | "terminate">;

export type CollaborationCheckpointClientOptions = {
  fetcher?: typeof fetch;
  getAccessToken: () => Promise<string>;
  workerBaseUrl: string;
  workerFactory?: (() => CheckpointWorker) | null;
};

export type CollaborationCheckpointDetailResult = {
  requestedShardIds: string[];
  resolvedShardIds: string[];
  records: LeafNodeRecord[];
};

export class LoadedCollaborationCheckpoint {
  readonly directory: LeafRecordDirectory;
  readonly format = "sharded" as const;
  readonly manifest: LeafCheckpointManifest;
  /** Document page list, carried by the directory chunk rather than by shards. */
  readonly pages: LeafPageRecord[];
  /** Comment lane, also carried by the directory chunk. Empty on pre-v3 checkpoints. */
  readonly comments: LeafCommentRecord[];
  readonly shardIds: string[];
  private readonly recordsByShard = new Map<string, LeafNodeRecord[]>();

  constructor(
    result: LeafCheckpointDirectoryLoadResult,
    private readonly loadMissing: (
      requestedShardIds: string[],
      skipShardIds: string[],
      signal?: AbortSignal,
    ) => Promise<LeafCheckpointShardLoadResult>,
  ) {
    this.manifest = structuredClone(result.manifest);
    this.directory = new LeafRecordDirectory(result.headers);
    this.shardIds = result.shardDirectory.shards.map((shard) => shard.shardId);
    this.shardDirectory = structuredClone(result.shardDirectory);
    this.pages = this.shardDirectory.pages;
    this.comments = this.shardDirectory.comments ?? [];
  }

  private readonly shardDirectory: LeafCheckpointDirectoryPayload;

  get loadedShardIds() {
    return [...this.recordsByShard.keys()];
  }

  async loadShards(
    requestedShardIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<CollaborationCheckpointDetailResult> {
    throwIfAborted(signal);
    const requested = [...new Set(requestedShardIds)];
    const shardDirectory = this.shardDirectory;
    const resolved = resolveLeafCheckpointShardClosure(shardDirectory, requested);
    const skip = resolved.filter((shardId) => this.recordsByShard.has(shardId));
    if (skip.length !== resolved.length) {
      const loaded = await this.loadMissing(requested, skip, signal);
      for (const shard of loaded.shards) {
        this.recordsByShard.set(shard.shardId, structuredClone(shard.records));
      }
    }
    throwIfAborted(signal);
    return {
      requestedShardIds: requested,
      resolvedShardIds: resolved,
      records: resolved.flatMap((shardId) =>
        structuredClone(this.recordsByShard.get(shardId) ?? []),
      ),
    };
  }
}

/** Authenticated checkpoint loader whose production fetch/decode path uses a Web Worker. */
export class CollaborationCheckpointClient {
  private readonly fetcher: typeof fetch;
  private readonly workerBaseUrl: string;
  private readonly workerFactory: (() => CheckpointWorker) | null;

  constructor(private readonly options: CollaborationCheckpointClientOptions) {
    this.fetcher = options.fetcher ?? fetchWithGlobalReceiver;
    this.workerBaseUrl = normalizeWorkerBaseUrl(options.workerBaseUrl);
    this.workerFactory =
      options.workerFactory === undefined
        ? typeof Worker === "undefined"
          ? null
          : () =>
              new Worker(new URL("./collaboration-checkpoint-worker.ts", import.meta.url), {
                type: "module",
              })
        : options.workerFactory;
  }

  async loadDirectory(
    identity: LeafRoomIdentity,
    reference: LeafCheckpointReference,
    signal?: AbortSignal,
  ) {
    const request = await this.createLoadRequest(identity, reference, signal);
    const result = this.workerFactory
      ? await this.runInWorker<LeafCheckpointDirectoryLoadResult>(
          { type: "directory", request },
          signal,
        )
      : await fetchAndDecodeLeafCheckpointDirectory(request, this.fetcher, signal);
    return new LoadedCollaborationCheckpoint(result, async (requested, skip, shardSignal) => {
      const shardRequest: LeafCheckpointShardLoadRequest = {
        accessToken: await this.getAccessToken(shardSignal),
        identity: structuredClone(identity),
        manifest: structuredClone(result.manifest),
        shardDirectory: structuredClone(result.shardDirectory),
        requestedShardIds: [...requested],
        skipShardIds: [...skip],
        workerBaseUrl: this.workerBaseUrl,
      };
      return this.workerFactory
        ? await this.runInWorker<LeafCheckpointShardLoadResult>(
            { type: "shards", request: shardRequest },
            shardSignal,
          )
        : await fetchAndDecodeLeafCheckpointShards(shardRequest, this.fetcher, shardSignal);
    });
  }

  async loadSnapshot(
    identity: LeafRoomIdentity,
    reference: LeafCheckpointReference,
    signal?: AbortSignal,
  ): Promise<LeafCheckpointLoadResult> {
    const loaded = await this.loadDirectory(identity, reference, signal);
    const details = await loaded.loadShards(loaded.shardIds, signal);
    return {
      manifest: loaded.manifest,
      snapshot: {
        schemaVersion: LEAF_RECORD_SCHEMA_VERSION,
        records: details.records,
        pages: loaded.pages,
        comments: loaded.comments,
      },
    };
  }

  private async createLoadRequest(
    identity: LeafRoomIdentity,
    reference: LeafCheckpointReference,
    signal?: AbortSignal,
  ): Promise<LeafCheckpointLoadRequest> {
    return {
      accessToken: await this.getAccessToken(signal),
      identity: structuredClone(identity),
      reference: structuredClone(reference),
      workerBaseUrl: this.workerBaseUrl,
    };
  }

  private async getAccessToken(signal?: AbortSignal) {
    throwIfAborted(signal);
    const accessToken = (await this.options.getAccessToken()).trim();
    throwIfAborted(signal);
    if (!accessToken) throw new Error("An access token is required to load a checkpoint");
    return accessToken;
  }

  private runInWorker<Result extends LeafCheckpointWorkerResult>(
    operation: LeafCheckpointWorkerOperation,
    signal?: AbortSignal,
  ) {
    throwIfAborted(signal);
    const worker = this.workerFactory!();
    const id = crypto.randomUUID();
    return new Promise<Result>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", handleAbort);
        worker.terminate();
        callback();
      };
      const handleAbort = () => finish(() => reject(abortReason(signal)));
      worker.addEventListener("error", (event) => {
        finish(() => reject(new Error(event.message || "Checkpoint worker failed")));
      });
      worker.addEventListener("message", (event: MessageEvent<CheckpointWorkerResponse>) => {
        const response = event.data;
        if (response.id !== id) return;
        if (response.ok) {
          finish(() => resolve(response.result as Result));
        } else {
          finish(() => reject(new Error(response.error)));
        }
      });
      signal?.addEventListener("abort", handleAbort, { once: true });
      worker.postMessage({ id, operation });
    });
  }
}

function normalizeWorkerBaseUrl(value: string) {
  const normalized = value.trim().replace(/\/+$/, "");
  const url = new URL(normalized);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The checkpoint Worker URL must use HTTP or HTTPS");
  }
  return url.toString().replace(/\/+$/, "");
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal?: AbortSignal) {
  return signal?.reason ?? new DOMException("Checkpoint load aborted", "AbortError");
}
