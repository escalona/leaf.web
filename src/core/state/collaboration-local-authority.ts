import {
  LEAF_COLLABORATION_PROTOCOL_VERSION,
  LEAF_RECORD_SCHEMA_VERSION,
  LeafReferenceDocument,
  invertLeafCanonicalPatches,
  prepareLeafConditionalUndo,
  type LeafCanonicalPatch,
  type LeafCommitMessage,
  type LeafSemanticCommand,
} from "../shared/collaboration";
import type {
  CollaborationHistoryMetadata,
  CollaborationVersionMetadata,
  LocalCollaborationAuthorityMetadata,
} from "./collaboration-history";
import { pruneUnreconstructibleVersions } from "./collaboration-history";
import type { NetworkCollaborationPersistence } from "./collaboration-network-session";
import type { CollaborationCacheIdentity } from "./collaboration-persistence";

const MAX_LOCAL_COMMIT_JOURNAL = 512;
const MAX_LOCAL_COMMIT_JOURNAL_BYTES = 2 * 1024 * 1024;
const FALLBACK_LOCKS = new Map<string, Promise<void>>();
const LOCAL_CHANNEL_LISTENERS = new Map<string, Set<(revision: number) => void>>();

export type LocalAuthorityOperation =
  | {
      baseRevision: number;
      clientTxId: string;
      commands: LeafSemanticCommand[];
      historyGroupId: string;
      kind: "user";
    }
  | {
      baseRevision: number;
      clientTxId: string;
      historyGroupId: string;
      kind: "undo" | "redo";
    };

export type LocalAuthorityOperationInput =
  | { commands: LeafSemanticCommand[]; historyGroupId: string; kind: "user" }
  | { historyGroupId: string; kind: "undo" | "redo" };

export async function commitLocalAuthorityOperation(options: {
  accountId: string;
  identity: CollaborationCacheIdentity;
  operation: LocalAuthorityOperation;
  persistence: NetworkCollaborationPersistence;
}) {
  const lockName = localAuthorityKey(options.identity);
  return await withExclusiveLocalLock(lockName, async () => {
    const persisted = await options.persistence.load(options.identity);
    const generation = persisted.activeGeneration;
    if (!generation) throw new Error("The local collaboration authority is not initialized");
    const authority = readLocalAuthority(generation.history, generation.cursor.revision);
    const model = LeafReferenceDocument.fromSnapshot(generation.confirmed, "adopt");
    const revision = generation.cursor.revision + 1;
    const operation = options.operation;
    let effectivePatches;

    if (operation.kind === "user") {
      const prepared = model.commit(operation.commands);
      effectivePatches = prepared.forward;
      const existingGroup = authority.groups.find(
        (group) => group.historyGroupId === operation.historyGroupId,
      );
      authority.groups = authority.groups.filter(
        (group) => group.historyGroupId !== operation.historyGroupId,
      );
      authority.groups.push({
        historyGroupId: operation.historyGroupId,
        inverse:
          existingGroup?.state === "applied"
            ? [...prepared.inverse, ...existingGroup.inverse]
            : prepared.inverse,
        redo: [],
        state: "applied",
        lastTransitionRevision: revision,
      });
    } else {
      const group = authority.groups.find(
        (candidate) => candidate.historyGroupId === operation.historyGroupId,
      );
      if (!group) throw new Error("The local history group is no longer available");
      const expectedState = operation.kind === "undo" ? "applied" : "undone";
      if (group.state !== expectedState) {
        throw new Error(`The local history group is already ${group.state}`);
      }
      // Undoing a CANVAS group restores the drawing only — a mixed inverse
      // (a journal persisted before comment transactions got their own group
      // ids) drops its comment patches so undo can never rewind a
      // conversation. A purely conversational group keeps its full inverse:
      // comment-group undo through the journal stays a supported capability.
      const source = canvasScopedHistoryInverse(
        operation.kind === "undo" ? group.inverse : group.redo,
      );
      const plan = prepareLeafConditionalUndo(model.records, source);
      model.apply(plan.patches);
      effectivePatches = plan.patches;
      if (operation.kind === "undo") {
        group.redo = invertLeafCanonicalPatches(plan.patches);
        group.state = "undone";
      } else {
        group.inverse = invertLeafCanonicalPatches(plan.patches);
        group.state = "applied";
      }
      group.lastTransitionRevision = revision;
    }

    const commit: LeafCommitMessage = {
      type: operation.baseRevision === generation.cursor.revision ? "commit" : "rebase",
      protocolVersion: LEAF_COLLABORATION_PROTOCOL_VERSION,
      schemaVersion: LEAF_RECORD_SCHEMA_VERSION,
      streamEpoch: generation.cursor.streamEpoch,
      revision,
      clientTxId: operation.clientTxId,
      actorId: options.accountId,
      historyGroupId: operation.historyGroupId,
      kind: operation.kind,
      effectivePatches,
    };
    authority.commits.push(commit);
    while (
      authority.commits.length > 1 &&
      (authority.commits.length > MAX_LOCAL_COMMIT_JOURNAL ||
        new TextEncoder().encode(JSON.stringify(authority.commits)).byteLength >
          MAX_LOCAL_COMMIT_JOURNAL_BYTES)
    ) {
      authority.commits.shift();
    }
    const firstRetainedCommit = authority.commits[0];
    authority.retainedFromRevision = firstRetainedCommit
      ? firstRetainedCommit.revision - 1
      : revision;
    const history = buildLocalHistoryMetadata(authority, generation.history?.versions);

    await options.persistence.installCommittedGeneration(options.identity, {
      generationId: `${generation.cursor.streamEpoch}:${revision}`,
      installedAtMs: Date.now(),
      cursor: { streamEpoch: generation.cursor.streamEpoch, revision },
      checkpoint: null,
      confirmed: model.recordSnapshot(),
      history,
    });
    return { commit, history };
  });
}

