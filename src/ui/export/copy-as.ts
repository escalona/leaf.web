/**
 * "Copy as …" — putting a node on the system clipboard in a form another
 * application understands.
 *
 * JSX comes from the same `generateJsx` the `get_jsx` MCP tool serves, so a
 * human and an agent hand the same code to a codebase.
 */
import type { EditorStore } from "../../core/state/EditorStore";
import { captureNodeScreenshot } from "../render/screenshot-capture";
import type { DesignNode } from "../../core/types";
import { generateJsx } from "../../core/editor/serialization";
import { canExportAsSvg, toStandaloneSvg, type NodeRasterizer } from "./node-export";

export interface ClipboardWriter {
  writeText(text: string): Promise<void>;
  writeBlob(blob: Blob, mimeType: string): Promise<void>;
}

function requireClipboard(): Clipboard {
  const clipboard = globalThis.navigator?.clipboard;
  if (!clipboard) {
    throw new Error("This browser does not expose the system clipboard to the page.");
  }
  return clipboard;
}

export const systemClipboardWriter: ClipboardWriter = {
  async writeText(text) {
    await requireClipboard().writeText(text);
  },
  async writeBlob(blob, mimeType) {
    const clipboard = requireClipboard();
    const ClipboardItemCtor = (globalThis as { ClipboardItem?: typeof ClipboardItem })
      .ClipboardItem;
    if (!clipboard.write || !ClipboardItemCtor) {
      throw new Error("This browser cannot put images on the clipboard.");
    }
    await clipboard.write([new ClipboardItemCtor({ [mimeType]: blob })]);
  },
};

export function serializeNodesAsJsx(nodes: readonly DesignNode[]): string {
  return nodes.map((node) => generateJsx(node, 0)).join("\n");
}

export function serializeNodesAsSvg(nodes: readonly DesignNode[]): string {
  const unsupported = nodes.find((node) => !canExportAsSvg(node));
  if (unsupported) {
    throw new Error(
      `"${unsupported.name}" is not an SVG node. Leaf has no node-tree to SVG serializer yet — copy it as PNG instead.`,
    );
  }
  return nodes.map((node) => toStandaloneSvg(node.content)).join("\n");
}

export async function copyNodesAsJsx(
  nodes: readonly DesignNode[],
  writer: ClipboardWriter = systemClipboardWriter,
): Promise<void> {
  if (nodes.length === 0) throw new Error("Nothing is selected.");
  await writer.writeText(serializeNodesAsJsx(nodes));
}

export async function copyNodesAsSvg(
  nodes: readonly DesignNode[],
  writer: ClipboardWriter = systemClipboardWriter,
): Promise<void> {
  if (nodes.length === 0) throw new Error("Nothing is selected.");
  await writer.writeText(serializeNodesAsSvg(nodes));
}

/**
 * A single node as a PNG on the clipboard.
 *
 * One node only: compositing a multi-node selection into one bitmap would need
 * a capture of their shared bounds, which the screenshot path does not offer.
 */
export async function copyNodeAsPng(
  store: EditorStore,
  nodes: readonly DesignNode[],
  scale = 2,
  writer: ClipboardWriter = systemClipboardWriter,
  rasterize: NodeRasterizer = captureNodeScreenshot,
): Promise<void> {
  const node = nodes[0];
  if (!node) throw new Error("Nothing is selected.");
  if (nodes.length > 1) {
    throw new Error("Copy as PNG captures one node at a time. Select a single node or frame.");
  }

  const captured = await rasterize(store, node, scale, true);
  const bytes = Uint8Array.from(globalThis.atob(captured.data), (character) =>
    character.charCodeAt(0),
  );
  await writer.writeBlob(new Blob([bytes], { type: captured.mimeType }), captured.mimeType);
}
