import type { PersistedEditorDocument } from "./document";

export function createStarterDocument(): PersistedEditorDocument {
  return { version: 1, nodes: [] };
}
