/**
 * The comments sidebar: every thread in the document, searchable and
 * filterable, each row flying the camera to its pin. Shown in the properties
 * panel slot only while the comment tool is active.
 *
 * Filter controls stay visible inline (author, page, resolved) rather than
 * hiding behind a context menu; search and sort share the row above them.
 * Author/page/resolved live in the store because the canvas pins overlay
 * applies the same filters; search and sort only shape this list.
 */
import { observer } from "mobx-react-lite";
import { useState, type CSSProperties } from "react";
import { CheckIcon, CommentIcon, LinkIcon, SearchIcon } from "../icons";
import type { LeafCommentThreadRecord } from "../../core/shared/collaboration";
import { useEditorStore, type EditorStore } from "../../core/state/EditorStore";
import {
  allThreads,
  threadComments,
  threadHasUnread,
  threadMatchesFilters,
} from "../../core/editor/comment-actions";
import { revealCommentThread } from "../canvas-overlay/CommentPinsOverlay";
import {
  CommentBodyText,
  commentAuthorLabel,
  formatCommentTime,
} from "../canvas-overlay/CommentThreadPopover";
import { FONT_STACK } from "../floating-styles";
import { Select } from "../properties/PropertyControls";
import { Input, ToggleButton, Tooltip } from "../primitives";

/** The URL for a thread: the current file/branch URL plus `?comment=`. */
export function commentThreadLink(threadId: string): string {
  const url = new URL(window.location.href);
  url.searchParams.set("comment", threadId);
  return url.toString();
}

type SidebarRow = {
  thread: LeafCommentThreadRecord;
  preview: string;
  count: number;
  lastActivity: number;
  unread: boolean;
};

type CommentSort = "newest" | "oldest" | "unread";

const SORT_OPTIONS: { value: CommentSort; label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "unread", label: "Unread first" },
];

// Sentinel Select values; author/page ids are namespaced to avoid collisions.
const ANYONE = "anyone";
const SELF = "you";
const ANY_PAGE = "any";

/** Everyone who has commented in the document, excluding this account. */
function otherCommentAuthors(store: EditorStore): { value: string; label: string }[] {
  const selfId = store.commentAuthor?.id ?? "local";
  const names = new Map<string, string | null>();
  for (const record of store.commentRecords.values()) {
    if (record.kind === "comment" && record.authorId !== selfId) {
      names.set(record.authorId, record.authorName ?? names.get(record.authorId) ?? null);
    } else if (record.kind === "thread" && record.createdBy !== selfId) {
      names.set(record.createdBy, record.createdByName ?? names.get(record.createdBy) ?? null);
    }
  }
  return [...names]
    .map(([id, name]) => ({ value: `a:${id}`, label: commentAuthorLabel(store, id, name) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

const CommentRowItem = observer(({ row }: { row: SidebarRow }) => {
  const store = useEditorStore();
  const { thread } = row;
  const [copied, setCopied] = useState(false);
  const resolved = thread.resolvedAt !== null;
  const label = commentAuthorLabel(store, thread.createdBy, thread.createdByName);
  const pageName = store.pages.find((page) => page.id === thread.pageId)?.name;
  const offPage = thread.pageId !== store.activePageId;
  const selected = store.openCommentThreadId === thread.id;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => revealCommentThread(store, thread.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter") revealCommentThread(store, thread.id);
      }}
      className={selected ? "bg-surface-sunken" : "transition-colors hover:bg-surface-sunken/60"}
      style={{
        ...ROW_STYLE,
        opacity: resolved ? 0.7 : 1,
      }}
    >
      <div style={ROW_HEAD_STYLE}>
        {resolved ? (
          <CheckIcon size={12} style={{ color: "var(--leaf-text-muted)", flexShrink: 0 }} />
        ) : (
          <CommentIcon size={12} style={{ color: "var(--leaf-accent)", flexShrink: 0 }} />
        )}
        <span style={ROW_AUTHOR_STYLE}>{label}</span>
        {row.unread && <span style={UNREAD_DOT_STYLE} />}
        <span style={ROW_TIME_STYLE}>{formatCommentTime(row.lastActivity)}</span>
        <button
          type="button"
          aria-label="Copy link to thread"
          title={copied ? "Link copied" : "Copy link"}
          onClick={(event) => {
            event.stopPropagation();
            void navigator.clipboard.writeText(commentThreadLink(thread.id)).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            });
          }}
          className={
            copied
              ? "bg-transparent text-accent transition-colors hover:bg-surface-sunken"
              : "bg-transparent text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink"
          }
          style={LINK_BUTTON_STYLE}
        >
          <LinkIcon size={12} />
        </button>
      </div>
      <div style={ROW_PREVIEW_STYLE}>
        <CommentBodyText body={row.preview} interactive={false} />
      </div>
      <div style={ROW_META_STYLE}>
        {row.count > 1 ? `${row.count - 1} ${row.count === 2 ? "reply" : "replies"}` : "No replies"}
        {offPage && pageName ? ` · ${pageName}` : ""}
      </div>
    </div>
  );
});

