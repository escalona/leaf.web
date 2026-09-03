import { z } from "zod";
import { isImageGenerationAvailable } from "../../core/editor/image-generation-client";
import { type McpAgentIdentity, normalizeMcpAgentIdentity } from "../../core/state/agent-identity";
import {
  canvasCoordinateSchema,
  collaborationFileNameSchema,
  pageOperationSchema,
  flagArtboardStylesPlacement,
  flagIncompleteMovePlacement,
  optionalPageIdSchema,
  positivePixelDimensionSchema,
  TEXT_OVERFLOW_TOLERANCE_NOTE,
  UNANCHORED_REGEX_NOTE,
} from "../mcp/tool-schemas";

export type WebMcpJsonValue =
  | null
  | boolean
  | number
  | string
  | WebMcpJsonValue[]
  | { [key: string]: WebMcpJsonValue };

export interface WebMcpToolAnnotations {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
}

export interface WebMcpToolExecutionContext {
  signal: AbortSignal;
}

export interface WebMcpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: WebMcpToolAnnotations;
  execute(
    input: unknown,
    context: WebMcpToolExecutionContext,
  ): WebMcpJsonValue | Promise<WebMcpJsonValue>;
}

/** Minimal browser API shape while WebMCP is still an emerging DOM standard. */
export interface WebMcpModelContext {
  registerTool(tool: WebMcpTool, options: { signal: AbortSignal }): void | Promise<void>;
}

export type LeafWebMcpExecutor = (
  method: string,
  params: Record<string, unknown>,
  expectedDocumentId: string,
  activityAgent: McpAgentIdentity | string,
) => Promise<unknown>;

export type LeafWebMcpEnvelope =
  | { ok: true; result: WebMcpJsonValue }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        issues?: Array<{ path: string; message: string }>;
      };
    };

export interface LeafWebMcpRegistration {
  readonly expectedDocumentId: string;
  /** The tab-scoped identity every tool call from this registration records activity under. */
  readonly activityAgent: McpAgentIdentity;
  readonly ready: Promise<void>;
  readonly signal: AbortSignal;
  /**
   * True only after dispose(). A registration failure also aborts `signal`, so
   * callers deciding whether a `ready` rejection was deliberate teardown must
   * check this flag, not the signal.
   */
  readonly disposed: boolean;
  dispose(): void;
}

export interface RegisterLeafWebMcpOptions {
  executor: LeafWebMcpExecutor;
  getDocumentId: () => string | null;
  /**
   * Display identity for the page agent. Its `id` is a base: registration
   * scopes it per browser tab (see `scopeWebMcpActivityAgent`) so agents in
   * different tabs never pool working indicators.
   */
  activityAgent: McpAgentIdentity | string;
  /** Test seam and escape hatch for hosts that provide their own ModelContext object. */
  modelContext?: WebMcpModelContext | null;
}

type ToolDefinition = {
  name: string;
  method?: string;
  description: string;
  /** Appended to the description only while image generation is available. */
  imageGenerationNote?: string;
  schema: z.ZodType;
  annotations: WebMcpToolAnnotations;
};

const readAnnotations = {
  readOnlyHint: true,
  untrustedContentHint: true,
} as const satisfies WebMcpToolAnnotations;

const writeAnnotations = {
  readOnlyHint: false,
  // Results can echo user-authored layer names, text, comments, or HTML-derived metadata.
  untrustedContentHint: true,
} as const satisfies WebMcpToolAnnotations;

const nodeIdSchema = z.string().min(1);
const coordinateSchema = canvasCoordinateSchema;
const emptySchema = z.strictObject({});

const artboardStylesSchema = z
  .object({
    width: positivePixelDimensionSchema,
    height: z.union([positivePixelDimensionSchema, z.literal("auto")]),
  })
  .catchall(z.union([z.string(), z.number()]))
  .superRefine(flagArtboardStylesPlacement);

