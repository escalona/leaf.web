/**
 * What an export asks for. The options are core so preferences can persist
 * them; producing the file is a UI-layer action (`src/ui/export`) because it
 * needs the rendered DOM.
 */
export type ExportFormat = "png" | "svg";

/**
 * Scales the export UI offers. The capture ceiling (`MAX_SCREENSHOT_SCALE`)
 * is a fixed constant, not a function of the selection, so a factor above it
 * could never be enabled for any node; only factors within it are listed.
 */
export const EXPORT_SCALES = [1, 2] as const;
export type ExportScale = (typeof EXPORT_SCALES)[number];

export interface ExportOptions {
  format: ExportFormat;
  scale: ExportScale;
}
