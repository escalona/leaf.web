import { EditorStore } from "./EditorStore";
import { CollaborationDocumentController } from "./collaboration-controller";
import { persistedDocumentToLeafSnapshot, type LeafRecordSnapshot } from "../shared/collaboration";
import type { PersistedEditorDocument } from "./document";

export type CollaborationSessionStartupMetrics = {
  collaborationAuthorityHydrationMs: number;
  editorStoreHydrationMs: number;
};

type CollaborationEditorSessionOptions = {
  captureStartupMetrics: true;
};

export type CollaborationEditorSession = {
  controller: CollaborationDocumentController;
  store: EditorStore;
};

export function createCollaborationEditorSession(
  initialDocument: PersistedEditorDocument,
  normalizedAuthority: LeafRecordSnapshot | PersistedEditorDocument,
  options: CollaborationEditorSessionOptions,
): CollaborationEditorSession & {
  startupMetrics: CollaborationSessionStartupMetrics;
};
export function createCollaborationEditorSession(
  initialDocument: PersistedEditorDocument,
  normalizedAuthority?: LeafRecordSnapshot | PersistedEditorDocument,
): CollaborationEditorSession;
export function createCollaborationEditorSession(
  initialDocument: PersistedEditorDocument,
  normalizedAuthority: LeafRecordSnapshot | PersistedEditorDocument = initialDocument,
  options?: CollaborationEditorSessionOptions,
) {
  const authoritySnapshot =
    "version" in normalizedAuthority
      ? persistedDocumentToLeafSnapshot(normalizedAuthority)
      : normalizedAuthority;
  const storeStartedAt = options ? performance.now() : null;
  const store = new EditorStore({ initialDocument });
  const editorStoreHydrationMs =
    storeStartedAt === null ? null : performance.now() - storeStartedAt;
  const authorityStartedAt = options ? performance.now() : null;
  const controller = new CollaborationDocumentController(store, authoritySnapshot);
  if (authorityStartedAt === null || editorStoreHydrationMs === null) return { controller, store };

  return {
    controller,
    startupMetrics: {
      collaborationAuthorityHydrationMs: performance.now() - authorityStartedAt,
      editorStoreHydrationMs,
    },
    store,
  };
}