const createArtboardSchema = z
  .strictObject({
    name: z.string().min(1),
    styles: artboardStylesSchema,
    x: coordinateSchema.optional(),
    y: coordinateSchema.optional(),
    nextTo: nodeIdSchema.optional(),
    pageId: optionalPageIdSchema,
  })
  .superRefine(({ x, y, nextTo }, context) => {
    if ((x === undefined) !== (y === undefined)) {
      context.addIssue({ code: "custom", message: "x and y must be provided together." });
    }
    if (nextTo !== undefined && x !== undefined) {
      context.addIssue({
        code: "custom",
        message: "nextTo cannot be combined with exact x/y placement.",
      });
    }
  });

const moveSchema = z
  .strictObject({
    nodeId: nodeIdSchema,
    parentId: nodeIdSchema.nullable().optional(),
    index: z.number().int().min(0).optional(),
    x: coordinateSchema.optional(),
    y: coordinateSchema.optional(),
    coordinateSpace: z.enum(["canvas", "parent"]).optional(),
  })
  .superRefine(flagIncompleteMovePlacement);

export const LEAF_WEBMCP_TOOL_DEFINITIONS = [
  {
    name: "list_pages",
    description:
      "List every page in the focused Leaf document, including stable IDs, order, active state, root counts, and camera state.",
    schema: emptySchema,
    annotations: readAnnotations,
  },
  {
    name: "get_basic_info",
    description:
      "Get compact document context: node and root counts, pages, artboards, top-level nodes, dimensions, and loaded fonts. Defaults to the active page.",
    schema: z
      .strictObject({ pageId: optionalPageIdSchema, allPages: z.boolean().optional() })
      .superRefine(({ pageId, allPages }, context) => {
        if (pageId !== undefined && allPages === true) {
          context.addIssue({
            code: "custom",
            message: "pageId and allPages cannot be combined.",
          });
        }
      }),
    annotations: readAnnotations,
  },
  {
    name: "get_selection",
    description:
      "Get detailed information about the currently selected nodes, including IDs, names, types, size, and styles.",
    schema: emptySchema,
    annotations: readAnnotations,
  },
  {
    name: "get_tree_summary",
    description:
      "Get a compact hierarchy summary for one node, one page, or all pages. Prefer this over repeatedly inspecting descendants.",
    schema: z
      .strictObject({
        nodeId: nodeIdSchema.optional(),
        pageId: optionalPageIdSchema,
        allPages: z.boolean().optional(),
        depth: z.number().int().min(0).max(10).optional(),
      })
      .superRefine(({ nodeId, pageId, allPages }, context) => {
        if (nodeId !== undefined && (pageId !== undefined || allPages === true)) {
          context.addIssue({
            code: "custom",
            message: "nodeId cannot be combined with pageId or allPages.",
          });
        }
        if (pageId !== undefined && allPages === true) {
          context.addIssue({
            code: "custom",
            message: "pageId and allPages cannot be combined.",
          });
        }
      }),
    annotations: readAnnotations,
  },
  {
    name: "get_node_info",
    description:
      "Inspect one node's size, position, parent, children, authored styles, and text or image content.",
    schema: z.strictObject({ nodeId: nodeIdSchema }),
    annotations: readAnnotations,
  },
  {
    name: "get_node_styles",
    method: "get_computed_styles",
    description:
      "Get Leaf's authored and model-resolved properties for one or more nodes. This excludes inherited browser defaults and renderer placement transforms.",
    schema: z.strictObject({ nodeIds: z.array(nodeIdSchema).min(1).max(100) }),
    annotations: readAnnotations,
  },
  {
    name: "measure_text",
    description: `Measure rendered Leaf text nodes after layout settles, including boxes, content size, overflow, and resolved font metrics. ${TEXT_OVERFLOW_TOLERANCE_NOTE}, so do not try to repair a small reported content-height excess that a screenshot shows is not clipped.`,
    schema: z.strictObject({ nodeIds: z.array(nodeIdSchema).min(1).max(100) }),
    annotations: readAnnotations,
  },
  {
    name: "find_nodes",
    description: `Search one page or all pages by layer-name regex, node type, or text regex. Filters combine with AND. ${UNANCHORED_REGEX_NOTE}`,
    schema: z
      .strictObject({
        name: z.string().optional(),
        type: z
          .enum(["frame", "text", "rectangle", "svg", "interactive-surface", "image"])
          .optional(),
        text: z.string().optional(),
        rootId: nodeIdSchema.optional(),
        pageId: optionalPageIdSchema,
        allPages: z.boolean().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      })
      .superRefine(({ rootId, pageId, allPages }, context) => {
        if (allPages === true && (rootId !== undefined || pageId !== undefined)) {
          context.addIssue({
            code: "custom",
            message: "allPages cannot be combined with rootId or pageId.",
          });
        }
      }),
    annotations: readAnnotations,
  },
  {
    name: "get_canvas_layout",
    description:
      "Measure page-level root layout, overlaps, visible-root gaps, and compact naming or unlocked-image lint.",
    schema: z.strictObject({
      pageId: optionalPageIdSchema,
      verboseLint: z.boolean().optional(),
    }),
    annotations: readAnnotations,
  },
  {
    name: "get_jsx",
    description:
      "Get the JSX code representation of a node and its descendants with inline styles.",
    schema: z.strictObject({ nodeId: nodeIdSchema }),
    annotations: readAnnotations,
  },
  {
    name: "get_font_family_info",
    description:
      "Check whether font families are available. Looks up fonts locally and on Google Fonts; a found Google Font is automatically loaded and made available for use.",
    schema: z.strictObject({ familyNames: z.array(z.string().min(1)).min(1).max(50) }),
    annotations: readAnnotations,
  },
  {
    name: "edit_pages",
    description:
      'Edit durable Leaf pages in one batch; operations apply in order. A failing operation stops the batch: the response carries completed results plus failedOperation {index, action, error}, and completed operations stay applied. Actions: "create" (append a page, active only with activate:true), "rename", "duplicate" (deep copy with fresh node IDs; activates the copy and returns descendantIdMap), "reorder" (complete page ID list), "set-active", and "move-nodes" (move nodes to a page as roots, preserving canvas positions and node IDs).',
    schema: z.strictObject({
      operations: z.array(pageOperationSchema).min(1),
    }),
    annotations: writeAnnotations,
  },
  {
    name: "rename_file",
    description:
      "Rename the focused Leaf file's display name (the file itself, not a page or layer) so finished work does not stay an untitled file. Fails with an explicit error when this document's runtime cannot rename files.",
    schema: z.strictObject({ name: collaborationFileNameSchema }),
    annotations: writeAnnotations,
  },
  {
    name: "create_artboard",
    description:
      "Create a root artboard with required width and height. Omit x/y for collision-aware placement, or use nextTo to place it beside an existing root.",
    imageGenerationNote:
      "A user-requested generated background may use a Leaf-native leaf-gen:// URL in styles.backgroundImage.",
    schema: createArtboardSchema,
    annotations: writeAnnotations,
  },
  {
    name: "write_html",
    description:
      "Parse inline HTML into Leaf nodes. Use insert-children to add content or replace to replace one target. Only inline HTML is accepted; filesystem paths are not exposed to the page agent.",
    imageGenerationNote:
      "User-requested generated imagery may use leaf-gen:// in an img src or background-image and completes asynchronously.",
    schema: z.strictObject({
      html: z.string().min(1),
      targetNodeId: nodeIdSchema,
      mode: z.enum(["insert-children", "replace"]),
      flattenFixedAndSticky: z.boolean().optional(),
      returnTree: z.boolean().optional().default(false),
    }),
    annotations: writeAnnotations,
  },
  {
    name: "update_styles",
    description:
      "Apply targeted camelCase style changes. A null value removes a property instead of assigning an empty string.",
    imageGenerationNote:
      "User-requested generated imagery may set backgroundImage to one leaf-gen:// url() and completes asynchronously.",
    schema: z.strictObject({
      updates: z
        .array(
          z.strictObject({
            nodeIds: z.array(nodeIdSchema).min(1),
            styles: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
          }),
        )
        .min(1),
    }),
    annotations: writeAnnotations,
  },
  {
    name: "set_text_content",
    description: "Set text content on one or more Text nodes without replacing their node IDs.",
    schema: z.strictObject({
      updates: z
        .array(
          z.strictObject({
            nodeId: nodeIdSchema,
            textContent: z.string(),
          }),
        )
        .min(1),
    }),
    annotations: writeAnnotations,
  },
  {
    name: "duplicate_nodes",
    description:
      "Deep-clone one or more nodes and descendants. Root artboard copies are placed to avoid overlap.",
    schema: z.strictObject({
      nodes: z
        .array(
          z.strictObject({
            id: nodeIdSchema,
            parentId: nodeIdSchema.optional(),
          }),
        )
        .min(1),
    }),
    annotations: writeAnnotations,
  },
  {
    name: "delete_nodes",
    description:
      "Permanently delete nodes and all descendants. Verify parentage with get_node_info before deleting uncertain targets.",
    schema: z.strictObject({ nodeIds: z.array(nodeIdSchema).min(1) }),
    annotations: writeAnnotations,
  },
  {
    name: "rename_nodes",
    description: "Rename one or more layers. Leaf truncates display names to 50 characters.",
    schema: z.strictObject({
      updates: z.array(z.strictObject({ nodeId: nodeIdSchema, name: z.string() })).min(1),
    }),
    annotations: writeAnnotations,
  },
  {
    name: "move_nodes",
    description:
      "Reparent, reorder, or position existing nodes while preserving IDs. Exact x/y values are canvas coordinates unless coordinateSpace is parent.",
    schema: z.strictObject({ moves: z.array(moveSchema).min(1) }),
    annotations: writeAnnotations,
  },
  {
    name: "set_node_visibility",
    description: "Show, hide, lock, or unlock one or more layers without deleting them.",
    schema: z.strictObject({
      updates: z
        .array(
          z
            .strictObject({
              nodeId: nodeIdSchema,
              visible: z.boolean().optional(),
              locked: z.boolean().optional(),
            })
            .refine(
              ({ visible, locked }) => visible !== undefined || locked !== undefined,
              "Each update must set visible, locked, or both.",
            ),
        )
        .min(1),
    }),
    annotations: writeAnnotations,
  },
  {
    name: "list_comments",
    description:
      "List canvas comment threads, anchors, authors, messages, reactions, and resolution state across one page or all pages.",
    schema: z.strictObject({
      includeResolved: z.boolean().optional().default(true),
      pageId: optionalPageIdSchema,
    }),
    annotations: readAnnotations,
  },
  {
    name: "add_comment",
    description:
      "Reply to a thread or start a page-, point-, or node-anchored comment authored under this agent's identity.",
    schema: z
      .strictObject({
        body: z.string().min(1),
        threadId: z.string().min(1).optional(),
        nodeId: nodeIdSchema.optional(),
        x: coordinateSchema.optional(),
        y: coordinateSchema.optional(),
        pageId: optionalPageIdSchema,
      })
      .superRefine(({ x, y }, context) => {
        if ((x === undefined) !== (y === undefined)) {
          context.addIssue({ code: "custom", message: "x and y must be provided together." });
        }
      }),
    annotations: writeAnnotations,
  },
  {
    name: "resolve_comment_thread",
    description: "Resolve or reopen a comment thread under this agent's identity.",
    schema: z.strictObject({
      threadId: z.string().min(1),
      resolved: z.boolean(),
    }),
    annotations: writeAnnotations,
  },
  {
    name: "set_viewport",
    description:
      "Fit a node in the viewport or set absolute zoom and pan, returning the resulting camera and viewport size.",
    schema: z.strictObject({
      nodeId: nodeIdSchema.optional(),
      margin: z.number().finite().optional(),
      zoom: z.number().finite().positive().optional(),
      panX: z.number().finite().optional(),
      panY: z.number().finite().optional(),
    }),
    annotations: writeAnnotations,
  },
  {
    name: "finish_working_on_nodes",
    description:
      "Release this agent's working indicators for selected node IDs, or all owned indicators when nodeIds is omitted.",
    schema: z.strictObject({ nodeIds: z.array(nodeIdSchema).min(1).optional() }),
    annotations: readAnnotations,
  },
] as const satisfies readonly ToolDefinition[];

