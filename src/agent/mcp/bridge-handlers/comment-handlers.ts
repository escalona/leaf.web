import {
  allThreads,
  commentReactions,
  MAX_COMMENT_BODY_LENGTH,
  pageThreads,
  threadComments,
  threadPageExists,
} from "../../../core/editor/comment-actions";
import { normalizedAnchorInRect } from "../../../core/editor/comment-anchor-math";
import type {
  LeafCommentAnchor,
  LeafCommentMessageRecord,
  LeafCommentThreadRecord,
} from "../../../core/shared/collaboration";
import type { EditorStore } from "../../../core/state/EditorStore";
import { requirePage } from "../node-inspection";
import type { RendererHandlerContext, RendererHandlerMap } from "./types";

function requireThread(store: EditorStore, threadId: string): LeafCommentThreadRecord {
  const record = store.commentRecords.get(threadId);
  if (record?.kind !== "thread") throw new Error(`Comment thread not found: ${threadId}`);
  return record;
}

function serializeThread(store: EditorStore, thread: LeafCommentThreadRecord) {
  return {
    id: thread.id,
    pageId: thread.pageId,
    // Passed through as stored so every anchor shape survives unchanged.
    anchor: thread.anchor,
    createdBy: thread.createdBy,
    createdByName: thread.createdByName,
    createdAt: thread.createdAt,
    resolved: thread.resolvedAt !== null,
    resolvedBy: thread.resolvedBy,
    resolvedAt: thread.resolvedAt,
    messages: threadComments(store, thread.id).map((message) => {
      const reactions: Record<string, number> = {};
      for (const reaction of commentReactions(store, message.id)) {
        reactions[reaction.emoji] = (reactions[reaction.emoji] ?? 0) + 1;
      }
      return {
        id: message.id,
        authorId: message.authorId,
        authorName: message.authorName,
        body: message.body,
        createdAt: message.createdAt,
        editedAt: message.editedAt,
        reactions,
      };
    }),
  };
}

export function createCommentHandlers(context: RendererHandlerContext) {
  const { activityAgent, store } = context;
  // Comments posted over MCP are attributed to the MCP client, never to the
  // human whose session hosts the bridge.
  const agentAuthor = { id: `agent:${activityAgent.label}`, name: activityAgent.label };

  return {
    list_comments: async (params) => {
      const { includeResolved = true, pageId } = params as {
        includeResolved?: boolean;
        pageId?: string;
      };
      const threads = pageId
        ? pageThreads(store, requirePage(store, pageId).id)
        : allThreads(store)
            // A deleted page keeps its threads so an undo can restore them;
            // until then they are unreachable in the UI and stay out of the
            // agent's view as well.
            .filter((thread) => threadPageExists(store, thread))
            .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
      return {
        threads: threads
          .filter((thread) => includeResolved || thread.resolvedAt === null)
          .map((thread) => serializeThread(store, thread)),
      };
    },

    add_comment: async (params) => {
      const { body, threadId, nodeId, x, y, pageId } = params as {
        body: string;
        threadId?: string;
        nodeId?: string;
        x?: number;
        y?: number;
        pageId?: string;
      };
      const text = body.trim().slice(0, MAX_COMMENT_BODY_LENGTH);
      if (!text) throw new Error("Comment body must not be empty.");
      const now = Date.now();

      if (threadId) {
        const thread = requireThread(store, threadId);
        const reply: LeafCommentMessageRecord = {
          id: `ccomment_${crypto.randomUUID()}`,
          kind: "comment",
          threadId,
          pageId: thread.pageId,
          authorId: agentAuthor.id,
          authorName: agentAuthor.name,
          createdAt: now,
          editedAt: null,
          body: text,
        };
        store.runtime.updateCommentRecords([reply]);
        return { threadId, commentId: reply.id, created: "reply" };
      }

      let anchor: LeafCommentAnchor;
      let threadPageId: string;
      if (nodeId) {
        const node = store.getNode(nodeId);
        if (!node) throw new Error(`Node not found: ${nodeId}`);
        const nodePageId = store.getPageIdForNode(nodeId) ?? store.activePageId;
        if (pageId && requirePage(store, pageId).id !== nodePageId) {
          throw new Error(`Node ${nodeId} does not belong to page ${pageId}.`);
        }
        threadPageId = nodePageId;
        if (x !== undefined && y !== undefined) {
          // Model geometry on purpose: comment pins must be placeable on
          // background pages where no DOM rect exists.
          const position = store.getCanvasPosition(nodeId) ?? { x: node.x, y: node.y };
          const { u, v } = normalizedAnchorInRect(
            { x: position.x, y: position.y, width: node.width, height: node.height },
            node.rotation ?? 0,
            { x, y },
          );
          anchor = { type: "node", nodeId, u, v };
        } else {
          anchor = { type: "node", nodeId, u: 0.5, v: 0.5 };
        }
      } else {
        if (x === undefined || y === undefined) {
          throw new Error(
            "add_comment needs a threadId to reply, or a nodeId or point x/y to anchor a new thread.",
          );
        }
        threadPageId = pageId ? requirePage(store, pageId).id : store.activePageId;
        anchor = { type: "point", x, y };
      }

      const thread: LeafCommentThreadRecord = {
        id: `cthread_${crypto.randomUUID()}`,
        kind: "thread",
        pageId: threadPageId,
        anchor,
        createdBy: agentAuthor.id,
        createdByName: agentAuthor.name,
        createdAt: now,
        resolvedBy: null,
        resolvedAt: null,
      };
      const comment: LeafCommentMessageRecord = {
        id: `ccomment_${crypto.randomUUID()}`,
        kind: "comment",
        threadId: thread.id,
        pageId: threadPageId,
        authorId: agentAuthor.id,
        authorName: agentAuthor.name,
        createdAt: now,
        editedAt: null,
        body: text,
      };
      store.runtime.updateCommentRecords([thread, comment]);
      return { threadId: thread.id, commentId: comment.id, created: "thread", anchor };
    },

    resolve_comment_thread: async (params) => {
      const { threadId, resolved } = params as { threadId: string; resolved: boolean };
      const current = requireThread(store, threadId);
      if (resolved !== (current.resolvedAt !== null)) {
        store.runtime.updateCommentRecords([
          resolved
            ? { ...current, resolvedBy: agentAuthor.id, resolvedAt: Date.now() }
            : { ...current, resolvedBy: null, resolvedAt: null },
        ]);
      }
      const updated = requireThread(store, threadId);
      return {
        threadId,
        resolved: updated.resolvedAt !== null,
        resolvedBy: updated.resolvedBy,
        resolvedAt: updated.resolvedAt,
      };
    },
  } satisfies RendererHandlerMap;
}
