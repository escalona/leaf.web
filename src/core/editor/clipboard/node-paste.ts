import { z } from "zod";
import type { PersistedDesignNode } from "../../state/document";
import type { Point } from "../../types";

export const NODE_CLIPBOARD_MIME_TYPE = "application/x-leaf-nodes+json";

export interface NodeClipboardEntry {
  node: PersistedDesignNode;
  canvasPosition: Point;
  parentId?: string;
}

export interface NodeClipboardPayload {
  version: 1;
  nodes: NodeClipboardEntry[];
}

const boundaryNumberSchema = z.custom<number>((value) => typeof value === "number");

const persistedDesignNodeSchema: z.ZodType<PersistedDesignNode> = z.lazy(
  () =>
    z
      .object({
        id: z.string(),
        type: z.string(),
        children: z.array(persistedDesignNodeSchema),
      })
      .passthrough() as unknown as z.ZodType<PersistedDesignNode>,
);

const nodeClipboardEntrySchema = z
  .object({
    node: persistedDesignNodeSchema,
    canvasPosition: z
      .object({
        x: boundaryNumberSchema,
        y: boundaryNumberSchema,
      })
      .passthrough(),
    parentId: z.string().optional(),
  })
  .passthrough();

const nodeClipboardPayloadSchema = z
  .object({
    version: z.literal(1),
    nodes: z.array(nodeClipboardEntrySchema),
  })
  .passthrough();

export function serializeNodeClipboardPayload(payload: NodeClipboardPayload) {
  return JSON.stringify(payload);
}

export function parseNodeClipboardPayload(serialized: string): NodeClipboardPayload | null {
  try {
    const parsed = nodeClipboardPayloadSchema.safeParse(JSON.parse(serialized));
    if (!parsed.success) return null;
    return { version: 1, nodes: parsed.data.nodes };
  } catch {
    return null;
  }
}