export type LeafWebMcpToolName = (typeof LEAF_WEBMCP_TOOL_DEFINITIONS)[number]["name"];

export const LEAF_WEBMCP_TOOL_NAMES: readonly LeafWebMcpToolName[] =
  LEAF_WEBMCP_TOOL_DEFINITIONS.map(({ name }) => name);

export const WEBMCP_AGENT_SESSION_STORAGE_KEY = "leaf.webmcp.agent-session";

let fallbackWebMcpSessionId: string | null = null;

function generateWebMcpSessionId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * A browser tab's WebMCP session ID: generated once per tab and kept in
 * `sessionStorage`, so it survives reloads and tab/branch re-registration but
 * differs across tabs. Falls back to a per-realm ID where storage is blocked.
 */
export function getWebMcpSessionId() {
  try {
    const storage = globalThis.sessionStorage;
    const existing = storage.getItem(WEBMCP_AGENT_SESSION_STORAGE_KEY);
    if (existing) return existing;
    const created = generateWebMcpSessionId();
    storage.setItem(WEBMCP_AGENT_SESSION_STORAGE_KEY, created);
    return created;
  } catch {
    fallbackWebMcpSessionId ??= generateWebMcpSessionId();
    return fallbackWebMcpSessionId;
  }
}

/**
 * Give each tab's page agent its own activity identity while keeping the
 * shared display name. `finish_working_on_nodes` releases leases by agent ID,
 * so without this one tab's finish would clear another tab's indicators.
 */
