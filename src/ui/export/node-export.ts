/**
 * Turning a node into a file the user can keep.
 *
 * Rasterizing reuses the MCP screenshot capture rather than a second renderer,
 * so an exported PNG is pixel-identical to what an agent sees. The destination
 * is the only new part: a Blob, which either downloads or goes on the clipboard.
 */
import { dataUrlToBlob } from "../../core/state/image-assets";
import type { EditorStore } from "../../core/state/EditorStore";
import { captureNodeScreenshot } from "../render/screenshot-capture";
import { MAX_SCREENSHOT_SCALE } from "../render/screenshot-limits";
import type { DesignNode } from "../../core/types";
import { getExportPreferences } from "../../core/editor/export/export-preferences";

import {
  EXPORT_SCALES,
  type ExportFormat,
  type ExportOptions,
  type ExportScale,
} from "../../core/editor/export/export-options";

export { EXPORT_SCALES };
export type { ExportFormat, ExportOptions, ExportScale };

export interface ExportedFile {
  blob: Blob;
  fileName: string;
  mimeType: string;
}

/**
 * A node rasterizer, injectable so tests do not need a real layout pass.
 * Matches the shape of `captureNodeScreenshot`.
 */
export type NodeRasterizer = (
  store: EditorStore,
  node: DesignNode,
  scale: number,
  transparent: boolean,
) => Promise<{ data: string; mimeType: string }>;

/**
 * Scale is bounded by the shared screenshot capture limit rather than by the
 * export UI, so raising that one constant lights up 3x everywhere at once.
 */
export function isExportScaleSupported(scale: number): boolean {
  return scale <= MAX_SCREENSHOT_SCALE;
}

/** SVG export is markup passthrough — there is no node-tree→SVG serializer. */
export function canExportAsSvg(node: DesignNode): boolean {
  return node.type === "svg" && /<svg[\s>]/i.test(node.content);
}

export function getExportableFormats(nodes: readonly DesignNode[]): ExportFormat[] {
  const formats: ExportFormat[] = ["png"];
  if (nodes.length > 0 && nodes.every(canExportAsSvg)) formats.push("svg");
  return formats;
}

/**
 * The options an export of `nodes` actually runs with: the preferred format
 * when the selection supports it, PNG otherwise — SVG is passthrough of SVG
 * nodes only, and the export panel shows the same fallback.
 */
export function resolveExportOptions(
  nodes: readonly DesignNode[],
  preferred: ExportOptions = getExportPreferences(),
): ExportOptions {
  const format: ExportFormat = getExportableFormats(nodes).includes(preferred.format)
    ? preferred.format
    : "png";
  return { format, scale: preferred.scale };
}

export function slugifyExportName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "node";
}

export function buildExportFileName(node: DesignNode, options: ExportOptions): string {
  const suffix = options.format === "png" && options.scale > 1 ? `@${options.scale}x` : "";
  return `${slugifyExportName(node.name)}${suffix}.${options.format}`;
}

/** Give standalone markup the namespace it needs to open as a file. */
export function toStandaloneSvg(markup: string): string {
  if (/\sxmlns\s*=/i.test(markup)) return markup;
  return markup.replace(/^(\s*<svg\b)/i, '$1 xmlns="http://www.w3.org/2000/svg"');
}

export async function exportNodeToFile(
  store: EditorStore,
  node: DesignNode,
  options: ExportOptions,
  rasterize: NodeRasterizer = captureNodeScreenshot,
): Promise<ExportedFile> {
  const fileName = buildExportFileName(node, options);

  if (options.format === "svg") {
    if (!canExportAsSvg(node)) {
      throw new Error(
        `"${node.name}" is not an SVG node. Only SVG nodes can be exported as SVG; export as PNG instead.`,
      );
    }
    return {
      blob: new Blob([toStandaloneSvg(node.content)], { type: "image/svg+xml" }),
      fileName,
      mimeType: "image/svg+xml",
    };
  }

  if (!isExportScaleSupported(options.scale)) {
    throw new Error(
      `Export at ${options.scale}x exceeds Leaf's capture scale limit of ${MAX_SCREENSHOT_SCALE}x.`,
    );
  }

  const captured = await rasterize(store, node, options.scale, true);
  const blob = await dataUrlToBlob(`data:${captured.mimeType};base64,${captured.data}`);
  return { blob, fileName, mimeType: captured.mimeType };
}

export function downloadFile({ blob, fileName }: ExportedFile): void {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Revoking synchronously can cancel the download in some engines; one turn
    // of the event loop is enough for the click to have been consumed.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * Export every node in the selection. Failures are collected rather than
 * thrown so one oversized node cannot silently cancel the rest.
 */
export async function exportNodesToFiles(
  store: EditorStore,
  nodes: readonly DesignNode[],
  options: ExportOptions,
  rasterize: NodeRasterizer = captureNodeScreenshot,
): Promise<{ exported: ExportedFile[]; errors: string[] }> {
  const exported: ExportedFile[] = [];
  const errors: string[] = [];

  for (const node of nodes) {
    try {
      const file = await exportNodeToFile(store, node, options, rasterize);
      downloadFile(file);
      exported.push(file);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return { exported, errors };
}

/**
 * Entry point for the export shortcut and context menu: exports the current
 * selection with the export panel's current format and scale unless the
 * caller passes its own.
 */
export async function exportSelection(
  store: EditorStore,
  options?: ExportOptions,
  rasterize: NodeRasterizer = captureNodeScreenshot,
) {
  const nodes = store.selectedNodes;
  return exportNodesToFiles(store, nodes, options ?? resolveExportOptions(nodes), rasterize);
}
