import { runInAction } from "mobx";
import {
  LEAF_MAX_COMMENT_RECORDS_PER_COMMAND,
  LeafReferenceDocument,
  getLeafComments,
  getLeafPages,
  invertLeafCanonicalPatches,
  prepareLeafConditionalUndo,
  type LeafCanonicalPatch,
  type LeafCommentRecord,
  type LeafCommitMessage,
  type LeafPreparedTransaction,
  type LeafRecordSnapshot,
  type LeafSemanticCommand,
} from "../shared/collaboration";
import type { DesignNode } from "../types";
import type {
  DocumentMutation,
  DocumentPersistenceAdapter,
  DuplicateNodeResult,
  PasteNodeResult,
} from "./document-adapter";
import type { PersistedEditorDocument } from "./document";
import type { EditorStore } from "./EditorStore";
import {
  createMoveRecordCommand,
  createPatchFieldsCommand,
  createRecordsCommand,
} from "./collaboration-commands";
import {
  collectPatchNodeIds,
  hydrateHistoryGroup,
  parseHistoryMetadata,
  pruneUnreconstructibleVersions,
  rebuildHistoryGroup,
  removeHistoryPart,
  sameIds,
  serializeHistoryGroup,
  type CollaborationHistoryMetadata,
  type CollaborationVersionMetadata,
  type HistoryGroup,
  type HistoryPart,
  type RedoGroup,
} from "./collaboration-history";
import { EditorStoreCollaborationReplica } from "./collaboration-replica";
import { collectStorePages, pageListsEqual } from "./collaboration-pages";
import { effectiveCommentRecordsCommand } from "./collaboration-comments";
import { batchLeafSemanticCommands } from "./collaboration-command-batches";
import { recordLeafPerfTrace, timeLeafPerfTrace } from "../lib/perf-trace";
import { reportEditorError } from "./editor-feedback-bus";

type PendingLocalTransaction = {
  commands: LeafSemanticCommand[];
  group: HistoryGroup;
  part: HistoryPart;
};

const HISTORY_PREVIEW_EDIT_ERROR = "Exit history preview before editing";
export const HISTORY_PREVIEW_EDIT_MESSAGE =
  "Exit history preview before editing. Choose Current to return to the latest version.";
const HISTORY_PREVIEW_REFUSAL_TOAST_INTERVAL_MS = 2000;

type DeferredHistoryMutation = {
  commands: LeafSemanticCommand[];
  part: HistoryPart;
};

type PendingHistoryOperation =
  | { clientTxId: string; kind: "undo"; group: HistoryGroup }
  | { clientTxId: string; kind: "redo"; entry: RedoGroup };

export type {
  CollaborationHistoryGroupMetadata,
  CollaborationHistoryMetadata,
} from "./collaboration-history";

export type CollaborationRestoredPendingTransaction = {
  clientTxId: string;
  commands?: LeafSemanticCommand[];
  historyGroupId: string;
  kind: "user" | "undo" | "redo";
};

/**
 * Primary local controller for the normalized collaboration engine.
 *
 * EditorRuntime still owns editor semantics. This adapter captures each local
 * semantic result into the normalized authority without snapshotting the full
 * document. A network transport can replace `acceptPrepared` without changing UI
 * call sites or the canonical patch/undo path.
 */
export class CollaborationDocumentController implements DocumentPersistenceAdapter {
  readonly replica: EditorStoreCollaborationReplica;
  confirmedDocument: LeafReferenceDocument;
  private undoStack: HistoryGroup[] = [];
  private redoStack: RedoGroup[] = [];
  private historyDepth = 0;
  private implicitHistoryDepth = 0;
  private activeGroup: HistoryGroup | null = null;
  private deferredHistoryMutations: DeferredHistoryMutation[] = [];
  private disposed = false;
  private acceptedTransactions = 0;
  private listeners = new Set<() => void>();
  private transactionDispatcher:
    | ((commands: LeafSemanticCommand[], historyGroupId: string) => string)
    | null = null;
  private historyDispatcher: ((kind: "undo" | "redo", historyGroupId: string) => string) | null =
    null;
  private pendingTransactions: PendingLocalTransaction[] = [];
  private pendingHistoryOperation: PendingHistoryOperation | null = null;
  private versions: CollaborationVersionMetadata[] = [createInitialVersion()];
  private historyPreviewId: string | null = null;
  private lastHistoryPreviewRefusalAt = 0;

  constructor(
    private readonly store: EditorStore,
    initialDocument: PersistedEditorDocument | LeafRecordSnapshot,
  ) {
    this.replica = new EditorStoreCollaborationReplica(store, initialDocument);
    // Local sessions have no speculative overlay, so one authority is enough.
    // A cheap copy-on-write confirmed fork is created only when networking starts.
    this.confirmedDocument = this.replica.document;
    store.attachDocumentAdapter(this);
    this.syncHistoryState();
  }

  get canUndo() {
    return (
      this.undoStack.length > 0 &&
      this.pendingTransactions.length === 0 &&
      this.deferredHistoryMutations.length === 0 &&
      this.pendingHistoryOperation === null &&
      this.historyPreviewId === null
    );
  }

  get canRedo() {
    return (
      this.redoStack.length > 0 &&
      this.pendingTransactions.length === 0 &&
      this.deferredHistoryMutations.length === 0 &&
      this.pendingHistoryOperation === null &&
      this.historyPreviewId === null
    );
  }

  get transactionCount() {
    return this.acceptedTransactions;
  }

  get pendingTransactionCount() {
    return (
      this.pendingTransactions.length +
      (this.deferredHistoryMutations.length ? 1 : 0) +
      (this.pendingHistoryOperation ? 1 : 0)
    );
  }

  get snapshot(): LeafRecordSnapshot {
    return this.replica.document.recordSnapshot();
  }

  get confirmedSnapshot(): LeafRecordSnapshot {
    return this.confirmedDocument.recordSnapshot();
  }

  /** Small reload-safe metadata; canonical inverse patches remain server-owned. */
  get historyMetadata(): CollaborationHistoryMetadata {
    return {
      version: 1,
      undo: this.undoStack.filter((group) => group.serverBacked).map(serializeHistoryGroup),
      redo: this.redoStack
        .filter((entry) => entry.group.serverBacked)
        .map((entry) => serializeHistoryGroup(entry.group)),
      versions: structuredClone(this.versions),
    };
  }

