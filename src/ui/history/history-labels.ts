import type { DocumentHistoryEntry } from "../../core/state/document-adapter";
import type { EditorStore } from "../../core/state/EditorStore";

/** The actor the controller records for the document's seed version. */
const SYSTEM_ACTOR = "Leaf";

/**
 * A version's number comes from its own id (`streamEpoch:revision`), not its
 * position in the list: the list is capped, so a position renumbers every row
 * each time an old version falls off the end, while the revision a version
 * was recorded at never changes. The seed version has no revision and is
 * named instead.
 */
export function getHistoryVersionLabel(entry: Pick<DocumentHistoryEntry, "id" | "isCurrent">) {
  if (entry.isCurrent) return "Current";
  const revision = getHistoryVersionRevision(entry.id);
  return revision === null ? "Initial version" : `Version ${revision}`;
}

export function getHistoryVersionRevision(entryId: string): number | null {
  const separator = entryId.lastIndexOf(":");
  if (separator === -1) return null;
  const revision = Number(entryId.slice(separator + 1));
  return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
}

/**
 * Who recorded the version. Resolves the local account the way comment
 * authorship does; a peer with no stored name falls back to its actor id the
 * way presence labels do, so two collaborators still read as two people.
 */
export function getHistoryActorLabel(store: EditorStore, actor: string): string {
  const selfId = store.commentAuthor?.id ?? "local";
  if (actor === selfId) return "You";
  if (actor === SYSTEM_ACTOR) return SYSTEM_ACTOR;
  const trimmed = actor.trim();
  return trimmed ? trimmed.slice(0, 24) : "Someone";
}

/** The controller stores the commit kind in `message` for non-user versions. */
export function getHistoryKindLabel(message: string | null): string | null {
  if (message === "undo") return "Undo";
  if (message === "redo") return "Redo";
  return null;
}