export function scopeWebMcpActivityAgent(agent: McpAgentIdentity | string): McpAgentIdentity {
  const identity = normalizeMcpAgentIdentity(agent);
  return { ...identity, id: `${identity.id}:${getWebMcpSessionId()}` };
}

function getDocumentModelContext(): unknown {
  if (typeof document === "undefined") return null;
  return (document as Document & { modelContext?: unknown }).modelContext;
}

export function isWebMcpAvailable(
  value: unknown = getDocumentModelContext(),
): value is WebMcpModelContext {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { registerTool?: unknown }).registerTool === "function"
  );
}

// The tool definitions are module constants, but registration re-runs on every
// tab or branch focus change — convert each schema at most once.
const inputJsonSchemaCache = new WeakMap<z.ZodType, Record<string, unknown>>();

function toInputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const cached = inputJsonSchemaCache.get(schema);
  if (cached) return cached;
  const { $schema: _dialect, ...inputSchema } = z.toJSONSchema(schema, {
    target: "draft-07",
    io: "input",
  });
  inputJsonSchemaCache.set(schema, inputSchema);
  return inputSchema;
}

function compactMessage(value: unknown) {
  const message = value instanceof Error ? value.message : "Leaf tool execution failed.";
  return message.trim().slice(0, 1_000) || "Leaf tool execution failed.";
}

