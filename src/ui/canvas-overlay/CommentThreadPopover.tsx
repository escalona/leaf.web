/**
 * The open comment thread: message list, reactions, reply composer, resolve
 * and delete actions. Screen-sized content inside the pin overlay's
 * counter-scaled anchor, so it lays out in screen pixels at any zoom.
 *
 * Composers persist their text to localStorage (one slot for the placement
 * draft, one per thread for replies) — the deliberate flip side of dismissing
 * without a discard warning. `@` opens a mention picker over the session
 * roster; bodies store mention tokens and render them as chips whose names
 * resolve at render time.
 */
import { reaction } from "mobx";
import { observer } from "mobx-react-lite";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DependencyList,
  type KeyboardEvent,
} from "react";
import {
  ArrowUpIcon,
  CheckIcon,
  CloseIcon,
  CommentIcon,
  ResetIcon,
  SmileIcon,
  TrashIcon,
} from "../icons";
import type {
  LeafCommentMessageRecord,
  LeafCommentThreadRecord,
} from "../../core/shared/collaboration";
import { useEditorStore } from "../../core/state/EditorStore";
import type { EditorStore } from "../../core/state/EditorStore";
import {
  COMMENT_REACTION_EMOJI,
  commentReactions,
  deleteComment,
  deleteThread,
  editComment,
  postPendingComment,
  reopenThread,
  replyToThread,
  resolveThread,
  threadComments,
  toggleCommentReaction,
} from "../../core/editor/comment-actions";
import {
  NEW_COMMENT_DRAFT_SLOT,
  clearCommentDraft,
  readCommentDraft,
  replyDraftSlot,
  writeCommentDraft,
} from "../../core/editor/comment-drafts";
import {
  filterMentionMembers,
  resolveMentionName,
  type MentionMember,
} from "../../core/editor/comment-mentions";
import { MarkupText, mentionMarkup } from "../../core/markup";
import { FONT_STACK } from "../floating-styles";
import { Popover, Tooltip } from "../primitives";

export const COMMENT_POPOVER_WIDTH = 300;

export function formatCommentTime(createdAt: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - createdAt);
  if (elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  if (elapsed < 7 * 86_400_000) return `${Math.floor(elapsed / 86_400_000)}d ago`;
  return new Date(createdAt).toLocaleDateString();
}

const FULL_COMMENT_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "full",
  timeStyle: "short",
});

export function formatFullCommentTime(createdAt: number): string {
  return FULL_COMMENT_TIME_FORMAT.format(createdAt);
}

export function commentAuthorLabel(
  store: EditorStore,
  authorId: string,
  authorName: string | null,
): string {
  const selfId = store.commentAuthor?.id ?? "local";
  if (authorId === selfId) return "You";
  return authorName?.trim() || "Someone";
}

/**
 * The label for an actor a record names only by id (a thread's resolver). The
 * name comes from wherever that actor has written in the document, the same
 * way mention chips resolve theirs; an actor with no trace stays "Someone".
 */
export function commentActorLabel(store: EditorStore, actorId: string): string {
  const selfId = store.commentAuthor?.id ?? "local";
  if (actorId === selfId) return "You";
  return resolveMentionName(store, actorId, "Someone");
}

function authorInitial(label: string): string {
  return label === "You" ? "Y" : (label.trim()[0]?.toUpperCase() ?? "?");
}

/** Screen-pixel shift that brings a rect inside the bounds, top-left wins. */
export function edgeClampOffset(
  rect: { left: number; top: number; right: number; bottom: number },
  bounds: { left: number; top: number; right: number; bottom: number },
  margin = 8,
): { dx: number; dy: number } {
  let dx = 0;
  let dy = 0;
  if (rect.right > bounds.right - margin) dx = bounds.right - margin - rect.right;
  if (rect.left + dx < bounds.left + margin) dx = bounds.left + margin - rect.left;
  if (rect.bottom > bounds.bottom - margin) dy = bounds.bottom - margin - rect.bottom;
  if (rect.top + dy < bounds.top + margin) dy = bounds.top + margin - rect.top;
  return { dx, dy };
}

