import { z } from "zod";

export const documentIdSchema = z
  .string()
  .optional()
  .describe("Target document ID from list_documents. Omit to use the shared default binding.");

export const pageIdSchema = z.string().min(1).describe("Page ID from list_pages.");

export const optionalPageIdSchema = pageIdSchema
  .optional()
  .describe("Page ID from list_pages. Defaults to the active page.");

export const canvasCoordinateSchema = z
  .number()
  .finite()
  .describe("Finite canvas-space coordinate in pixels.");

export const collaborationFileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((value) => !value.includes("\u0000") && !value.includes("\r") && !value.includes("\n"), {
    message: "File names must be a single non-empty line of 120 characters or fewer.",
  });

export const positivePixelDimensionSchema = z.union([
  z.number().finite().positive(),
  z
    .string()
    .regex(/^(?:\d+(?:\.\d+)?)px$/, 'Expected a positive pixel value such as "1440px".')
    .refine((value) => Number.parseFloat(value) > 0, "Pixel dimensions must be greater than zero."),
]);

/** Placement belongs to the top-level x/y parameters, never to artboard styles. */
export function flagArtboardStylesPlacement(
  styles: Record<string, unknown>,
  context: z.core.$RefinementCtx,
) {
  for (const key of ["x", "y"] as const) {
    if (!Object.hasOwn(styles, key)) continue;
    context.addIssue({
      code: "custom",
      path: [key],
      message: `Use the top-level ${key} placement parameter, not styles.${key}.`,
    });
  }
}

/** Cross-field rules shared by every move_nodes surface. */
export function flagIncompleteMovePlacement(
  move: { x?: number; y?: number; coordinateSpace?: "canvas" | "parent" },
  context: z.core.$RefinementCtx,
) {
  if ((move.x === undefined) !== (move.y === undefined)) {
    context.addIssue({ code: "custom", message: "x and y must be provided together." });
  }
  if (move.coordinateSpace !== undefined && move.x === undefined) {
    context.addIssue({ code: "custom", message: "coordinateSpace requires x and y." });
  }
}

// Behavior-critical caveats shared verbatim by the desktop MCP and WebMCP tool
// descriptions so the two surfaces cannot drift apart.
/**
 * Batched page operations shared by the desktop `edit_pages` tool and the
 * WebMCP projection — one definition so the two surfaces cannot drift.
 * Strict objects because WebMCP treats browser schema enforcement as
 * advisory and re-validates inputs itself.
 */
export const pageOperationSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("create"),
    name: z.string().trim().min(1).optional().describe("Optional page name."),
    activate: z.boolean().optional().describe("Switch the editor to the new page. Default false."),
  }),
  z.strictObject({
    action: z.literal("rename"),
    pageId: pageIdSchema,
    name: z.string().trim().min(1).describe("New page name."),
  }),
  z.strictObject({
    action: z.literal("duplicate"),
    pageId: pageIdSchema,
  }),
  z.strictObject({
    action: z.literal("reorder"),
    pageIds: z.array(pageIdSchema).min(1).describe("Complete ordered page ID list."),
  }),
  z.strictObject({
    action: z.literal("set-active"),
    pageId: pageIdSchema,
  }),
  z.strictObject({
    action: z.literal("move-nodes"),
    nodeIds: z.array(z.string().min(1)).min(1).describe("Node IDs to move."),
    pageId: pageIdSchema,
  }),
]);

export const TEXT_OVERFLOW_TOLERANCE_NOTE =
  "Overflow flags ignore sub-line excess from line-box rounding and font metrics (content up to ~10% of one line-height taller than the box is not overflow)";

export const UNANCHORED_REGEX_NOTE =
  'Name and text patterns are unanchored regular expressions, not exact matches — "Price" also matches "Price row"; anchor with ^...$ for an exact match.';