function toJsonValue(value: unknown): WebMcpJsonValue {
  if (value === undefined) return null;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("Leaf returned a result that cannot be serialized as JSON.");
  }
  return JSON.parse(encoded) as WebMcpJsonValue;
}

function invalidInputEnvelope(error: z.ZodError): LeafWebMcpEnvelope {
  return {
    ok: false,
    error: {
      code: "invalid_input",
      message: "The tool input did not match Leaf's WebMCP schema.",
      issues: error.issues.slice(0, 8).map((issue) => ({
        path: issue.path.join("."),
        message: issue.message.slice(0, 240),
      })),
    },
  };
}

function describeTool(definition: ToolDefinition) {
  if (!definition.imageGenerationNote || !isImageGenerationAvailable())
    return definition.description;
  return `${definition.description} ${definition.imageGenerationNote}`;
}

function createRegisteredTool(
  definition: ToolDefinition,
  options: RegisterLeafWebMcpOptions,
  expectedDocumentId: string,
  activityAgent: McpAgentIdentity,
  registrationSignal: AbortSignal,
): WebMcpTool {
  return {
    name: definition.name,
    description: describeTool(definition),
    inputSchema: toInputJsonSchema(definition.schema),
    annotations: definition.annotations,
    execute: async (input, context) => {
      if (registrationSignal.aborted) {
        return {
          ok: false,
          error: { code: "registration_disposed", message: "Leaf removed this WebMCP tool." },
        } satisfies LeafWebMcpEnvelope;
      }
      // The draft requires options.signal, but tolerate host adapters that pass an empty object.
      if (context?.signal?.aborted) {
        return {
          ok: false,
          error: { code: "call_aborted", message: "The WebMCP tool call was cancelled." },
        } satisfies LeafWebMcpEnvelope;
      }

      // MCP hosts commonly send null (not just omitted) arguments for
      // parameterless tools; treat both as an empty input object.
      const parsed = definition.schema.safeParse(input ?? {});
      if (!parsed.success) return invalidInputEnvelope(parsed.error);

      let currentDocumentId: string | null = null;
      try {
        currentDocumentId = options.getDocumentId();
      } catch {
        // Treat a failing focus accessor exactly like a missing document.
      }
      if (currentDocumentId !== expectedDocumentId) {
        return {
          ok: false,
          error: {
            code: "document_changed",
            message:
              "Leaf's focused document changed after these tools were registered. No action was taken.",
          },
        } satisfies LeafWebMcpEnvelope;
      }

      try {
        const result = await options.executor(
          definition.method ?? definition.name,
          parsed.data as Record<string, unknown>,
          expectedDocumentId,
          activityAgent,
        );
        return { ok: true, result: toJsonValue(result) } satisfies LeafWebMcpEnvelope;
      } catch (error) {
        return {
          ok: false,
          error: { code: "execution_failed", message: compactMessage(error) },
        } satisfies LeafWebMcpEnvelope;
      }
    },
  };
}