export const CommentsPanel = observer(() => {
  const store = useEditorStore();
  const filters = store.commentFilters;
  const selfId = store.commentAuthor?.id ?? "local";
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<CommentSort>("newest");

  const needle = query.trim().toLowerCase();
  const rows: SidebarRow[] = [];
  for (const thread of allThreads(store)) {
    if (!threadMatchesFilters(store, thread)) continue;
    const comments = threadComments(store, thread.id);
    if (comments.length === 0) continue;
    if (needle) {
      const haystack = comments
        .flatMap((comment) => [
          comment.body,
          commentAuthorLabel(store, comment.authorId, comment.authorName),
        ])
        .join("\n")
        .toLowerCase();
      if (!haystack.includes(needle)) continue;
    }
    rows.push({
      thread,
      preview: comments[0]!.body,
      count: comments.length,
      lastActivity: comments.at(-1)!.createdAt,
      unread: threadHasUnread(store, thread.id),
    });
  }
  rows.sort(
    (a, b) =>
      // Resolved threads sink below open ones under every sort.
      Number(a.thread.resolvedAt !== null) - Number(b.thread.resolvedAt !== null) ||
      (sort === "unread" ? Number(b.unread) - Number(a.unread) : 0) ||
      (sort === "oldest" ? a.lastActivity - b.lastActivity : b.lastActivity - a.lastActivity) ||
      a.thread.id.localeCompare(b.thread.id),
  );

  const authorValue =
    filters.authorId === null
      ? ANYONE
      : filters.authorId === selfId
        ? SELF
        : `a:${filters.authorId}`;
  const authorOptions = [
    { value: ANYONE, label: "Anyone" },
    { value: SELF, label: "You" },
    ...otherCommentAuthors(store),
  ];
  const pageValue = filters.pageId === null ? ANY_PAGE : `p:${filters.pageId}`;
  const pageOptions = [
    { value: ANY_PAGE, label: "Any page" },
    ...store.pages.map((page) => ({ value: `p:${page.id}`, label: page.name })),
  ];

  const hasAnyThread = allThreads(store).length > 0;

  return (
    <div style={PANEL_STYLE}>
      <div style={CONTROLS_STYLE}>
        <div style={SEARCH_ROW_STYLE}>
          <div style={SEARCH_BOX_STYLE}>
            <SearchIcon size={12} style={SEARCH_ICON_STYLE} />
            <Input
              aria-label="Search comments"
              placeholder="Search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="leaf-input-filled"
              style={SEARCH_INPUT_STYLE}
            />
          </div>
          <div style={SORT_SELECT_STYLE}>
            <Select
              aria-label="Sort comments"
              value={sort}
              onChange={(value) => setSort(value as CommentSort)}
              options={SORT_OPTIONS}
            />
          </div>
        </div>
        <div style={FILTER_ROW_STYLE}>
          <div style={FILTER_SELECT_STYLE}>
            <Select
              aria-label="Filter comments by author"
              value={authorValue}
              onChange={(value) =>
                store.setCommentFilters({
                  ...filters,
                  authorId: value === ANYONE ? null : value === SELF ? selfId : value.slice(2),
                })
              }
              options={authorOptions}
            />
          </div>
          <div style={FILTER_SELECT_STYLE}>
            <Select
              aria-label="Filter comments by page"
              value={pageValue}
              onChange={(value) =>
                store.setCommentFilters({
                  ...filters,
                  pageId: value === ANY_PAGE ? null : value.slice(2),
                })
              }
              options={pageOptions}
            />
          </div>
          <Tooltip
            content={filters.showResolved ? "Hide resolved comments" : "Show resolved comments"}
          >
            <ToggleButton
              aria-label="Show resolved comments"
              pressed={filters.showResolved}
              onPressedChange={(showResolved) =>
                store.setCommentFilters({ ...filters, showResolved })
              }
            >
              <CheckIcon size={12} />
            </ToggleButton>
          </Tooltip>
        </div>
      </div>
      <div className="panel-scroll" style={LIST_STYLE}>
        {rows.map((row) => (
          <CommentRowItem key={row.thread.id} row={row} />
        ))}
        {rows.length === 0 && (
          <div style={EMPTY_STYLE}>
            {hasAnyThread
              ? "No comments match your search or filters."
              : "No comments yet. Click anywhere on the canvas to start a thread."}
          </div>
        )}
      </div>
    </div>
  );
});