export function readLocalAuthority(
  history: CollaborationHistoryMetadata | null,
  currentRevision: number,
): LocalCollaborationAuthorityMetadata {
  const authority = history?.localAuthority;
  if (!authority) {
    return { version: 1, retainedFromRevision: currentRevision, commits: [], groups: [] };
  }
  if (
    authority.version !== 1 ||
    !Number.isSafeInteger(authority.retainedFromRevision) ||
    authority.retainedFromRevision < 0 ||
    !Array.isArray(authority.commits) ||
    !Array.isArray(authority.groups)
  ) {
    throw new Error("The local collaboration authority metadata is invalid");
  }
  return structuredClone(authority);
}

export function buildLocalHistoryMetadata(
  authority: LocalCollaborationAuthorityMetadata,
  existingVersions?: CollaborationVersionMetadata[],
): CollaborationHistoryMetadata {
  const toMetadata = (group: LocalCollaborationAuthorityMetadata["groups"][number]) => ({
    historyGroupId: group.historyGroupId,
    selectionBefore: [],
    selectionAfter: [],
  });
  const ordered = [...authority.groups].sort(
    (left, right) => left.lastTransitionRevision - right.lastTransitionRevision,
  );
  const versions = buildLocalVersions(authority, existingVersions);
  return {
    version: 1,
    undo: ordered.filter((group) => group.state === "applied").map(toMetadata),
    redo: ordered.filter((group) => group.state === "undone").map(toMetadata),
    versions,
    localAuthority: structuredClone(authority),
  };
}

