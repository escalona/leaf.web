import type { EditorStore } from "../core/state/EditorStore";
import {
  exportSelection,
  type ExportOptions,
  type ExportedFile,
  type NodeRasterizer,
} from "./export/node-export";
import { reportEditorError } from "../core/state/editor-feedback-bus";

export {
  EDITOR_FEEDBACK_EVENT,
  associateEditorFeedbackScope,
  reportEditorError,
  reportEditorFailure,
  subscribeToEditorFeedback,
  type EditorFeedbackDetail,
} from "../core/state/editor-feedback-bus";

function describeExportErrors(exportedCount: number, errors: readonly string[]): string {
  const total = exportedCount + errors.length;
  const summary =
    exportedCount === 0
      ? `Export failed for all ${total} selected ${total === 1 ? "node" : "nodes"}.`
      : `${errors.length} of ${total} selected nodes could not be exported.`;
  return `${summary} ${errors.join(" ")}`.trim();
}

/**
 * Shared UI entry point for keyboard and context-menu exports. The lower-level
 * exporter deliberately returns per-node failures so callers can choose their
 * own presentation; editor actions use the transient feedback surface.
 */
export async function exportSelectionWithFeedback(
  store: EditorStore,
  options?: ExportOptions,
  rasterize?: NodeRasterizer,
): Promise<{ exported: ExportedFile[]; errors: string[] }> {
  try {
    const result = await exportSelection(store, options, rasterize);
    if (result.errors.length > 0) {
      reportEditorError(describeExportErrors(result.exported.length, result.errors), store);
    }
    return result;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The selected nodes could not be exported.";
    reportEditorError(`Export failed. ${message}`, store);
    return { exported: [], errors: [message] };
  }
}