const PANEL_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  fontFamily: FONT_STACK,
};

const CONTROLS_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  padding: "10px 12px",
  borderBottom: "1px solid var(--leaf-border)",
  flexShrink: 0,
};

const SEARCH_ROW_STYLE: CSSProperties = {
  display: "flex",
  gap: 6,
};

const SEARCH_BOX_STYLE: CSSProperties = {
  position: "relative",
  flex: 1,
  minWidth: 0,
  display: "flex",
};

const SEARCH_ICON_STYLE: CSSProperties = {
  position: "absolute",
  left: 8,
  top: "50%",
  transform: "translateY(-50%)",
  color: "var(--leaf-text-faint)",
  pointerEvents: "none",
};

const SEARCH_INPUT_STYLE: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  paddingLeft: 26,
};

const SORT_SELECT_STYLE: CSSProperties = {
  flex: "0 0 100px",
  display: "flex",
};

const FILTER_ROW_STYLE: CSSProperties = {
  display: "flex",
  gap: 6,
};

const FILTER_SELECT_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
};

const LIST_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
};

const ROW_STYLE: CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid var(--leaf-border)",
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const ROW_HEAD_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const ROW_AUTHOR_STYLE: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--leaf-text)",
};

const ROW_TIME_STYLE: CSSProperties = {
  fontSize: 11,
  color: "var(--leaf-text-muted)",
  flex: 1,
};

// Background and color live in the button's classes — an inline declaration
// here would outrank the hover: utilities.
const LINK_BUTTON_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 20,
  height: 20,
  border: "none",
  borderRadius: 5,
  padding: 0,
};

const UNREAD_DOT_STYLE: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: "50%",
  background: "var(--leaf-accent)",
  flexShrink: 0,
};

const ROW_PREVIEW_STYLE: CSSProperties = {
  fontSize: 12,
  color: "var(--leaf-text-secondary)",
  lineHeight: 1.4,
  overflow: "hidden",
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
};

const ROW_META_STYLE: CSSProperties = {
  fontSize: 11,
  color: "var(--leaf-text-faint)",
};

const EMPTY_STYLE: CSSProperties = {
  padding: "24px 16px",
  fontSize: 12,
  color: "var(--leaf-text-faint)",
  lineHeight: 1.5,
};
