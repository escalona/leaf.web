/**
 * Comment verbs: the only place comment records are composed and written.
 *
 * Every verb takes ids, re-reads the latest record from the store projection,
 * and patches only the fields it owns — a stale snapshot captured before a
 * remote edit must never resurrect a deleted record or drag a moved pin back.
 * Writes go through `EditorRuntime.updateCommentRecords`, which syncs durably
 * but stays out of the canvas undo stack.
 */
import {
  createLeafCommentReactionId,
  type LeafCommentAnchor,
  type LeafCommentMessageRecord,
  type LeafCommentRecord,
  type LeafCommentThreadRecord,
} from "../shared/collaboration";
import type { EditorStore } from "../state/EditorStore";

/** Fixed reaction palette. */
export const COMMENT_REACTION_EMOJI = [
  "👍",
  "👎",
  "❤️",
  "🎉",
  "😄",
  "😮",
  "😢",
  "🙏",
  "👀",
  "🔥",
] as const;

export const MAX_COMMENT_BODY_LENGTH = 10_000;

function author(store: EditorStore) {
  // Offline and desktop sessions have no synced identity; "local" matches the
  // single-actor world those sessions run in.
  return store.commentAuthor ?? { id: "local", name: null };
}

function thread(store: EditorStore, threadId: string): LeafCommentThreadRecord | null {
  const record = store.commentRecords.get(threadId);
  return record?.kind === "thread" ? record : null;
}

function message(store: EditorStore, commentId: string): LeafCommentMessageRecord | null {
  const record = store.commentRecords.get(commentId);
  return record?.kind === "comment" ? record : null;
}