  restoreHistoryMetadata(metadata: CollaborationHistoryMetadata) {
    this.assertActive();
    if (
      this.historyDepth !== 0 ||
      this.activeGroup ||
      this.pendingTransactions.length ||
      this.pendingHistoryOperation ||
      this.undoStack.length ||
      this.redoStack.length
    ) {
      throw new Error("History metadata can only hydrate a fresh collaboration session");
    }
    const parsed = parseHistoryMetadata(metadata);
    this.undoStack = parsed.undo.map(hydrateHistoryGroup);
    this.redoStack = parsed.redo.map((group) => ({
      group: hydrateHistoryGroup(group),
      patches: [],
      selectionBefore: [...group.selectionBefore],
      selectionAfter: [...group.selectionAfter],
    }));
    if (parsed.versions.length) {
      this.versions = parsed.versions;
      pruneUnreconstructibleVersions(this.versions);
    }
    this.syncHistoryState();
    this.notify();
  }

  /** Rebuilds a crash-durable optimistic overlay over the committed cache. */
  restorePendingTransactions(transactions: readonly CollaborationRestoredPendingTransaction[]) {
    this.assertActive();
    if (
      this.historyDepth !== 0 ||
      this.activeGroup ||
      this.pendingTransactions.length ||
      this.pendingHistoryOperation
    ) {
      throw new Error("Pending transactions can only hydrate a fresh collaboration session");
    }
    if (this.confirmedDocument === this.replica.document) {
      this.confirmedDocument = this.replica.document.fork();
    }
    const ids = new Set<string>();
    const groups = new Map(this.undoStack.map((group) => [group.id, group]));
    for (const transaction of transactions) {
      if (
        !transaction.clientTxId ||
        !transaction.historyGroupId ||
        ids.has(transaction.clientTxId)
      ) {
        throw new Error("Persisted pending collaboration transaction is invalid");
      }
      ids.add(transaction.clientTxId);
      if (transaction.kind === "user") {
        if (!transaction.commands?.length) {
          throw new Error("Persisted user transaction has no commands");
        }
        let group = groups.get(transaction.historyGroupId);
        if (!group) {
          const selection = [...this.store.selectedIds];
          group = {
            id: transaction.historyGroupId,
            serverBacked: false,
            forward: [],
            inverse: [],
            parts: [],
            selectionBefore: selection,
            selectionAfter: selection,
          };
          groups.set(group.id, group);
          this.undoStack.push(group);
        }
        const commands = structuredClone(transaction.commands);
        const prepared = this.replica.document.prepare(commands);
        this.replica.apply(prepared.forward);
        const part = { clientTxId: transaction.clientTxId, prepared };
        group.parts.push(part);
        group.selectionAfter = [...this.store.selectedIds];
        rebuildHistoryGroup(group);
        this.pendingTransactions.push({ commands, group, part });
        continue;
      }
      if (this.pendingHistoryOperation) {
        throw new Error("Only one persisted history transition may be pending");
      }
      if (transaction.kind === "undo") {
        const group = this.undoStack.at(-1);
        if (!group || group.id !== transaction.historyGroupId) {
          throw new Error("Persisted undo does not match the restored history head");
        }
        this.pendingHistoryOperation = { clientTxId: transaction.clientTxId, kind: "undo", group };
      } else {
        const entry = this.redoStack.at(-1);
        if (!entry || entry.group.id !== transaction.historyGroupId) {
          throw new Error("Persisted redo does not match the restored history head");
        }
        this.pendingHistoryOperation = { clientTxId: transaction.clientTxId, kind: "redo", entry };
      }
    }
    // A restored pending comment write re-created its detached group above;
    // comment-only groups must never become undo targets (Cmd+Z cannot delete
    // a conversation), so strip them the way live sessions never push them.
    this.undoStack = this.undoStack.filter(
      (group) =>
        !(group.forward.length > 0 && group.forward.every((p) => p.type === "commentRecords")),
    );
    this.syncHistoryState();
    this.notify();
  }

  dispose() {
    this.disposed = true;
    this.listeners.clear();
    if (this.store.documentAdapter === this) this.store.documentAdapter = null;
  }

