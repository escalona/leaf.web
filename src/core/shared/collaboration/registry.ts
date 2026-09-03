/** Stable registry DTOs for the normalized collaboration engine. */

export const LEAF_FILE_STATUSES = ["active", "archived", "deleted"] as const;
export const LEAF_BRANCH_STATUSES = [
  "creating",
  "active",
  "archiving",
  "archived",
  "deleted",
] as const;
export const LEAF_BRANCH_WRITE_MODES = ["writable", "read_only", "archived"] as const;

export type LeafFileStatus = (typeof LEAF_FILE_STATUSES)[number];
export type LeafBranchStatus = (typeof LEAF_BRANCH_STATUSES)[number];
export type LeafBranchWriteMode = (typeof LEAF_BRANCH_WRITE_MODES)[number];

export type LeafBranchDto = {
  branchId: string;
  createdAt: string;
  fileId: string;
  name: string;
  status: LeafBranchStatus;
  updatedAt: string;
  writeMode: LeafBranchWriteMode;
};

export type LeafFileDto = {
  branches: LeafBranchDto[];
  createdAt: string;
  fileId: string;
  name: string;
  status: LeafFileStatus;
  /**
   * Content-addressed shared-asset id (`sha256:…`) of the file's dashboard
   * thumbnail, or null when none has been captured yet. Optional so file
   * directories persisted before the field existed still validate.
   */
  thumbnailAssetId?: string | null;
  updatedAt: string;
  workspaceId: string;
};

/** Matches the shared asset store's content-addressed id shape. */
export const LEAF_THUMBNAIL_ASSET_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function createLeafFileWithMainBranch(options: {
  branchId: string;
  fileId: string;
  name: string;
  now: string;
  workspaceId: string;
}): LeafFileDto {
  return {
    branches: [
      {
        branchId: options.branchId,
        createdAt: options.now,
        fileId: options.fileId,
        name: "main",
        status: "active",
        updatedAt: options.now,
        writeMode: "writable",
      },
    ],
    createdAt: options.now,
    fileId: options.fileId,
    name: options.name,
    status: "active",
    thumbnailAssetId: null,
    updatedAt: options.now,
    workspaceId: options.workspaceId,
  };
}

/** A short-lived, branch-bound connection descriptor. */
export type LeafBranchSessionDto = {
  branchId: string;
  expiresAt: string;
  fileId: string;
  presenceServerUrl: string;
  status: Extract<LeafBranchStatus, "active">;
  syncServerUrl: string;
  workspaceId: string;
  writeMode: Exclude<LeafBranchWriteMode, "archived">;
};

export function isLeafBranchDto(value: unknown): value is LeafBranchDto {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.branchId) &&
    isIsoDate(value.createdAt) &&
    isNonEmptyString(value.fileId) &&
    isNonEmptyString(value.name) &&
    isLeafBranchStatus(value.status) &&
    isIsoDate(value.updatedAt) &&
    isLeafBranchWriteMode(value.writeMode)
  );
}

export function isLeafFileDto(value: unknown): value is LeafFileDto {
  if (!isRecord(value) || !Array.isArray(value.branches)) return false;
  return (
    value.branches.every(isLeafBranchDto) &&
    isIsoDate(value.createdAt) &&
    isNonEmptyString(value.fileId) &&
    isNonEmptyString(value.name) &&
    isLeafFileStatus(value.status) &&
    (value.thumbnailAssetId === undefined ||
      value.thumbnailAssetId === null ||
      (typeof value.thumbnailAssetId === "string" &&
        LEAF_THUMBNAIL_ASSET_ID_PATTERN.test(value.thumbnailAssetId))) &&
    isIsoDate(value.updatedAt) &&
    isNonEmptyString(value.workspaceId) &&
    value.branches.every((branch) => branch.fileId === value.fileId)
  );
}

export function isLeafBranchSessionDto(value: unknown): value is LeafBranchSessionDto {
  if (!isRecord(value)) return false;
  if (
    !isNonEmptyString(value.branchId) ||
    !isIsoDate(value.expiresAt) ||
    !isNonEmptyString(value.fileId) ||
    typeof value.presenceServerUrl !== "string" ||
    !isWebSocketUrl(value.presenceServerUrl) ||
    value.status !== "active" ||
    !isNonEmptyString(value.syncServerUrl) ||
    !isNonEmptyString(value.workspaceId) ||
    (value.writeMode !== "writable" && value.writeMode !== "read_only")
  ) {
    return false;
  }
  return isWebSocketUrl(value.syncServerUrl);
}

function isLeafFileStatus(value: unknown): value is LeafFileStatus {
  return LEAF_FILE_STATUSES.some((status) => status === value);
}

function isLeafBranchStatus(value: unknown): value is LeafBranchStatus {
  return LEAF_BRANCH_STATUSES.some((status) => status === value);
}

function isLeafBranchWriteMode(value: unknown): value is LeafBranchWriteMode {
  return LEAF_BRANCH_WRITE_MODES.some((mode) => mode === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isIsoDate(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isWebSocketUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "ws:" || url.protocol === "wss:";
  } catch {
    return false;
  }
}
