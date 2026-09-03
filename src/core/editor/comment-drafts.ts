/**
 * Composer draft persistence: the deliberate flip side of dismissing a
 * composer without a discard warning. One slot for the placement composer
 * (the anchor is re-picked by clicking, so only the text is worth keeping)
 * and one per thread for replies (thread ids are globally unique and stable
 * across reloads). Saving empty content clears the slot.
 */
const DRAFT_KEY_PREFIX = "leaf-comment-draft";

function draftKey(slot: string): string {
  return `${DRAFT_KEY_PREFIX}:${slot}`;
}

export function readCommentDraft(slot: string): string {
  try {
    return window.localStorage.getItem(draftKey(slot)) ?? "";
  } catch {
    return "";
  }
}

export function writeCommentDraft(slot: string, text: string): void {
  try {
    if (text.trim()) window.localStorage.setItem(draftKey(slot), text);
    else window.localStorage.removeItem(draftKey(slot));
  } catch {
    // Storage may be unavailable (private mode, quota); drafts are best-effort.
  }
}

export function clearCommentDraft(slot: string): void {
  writeCommentDraft(slot, "");
}

export const NEW_COMMENT_DRAFT_SLOT = "new";

export function replyDraftSlot(threadId: string): string {
  return `reply:${threadId}`;
}
