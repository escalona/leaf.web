import { isLeafDocumentPatch } from "../shared/collaboration";
import type {
  LeafCanonicalPatch,
  LeafCommitMessage,
  LeafPreparedTransaction,
} from "../shared/collaboration";

export type HistoryPart = {
  clientTxId: string | null;
  prepared: LeafPreparedTransaction;
};

export type HistoryGroup = {
  id: string;
  serverBacked: boolean;
  forward: LeafCanonicalPatch[];
  inverse: LeafCanonicalPatch[];
  parts: HistoryPart[];
  selectionBefore: string[];
  selectionAfter: string[];
};

export type RedoGroup = {
  group: HistoryGroup;
  patches: LeafCanonicalPatch[];
  selectionBefore: string[];
  selectionAfter: string[];
};

export type CollaborationHistoryMetadata = {
  version: 1;
  redo: CollaborationHistoryGroupMetadata[];
  undo: CollaborationHistoryGroupMetadata[];
  versions?: CollaborationVersionMetadata[];
  localAuthority?: LocalCollaborationAuthorityMetadata;
};

export type CollaborationVersionMetadata = {
  actor: string;
  historyGroupId: string;
  id: string;
  inverse: LeafCanonicalPatch[];
  kind: "user" | "undo" | "redo";
  revision: number;
  streamEpoch: string;
  timestamp: number;
};

export const MAX_COLLABORATION_VERSIONS = 500;

/** Drops versions whose state can no longer be reached from the retained inverse chain. */
export function pruneUnreconstructibleVersions(versions: CollaborationVersionMetadata[]) {
  if (versions.length > MAX_COLLABORATION_VERSIONS) {
    versions.splice(0, versions.length - MAX_COLLABORATION_VERSIONS);
  }
}

export type LocalCollaborationAuthorityMetadata = {
  version: 1;
  retainedFromRevision: number;
  commits: LeafCommitMessage[];
  groups: Array<{
    historyGroupId: string;
    inverse: LeafCanonicalPatch[];
    redo: LeafCanonicalPatch[];
    state: "applied" | "undone";
    lastTransitionRevision: number;
  }>;
};

export type CollaborationHistoryGroupMetadata = {
  historyGroupId: string;
  selectionAfter: string[];
  selectionBefore: string[];
};

export function rebuildHistoryGroup(group: HistoryGroup) {
  group.forward = group.parts.flatMap((part) => part.prepared.forward);
  group.inverse = [...group.parts].reverse().flatMap((part) => part.prepared.inverse);
}

export function removeHistoryPart(group: HistoryGroup, part: HistoryPart) {
  const index = group.parts.indexOf(part);
  if (index >= 0) group.parts.splice(index, 1);
}

export function collectPatchNodeIds(patches: readonly LeafCanonicalPatch[]) {
  const ids = new Set<string>();
  for (const patch of patches) {
    // A document-level patch names no records; it contributes no node ids.
    if (isLeafDocumentPatch(patch)) continue;
    if (patch.type === "patchFields" || patch.type === "moveRecord") ids.add(patch.nodeId);
    else for (const record of patch.records) ids.add(record.id);
  }
  return [...ids];
}

export function serializeHistoryGroup(group: HistoryGroup): CollaborationHistoryGroupMetadata {
  return {
    historyGroupId: group.id,
    selectionBefore: [...group.selectionBefore],
    selectionAfter: [...group.selectionAfter],
  };
}

export function hydrateHistoryGroup(metadata: CollaborationHistoryGroupMetadata): HistoryGroup {
  return {
    id: metadata.historyGroupId,
    serverBacked: true,
    forward: [],
    inverse: [],
    parts: [],
    selectionBefore: [...metadata.selectionBefore],
    selectionAfter: [...metadata.selectionAfter],
  };
}

export function parseHistoryMetadata(metadata: CollaborationHistoryMetadata) {
  if (
    !metadata ||
    metadata.version !== 1 ||
    !Array.isArray(metadata.undo) ||
    !Array.isArray(metadata.redo)
  ) {
    throw new Error("Collaboration history metadata is invalid");
  }
  const seen = new Set<string>();
  const parseGroup = (group: CollaborationHistoryGroupMetadata) => {
    if (
      !group ||
      typeof group.historyGroupId !== "string" ||
      group.historyGroupId.length === 0 ||
      group.historyGroupId.length > 256 ||
      seen.has(group.historyGroupId) ||
      !isStringArray(group.selectionBefore) ||
      !isStringArray(group.selectionAfter)
    ) {
      throw new Error("Collaboration history metadata is invalid");
    }
    seen.add(group.historyGroupId);
    return {
      historyGroupId: group.historyGroupId,
      selectionBefore: [...group.selectionBefore],
      selectionAfter: [...group.selectionAfter],
    };
  };
  const versions = metadata.versions?.map((version) => {
    if (
      !version ||
      typeof version.id !== "string" ||
      !version.id ||
      typeof version.actor !== "string" ||
      typeof version.historyGroupId !== "string" ||
      typeof version.streamEpoch !== "string" ||
      !Number.isSafeInteger(version.revision) ||
      version.revision < 0 ||
      !Number.isFinite(version.timestamp) ||
      !Array.isArray(version.inverse) ||
      (version.kind !== "user" && version.kind !== "undo" && version.kind !== "redo")
    ) {
      throw new Error("Collaboration version history metadata is invalid");
    }
    return structuredClone(version);
  });
  return {
    undo: metadata.undo.map(parseGroup),
    redo: metadata.redo.map(parseGroup),
    versions: versions ?? [],
  };
}

export function sameIds(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 10_000 &&
    value.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 256)
  );
}
