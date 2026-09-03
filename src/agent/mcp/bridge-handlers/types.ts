import type { LeafBranchDto, LeafFileDto } from "../../../core/shared/collaboration";
import type { EditorStore } from "../../../core/state/EditorStore";
import type { McpAgentIdentity } from "../../../core/state/agent-identity";

export interface RendererDocumentFileInfo {
  branchId: string;
  fileId: string;
  name: string;
}

/** One open collaboration document as reported by list_documents in web/dev mode. */
export interface RendererOpenDocumentInfo {
  dirty: null;
  displayName: string;
  documentId: string;
  filePath: null;
  focused: boolean;
  kind: "collaboration";
}

/**
 * Collaboration access scoped to the document a tool call was routed to.
 * For background tabs this targets that tab, not the focused one.
 */
export interface RendererCollaborationAccess {
  currentFile: LeafFileDto;
  currentBranch: LeafBranchDto;
  /** Rename the document's file. Absent when the runtime cannot rename files. */
  renameFile?(name: string): Promise<LeafFileDto>;
}

export interface RendererHandlerContext {
  activityAgent: McpAgentIdentity;
  store: EditorStore;
  getCollaborationContext: () => RendererCollaborationAccess;
  getCurrentFileInfo: () => RendererDocumentFileInfo | null;
  listOpenDocuments: () => RendererOpenDocumentInfo[];
}

export type RendererHandler = (params: Record<string, unknown>) => Promise<unknown>;
export type RendererHandlerMap = Record<string, RendererHandler>;