  subscribe(listener: () => void) {
    this.assertActive();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  attachTransactionDispatcher(
    dispatcher: (commands: LeafSemanticCommand[], historyGroupId: string) => string,
    historyDispatcher?: (kind: "undo" | "redo", historyGroupId: string) => string,
  ) {
    this.assertActive();
    if (
      this.transactionDispatcher &&
      (this.pendingTransactions.length ||
        this.deferredHistoryMutations.length ||
        this.pendingHistoryOperation)
    ) {
      throw new Error("Cannot replace the collaboration dispatcher with pending transactions");
    }
    if (this.confirmedDocument === this.replica.document) {
      this.confirmedDocument = this.replica.document.fork();
    }
    this.transactionDispatcher = dispatcher;
    this.historyDispatcher = historyDispatcher ?? null;
    return () => {
      if (
        this.pendingTransactions.length ||
        this.deferredHistoryMutations.length ||
        this.pendingHistoryOperation
      ) {
        throw new Error("Cannot detach the collaboration dispatcher with pending transactions");
      }
      if (this.transactionDispatcher === dispatcher) {
        this.transactionDispatcher = null;
        this.historyDispatcher = null;
      }
    };
  }

  beginHistoryTransaction() {
    this.assertActive();
    if (this.historyDepth++ === 0) {
      const selection = [...this.store.selectedIds];
      this.activeGroup = {
        id: `history-${crypto.randomUUID()}`,
        serverBacked: false,
        forward: [],
        inverse: [],
        parts: [],
        selectionBefore: selection,
        selectionAfter: selection,
      };
    }
  }

  endHistoryTransaction() {
    if (this.historyDepth === 0) return;
    this.historyDepth -= 1;
    if (this.historyDepth > 0) return;
    this.finalizeDeferredHistoryMutations();
    this.finishActiveGroup();
  }

  cancelHistoryTransaction() {
    if (this.historyDepth === 0) return;
    const group = this.activeGroup;
    this.historyDepth = 0;
    this.activeGroup = null;
    this.deferredHistoryMutations = [];

    if (group?.inverse.length) {
      this.replica.apply(group.inverse);
      // With no dispatcher, the confirmed document follows local edits
      // immediately. Network-backed explicit groups are deferred, so their
      // confirmed document never received the gesture frames in the first
      // place and must not be rewound here.
      if (!this.transactionDispatcher) this.applyToDistinctConfirmedDocument(group.inverse);
    }
    if (group) this.restoreSelection(group.selectionBefore);
    this.syncHistoryState();
    this.notify();
  }

  recordSelectionChange(beforeIds: string[], afterIds: string[]) {
    const ownsGroup = this.historyDepth === 0;
    if (ownsGroup) this.beginHistoryTransaction();
    if (this.activeGroup) {
      // An explicit interaction group captures pointer-down selection in
      // beginHistoryTransaction. Marquee previews may update selection many
      // times, but cancelling must always return to that original snapshot.
      if (ownsGroup) this.activeGroup.selectionBefore = [...beforeIds];
      this.activeGroup.selectionAfter = [...afterIds];
    }
    if (ownsGroup) this.endHistoryTransaction();
  }

  executeMutation<T>(mutation: DocumentMutation, apply: () => T): T {
    if (this.historyPreviewId) {
      this.reportHistoryPreviewRefusal();
      throw new Error(HISTORY_PREVIEW_EDIT_ERROR);
    }
    return this.mutate(() => {
      const selectionBefore = [...this.store.selectedIds];
      try {
        if (
          mutation.type === "delete-subtree" &&
          !this.replica.document.records.has(mutation.nodeId)
        ) {
          return undefined as T;
        }
        const oldParentId =
          mutation.type === "write-html"
            ? (this.store.parentMap.get(mutation.targetNodeId) ?? null)
            : null;
        const topLevelIds =
          mutation.type === "delete-nodes"
            ? mutation.nodeIds.filter(
                (id) =>
                  !mutation.nodeIds.some(
                    (candidate) => candidate !== id && this.store.isDescendant(id, candidate),
                  ),
              )
            : [];
        const result = apply();

        switch (mutation.type) {
          case "create-root":
            this.acceptCommands([
              createRecordsCommand(
                this.store,
                this.replica.document.records,
                [result as DesignNode],
                null,
              ),
            ]);
            break;
          case "create-node":
            this.acceptCommands([
              createRecordsCommand(this.store, this.replica.document.records, [
                result as DesignNode,
              ]),
            ]);
            break;
          case "delete-subtree":
            this.acceptCommands([{ type: "deleteSubtree", nodeId: mutation.nodeId }]);
            break;
          case "move-node": {
            const commands = [
              createMoveRecordCommand(this.store, this.replica.document.records, mutation.nodeId),
              mutation.patchFields
                ? createPatchFieldsCommand(
                    this.store,
                    this.replica.document.records,
                    mutation.nodeId,
                  )
                : null,
            ].filter((command): command is LeafSemanticCommand => !!command);
            this.acceptCommands(commands);
            break;
          }
          case "patch-node": {
            const command = createPatchFieldsCommand(
              this.store,
              this.replica.document.records,
              mutation.nodeId,
            );
            if (command) this.acceptCommands([command]);
            break;
          }
          case "patch-nodes": {
            const commands = (result as string[])
              .map((id) => createPatchFieldsCommand(this.store, this.replica.document.records, id))
              .filter((command): command is LeafSemanticCommand => !!command);
            this.acceptCommands(commands);
            break;
          }
          case "set-pages": {
            // A page edit that changed nothing (a rename to the same text, or a
            // redundant sync from a caller that flushes the list twice) prepares
            // to a no-op command, which `prepareCommand` rejects. Drop it here
            // rather than letting it abort the surrounding group.
            const pages = collectStorePages(this.store);
            const basePages = this.replica.document.pages();
            if (!pageListsEqual(pages, basePages)) {
              this.acceptCommands([{ type: "setPages", pages, basePages }]);
            }
            break;
          }
          case "comment-records": {
            // Filtered against the canonical lane so a redundant write (the
            // same reaction toggled twice, a replayed delete) is dropped here
            // instead of letting prepare's "no effect" throw abort the group.
            const command = effectiveCommentRecordsCommand(
              this.replica.document.records,
              mutation.puts,
              mutation.deletes,
            );
            if (command) this.acceptCommands([command]);
            break;
          }
          case "paste-nodes":
            this.acceptPastedResults(result as PasteNodeResult[]);
            break;
          case "duplicate-nodes": {
            const created = (result as DuplicateNodeResult[])
              .map((entry) => this.store.getNode(entry.newId))
              .filter((node): node is DesignNode => !!node);
            if (created.length) {
              this.acceptCommands([
                createRecordsCommand(this.store, this.replica.document.records, created),
              ]);
            }
            break;
          }
          case "delete-nodes":
            this.acceptCommands(
              topLevelIds
                .filter((id) => this.replica.document.records.has(id))
                .map((nodeId) => ({ type: "deleteSubtree", nodeId })),
            );
            break;
          case "write-html": {
            const commands: LeafSemanticCommand[] = [];
            if (
              mutation.mode === "replace" &&
              this.replica.document.records.has(mutation.targetNodeId)
            ) {
              commands.push({ type: "deleteSubtree", nodeId: mutation.targetNodeId });
            }
            const nodes = result as DesignNode[];
            if (nodes.length) {
              commands.push(
                createRecordsCommand(
                  this.store,
                  this.replica.document.records,
                  nodes,
                  mutation.mode === "replace" ? oldParentId : undefined,
                ),
              );
            }
            this.acceptCommands(commands);
            break;
          }
        }

        return result;
      } catch (error) {
        this.replica.restoreStoreFromDocument();
        this.restoreSelection(selectionBefore);
        if (this.activeGroup) this.activeGroup.selectionAfter = [...selectionBefore];
        throw error;
      }
    });
  }

  undo() {
    if (this.historyDepth > 0) {
      this.historyDepth = 0;
      this.finalizeDeferredHistoryMutations();
      this.finishActiveGroup();
    }
    if (this.pendingTransactions.length || this.pendingHistoryOperation) return;
    const entry = this.undoStack.at(-1);
    if (!entry) return;
    if (entry.serverBacked && this.historyDispatcher) {
      const clientTxId = this.historyDispatcher("undo", entry.id);
      this.pendingHistoryOperation = { clientTxId, kind: "undo", group: entry };
      this.syncHistoryState();
      this.notify();
      return;
    }
    this.undoStack.pop();
    const plan = prepareLeafConditionalUndo(this.replica.document.records, entry.inverse);
    if (plan.patches.length) {
      this.replica.apply(plan.patches);
      this.applyToDistinctConfirmedDocument(plan.patches);
    }
    this.redoStack.push({
      group: entry,
      patches: invertLeafCanonicalPatches(plan.patches),
      selectionBefore: entry.selectionBefore,
      selectionAfter: entry.selectionAfter,
    });
    this.restoreSelection(entry.selectionBefore);
    this.syncHistoryState();
    this.notify();
  }

  redo() {
    if (this.historyDepth > 0) {
      this.historyDepth = 0;
      this.finalizeDeferredHistoryMutations();
      this.finishActiveGroup();
    }
    if (this.pendingTransactions.length || this.pendingHistoryOperation) return;
    const entry = this.redoStack.at(-1);
    if (!entry) return;
    if (entry.group.serverBacked && this.historyDispatcher) {
      const clientTxId = this.historyDispatcher("redo", entry.group.id);
      this.pendingHistoryOperation = { clientTxId, kind: "redo", entry };
      this.syncHistoryState();
      this.notify();
      return;
    }
    this.redoStack.pop();
    const plan = prepareLeafConditionalUndo(this.replica.document.records, entry.patches);
    if (plan.patches.length) {
      this.replica.apply(plan.patches);
      this.applyToDistinctConfirmedDocument(plan.patches);
    }
    const inverse = invertLeafCanonicalPatches(plan.patches);
    Object.assign(entry.group, {
      forward: plan.patches,
      inverse,
      parts: [
        {
          clientTxId: null,
          prepared: {
            forward: plan.patches,
            inverse,
            touchedNodeIds: collectPatchNodeIds(plan.patches),
          },
        },
      ],
      selectionBefore: entry.selectionBefore,
      selectionAfter: entry.selectionAfter,
    });
    this.undoStack.push(entry.group);
    this.restoreSelection(entry.selectionAfter);
    this.syncHistoryState();
    this.notify();
  }

  previewHistoryVersion(entryId: string) {
    this.assertActive();
    if (this.pendingTransactionCount > 0) {
      throw new Error("Wait for collaboration changes to sync before previewing history");
    }
    const target = this.snapshotForVersion(entryId);
    if (this.confirmedDocument === this.replica.document) {
      this.confirmedDocument = this.replica.document.fork();
    }
    this.replaceReplicaSnapshot(target);
    this.historyPreviewId = entryId;
    this.syncHistoryState();
    this.notify();
  }

  /**
   * The refusal above is the one place every UI edit path converges, so it is
   * where the user hears about it. A drag frame can arrive here many times a
   * second; one toast per window is enough to explain the locked document.
   */
  private reportHistoryPreviewRefusal() {
    const now = Date.now();
    if (now - this.lastHistoryPreviewRefusalAt < HISTORY_PREVIEW_REFUSAL_TOAST_INTERVAL_MS) return;
    this.lastHistoryPreviewRefusalAt = now;
    reportEditorError(HISTORY_PREVIEW_EDIT_MESSAGE, this.store);
  }

  exitHistoryPreview() {
    if (!this.historyPreviewId) return;
    this.replaceReplicaSnapshot(this.confirmedSnapshot);
    this.historyPreviewId = null;
    this.syncHistoryState();
    this.notify();
  }

  restoreHistoryVersion(entryId = this.historyPreviewId ?? "") {
    this.assertActive();
    if (this.pendingTransactionCount > 0) {
      throw new Error("Wait for collaboration changes to sync before restoring history");
    }
    const target = this.snapshotForVersion(entryId);
    if (this.historyPreviewId) this.exitHistoryPreview();
    const commands = createSnapshotReplacementCommands(this.replica.document, target);
    if (!commands.length) return;
    this.beginHistoryTransaction();
    try {
      this.acceptCommands(commands, true);
    } finally {
      this.endHistoryTransaction();
    }
  }

  replaceDocumentSnapshot(snapshot: LeafRecordSnapshot) {
    this.assertActive();
    if (this.pendingTransactionCount > 0 || this.historyPreviewId) {
      throw new Error("Wait for collaboration changes to sync before replacing the document");
    }
    const commands = createSnapshotReplacementCommands(this.replica.document, snapshot);
    if (!commands.length) return;
    this.beginHistoryTransaction();
    try {
      this.acceptCommands(commands, true);
    } finally {
      this.endHistoryTransaction();
    }
  }

  private mutate<T>(callback: () => T): T {
    const ownsGroup = this.historyDepth === 0;
    if (ownsGroup) {
      this.implicitHistoryDepth += 1;
      this.beginHistoryTransaction();
    }
    try {
      return callback();
    } finally {
      if (ownsGroup) {
        try {
          this.endHistoryTransaction();
        } finally {
          this.implicitHistoryDepth -= 1;
        }
      }
    }
  }

  private acceptCommands(commands: LeafSemanticCommand[], applyToStore = false) {
    if (!commands.length) return;
    const batches = timeLeafPerfTrace("collaboration.prepare", () =>
      batchLeafSemanticCommands(this.replica.document, commands),
    );
    for (const batch of batches) {
      this.acceptPrepared(batch.prepared, batch.commands, applyToStore);
    }
  }

  private acceptPrepared(
    prepared: LeafPreparedTransaction,
    commands: LeafSemanticCommand[],
    applyToStore = false,
  ) {
    timeLeafPerfTrace("collaboration.applyLocal", () => {
      if (applyToStore) this.replica.apply(prepared.forward);
      else this.replica.document.apply(prepared.forward);
    });
    // Comment-lane transactions never ride the active canvas group, no matter
    // what transaction is open around them (a gesture, a text-editing session,
    // a delete whose anchor conversion follows it). Both authorities derive
    // per-group journal inverses, so a comment transaction tagged with a
    // canvas group id would be rewound by that group's undo — Cmd+Z deleting
    // a conversation. A detached group keeps the dispatch and rebase
    // bookkeeping intact while guaranteeing the id is never a history target.
    const commentOnly =
      prepared.forward.length > 0 &&
      prepared.forward.every((patch) => patch.type === "commentRecords");
    const isExplicitHistoryMutation =
      !commentOnly && this.historyDepth > 0 && this.implicitHistoryDepth === 0;
    if (!isExplicitHistoryMutation) this.acceptedTransactions += 1;
    const group = commentOnly ? this.createDetachedCommentGroup() : this.activeGroup;
    if (group) {
      const part: HistoryPart = { clientTxId: null, prepared };
      group.parts.push(part);
      if (this.transactionDispatcher) {
        if (isExplicitHistoryMutation) {
          this.deferredHistoryMutations.push({
            commands: structuredClone(commands),
            part,
          });
        } else {
          try {
            part.clientTxId = this.transactionDispatcher(structuredClone(commands), group.id);
            this.pendingTransactions.push({ commands: structuredClone(commands), group, part });
          } catch (error) {
            group.parts.pop();
            this.replica.apply(prepared.inverse);
            throw error;
          }
        }
      } else {
        this.applyToDistinctConfirmedDocument(prepared.forward);
      }
      rebuildHistoryGroup(group);
      group.selectionAfter = [...this.store.selectedIds];
    }
    recordLeafPerfTrace("collaboration.localCommit");
    if (!isExplicitHistoryMutation) this.notify();
  }

  /** A history group that exists only for dispatch/ack/rebase bookkeeping. */
  private createDetachedCommentGroup(): HistoryGroup {
    const selection = [...this.store.selectedIds];
    return {
      id: `history-${crypto.randomUUID()}`,
      serverBacked: false,
      forward: [],
      inverse: [],
      parts: [],
      selectionBefore: selection,
      selectionAfter: selection,
    };
  }

  private finalizeDeferredHistoryMutations() {
    const deferred = this.deferredHistoryMutations;
    this.deferredHistoryMutations = [];
    const group = this.activeGroup;
    if (!group || deferred.length === 0) {
      if (group?.forward.length && this.implicitHistoryDepth === 0) {
        this.acceptedTransactions += 1;
      }
      return;
    }

    this.preserveSelection(() => {
      for (let index = deferred.length - 1; index >= 0; index--) {
        this.replica.apply(deferred[index].part.prepared.inverse);
        removeHistoryPart(group, deferred[index].part);
      }

      const compacted = compactSemanticCommands(deferred.flatMap((entry) => entry.commands));
      const effective = selectEffectiveCommands(this.replica.document, compacted);
      if (effective.length === 0) return;

      const batches = batchLeafSemanticCommands(this.replica.document, effective);
      const applied: HistoryPart[] = [];
      try {
        for (const batch of batches) {
          this.replica.apply(batch.prepared.forward);
          const part: HistoryPart = { clientTxId: null, prepared: batch.prepared };
          group.parts.push(part);
          applied.push(part);
          if (!this.transactionDispatcher) {
            this.applyToDistinctConfirmedDocument(batch.prepared.forward);
          } else {
            part.clientTxId = this.transactionDispatcher(structuredClone(batch.commands), group.id);
            this.pendingTransactions.push({
              commands: structuredClone(batch.commands),
              group,
              part,
            });
          }
        }
        rebuildHistoryGroup(group);
        this.acceptedTransactions += 1;
      } catch (error) {
        for (let index = applied.length - 1; index >= 0; index -= 1) {
          const part = applied[index]!;
          if (part.clientTxId) {
            this.pendingTransactions = this.pendingTransactions.filter(
              (entry) => entry.part !== part,
            );
          }
          removeHistoryPart(group, part);
          this.replica.apply(part.prepared.inverse);
        }
        rebuildHistoryGroup(group);
        throw error;
      }
    });
  }

  receiveAuthoritativeCommit(commit: LeafCommitMessage) {
    this.assertActive();
    if (this.historyPreviewId) this.exitHistoryPreview();
    const pendingUser = this.pendingTransactions.find(
      (entry) => entry.part.clientTxId === commit.clientTxId,
    );
    if (pendingUser && (commit.kind !== "user" || commit.historyGroupId !== pendingUser.group.id)) {
      throw new Error("The authoritative user commit does not match its local history group");
    }
    const pendingHistory = this.pendingHistoryOperation;
    if (pendingHistory?.clientTxId === commit.clientTxId) {
      const group =
        pendingHistory.kind === "undo" ? pendingHistory.group : pendingHistory.entry.group;
      if (
        commit.kind !== pendingHistory.kind ||
        commit.historyGroupId !== group.id ||
        (pendingHistory.kind === "undo" && this.undoStack.at(-1) !== group) ||
        (pendingHistory.kind === "redo" && this.redoStack.at(-1) !== pendingHistory.entry)
      ) {
        throw new Error("The authoritative history commit does not match its local request");
      }
    }
    runInAction(() => {
      const touchedGroups = new Set<HistoryGroup>();
      this.preserveTransientSessionState(() => {
        const pending = [...this.pendingTransactions];
        const editingTextNodeId = this.store.editingTextNodeId;
        const preserveTextEditingSessionIds = editingTextNodeId
          ? new Set([editingTextNodeId])
          : undefined;
        this.rollbackDeferredHistoryMutations(preserveTextEditingSessionIds);
        this.rollbackPendingTransactions(pending, preserveTextEditingSessionIds);

        this.confirmedDocument.apply(commit.effectivePatches);
        this.replica.apply(commit.effectivePatches);
        this.recordAuthoritativeVersion(commit);

        const acknowledgedIndex = this.pendingTransactions.findIndex(
          (entry) => entry.part.clientTxId === commit.clientTxId,
        );
        if (acknowledgedIndex >= 0) {
          const [acknowledged] = this.pendingTransactions.splice(acknowledgedIndex, 1);
          acknowledged.part.prepared = {
            forward: commit.effectivePatches,
            inverse: invertLeafCanonicalPatches(commit.effectivePatches),
            touchedNodeIds: collectPatchNodeIds(commit.effectivePatches),
          };
          acknowledged.group.serverBacked = true;
          touchedGroups.add(acknowledged.group);
        }

        for (const entry of this.pendingTransactions) {
          entry.part.prepared = this.prepareRebasedCommands(entry.commands);
          this.replica.apply(entry.part.prepared.forward);
          touchedGroups.add(entry.group);
        }
        this.replayDeferredHistoryMutations();
      });
      for (const group of touchedGroups) rebuildHistoryGroup(group);
      if (this.activeGroup) rebuildHistoryGroup(this.activeGroup);
      this.completePendingHistoryOperation(commit);
      this.syncHistoryState();
      this.notify();
    });
  }

  /** Clears a durable optimistic request already represented by an installed snapshot. */
  acknowledgeAuthoritativeSnapshotCommit(commit: LeafCommitMessage) {
    this.assertActive();
    if (this.historyPreviewId) this.exitHistoryPreview();
    const pendingUser = this.pendingTransactions.find(
      (entry) => entry.part.clientTxId === commit.clientTxId,
    );
    if (pendingUser && (commit.kind !== "user" || commit.historyGroupId !== pendingUser.group.id)) {
      throw new Error("The snapshot acknowledgement does not match its local history group");
    }
    const pendingHistory = this.pendingHistoryOperation;
    if (pendingHistory?.clientTxId === commit.clientTxId) {
      const group =
        pendingHistory.kind === "undo" ? pendingHistory.group : pendingHistory.entry.group;
      if (commit.kind !== pendingHistory.kind || commit.historyGroupId !== group.id) {
        throw new Error("The snapshot history acknowledgement does not match its local request");
      }
    }

    const touchedGroups = new Set<HistoryGroup>();
    // Rollback/replay transiently removes optimistically created pages, the
    // same as the authoritative-commit path; without the wrapper the
    // removed-active-page fallback strands the user on the first page.
    this.preserveTransientSessionState(() => {
      const pending = [...this.pendingTransactions];
      const editingTextNodeId = this.store.editingTextNodeId;
      const preserveTextEditingSessionIds = editingTextNodeId
        ? new Set([editingTextNodeId])
        : undefined;
      this.rollbackDeferredHistoryMutations(preserveTextEditingSessionIds);
      this.rollbackPendingTransactions(pending, preserveTextEditingSessionIds);
      const acknowledgedIndex = this.pendingTransactions.findIndex(
        (entry) => entry.part.clientTxId === commit.clientTxId,
      );
      if (acknowledgedIndex >= 0) {
        const [acknowledged] = this.pendingTransactions.splice(acknowledgedIndex, 1);
        acknowledged.group.serverBacked = true;
        touchedGroups.add(acknowledged.group);
      }
      for (const entry of this.pendingTransactions) {
        entry.part.prepared = this.prepareRebasedCommands(entry.commands);
        this.replica.apply(entry.part.prepared.forward);
        touchedGroups.add(entry.group);
      }
      this.replayDeferredHistoryMutations();
    });
    for (const group of touchedGroups) rebuildHistoryGroup(group);
    if (this.activeGroup) rebuildHistoryGroup(this.activeGroup);
    this.completePendingHistoryOperation(commit);
    this.recordAuthoritativeVersion(commit);
    this.syncHistoryState();
    this.notify();
  }

  private completePendingHistoryOperation(commit: LeafCommitMessage) {
    const pending = this.pendingHistoryOperation;
    if (!pending || pending.clientTxId !== commit.clientTxId) return;
    const group = pending.kind === "undo" ? pending.group : pending.entry.group;
    if (commit.kind !== pending.kind || commit.historyGroupId !== group.id) {
      throw new Error("The authoritative history commit does not match its local request");
    }

    if (pending.kind === "undo") {
      if (this.undoStack.at(-1) !== group) {
        throw new Error("The authoritative undo no longer matches the local history head");
      }
      this.undoStack.pop();
      this.redoStack.push({
        group,
        patches: invertLeafCanonicalPatches(commit.effectivePatches),
        selectionBefore: group.selectionBefore,
        selectionAfter: group.selectionAfter,
      });
      this.restoreSelection(group.selectionBefore);
    } else {
      if (this.redoStack.at(-1) !== pending.entry) {
        throw new Error("The authoritative redo no longer matches the local history head");
      }
      this.redoStack.pop();
      const inverse = invertLeafCanonicalPatches(commit.effectivePatches);
      Object.assign(group, {
        serverBacked: true,
        forward: commit.effectivePatches,
        inverse,
        parts: [
          {
            clientTxId: commit.clientTxId,
            prepared: {
              forward: commit.effectivePatches,
              inverse,
              touchedNodeIds: collectPatchNodeIds(commit.effectivePatches),
            },
          },
        ],
      });
      this.undoStack.push(group);
      this.restoreSelection(group.selectionAfter);
    }
    this.pendingHistoryOperation = null;
  }

  /**
   * Removes a server-rejected optimistic transaction, then deterministically
   * rebuilds the remaining pending overlay over confirmed state. Transactions
   * that depended on the rejected result are returned so the transport can
   * remove and resequence them before sending another queue head.
   */
  rejectAuthoritativeTransaction(clientTxId: string): string[] {
    this.assertActive();
    if (this.pendingHistoryOperation?.clientTxId === clientTxId) {
      this.pendingHistoryOperation = null;
      this.syncHistoryState();
      this.notify();
      return [];
    }
    if (!this.pendingTransactions.some((entry) => entry.part.clientTxId === clientTxId)) return [];
    return this.rejectPendingTransactions(new Set([clientTxId])).filter(
      (rejectedId) => rejectedId !== clientTxId,
    );
  }

  rejectAllPendingTransactions(): string[] {
    this.assertActive();
    const userIds = new Set(
      this.pendingTransactions
        .map((entry) => entry.part.clientTxId)
        .filter((clientTxId): clientTxId is string => clientTxId !== null),
    );
    const historyId = this.pendingHistoryOperation?.clientTxId ?? null;
    if (this.pendingHistoryOperation) {
      this.pendingHistoryOperation = null;
    }
    const rejected = this.rejectPendingTransactions(userIds);
    this.syncHistoryState();
    this.notify();
    return historyId ? [...rejected, historyId] : rejected;
  }

  private rejectPendingTransactions(initialRejectedIds: Set<string>): string[] {
    if (initialRejectedIds.size === 0) return [];

    const rejectedIds = new Set(initialRejectedIds);
    // Rollback/replay transiently removes optimistically created pages, the
    // same as the authoritative-commit path. preserveActivePage's existence
    // check keeps the fallback for a page whose creation was itself rejected.
    this.preserveTransientSessionState(() => {
      const pending = [...this.pendingTransactions];
      this.rollbackDeferredHistoryMutations();
      this.rollbackPendingTransactions(pending);

      const retained: PendingLocalTransaction[] = [];
      const touchedGroups = new Set<HistoryGroup>();
      for (const entry of pending) {
        const clientTxId = entry.part.clientTxId;
        if (clientTxId && rejectedIds.has(clientTxId)) {
          removeHistoryPart(entry.group, entry.part);
          touchedGroups.add(entry.group);
          continue;
        }

        try {
          entry.part.prepared = this.prepareRebasedCommands(entry.commands);
          this.replica.apply(entry.part.prepared.forward);
          retained.push(entry);
          touchedGroups.add(entry.group);
        } catch {
          if (clientTxId) rejectedIds.add(clientTxId);
          removeHistoryPart(entry.group, entry.part);
          touchedGroups.add(entry.group);
        }
      }
      this.pendingTransactions = retained;
      this.replayDeferredHistoryMutations();
      this.acceptedTransactions = Math.max(0, this.acceptedTransactions - rejectedIds.size);

      for (const group of touchedGroups) {
        rebuildHistoryGroup(group);
        if (group.parts.length === 0) {
          this.undoStack = this.undoStack.filter((entry) => entry !== group);
          if (this.activeGroup === group) this.activeGroup = null;
        }
      }
      this.redoStack = [];
    });
    this.syncHistoryState();
    this.notify();
    return [...rejectedIds];
  }

  private rollbackPendingTransactions(
    pending: readonly PendingLocalTransaction[],
    preserveTextEditingSessionIds?: ReadonlySet<string>,
  ) {
    for (let index = pending.length - 1; index >= 0; index--) {
      this.replica.apply(pending[index].part.prepared.inverse, {
        preserveTextEditingSessionIds,
      });
    }
  }

  /**
   * Re-prepare a pending transaction against the rebased document.
   *
   * A local command can become a no-op once an authoritative commit lands — a
   * peer wrote the same field value, or converged on the same page list — and
   * `prepare` reports that by throwing. Dropping just those keeps the rebase
   * going; letting one redundant edit throw would strand the whole pending
   * queue. Any other precondition failure still surfaces.
   */
  private prepareRebasedCommands(commands: LeafSemanticCommand[]): LeafPreparedTransaction {
    const effective = selectEffectiveCommands(this.replica.document, commands);
    if (effective.length === 0) return { forward: [], inverse: [], touchedNodeIds: [] };
    return this.replica.document.prepare(effective);
  }

  private rollbackDeferredHistoryMutations(preserveTextEditingSessionIds?: ReadonlySet<string>) {
    for (let index = this.deferredHistoryMutations.length - 1; index >= 0; index--) {
      this.replica.apply(this.deferredHistoryMutations[index].part.prepared.inverse, {
        preserveTextEditingSessionIds,
      });
    }
  }

  private replayDeferredHistoryMutations() {
    for (const entry of this.deferredHistoryMutations) {
      entry.part.prepared = this.prepareRebasedCommands(entry.commands);
      this.replica.apply(entry.part.prepared.forward);
    }
  }

  private applyToDistinctConfirmedDocument(patches: readonly LeafCanonicalPatch[]) {
    if (this.confirmedDocument !== this.replica.document) {
      this.confirmedDocument.apply(patches);
    }
  }

  private acceptPastedResults(results: readonly PasteNodeResult[]) {
    const created = timeLeafPerfTrace("collaboration.paste.lookup", () =>
      results
        .map((result) => this.store.getNode(result.newId))
        .filter((node): node is DesignNode => !!node),
    );
    if (!created.length) return;
    const command = timeLeafPerfTrace("collaboration.paste.encode", () =>
      createRecordsCommand(this.store, this.replica.document.records, created),
    );
    this.acceptCommands([command]);
  }

  private finishActiveGroup() {
    const group = this.activeGroup;
    this.activeGroup = null;
    this.historyDepth = 0;
    // Comment transactions ride detached groups (see acceptPrepared), so the
    // active group only ever holds canvas parts and Cmd+Z cannot delete a
    // conversation.
    if (group && (group.forward.length || !sameIds(group.selectionBefore, group.selectionAfter))) {
      this.undoStack.push(group);
      this.redoStack = [];
    }
    this.syncHistoryState();
    this.notify();
  }

  /**
   * Rolling back deferred or pending mutations deletes freshly created
   * records, and unregistering a node prunes it from the live selection — so a
   * node created and selected inside the wrapped span (a pasted image, a drawn
   * shape) would come back deselected after the replay recreates it. Capture
   * the selection first and restore whatever survives, even when the span
   * throws. `restoreSelection` re-filters against the post-replay node map, so
   * nodes from genuinely rejected creates still drop out.
   */
  private preserveSelection<T>(fn: () => T): T {
    const selectionBefore = [...this.store.selectedIds];
    try {
      return fn();
    } finally {
      this.restoreSelection(selectionBefore);
    }
  }

  /** Every rollback/replay cycle keeps the same transient session state alive. */
  private preserveTransientSessionState<T>(fn: () => T): T {
    return this.preserveGeneratedImageJobs(() =>
      this.preserveActivePage(() => this.preserveSelection(fn)),
    );
  }

  /**
   * Keep in-flight image generation jobs alive across a rollback/replay cycle.
   * Rolling back a pending create unregisters the target node, which drops its
   * renderer-local job, and the replay recreates the node still marked
   * "generating" — the interrupt sweep would then fail a request that is still
   * running (every generation started by write_html or create_artboard died
   * this way on its first acknowledgement). Restore every job whose node
   * survives the round trip; a genuinely rejected target keeps its job dropped.
   */
  private preserveGeneratedImageJobs<T>(fn: () => T): T {
    const jobsBefore = new Map(this.store.generatedImageJobs);
    try {
      return fn();
    } finally {
      const restored = [...jobsBefore].filter(
        ([nodeId]) => !this.store.generatedImageJobs.has(nodeId) && this.store.nodeMap.has(nodeId),
      );
      if (restored.length > 0) {
        runInAction(() => {
          for (const [nodeId, job] of restored) this.store.generatedImageJobs.set(nodeId, job);
        });
      }
    }
  }

  /**
   * Keep the active page stable across a rollback/replay cycle. Rolling back
   * an optimistic page-create removes the page for a moment, which trips the
   * removed-active-page fallback in applyPagesToStore and strands the user on
   * the first page even though the replay immediately restores their page.
   * Restore activation only when the page still exists afterwards, so a page
   * that is genuinely gone after reconciliation keeps the fallback behavior.
   */
  private preserveActivePage<T>(fn: () => T): T {
    const activePageIdBefore = this.store.activePageId;
    try {
      return fn();
    } finally {
      if (
        this.store.activePageId !== activePageIdBefore &&
        this.store.pages.some((page) => page.id === activePageIdBefore)
      ) {
        this.store.setActivePage(activePageIdBefore, { allowDuringPointerGesture: true });
      }
    }
  }

  private restoreSelection(ids: string[]) {
    const next = ids.filter((id) => this.store.nodeMap.has(id));
    // Runs on every authoritative commit; replacing the observable Set when
    // nothing changed would re-render the selection chrome for no reason.
    if (
      next.length === this.store.selectedIds.size &&
      next.every((id) => this.store.selectedIds.has(id))
    ) {
      return;
    }
    runInAction(() => {
      this.store.selectedIds = new Set(next);
    });
  }

  private syncHistoryState() {
    this.store.setHistoryState(this.canUndo, this.canRedo, this.pendingTransactionCount === 0);
    const currentId = this.versions.at(-1)?.id ?? null;
    const entries = this.versions.map((version, index) => ({
      actor: version.actor,
      id: version.id,
      isCurrent: version.id === currentId,
      message: version.kind === "user" ? null : version.kind,
      timestamp: version.timestamp,
      versionNumber: index + 1,
    }));
    this.store.setDocumentHistoryState(
      entries,
      entries.find((entry) => entry.id === this.historyPreviewId) ?? null,
    );
  }

  private recordAuthoritativeVersion(commit: LeafCommitMessage) {
    // Comment activity is not part of the drawing's version timeline: a
    // comment-only commit records no version entry, and mixed commits drop
    // their comment patches from the stored inverse. Version reconstruction
    // (`snapshotForVersion` → `replaceReplicaSnapshot`) never rewrites the
    // comment lane, so an inverse chain with no comment patches stays
    // internally consistent.
    const canvasPatches = commit.effectivePatches.filter(
      (patch) => patch.type !== "commentRecords",
    );
    if (canvasPatches.length === 0) return;
    const inverse = invertLeafCanonicalPatches(canvasPatches);
    const previous = this.versions.at(-1);
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
      return;
    }
    this.versions.push({
      actor: commit.actorId,
      historyGroupId: commit.historyGroupId,
      id: `${commit.streamEpoch}:${commit.revision}`,
      inverse,
      kind: commit.kind,
      revision: commit.revision,
      streamEpoch: commit.streamEpoch,
      timestamp: Date.now(),
    });
    pruneUnreconstructibleVersions(this.versions);
  }