function buildLocalVersions(
  authority: LocalCollaborationAuthorityMetadata,
  existingVersions?: CollaborationVersionMetadata[],
) {
  const commits = [...authority.commits].sort((left, right) => left.revision - right.revision);
  const latest = commits.at(-1);
  if (!latest) return structuredClone(existingVersions ?? []);

  let versions = structuredClone(existingVersions ?? []);
  const hasLatest = versions.some(
    (version) => version.streamEpoch === latest.streamEpoch && version.revision === latest.revision,
  );
  const commitsToAppend = hasLatest ? [] : versions.length ? [latest] : commits;

  if (versions.length === 0) {
    versions.push({
      actor: "Leaf",
      historyGroupId: "initial",
      id: `${latest.streamEpoch}:${authority.retainedFromRevision}`,
      inverse: [],
      kind: "user",
      revision: authority.retainedFromRevision,
      streamEpoch: latest.streamEpoch,
      timestamp: Date.now(),
    });
  }

  for (const commit of commitsToAppend) {
    const inverse = invertLeafCanonicalPatches(commit.effectivePatches);
    const previous = versions.at(-1);
    if (
      previous &&
      previous.historyGroupId === commit.historyGroupId &&
      previous.streamEpoch === commit.streamEpoch &&
      previous.kind === commit.kind
    ) {
      previous.id = `${commit.streamEpoch}:${commit.revision}`;
      previous.inverse = [...inverse, ...previous.inverse];
      previous.revision = commit.revision;
      previous.timestamp = Date.now();
      continue;
    }
    versions.push({
      actor: commit.actorId,
      historyGroupId: commit.historyGroupId,
      id: `${commit.streamEpoch}:${commit.revision}`,
      inverse,
      kind: commit.kind,
      revision: commit.revision,
      streamEpoch: commit.streamEpoch,
      timestamp: Date.now(),
    });
  }

  pruneUnreconstructibleVersions(versions);
  return versions;
}

export function createLocalAuthorityChannel(
  identity: CollaborationCacheIdentity,
  onRevision: (revision: number) => void,
) {
  const name = `leaf-local-authority:${localAuthorityKey(identity)}`;
  let listeners = LOCAL_CHANNEL_LISTENERS.get(name);
  if (!listeners) {
    listeners = new Set();
    LOCAL_CHANNEL_LISTENERS.set(name, listeners);
  }
  listeners.add(onRevision);
  const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(name);
  if (channel) {
    channel.onmessage = (event) => {
      if (typeof event.data === "number" && Number.isSafeInteger(event.data)) {
        onRevision(event.data);
      }
    };
  }
  return {
    publish(revision: number) {
      for (const listener of LOCAL_CHANNEL_LISTENERS.get(name) ?? []) listener(revision);
      channel?.postMessage(revision);
    },
    dispose() {
      const current = LOCAL_CHANNEL_LISTENERS.get(name);
      current?.delete(onRevision);
      if (current?.size === 0) LOCAL_CHANNEL_LISTENERS.delete(name);
      channel?.close();
    },
  };
}

function canvasScopedHistoryInverse(patches: readonly LeafCanonicalPatch[]): LeafCanonicalPatch[] {
  const hasCanvasPatch = patches.some((patch) => patch.type !== "commentRecords");
  if (!hasCanvasPatch) return [...patches];
  return patches.filter((patch) => patch.type !== "commentRecords");
}

function localAuthorityKey(identity: CollaborationCacheIdentity) {
  return [
    identity.accountId,
    identity.workspaceId,
    identity.fileId,
    identity.branchId,
    identity.schemaVersion,
  ]
    .map(encodeURIComponent)
    .join(":");
}

async function withExclusiveLocalLock<T>(name: string, operation: () => Promise<T>) {
  const locks =
    typeof navigator === "undefined"
      ? null
      : (
          navigator as Navigator & {
            locks?: { request<T>(name: string, callback: () => Promise<T>): Promise<T> };
          }
        ).locks;
  if (locks) return await locks.request(name, operation);

  const previous = FALLBACK_LOCKS.get(name) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  FALLBACK_LOCKS.set(name, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (FALLBACK_LOCKS.get(name) === tail) FALLBACK_LOCKS.delete(name);
  }
}