/**
 * Register Leaf's curated, page-local browser tool surface.
 *
 * The document identity is captured once and checked again before every call.
 * The injected bridge executor also receives that identity so a focus change
 * racing the local check remains fail-closed at the renderer routing boundary.
 */
export function registerLeafWebMcp(
  options: RegisterLeafWebMcpOptions,
): LeafWebMcpRegistration | null {
  const modelContext = options.modelContext ?? getDocumentModelContext();
  if (!isWebMcpAvailable(modelContext)) return null;

  let expectedDocumentId: string | null = null;
  try {
    expectedDocumentId = options.getDocumentId();
  } catch {
    return null;
  }
  if (typeof expectedDocumentId !== "string" || expectedDocumentId.trim().length === 0) {
    return null;
  }

  const activityAgent = scopeWebMcpActivityAgent(options.activityAgent);
  const controller = new AbortController();
  const pendingRegistrations: Array<Promise<void>> = [];
  try {
    for (const definition of LEAF_WEBMCP_TOOL_DEFINITIONS) {
      const registration = modelContext.registerTool(
        createRegisteredTool(
          definition,
          options,
          expectedDocumentId,
          activityAgent,
          controller.signal,
        ),
        { signal: controller.signal },
      );
      pendingRegistrations.push(Promise.resolve(registration));
    }
  } catch (error) {
    controller.abort();
    throw error;
  }

  const ready = Promise.all(pendingRegistrations).then(
    () => undefined,
    (error: unknown) => {
      controller.abort();
      throw error;
    },
  );

  let disposed = false;
  return {
    activityAgent,
    expectedDocumentId,
    ready,
    signal: controller.signal,
    get disposed() {
      return disposed;
    },
    dispose: () => {
      disposed = true;
      controller.abort();
    },
  };
}