  private snapshotForVersion(entryId: string): LeafRecordSnapshot {
    const index = this.versions.findIndex((version) => version.id === entryId);
    if (index < 0) throw new Error("History version not found");
    const document = this.confirmedDocument.fork();
    for (let cursor = this.versions.length - 1; cursor > index; cursor -= 1) {
      document.apply(this.versions[cursor]!.inverse);
    }
    return document.recordSnapshot();
  }

  private replaceReplicaSnapshot(snapshot: LeafRecordSnapshot) {
    // Replacement can delete-and-recreate records, which prunes those nodes
    // from the live selection.
    this.preserveSelection(() => {
      const commands = createSnapshotReplacementCommands(this.replica.document, snapshot);
      for (const batch of batchLeafSemanticCommands(this.replica.document, commands)) {
        this.replica.apply(batch.prepared.forward);
      }
    });
  }

  private assertActive() {
    if (this.disposed) throw new Error("Collaboration controller is disposed");
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }
}

/** Collapses uninterrupted property frames into one final property intent per node. */
function compactSemanticCommands(commands: readonly LeafSemanticCommand[]) {
  const compacted: LeafSemanticCommand[] = [];
  const patches = new Map<
    string,
    Map<string, Extract<LeafSemanticCommand, { type: "patchFields" }>["mutations"][number]>
  >();

  const flushPatches = () => {
    for (const [nodeId, mutations] of patches) {
      compacted.push({
        type: "patchFields",
        nodeId,
        mutations: [...mutations.values()].map((mutation) => structuredClone(mutation)),
      });
    }
    patches.clear();
  };

  for (const command of commands) {
    if (command.type !== "patchFields") {
      flushPatches();
      compacted.push(structuredClone(command));
      continue;
    }
    let mutations = patches.get(command.nodeId);
    if (!mutations) {
      mutations = new Map();
      patches.set(command.nodeId, mutations);
    }
    for (const mutation of command.mutations) {
      const key =
        mutation.type === "setField" ? `field:${mutation.field}` : `style:${mutation.key}`;
      mutations.set(key, structuredClone(mutation));
    }
  }
  flushPatches();
  return compacted;
}

