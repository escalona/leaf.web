import type { LeafBranchDto, LeafFileDto } from "../../core/shared/collaboration";
import { collaborationSelectionKey } from "../../core/state/collaboration-app-runtime";
import type { FileNavigationEntry } from "../../core/state/file-navigation";
import { getSharedAssetUrlForId } from "../../core/state/image-assets";

export {
  applyViewportSnapshot,
  readViewportSnapshot,
  type ViewportSnapshot,
} from "../../core/state/workspace-tabs";

export function toFileNavigationEntry(
  file: LeafFileDto,
  branch: LeafBranchDto,
): FileNavigationEntry {
  return {
    url: collaborationSelectionKey(file.fileId, branch.branchId),
    fileId: file.fileId,
    name: file.name,
    createdAt: branch.createdAt,
    updatedAt: branch.updatedAt,
    thumbnailUrl: file.thumbnailAssetId ? getSharedAssetUrlForId(file.thumbnailAssetId) : null,
  };
}