/**
 * The area comment panels must stay inside: the editing viewport, not the
 * window. App chrome around the canvas — the workspace tab strip and desktop
 * title bar above, the layers and properties panels beside — is opaque and
 * stacked higher, so a window-clamped panel can end up occluded underneath
 * it. The viewport element's rect encodes every chrome configuration
 * (browser, native shell, workspace tabs) without naming any of them.
 */
function clampBounds(): { left: number; top: number; right: number; bottom: number } {
  const viewport = document.querySelector("[data-viewport]")?.getBoundingClientRect();
  const window_ = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  if (!viewport || viewport.width === 0) return window_;
  return {
    left: Math.max(viewport.left, window_.left),
    top: Math.max(viewport.top, window_.top),
    right: Math.min(viewport.right, window_.right),
    bottom: Math.min(viewport.bottom, window_.bottom),
  };
}

/**
 * Keeps a popover panel inside the window: measures after layout and applies
 * a screen-pixel translate. The panel lives inside a counter-scaled anchor,
 * so a child translate in local pixels is a screen-pixel shift.
 *
 * Clamping is re-run whenever the panel can drift off-screen after mount: the
 * panel resizes (replies landing in a bottom-anchored popover grow it upward,
 * past the top edge), the camera moves (the anchor rides the canvas, and
 * `revealCommentThread` keeps flying after the popover opens), or the window
 * resizes. Each pass clears the previous translate, measures the natural
 * position, and reapplies in one synchronous block, so no intermediate state
 * ever paints.
 */
export function useEdgeClampedPlacement<T extends HTMLElement>(deps: DependencyList) {
  const ref = useRef<T | null>(null);
  const store = useEditorStore();
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const clamp = () => {
      element.style.transform = "";
      const { dx, dy } = edgeClampOffset(element.getBoundingClientRect(), clampBounds());
      if (dx || dy) element.style.transform = `translate(${dx}px, ${dy}px)`;
    };
    clamp();
    // The translate never changes the panel's size, so this cannot loop.
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(clamp) : null;
    observer?.observe(element);
    window.addEventListener("resize", clamp);
    const disposeCamera = reaction(
      () => ({ panX: store.panX, panY: store.panY, zoom: store.zoom }),
      clamp,
    );
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", clamp);
      disposeCamera();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, ...deps]);
  return ref;
}

/**
 * A body rendered as Leaf markup — mention chips with live names, links,
 * code, and emphasis. Non-interactive on surfaces that are themselves
 * clickable (panel rows, hover cards), where links render as styled text.
 */
export const CommentBodyText = observer(
  ({ body, interactive = true }: { body: string; interactive?: boolean }) => {
    const store = useEditorStore();
    return (
      <MarkupText
        body={body}
        interactive={interactive}
        resolveMentionLabel={(actorId, fallback) => resolveMentionName(store, actorId, fallback)}
      />
    );
  },
);

/**
 * Pill-shaped composer: a borderless field and a round
 * arrow send button in one rounded capsule. Enter posts, Shift+Enter breaks,
 * Escape dismisses (or closes the mention picker first). `@` opens the
 * mention picker. Cmd/Ctrl+B, I, and E toggle the markup markers for bold,
 * italic, and code around the selection — the field shows raw markers;
 * formatting appears once posted.
 */