/** `prepareCommand` messages that mean "this command changes nothing". */
const NO_EFFECT_ERRORS = new Set([
  "patchFields has no effect",
  "setPages has no effect",
  "commentRecords has no effect",
]);

function selectEffectiveCommands(
  document: LeafReferenceDocument,
  commands: readonly LeafSemanticCommand[],
) {
  const working = document.fork();
  const effective: LeafSemanticCommand[] = [];
  for (const command of commands) {
    try {
      const prepared = working.prepare([command]);
      working.apply(prepared.forward);
      effective.push(command);
    } catch (error) {
      // Compaction can turn a command into a no-op — two writes to the same
      // field, or a page created and removed inside one history transaction.
      // Those are dropped rather than aborting the group; any other failure is
      // a real precondition violation and must surface.
      if (error instanceof Error && NO_EFFECT_ERRORS.has(error.message)) continue;
      throw error;
    }
  }
  return effective;
}

function createInitialVersion(): CollaborationVersionMetadata {
  return {
    actor: "Leaf",
    historyGroupId: "initial",
    id: `initial:${crypto.randomUUID()}`,
    inverse: [],
    kind: "user",
    revision: 0,
    streamEpoch: "local",
    timestamp: Date.now(),
  };
}

function createSnapshotReplacementCommands(
  document: LeafReferenceDocument,
  snapshot: LeafRecordSnapshot,
): LeafSemanticCommand[] {
  const pages = getLeafPages(snapshot);
  const pagesChanged = !pageListsEqual(pages, document.pages());
  // The comment lane replaces along with the records — a merged branch's
  // threads reach the source only through these commands. History snapshots
  // carry the current lane unchanged, so this diff is empty there.
  const currentComments = new Map(document.comments().map((record) => [record.id, record]));
  const targetComments = new Map(getLeafComments(snapshot).map((record) => [record.id, record]));
  const commentPuts: LeafCommentRecord[] = [];
  const commentDeletes: string[] = [];
  for (const id of currentComments.keys()) {
    if (!targetComments.has(id)) commentDeletes.push(id);
  }
  for (const [id, record] of targetComments) {
    const current = currentComments.get(id);
    if (!current || JSON.stringify(current) !== JSON.stringify(record)) {
      commentPuts.push(structuredClone(record));
    }
  }
  const commentsChanged = commentPuts.length > 0 || commentDeletes.length > 0;
  if (
    !pagesChanged &&
    !commentsChanged &&
    sameRecordSnapshots(document.snapshot(), snapshot.records)
  ) {
    return [];
  }

  const commands: LeafSemanticCommand[] = [];
  // Clear the old document FIRST. Applying setPages before the deletes would
  // retire a page while its roots are still attached, and applyPagesToStore
  // folds the roots of a vanished page onto the first surviving one — so the
  // deletes would then be chasing nodes that had already been moved.
  for (const record of document.records.values()) {
    if (record.parentId === null) commands.push({ type: "deleteSubtree", nodeId: record.id });
  }
  // Pages before the new records, though: a root names the page it belongs to,
  // and a peer cannot route one to a page it has not been told about yet.
  if (pagesChanged) commands.push({ type: "setPages", pages: structuredClone(pages) });
  if (snapshot.records.length) {
    commands.push({ type: "createRecords", records: structuredClone(snapshot.records) });
  }
  // Chunked to the per-command comment cap; batching passes these through.
  let putIndex = 0;
  let deleteIndex = 0;
  while (putIndex < commentPuts.length || deleteIndex < commentDeletes.length) {
    const puts = commentPuts.slice(putIndex, putIndex + LEAF_MAX_COMMENT_RECORDS_PER_COMMAND);
    putIndex += puts.length;
    const deletes = commentDeletes.slice(
      deleteIndex,
      deleteIndex + LEAF_MAX_COMMENT_RECORDS_PER_COMMAND - puts.length,
    );
    deleteIndex += deletes.length;
    commands.push({ type: "commentRecords", puts, deletes });
  }
  return commands;
}

function sameRecordSnapshots(
  left: readonly LeafRecordSnapshot["records"][number][],
  right: readonly LeafRecordSnapshot["records"][number][],
) {
  if (left.length !== right.length) return false;
  const rightById = new Map(right.map((record) => [record.id, record]));
  return left.every(
    (record) => JSON.stringify(record) === JSON.stringify(rightById.get(record.id)),
  );
}
