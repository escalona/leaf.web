import type { EditorStore } from "./EditorStore";

/**
 * Transient editor feedback bus. Lives in the state layer so document
 * controllers and asset pipelines can report user-facing failures without
 * depending on React component modules; `components/editor-feedback.ts`
 * re-exports it for UI callers and adds the export helper.
 */
export const EDITOR_FEEDBACK_EVENT = "leaf:editor-feedback";

export type EditorFeedbackDetail = {
  kind: "error";
  message: string;
  scopeId?: string;
};

type EditorFeedbackTarget = EditorStore | string;
type EditorFeedbackListener = (detail: EditorFeedbackDetail) => void;

const feedbackScopeByStore = new WeakMap<EditorStore, string>();
const feedbackListenersByScope = new Map<string, Set<EditorFeedbackListener>>();
const queuedFeedbackByScope = new Map<string, EditorFeedbackDetail[]>();
const MAX_QUEUED_FEEDBACK_PER_SCOPE = 3;

/** Associates async work started by an editor store with its owning workspace tab. */
export function associateEditorFeedbackScope(store: EditorStore, scopeId: string): void {
  feedbackScopeByStore.set(store, scopeId);
}

/**
 * Subscribes the feedback surface owned by one workspace tab. Messages emitted
 * while that tab is switching branches remain queued for the same tab instead
 * of leaking into whichever editor happens to be mounted next.
 */
export function subscribeToEditorFeedback(
  scopeId: string,
  listener: EditorFeedbackListener,
): () => void {
  const listeners = feedbackListenersByScope.get(scopeId) ?? new Set<EditorFeedbackListener>();
  listeners.add(listener);
  feedbackListenersByScope.set(scopeId, listeners);

  const queued = queuedFeedbackByScope.get(scopeId);
  if (queued) {
    queuedFeedbackByScope.delete(scopeId);
    for (const detail of queued) listener(detail);
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) feedbackListenersByScope.delete(scopeId);
  };
}

function resolveFeedbackScope(target?: EditorFeedbackTarget): string | undefined {
  return typeof target === "string"
    ? target
    : target
      ? feedbackScopeByStore.get(target)
      : undefined;
}

export function reportEditorError(message: string, target?: EditorFeedbackTarget): void {
  const normalized = message.trim();
  if (!normalized) return;
  const scopeId = resolveFeedbackScope(target);
  const detail: EditorFeedbackDetail = { kind: "error", message: normalized, scopeId };
  if (scopeId) {
    const listeners = feedbackListenersByScope.get(scopeId);
    if (listeners?.size) {
      for (const listener of listeners) listener(detail);
    } else {
      const queued = queuedFeedbackByScope.get(scopeId) ?? [];
      queued.push(detail);
      queuedFeedbackByScope.set(scopeId, queued.slice(-MAX_QUEUED_FEEDBACK_PER_SCOPE));
    }
  }
  // Background asset work can report from non-DOM test environments; the
  // scoped listeners above already received the message there.
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<EditorFeedbackDetail>(EDITOR_FEEDBACK_EVENT, {
      detail,
    }),
  );
}

export function reportEditorFailure(
  error: unknown,
  fallback: string,
  target?: EditorFeedbackTarget,
): void {
  reportEditorError(error instanceof Error ? error.message : fallback, target);
}
