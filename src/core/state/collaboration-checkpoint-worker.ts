import {
  fetchAndDecodeLeafCheckpointDirectory,
  fetchAndDecodeLeafCheckpointShards,
  type LeafCheckpointWorkerOperation,
  type LeafCheckpointWorkerResult,
} from "./collaboration-checkpoint-codec";

type CheckpointWorkerRequest = { id: string; operation: LeafCheckpointWorkerOperation };
type CheckpointWorkerResponse =
  | { id: string; ok: true; result: LeafCheckpointWorkerResult }
  | { id: string; ok: false; error: string };

type CheckpointWorkerScope = {
  onmessage: ((event: MessageEvent<CheckpointWorkerRequest>) => void) | null;
  postMessage(message: CheckpointWorkerResponse): void;
};

const scope = globalThis as CheckpointWorkerScope;

scope.onmessage = (event) => {
  const { id, operation } = event.data;
  const task =
    operation.type === "directory"
      ? fetchAndDecodeLeafCheckpointDirectory(operation.request)
      : fetchAndDecodeLeafCheckpointShards(operation.request);
  void task.then(
    (result) => scope.postMessage({ id, ok: true, result }),
    (error: unknown) =>
      scope.postMessage({
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
  );
};
