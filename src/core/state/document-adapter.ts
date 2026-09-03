import type { StylePatch } from "../editor/style-mutation";
import type { LeafCommentRecord } from "../shared/collaboration";
import type { DesignNode, Point } from "../types";
import type { PersistedDesignNode } from "./document";

export interface DuplicateNodeRequest {
  id: string;
  parentId?: string;
}

export interface RenameNodeRequest {
  nodeId: string;
  name: string;
}

export interface SetTextContentRequest {
  nodeId: string;
  textContent: string;
}

export interface StyleUpdateRequest {
  nodeIds: string[];
  /** A `null` value removes the key. See `StylePatch` in editor/style-mutation. */
  styles: StylePatch;
}

export interface DuplicateNodeResult {
  sourceId: string;
  newId: string;
  descendantIdMap: Record<string, string>;
}

export interface PasteNodeRequest {
  node: PersistedDesignNode;
  parentId?: string;
  offset?: Point;
  /** Insertion index among the new siblings. Appends when omitted. */
  index?: number;
  /**
   * Place the clone directly after this existing sibling, resolved at insertion
   * time. Preferred over `index` for a batch: a precomputed index goes stale the
   * moment an earlier clone in the same batch is spliced in.
   */
  afterNodeId?: string;
}

export interface PasteNodeResult {
  newId: string;
  descendantIdMap: Record<string, string>;
}

export interface PreparedPasteNode {
  node: DesignNode;
  parentId?: string;
  /**
   * Page a root-level entry was prepared for. Captured at preparation time so
   * a page switch during an incremental (async) preparation cannot redirect
   * the paste onto whichever page is active when it commits.
   */
  pageId?: string;
  index?: number;
  afterNodeId?: string;
  result: PasteNodeResult;
}

export interface FlowRestoreState {
  position: string | null;
  x: number;
  y: number;
}

export interface DocumentHistoryEntry {
  actor: string;
  id: string;
  isCurrent: boolean;
  message: string | null;
  timestamp: number | null;
  versionNumber: number;
}

export interface MoveNodeToParentOptions {
  flowRestore?: FlowRestoreState;
  index?: number;
  mode?: "absolute" | "flow";
}

export type DocumentMutation =
  | { type: "create-root" }
  | { type: "create-node" }
  | { type: "delete-subtree"; nodeId: string }
  | { type: "move-node"; nodeId: string; patchFields?: boolean }
  | { type: "patch-node"; nodeId: string }
  | { type: "patch-nodes" }
  | { type: "paste-nodes" }
  | { type: "duplicate-nodes" }
  | { type: "delete-nodes"; nodeIds: string[] }
  | {
      type: "write-html";
      mode: "insert-children" | "replace";
      targetNodeId: string;
    }
  // Document-level rather than node-scoped: the page list is not derivable from
  // `record.pageId`, because a page holding zero nodes still has to survive.
  | { type: "set-pages" }
  // Document-level like set-pages, but per-record: comment threads live
  // alongside the canvas and sync durably, yet never enter the canvas undo
  // stack (see finishActiveGroup in collaboration-controller).
  | { type: "comment-records"; puts: LeafCommentRecord[]; deletes: string[] };

export interface DocumentPersistenceAdapter {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  beginHistoryTransaction(): void;
  endHistoryTransaction(): void;
  cancelHistoryTransaction(): void;
  recordSelectionChange(beforeIds: string[], afterIds: string[]): void;
  executeMutation<T>(mutation: DocumentMutation, apply: () => T): T;
  undo(): void;
  redo(): void;
  exitHistoryPreview?(): void;
  previewHistoryVersion?(entryId: string): void;
  restoreHistoryVersion?(entryId?: string): void;
}
