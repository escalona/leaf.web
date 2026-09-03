import { useCallback, useRef } from "react";
import type { CollaborationApplicationSession } from "../../core/state/collaboration-app-runtime";

/** Cap on retained session-disposal failures awaiting a native save/close drain. */
const MAX_RETAINED_SESSION_DISPOSAL_ERRORS = 8;

/**
 * Tracks asynchronous session teardown independently from session replacement.
 *
 * Native save and close flows call the returned drain before archiving a
 * working copy, so a failed final persistence flush remains visible instead of
 * allowing stale state to be saved on a later attempt.
 */
export function usePendingSessionDisposals() {
  const pendingDisposalsRef = useRef(new Set<Promise<void>>());
  const pendingDisposalErrorsRef = useRef<unknown[]>([]);

  const disposeSession = useCallback((session: CollaborationApplicationSession) => {
    const disposal = session.dispose();
    pendingDisposalsRef.current.add(disposal);
    void disposal.then(
      () => pendingDisposalsRef.current.delete(disposal),
      (error) => {
        pendingDisposalsRef.current.delete(disposal);
        // Log on capture as well as on drain: only a native document host awaits
        // these, so in web mode the failure would otherwise never be seen.
        console.error("An editor session failed to persist while closing.", error);
        const errors = pendingDisposalErrorsRef.current;
        errors.push(error);
        if (errors.length > MAX_RETAINED_SESSION_DISPOSAL_ERRORS) {
          errors.splice(0, errors.length - MAX_RETAINED_SESSION_DISPOSAL_ERRORS);
        }
      },
    );
    return disposal;
  }, []);

  const waitForPendingSessionDisposals = useCallback(async () => {
    while (pendingDisposalsRef.current.size > 0) {
      await Promise.allSettled(pendingDisposalsRef.current);
    }
    // Keep failures sticky: the disposed session containing the newest
    // optimistic state cannot safely be retried.
    const errors = pendingDisposalErrorsRef.current;
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Multiple editor sessions failed to persist while closing.");
    }
  }, []);

  return { disposeSession, waitForPendingSessionDisposals };
}
