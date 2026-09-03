import type { DesignNode } from "../types";
import type { DocumentPersistenceAdapter } from "./document-adapter";

export type TextEditingSelection =
  | { type: "all" }
  | { type: "end" }
  | { type: "offset"; offset: number };

export interface TextEditingSession {
  nodeId: string;
  initialContent: string;
  isCreating: boolean;
  selection: TextEditingSelection;
}

export interface EditorTextEditingState {
  nodeMap: ReadonlyMap<string, DesignNode>;
  editingTextSession: TextEditingSession | null;
  readonly editingTextNodeId: string | null;
  documentAdapter: Pick<
    DocumentPersistenceAdapter,
    "beginHistoryTransaction" | "cancelHistoryTransaction" | "endHistoryTransaction"
  > | null;
  runtime: { deleteNodes(nodeIds: string[]): string[] };
}

export function beginTextEditing(
  state: EditorTextEditingState,
  nodeId: string,
  options: { isCreating?: boolean; selection?: TextEditingSelection } = {},
) {
  const node = state.nodeMap.get(nodeId);
  if (node?.type !== "text") return;
  if (state.editingTextNodeId === nodeId) {
    state.editingTextSession = {
      ...state.editingTextSession!,
      selection: options.selection ?? state.editingTextSession!.selection,
      isCreating: options.isCreating ?? state.editingTextSession!.isCreating,
    };
    return;
  }
  finishTextEditing(state);
  state.editingTextSession = {
    nodeId,
    initialContent: node.content,
    isCreating: options.isCreating ?? false,
    selection: options.selection ?? { type: "end" },
  };
  state.documentAdapter?.beginHistoryTransaction();
}

/**
 * End the text session and settle its history transaction.
 *
 * Empty text is invisible — a ~16px box nothing can see or click — so by
 * default the session deletes a node it leaves empty, whether the session
 * created it or emptied an existing one. Pass `deleteEmptyText: false` when the
 * node is leaving for another reason (a remote change unmounted it).
 *
 * A node the session created and never filled is not a document change at
 * all: the creation still sits inside this session's history transaction, so
 * cancelling that transaction rolls the node back and records nothing, where a
 * delete would leave an undo step that reinstates an invisible node.
 */
export function finishTextEditing(
  state: EditorTextEditingState,
  options: { deleteEmptyText?: boolean } = {},
) {
  const session = state.editingTextSession;
  if (!session) return;
  const node = state.nodeMap.get(session.nodeId);
  const deleteEmptyText = options.deleteEmptyText ?? true;
  state.editingTextSession = null;
  const leavesEmptyText =
    deleteEmptyText && node?.type === "text" && node.content.trim().length === 0;
  if (leavesEmptyText && session.isCreating && state.documentAdapter) {
    state.documentAdapter.cancelHistoryTransaction();
    if (state.nodeMap.has(node.id)) state.runtime.deleteNodes([node.id]);
    return;
  }
  if (leavesEmptyText) {
    state.runtime.deleteNodes([node.id]);
  }
  state.documentAdapter?.endHistoryTransaction();
}