function Composer({
  autoFocus,
  focusKey,
  placeholder,
  initialValue,
  draftSlot,
  floating,
  mentionRoster = [],
  onSubmit,
  onDismiss,
}: {
  autoFocus?: boolean;
  /**
   * Re-focuses the field whenever this value changes. The canvas click that
   * places a draft moves native focus AFTER React mounts the textarea, so
   * `autoFocus` alone loses the race; this claims focus a tick later, and
   * again when the draft is re-placed by another click.
   */
  focusKey?: unknown;
  placeholder: string;
  initialValue?: string;
  /** Persisted slot; omitted for edit-in-place, which edits live text. */
  draftSlot?: string;
  /** Standalone on the canvas (the placement draft): shadow, fixed width. */
  floating?: boolean;
  mentionRoster?: MentionMember[];
  onSubmit: (body: string) => void;
  onDismiss?: () => void;
}) {
  const [value, setValue] = useState(
    () => initialValue ?? (draftSlot ? readCommentDraft(draftSlot) : ""),
  );
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [focused, setFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (focusKey === undefined) return;
    const handle = window.setTimeout(() => textareaRef.current?.focus(), 0);
    return () => window.clearTimeout(handle);
  }, [focusKey]);

  const write = (next: string) => {
    setValue(next);
    if (draftSlot) writeCommentDraft(draftSlot, next);
  };

  const trackMention = (next: string, caret: number) => {
    const match = /(?:^|\s)@([^\s@]*)$/.exec(next.slice(0, caret));
    setMention(match ? { query: match[1]!, start: caret - match[1]!.length - 1 } : null);
    setHighlight(0);
  };

  const members = mention ? filterMentionMembers(mentionRoster, mention.query).slice(0, 6) : [];

  const insertMention = (member: MentionMember) => {
    if (!mention) return;
    const caret = textareaRef.current?.selectionStart ?? value.length;
    const token = `${mentionMarkup(member)} `;
    write(value.slice(0, mention.start) + token + value.slice(caret));
    setMention(null);
    textareaRef.current?.focus();
  };

  const submit = () => {
    if (!value.trim()) return;
    onSubmit(value);
    setValue("");
    if (draftSlot) clearCommentDraft(draftSlot);
  };

  const toggleMarker = (marker: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const { selectionStart: start, selectionEnd: end } = textarea;
    const length = marker.length;
    const wrapped =
      value.slice(Math.max(0, start - length), start) === marker &&
      value.slice(end, end + length) === marker;
    write(
      wrapped
        ? value.slice(0, start - length) + value.slice(start, end) + value.slice(end + length)
        : value.slice(0, start) + marker + value.slice(start, end) + marker + value.slice(end),
    );
    const shift = wrapped ? -length : length;
    // Selection is restored after React re-renders the controlled value.
    window.setTimeout(() => textarea.setSelectionRange(start + shift, end + shift), 0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // The editor's shortcut layer skips editable targets, but Escape must act
    // here rather than bubble into "deselect everything".
    event.stopPropagation();
    // An Enter (or arrow) that confirms an IME composition candidate belongs
    // to the composition, not to submit or the mention picker.
    if (event.nativeEvent.isComposing) return;
    if ((event.metaKey || event.ctrlKey) && !event.altKey) {
      const marker = { b: "**", i: "*", e: "`" }[event.key.toLowerCase()];
      if (marker) {
        event.preventDefault();
        toggleMarker(marker);
        return;
      }
    }
    if (mention && members.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setHighlight((current) => (current + step + members.length) % members.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        insertMention(members[highlight]!);
        return;
      }
      if (event.key === "Escape") {
        setMention(null);
        return;
      }
    }
    if (event.key === "Escape") {
      onDismiss?.();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const canSubmit = Boolean(value.trim());
  return (
    <div style={floating ? FLOATING_COMPOSER_STYLE : COMPOSER_STYLE}>
      {members.length > 0 && (
        <div data-comment-mention-picker="" style={MENTION_PICKER_STYLE}>
          {members.map((member, index) => (
            <button
              key={member.id}
              type="button"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => insertMention(member)}
              style={{
                ...MENTION_ITEM_STYLE,
                background: index === highlight ? "var(--leaf-surface-sunken)" : "transparent",
              }}
            >
              @{member.name}
            </button>
          ))}
        </div>
      )}
      <div
        style={{
          ...PILL_STYLE,
          ...(floating ? FLOATING_PILL_STYLE : undefined),
          // The focused input shows its outline the way every other input
          // does — the accent ring.
          borderColor: focused ? "var(--leaf-accent)" : "var(--leaf-border)",
        }}
      >
        <textarea
          ref={textareaRef}
          autoFocus={autoFocus}
          aria-label={placeholder}
          placeholder={placeholder}
          rows={value.includes("\n") || value.length > 40 ? 3 : 1}
          value={value}
          onChange={(event) => {
            write(event.target.value);
            trackMention(event.target.value, event.target.selectionStart ?? 0);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={TEXTAREA_STYLE}
        />
        <button
          type="button"
          aria-label="Post comment"
          disabled={!canSubmit}
          onClick={submit}
          style={{
            ...SEND_STYLE,
            background: canSubmit ? "var(--leaf-accent)" : "var(--leaf-surface-sunken)",
            color: canSubmit ? "var(--leaf-text-on-accent)" : "var(--leaf-text-muted)",
          }}
        >
          <ArrowUpIcon size={12} />
        </button>
      </div>
    </div>
  );
}

const CommentRow = observer(
  ({
    comment,
    mentionRoster,
  }: {
    comment: LeafCommentMessageRecord;
    mentionRoster: MentionMember[];
  }) => {
    const store = useEditorStore();
    const [editing, setEditing] = useState(false);
    const [pickerOpen, setPickerOpen] = useState(false);
    const label = commentAuthorLabel(store, comment.authorId, comment.authorName);
    const own = label === "You";
    const fullCreatedAt = formatFullCommentTime(comment.createdAt);
    const reactions = commentReactions(store, comment.id);
    const tally = new Map<string, { count: number; mine: boolean }>();
    const selfId = store.commentAuthor?.id ?? "local";
    for (const reaction of reactions) {
      const entry = tally.get(reaction.emoji) ?? { count: 0, mine: false };
      entry.count += 1;
      if (reaction.userId === selfId) entry.mine = true;
      tally.set(reaction.emoji, entry);
    }

    return (
      <div className="group" style={ROW_STYLE}>
        <div style={ROW_HEAD_STYLE}>
          <span style={AVATAR_STYLE}>{authorInitial(label)}</span>
          <span style={AUTHOR_STYLE}>{label}</span>
          <span style={TIME_STYLE}>
            <Tooltip content={fullCreatedAt} side="bottom">
              <time
                aria-label={fullCreatedAt}
                data-comment-time={comment.id}
                dateTime={new Date(comment.createdAt).toISOString()}
              >
                {formatCommentTime(comment.createdAt)}
              </time>
            </Tooltip>
            {comment.editedAt !== null ? " (edited)" : ""}
          </span>
          {/* Row actions surface on hover of the row (pointer-hover devices
              only — elsewhere they stay visible), while the reaction picker
              is open, and whenever a button inside has keyboard focus. */}
          <span
            data-comment-row-actions={comment.id}
            className={
              pickerOpen
                ? "opacity-100"
                : "transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:hover)]:opacity-0"
            }
            style={ROW_ACTIONS_STYLE}
          >
            <Popover.Root open={pickerOpen} onOpenChange={setPickerOpen}>
              <Popover.Trigger
                render={
                  <button
                    type="button"
                    aria-label="Add reaction"
                    title="Add reaction"
                    style={{
                      ...ICON_BUTTON_STYLE,
                      background: pickerOpen ? "var(--leaf-surface-sunken)" : "transparent",
                    }}
                  />
                }
              >
                <SmileIcon size={12} />
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Positioner
                  side="bottom"
                  align="start"
                  sideOffset={8}
                  alignOffset={-24}
                  collisionBoundary={
                    document.querySelector<HTMLElement>("[data-viewport]") ?? undefined
                  }
                  collisionPadding={8}
                  collisionAvoidance={{
                    side: "flip",
                    align: "shift",
                    fallbackAxisSide: "none",
                  }}
                >
                  <Popover.Popup
                    aria-label="Choose a reaction"
                    data-comment-ui=""
                    data-overlay-ui=""
                    data-comment-reaction-picker={comment.id}
                    initialFocus={(openType) => openType === "keyboard"}
                    style={REACTION_PICKER_STYLE}
                  >
                    {COMMENT_REACTION_EMOJI.map((emoji) => (
                      <button
                        key={emoji}
                        type="button"
                        aria-label={`React with ${emoji}`}
                        onClick={() => {
                          toggleCommentReaction(store, comment.id, emoji);
                          setPickerOpen(false);
                        }}
                        style={REACTION_PICKER_ITEM_STYLE}
                      >
                        {emoji}
                      </button>
                    ))}
                  </Popover.Popup>
                </Popover.Positioner>
              </Popover.Portal>
            </Popover.Root>
            {own && (
              <button
                type="button"
                aria-label="Delete comment"
                title="Delete comment"
                onClick={() => deleteComment(store, comment.id)}
                style={ICON_BUTTON_STYLE}
              >
                <TrashIcon size={12} />
              </button>
            )}
          </span>
        </div>
        {editing ? (
          <Composer
            autoFocus
            placeholder="Edit comment"
            initialValue={comment.body}
            mentionRoster={mentionRoster}
            onDismiss={() => setEditing(false)}
            onSubmit={(body) => {
              editComment(store, comment.id, body);
              setEditing(false);
            }}
          />
        ) : (
          <div
            style={BODY_STYLE}
            onDoubleClick={own ? () => setEditing(true) : undefined}
            title={own ? "Double-click to edit" : undefined}
          >
            <CommentBodyText body={comment.body} />
          </div>
        )}
        {tally.size > 0 && (
          <div style={REACTIONS_ROW_STYLE}>
            {[...tally.entries()].map(([emoji, entry]) => (
              <button
                key={emoji}
                type="button"
                aria-label={`${emoji} ${entry.count}`}
                onClick={() => toggleCommentReaction(store, comment.id, emoji)}
                style={{
                  ...REACTION_PILL_STYLE,
                  borderColor: entry.mine ? "var(--leaf-accent)" : "var(--leaf-border)",
                  background: entry.mine ? "var(--leaf-accent-soft)" : "var(--leaf-surface)",
                }}
              >
                <span>{emoji}</span>
                <span style={REACTION_COUNT_STYLE}>{entry.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  },
);

export const CommentThreadPopover = observer(
  ({
    thread,
    mentionRoster = [],
  }: {
    thread: LeafCommentThreadRecord;
    mentionRoster?: MentionMember[];
  }) => {
    const store = useEditorStore();
    const comments = threadComments(store, thread.id);
    const resolved = thread.resolvedAt !== null;
    const listRef = useRef<HTMLDivElement | null>(null);
    const rootRef = useEdgeClampedPlacement<HTMLDivElement>([thread.id]);
    const canDeleteThread = (store.commentAuthor?.id ?? "local") === thread.createdBy;

    // Keep the newest message visible as replies land, and mark everything in
    // view read — the receipt write flips the unread projection, so re-runs
    // find nothing new to report.
    useEffect(() => {
      const list = listRef.current;
      if (list) list.scrollTop = list.scrollHeight;
      store.markCommentsRead(threadComments(store, thread.id).map((comment) => comment.id));
    }, [store, thread.id, comments.length]);

    return (
      <div
        ref={rootRef}
        data-overlay-ui=""
        data-comment-ui=""
        data-comment-popover={thread.id}
        style={POPOVER_STYLE}
      >
        <div style={HEADER_STYLE}>
          <span style={HEADER_TITLE_STYLE}>
            <CommentIcon size={12} style={{ marginRight: 6, flexShrink: 0 }} />
            {resolved
              ? `Resolved by ${commentActorLabel(store, thread.resolvedBy ?? "")}`
              : "Comment"}
          </span>
          <span style={HEADER_ACTIONS_STYLE}>
            <button
              type="button"
              aria-label={resolved ? "Reopen thread" : "Resolve thread"}
              title={resolved ? "Reopen" : "Resolve"}
              onClick={() =>
                resolved ? reopenThread(store, thread.id) : resolveThread(store, thread.id)
              }
              style={{
                ...ICON_BUTTON_STYLE,
                color: resolved ? "var(--leaf-text-muted)" : "var(--leaf-accent)",
              }}
            >
              {resolved ? <ResetIcon size={12} /> : <CheckIcon size={12} />}
            </button>
            {canDeleteThread && (
              <button
                type="button"
                aria-label="Delete thread"
                title="Delete thread"
                onClick={() => deleteThread(store, thread.id)}
                style={ICON_BUTTON_STYLE}
              >
                <TrashIcon size={12} />
              </button>
            )}
            <button
              type="button"
              aria-label="Close thread"
              title="Close"
              onClick={() => store.setOpenCommentThread(null)}
              style={ICON_BUTTON_STYLE}
            >
              <CloseIcon size={12} />
            </button>
          </span>
        </div>
        <div ref={listRef} style={LIST_STYLE}>
          {comments.map((comment) => (
            <CommentRow key={comment.id} comment={comment} mentionRoster={mentionRoster} />
          ))}
        </div>
        {!resolved && (
          <Composer
            placeholder="Reply…"
            draftSlot={replyDraftSlot(thread.id)}
            mentionRoster={mentionRoster}
            onDismiss={() => store.setOpenCommentThread(null)}
            onSubmit={(body) => replyToThread(store, thread.id, body)}
          />
        )}
      </div>
    );
  },
);

/**
 * The placement draft's composer, shown before anything durable exists: a
 * bare floating pill beside the draft pin — no card, no close
 * button. Escape, clicking elsewhere, or switching tools dismisses; the text
 * survives in the draft slot.
 */
export const CommentDraftComposer = observer(
  ({ mentionRoster = [] }: { mentionRoster?: MentionMember[] }) => {
    const store = useEditorStore();
    const rootRef = useEdgeClampedPlacement<HTMLDivElement>([store.pendingCommentDraft]);
    return (
      <div ref={rootRef} data-overlay-ui="" data-comment-ui="" data-comment-draft="">
        <Composer
          autoFocus
          floating
          focusKey={store.pendingCommentDraft}
          placeholder="Add a comment…"
          draftSlot={NEW_COMMENT_DRAFT_SLOT}
          mentionRoster={mentionRoster}
          onDismiss={() => store.setPendingCommentDraft(null)}
          onSubmit={(body) => postPendingComment(store, body)}
        />
      </div>
    );
  },
);

const POPOVER_STYLE: CSSProperties = {
  width: COMMENT_POPOVER_WIDTH,
  display: "flex",
  flexDirection: "column",
  background: "var(--leaf-surface)",
  border: "1px solid var(--leaf-border)",
  borderRadius: 12,
  boxShadow: "var(--leaf-shadow-overlay)",
  fontFamily: FONT_STACK,
  fontSize: 12,
  color: "var(--leaf-text)",
  overflow: "visible",
};

const HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "8px 8px 8px 12px",
  borderBottom: "1px solid var(--leaf-border)",
};

const HEADER_TITLE_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  fontWeight: 600,
  color: "var(--leaf-text-secondary)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const HEADER_ACTIONS_STYLE: CSSProperties = { display: "flex", gap: 2, flexShrink: 0 };

const LIST_STYLE: CSSProperties = {
  maxHeight: 320,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
};

const ROW_STYLE: CSSProperties = {
  padding: "8px 12px",
  display: "flex",
  flexDirection: "column",
  gap: 4,
  position: "relative",
};

const ROW_HEAD_STYLE: CSSProperties = { display: "flex", alignItems: "center", gap: 6 };

const AVATAR_STYLE: CSSProperties = {
  width: 18,
  height: 18,
  borderRadius: "50%",
  background: "var(--leaf-accent)",
  color: "var(--leaf-text-on-accent)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 10,
  fontWeight: 700,
  flexShrink: 0,
};

const AUTHOR_STYLE: CSSProperties = { fontWeight: 600 };

const TIME_STYLE: CSSProperties = { color: "var(--leaf-text-muted)", fontSize: 11, flex: 1 };

const ROW_ACTIONS_STYLE: CSSProperties = { display: "flex", gap: 2 };

const BODY_STYLE: CSSProperties = {
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  lineHeight: 1.45,
  paddingLeft: 24,
  cursor: "text",
  userSelect: "text",
  WebkitUserSelect: "text",
};

const ICON_BUTTON_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  border: "none",
  borderRadius: 6,
  background: "transparent",
  color: "var(--leaf-text-muted)",
  padding: 0,
};

const COMPOSER_STYLE: CSSProperties = {
  position: "relative",
  padding: 8,
};

const FLOATING_COMPOSER_STYLE: CSSProperties = {
  position: "relative",
  width: COMMENT_POPOVER_WIDTH,
  fontFamily: FONT_STACK,
  fontSize: 12,
};

/** The capsule around the field and send button; grows into a rounded rect. */
const PILL_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: 4,
  padding: 4,
  background: "var(--leaf-surface)",
  border: "1px solid var(--leaf-border)",
  borderRadius: 10,
};

const FLOATING_PILL_STYLE: CSSProperties = {
  boxShadow: "var(--leaf-shadow-pill)",
};

const MENTION_PICKER_STYLE: CSSProperties = {
  position: "absolute",
  bottom: "100%",
  left: 8,
  right: 8,
  marginBottom: 4,
  display: "flex",
  flexDirection: "column",
  background: "var(--leaf-surface)",
  border: "1px solid var(--leaf-border)",
  borderRadius: 8,
  boxShadow: "var(--leaf-shadow-float)",
  overflow: "hidden",
  zIndex: 1,
};

const MENTION_ITEM_STYLE: CSSProperties = {
  border: "none",
  textAlign: "left",
  padding: "6px 10px",
  fontFamily: FONT_STACK,
  fontSize: 12,
  color: "var(--leaf-text)",
  background: "transparent",
};

const TEXTAREA_STYLE: CSSProperties = {
  flex: 1,
  resize: "none",
  border: "none",
  padding: "6px 0 6px 10px",
  fontFamily: FONT_STACK,
  fontSize: 12,
  lineHeight: 1.45,
  background: "transparent",
  color: "var(--leaf-text)",
  outline: "none",
};

const SEND_STYLE: CSSProperties = {
  width: 28,
  height: 28,
  flexShrink: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "none",
  borderRadius: "50%",
  padding: 0,
};

const REACTION_PICKER_STYLE: CSSProperties = {
  width: 208,
  minWidth: 0,
  display: "grid",
  gridTemplateColumns: "repeat(5, 32px)",
  gap: 8,
  padding: 12,
};

const REACTION_PICKER_ITEM_STYLE: CSSProperties = {
  width: 32,
  height: 32,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "none",
  background: "transparent",
  fontSize: 21,
  lineHeight: 1,
  padding: 0,
  borderRadius: 8,
};

const REACTIONS_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
  paddingLeft: 24,
};

const REACTION_PILL_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  border: "1px solid var(--leaf-border)",
  borderRadius: 999,
  padding: "1px 7px",
  fontSize: 12,
  color: "var(--leaf-text)",
};

const REACTION_COUNT_STYLE: CSSProperties = { fontSize: 11, color: "var(--leaf-text-secondary)" };