export function threadComments(store: EditorStore, threadId: string): LeafCommentMessageRecord[] {
  const comments: LeafCommentMessageRecord[] = [];
  for (const record of store.commentRecords.values()) {
    if (record.kind === "comment" && record.threadId === threadId) comments.push(record);
  }
  return comments.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export function commentReactions(store: EditorStore, commentId: string) {
  const reactions = [];
  for (const record of store.commentRecords.values()) {
    if (record.kind === "reaction" && record.commentId === commentId) reactions.push(record);
  }
  return reactions.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** Threads on a page, newest first. */
export function pageThreads(store: EditorStore, pageId: string): LeafCommentThreadRecord[] {
  const threads: LeafCommentThreadRecord[] = [];
  for (const record of store.commentRecords.values()) {
    if (record.kind === "thread" && record.pageId === pageId) threads.push(record);
  }
  return threads.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

export function allThreads(store: EditorStore): LeafCommentThreadRecord[] {
  const threads: LeafCommentThreadRecord[] = [];
  for (const record of store.commentRecords.values()) {
    if (record.kind === "thread") threads.push(record);
  }
  return threads;
}

/**
 * Whether a thread passes the document-wide comment filters. Shared by the
 * sidebar list and the canvas pins overlay so both always show the same set.
 */
export function threadMatchesFilters(store: EditorStore, thread: LeafCommentThreadRecord): boolean {
  // A thread whose page was deleted stays in the document (comment records
  // sit outside canvas undo, so the page can come back) but has nowhere to be
  // shown until it does.
  if (!threadPageExists(store, thread)) return false;
  const filters = store.commentFilters;
  if (!filters.showResolved && thread.resolvedAt !== null) return false;
  if (filters.pageId && thread.pageId !== filters.pageId) return false;
  if (filters.authorId) {
    const participates =
      thread.createdBy === filters.authorId ||
      threadComments(store, thread.id).some((comment) => comment.authorId === filters.authorId);
    if (!participates) return false;
  }
  return true;
}

/** Whether the page a thread points at is still in the document. */
export function threadPageExists(store: EditorStore, thread: LeafCommentThreadRecord): boolean {
  return store.pages.some((page) => page.id === thread.pageId);
}

/** Unread = someone else wrote it and this account has no receipt for it. */
function isCommentUnread(store: EditorStore, comment: LeafCommentMessageRecord): boolean {
  const selfId = store.commentAuthor?.id ?? "local";
  return comment.authorId !== selfId && !store.commentReadIds.has(comment.id);
}

export function threadHasUnread(store: EditorStore, threadId: string): boolean {
  return threadComments(store, threadId).some((comment) => isCommentUnread(store, comment));
}

function normalizedBody(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_COMMENT_BODY_LENGTH);
}

/**
 * Posts the in-flight placement draft as a new thread with its first comment.
 * Returns the new thread id, or null when there is nothing to post.
 */
export function postPendingComment(store: EditorStore, body: string): string | null {
  const draft = store.pendingCommentDraft;
  const text = normalizedBody(body);
  if (!draft || !text) return null;
  const { id: authorId, name } = author(store);
  const now = Date.now();
  const threadId = `cthread_${crypto.randomUUID()}`;
  // The anchor lifecycle converts a draft whose node is deleted mid-compose to
  // the pin's point; this covers a node that vanished without passing through
  // it (a history preview, a resync). A thread anchored to a missing node
  // would have no pin at all.
  const anchor: LeafCommentAnchor =
    draft.anchor.type === "node" && !store.getNode(draft.anchor.nodeId)
      ? { type: "point", x: draft.canvasPoint.x, y: draft.canvasPoint.y }
      : draft.anchor;
  const threadRecord: LeafCommentThreadRecord = {
    id: threadId,
    kind: "thread",
    pageId: draft.pageId,
    anchor,
    createdBy: authorId,
    createdByName: name,
    createdAt: now,
    resolvedBy: null,
    resolvedAt: null,
  };
  const commentRecord: LeafCommentMessageRecord = {
    id: `ccomment_${crypto.randomUUID()}`,
    kind: "comment",
    threadId,
    pageId: threadRecord.pageId,
    authorId,
    authorName: name,
    createdAt: now,
    editedAt: null,
    body: text,
  };
  store.runtime.updateCommentRecords([threadRecord, commentRecord]);
  store.setPendingCommentDraft(null);
  store.setOpenCommentThread(threadId);
  store.setTool("select");
  return threadId;
}

export function replyToThread(store: EditorStore, threadId: string, body: string): string | null {
  const target = thread(store, threadId);
  const text = normalizedBody(body);
  if (!target || !text) return null;
  const { id: authorId, name } = author(store);
  const record: LeafCommentMessageRecord = {
    id: `ccomment_${crypto.randomUUID()}`,
    kind: "comment",
    threadId,
    pageId: target.pageId,
    authorId,
    authorName: name,
    createdAt: Date.now(),
    editedAt: null,
    body: text,
  };
  store.runtime.updateCommentRecords([record]);
  return record.id;
}

export function editComment(store: EditorStore, commentId: string, body: string): void {
  const current = message(store, commentId);
  const text = normalizedBody(body);
  if (!current || !text || current.body === text) return;
  store.runtime.updateCommentRecords([{ ...current, body: text, editedAt: Date.now() }]);
}

export function resolveThread(store: EditorStore, threadId: string): void {
  const current = thread(store, threadId);
  if (!current || current.resolvedAt !== null) return;
  store.runtime.updateCommentRecords([
    { ...current, resolvedBy: author(store).id, resolvedAt: Date.now() },
  ]);
}

export function reopenThread(store: EditorStore, threadId: string): void {
  const current = thread(store, threadId);
  if (!current || current.resolvedAt === null) return;
  store.runtime.updateCommentRecords([{ ...current, resolvedBy: null, resolvedAt: null }]);
}

export function moveThreadAnchor(
  store: EditorStore,
  threadId: string,
  anchor: LeafCommentAnchor,
): void {
  const current = thread(store, threadId);
  if (!current) return;
  store.runtime.updateCommentRecords([{ ...current, anchor }]);
}

/** Deletes a thread with every comment and reaction that hangs off it. */
export function deleteThread(store: EditorStore, threadId: string): void {
  if (!thread(store, threadId)) return;
  // Thread last: a large delete syncs as multiple chunked commands, and the
  // hanging records must not be orphaned invisibly if a later chunk is lost.
  const deletes = [];
  for (const record of store.commentRecords.values()) {
    if (record.kind !== "thread" && record.threadId === threadId) deletes.push(record.id);
  }
  deletes.push(threadId);
  if (store.openCommentThreadId === threadId) store.setOpenCommentThread(null);
  store.runtime.updateCommentRecords([], deletes);
}

/** Deletes one comment (and its reactions); the last comment takes its thread. */
export function deleteComment(store: EditorStore, commentId: string): void {
  const current = message(store, commentId);
  if (!current) return;
  const remaining = threadComments(store, current.threadId).filter(
    (record) => record.id !== commentId,
  );
  if (remaining.length === 0) {
    deleteThread(store, current.threadId);
    return;
  }
  const deletes = [commentId, ...commentReactions(store, commentId).map((record) => record.id)];
  store.runtime.updateCommentRecords([], deletes);
}

/**
 * Toggles this session's reaction. The id is derived from the (comment, user,
 * emoji) triple, so toggling from two tabs converges as an upsert/delete pair
 * instead of racing.
 */
export function toggleCommentReaction(store: EditorStore, commentId: string, emoji: string): void {
  const target = message(store, commentId);
  if (!target || !COMMENT_REACTION_EMOJI.includes(emoji as never)) return;
  const { id: userId, name } = author(store);
  const reactionId = createLeafCommentReactionId(commentId, userId, emoji);
  if (store.commentRecords.has(reactionId)) {
    store.runtime.updateCommentRecords([], [reactionId]);
    return;
  }
  const record: LeafCommentRecord = {
    id: reactionId,
    kind: "reaction",
    commentId,
    threadId: target.threadId,
    pageId: target.pageId,
    userId,
    userName: name,
    emoji,
    createdAt: Date.now(),
  };
  store.runtime.updateCommentRecords([record]);
}
