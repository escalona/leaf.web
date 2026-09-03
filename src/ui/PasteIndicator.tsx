import { observer } from "mobx-react-lite";
import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderIcon } from "./icons";
import { useEditorStore } from "../core/state/EditorStore";
import {
  associateEditorFeedbackScope,
  EDITOR_FEEDBACK_EVENT,
  subscribeToEditorFeedback,
  type EditorFeedbackDetail,
} from "./editor-feedback";

export const PASTE_INDICATOR_LABEL = "Pasting";

/** A paste faster than this never shows the indicator at all. */
export const PASTE_INDICATOR_SHOW_DELAY_MS = 250;

/** Once shown, the indicator stays at least this long so it never flashes. */
export const PASTE_INDICATOR_MIN_VISIBLE_MS = 500;

/** Error feedback stays long enough to read but never becomes stale UI. */
export const EDITOR_ERROR_VISIBLE_MS = 8_000;

/**
 * Floating "Pasting" pill above the bottom toolbar while image paste/drop
 * uploads are in flight. Small pastes finish inside the show delay and never
 * render it.
 */
export const PasteIndicator = observer(({ feedbackScopeId }: { feedbackScopeId?: string }) => {
  const store = useEditorStore();
  const active = store.imagePastesInProgress > 0;
  const [visible, setVisible] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const shownAtRef = useRef(0);
  const dismissTimerRef = useRef<number | null>(null);

  const showError = useCallback((detail: EditorFeedbackDetail) => {
    if (!detail || detail.kind !== "error") return;
    setErrorMessage(detail.message);
    if (dismissTimerRef.current !== null) window.clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = window.setTimeout(() => {
      dismissTimerRef.current = null;
      setErrorMessage(null);
    }, EDITOR_ERROR_VISIBLE_MS);
  }, []);

  useEffect(
    () => () => {
      if (dismissTimerRef.current !== null) window.clearTimeout(dismissTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (feedbackScopeId) {
      associateEditorFeedbackScope(store, feedbackScopeId);
      return subscribeToEditorFeedback(feedbackScopeId, showError);
    }
    const onWindowFeedback = (event: Event) => {
      const detail = (event as CustomEvent<EditorFeedbackDetail>).detail;
      if (detail?.scopeId) return;
      showError(detail);
    };
    window.addEventListener(EDITOR_FEEDBACK_EVENT, onWindowFeedback);
    return () => window.removeEventListener(EDITOR_FEEDBACK_EVENT, onWindowFeedback);
  }, [feedbackScopeId, showError, store]);

  useEffect(() => {
    if (active) {
      if (visible) return;
      const timer = window.setTimeout(() => {
        shownAtRef.current = Date.now();
        setVisible(true);
      }, PASTE_INDICATOR_SHOW_DELAY_MS);
      return () => window.clearTimeout(timer);
    }
    if (!visible) return;
    const remaining = Math.max(
      0,
      PASTE_INDICATOR_MIN_VISIBLE_MS - (Date.now() - shownAtRef.current),
    );
    if (remaining === 0) {
      setVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setVisible(false), remaining);
    return () => window.clearTimeout(timer);
  }, [active, visible]);

  if (!visible && !errorMessage) return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 100,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        zIndex: 100,
        pointerEvents: "none",
      }}
    >
      {errorMessage ? (
        <div
          data-editor-feedback
          role="alert"
          style={{
            maxWidth: "min(520px, calc(100vw - 32px))",
            padding: "9px 14px",
            backgroundColor: "var(--leaf-surface)",
            border: "1px solid var(--leaf-danger, #dc2626)",
            borderRadius: 10,
            boxShadow: "var(--leaf-shadow-pill)",
            fontFamily: "var(--leaf-font-sans)",
            fontSize: 13,
            lineHeight: 1.4,
            color: "var(--leaf-text)",
            textAlign: "center",
          }}
        >
          {errorMessage}
        </div>
      ) : null}
      {visible ? (
        <div
          data-paste-indicator
          role="status"
          aria-live="polite"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 14px",
            backgroundColor: "var(--leaf-surface)",
            borderRadius: 999,
            boxShadow: "var(--leaf-shadow-pill)",
            fontFamily: "var(--leaf-font-sans)",
            fontSize: 13,
            color: "var(--leaf-text)",
          }}
        >
          <LoaderIcon
            aria-hidden="true"
            className="paste-indicator-spinner"
            size={12}
            style={{ color: "var(--leaf-text-faint)" }}
          />
          {PASTE_INDICATOR_LABEL}
        </div>
      ) : null}
    </div>
  );
});
