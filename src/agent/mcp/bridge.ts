/**
 * Renderer-side MCP handlers used by the Electron desktop MCP server.
 *
 * One bridge installation serves the whole window. A document provider maps
 * tool calls onto the open document sessions: unaddressed calls route to the
 * focused (active-tab) document, while calls carrying an expected document id
 * route to any open tab — foreground or background — so agents can keep
 * working in documents the user is not currently viewing.
 */
import type { LeafBranchDto, LeafFileDto } from "../../core/shared/collaboration";
import type { EditorStore } from "../../core/state/EditorStore";
import type { LeafCollaborationWindowContext } from "../../core/state/collaboration-app-runtime";
import { type McpAgentIdentity, normalizeMcpAgentIdentity } from "../../core/state/agent-identity";
import { createRendererHandlers, dispatchRendererMcpCall } from "./bridge-handlers";
import { prepareMcpAgentActivity, recordMcpAgentActivity } from "./bridge-handlers/agent-activity";
import {
  aliasNodeIdsInMessage,
  aliasOutboundNodeIds,
  resolveInboundNodeHandles,
} from "./node-handles";
import type {
  RendererCollaborationAccess,
  RendererDocumentFileInfo,
  RendererOpenDocumentInfo,
} from "./bridge-handlers/types";

interface McpRequest {
  method: string;
  params: Record<string, unknown>;
}

/** Live accessors for one open document session (one editor tab). */
export interface McpDocumentBinding {
  /** `${fileId}:${branchId}` for the session, or null while it is still resolving. */
  getDocumentId(): string | null;
  getStore(): EditorStore | null;
  /** Terminal open failure for the session, when the provider tracks one. */
  getError?(): string | null;
  getFile(): LeafFileDto | null;
  getBranch(): LeafBranchDto | null;
  /** Rename the session's file. Absent when the runtime cannot rename files. */
  renameFile?(name: string): Promise<LeafFileDto>;
}

/** Window-level registry of open document sessions consumed by the bridge. */
export interface McpBridgeDocumentProvider {
  /** Create and ready a network-backed collaboration file, returning `fileId:branchId`. */
  createFile?(name: string): Promise<string>;
  /**
   * Close an open collaboration tab. Implementations refuse the window's
   * active tab. Absent when the runtime has no closable workspace tabs.
   */
  closeDocument?(documentId: string): void;
  getFocusedDocument(): McpDocumentBinding | null;
  findDocument(documentId: string): McpDocumentBinding | null;
  listDocuments(): McpDocumentBinding[];
}

export type McpHandler = {
  handleToolCall: (
    method: string,
    params: Record<string, unknown>,
    expectedDocumentId?: string,
    activityAgent?: McpAgentIdentity | string,
  ) => Promise<unknown>;
};

type McpBridgeHandlerOptions = {
  assertActive?: () => void;
};

interface McpBridgeInstallation {
  handler: McpHandler;
  provider: McpBridgeDocumentProvider;
}

let activeBridgeInstallation: McpBridgeInstallation | null = null;

type LeafWindow = Window & {
  leafCollaboration?: LeafCollaborationWindowContext;
  mcpHandlers?: McpHandler;
};

function getLeafWindow() {
  return window as LeafWindow;
}

/**
 * Create the page-local renderer handler independently of Electron's global
 * `window.mcpHandlers` installation. Browser-native transports such as
 * WebMCP use this same routing and EditorRuntime boundary without requiring
 * the desktop MCP server.
 */
export function createMcpBridgeHandler(
  provider: McpBridgeDocumentProvider,
  options: McpBridgeHandlerOptions = {},
) {
  const handler: McpHandler = {
    handleToolCall: async (method, params, expectedDocumentId, rawActivityAgent) => {
      options.assertActive?.();
      // Discovery and context reads are served from the provider directly:
      // they must work while the dashboard is focused (no active tab) and
      // while a routed tab's session is still opening, when no EditorStore
      // is dispatchable yet.
      if (method === "list_documents" && expectedDocumentId === undefined) {
        return { documents: collectOpenDocuments(provider) };
      }
      if (method === "create_file" && expectedDocumentId === undefined) {
        if (!provider.createFile) {
          throw new Error(
            "create_file is available only from Leaf's authenticated home workspace. No file was created.",
          );
        }
        const rawName = params.name;
        if (typeof rawName !== "string" || rawName.trim().length === 0) {
          throw new Error("create_file requires a non-empty file name. No file was created.");
        }
        const documentId = await provider.createFile(rawName.trim());
        const binding = provider.findDocument(documentId);
        const context = binding ? toContextInfo(binding) : null;
        const file = binding?.getFile() ?? null;
        const branch = binding?.getBranch() ?? null;
        if (!binding || !binding.getStore() || !context || !file || !branch) {
          throw new Error(
            `Leaf created collaboration document ${documentId}, but its editor session was not ready for MCP tools. Call list_documents and retry with that documentId.`,
          );
        }
        return {
          ...context,
          branchId: branch.branchId,
          fileId: file.fileId,
          workspaceId: file.workspaceId,
        };
      }
      // Served at the provider level, not through a store dispatch: a tab
      // whose session is stuck opening or failed must still be closable.
      if (method === "close_file") {
        if (expectedDocumentId === undefined) {
          throw new Error(
            "close_file requires documentId so the intended tab is explicit. No tab was closed.",
          );
        }
        if (!provider.closeDocument) {
          throw new Error(
            "close_file is available only for collaboration workspace tabs in this runtime. No tab was closed.",
          );
        }
        if (!provider.findDocument(expectedDocumentId)) {
          throw new Error(
            `close_file: no open tab has documentId ${expectedDocumentId}. Call list_documents for the open set. No tab was closed.`,
          );
        }
        provider.closeDocument(expectedDocumentId);
        return { closedDocumentId: expectedDocumentId };
      }
      if (method === "use_focused_document" && expectedDocumentId === undefined) {
        const focused = provider.getFocusedDocument();
        return {
          document: focused ? toContextInfo(focused) : null,
          retargeted: false,
        };
      }
      if (method === "get_document_context") {
        if (expectedDocumentId === undefined) {
          const focused = provider.getFocusedDocument();
          return focused ? toContextInfo(focused) : null;
        }
        const target = provider.findDocument(expectedDocumentId);
        return target ? toContextInfo(target) : null;
      }
      let binding: McpDocumentBinding | null;
      if (expectedDocumentId !== undefined) {
        binding = provider.findDocument(expectedDocumentId);
        if (!binding) {
          const focusedId = provider.getFocusedDocument()?.getDocumentId() ?? null;
          throw new Error(
            focusedId === null
              ? `Blocked ${method}: this renderer no longer has the expected document context (${expectedDocumentId}). No changes were made.`
              : `Blocked ${method}: this renderer now contains a different document (${focusedId}) instead of the expected document (${expectedDocumentId}). No changes were made.`,
          );
        }
      } else {
        binding = provider.getFocusedDocument();
        if (!binding) {
          throw new Error(
            `Blocked ${method}: no document is focused in this window. Focus a document tab or address the call with documentId.`,
          );
        }
      }
      const store = binding.getStore();
      if (!store) {
        const openError = binding.getError?.() ?? null;
        const documentLabel = expectedDocumentId ? ` (${expectedDocumentId})` : "";
        throw new Error(
          openError
            ? `The document session${documentLabel} failed to open: ${openError}`
            : `The document session${documentLabel} is still opening. Retry once it is ready.`,
        );
      }
      return handleRequest(
        store,
        { method, params },
        createBindingAccess(binding, provider),
        normalizeMcpAgentIdentity(rawActivityAgent),
      );
    },
  };
  return handler;
}

export function installMcpBridge(provider: McpBridgeDocumentProvider) {
  let installation: McpBridgeInstallation;
  let handler: McpHandler;
  handler = createMcpBridgeHandler(provider, {
    assertActive: () => {
      if (activeBridgeInstallation !== installation || getLeafWindow().mcpHandlers !== handler) {
        throw new Error("MCP bridge store is not initialized.");
      }
    },
  });
  installation = { handler, provider };

  activeBridgeInstallation = installation;
  getLeafWindow().mcpHandlers = handler;

  return () => {
    if (activeBridgeInstallation !== installation) return;
    activeBridgeInstallation = null;
    for (const binding of provider.listDocuments()) {
      binding.getStore()?.agentActivity.dispose();
    }
    if (getLeafWindow().mcpHandlers === handler) delete getLeafWindow().mcpHandlers;
  };
}

/**
 * Single-document compatibility wrapper over installMcpBridge.
 *
 * Serves windows that host exactly one document session (native document
 * windows, the bench harness, and tests). Session replacement is followed
 * through the collaboration context when one is available.
 */
export function initMcpBridge(
  store: EditorStore,
  collaborationContext?: LeafCollaborationWindowContext,
) {
  const normalizedContext = collaborationContext ?? null;
  const getContext = () => normalizedContext ?? getLeafWindow().leafCollaboration ?? null;
  const binding: McpDocumentBinding = {
    getDocumentId() {
      const context = getContext();
      const file = context?.currentFile;
      const branch = context?.currentBranch;
      return file && branch ? `${file.fileId}:${branch.branchId}` : null;
    },
    getStore() {
      const context = getContext();
      return context && typeof context.getCurrentSession === "function"
        ? (context.getCurrentSession()?.store ?? store)
        : store;
    },
    getFile() {
      return getContext()?.currentFile ?? null;
    },
    getBranch() {
      return getContext()?.currentBranch ?? null;
    },
  };
  return installMcpBridge({
    getFocusedDocument: () => binding,
    findDocument: (documentId) => (binding.getDocumentId() === documentId ? binding : null),
    listDocuments: () => [binding],
  });
}

function toDocumentInfo(
  binding: McpDocumentBinding,
  focusedDocumentId: string | null,
): RendererOpenDocumentInfo | null {
  const documentId = binding.getDocumentId();
  const file = binding.getFile();
  if (!documentId || !file) return null;
  return {
    dirty: null,
    displayName: file.name,
    documentId,
    filePath: null,
    focused: focusedDocumentId !== null && documentId === focusedDocumentId,
    kind: "collaboration",
  };
}

/** get_document_context response shape: document identity without a focused flag. */
function toContextInfo(binding: McpDocumentBinding) {
  const documentId = binding.getDocumentId();
  const file = binding.getFile();
  if (!documentId || !file) return null;
  return {
    dirty: null,
    displayName: file.name,
    documentId,
    filePath: null,
    kind: "collaboration",
  };
}

function collectOpenDocuments(provider: McpBridgeDocumentProvider): RendererOpenDocumentInfo[] {
  const focusedDocumentId = provider.getFocusedDocument()?.getDocumentId() ?? null;
  return provider
    .listDocuments()
    .map((candidate) => toDocumentInfo(candidate, focusedDocumentId))
    .filter((info): info is RendererOpenDocumentInfo => info !== null);
}

function toFileInfo(binding: McpDocumentBinding): RendererDocumentFileInfo | null {
  const currentFile = binding.getFile();
  const currentBranch = binding.getBranch();
  if (!currentFile || !currentBranch) return null;
  return {
    branchId: currentBranch.branchId,
    fileId: currentFile.fileId,
    name: currentFile.name,
  };
}

type BindingHandlerAccess = {
  getCollaborationContext: () => RendererCollaborationAccess;
  getCurrentFileInfo: () => RendererDocumentFileInfo | null;
  /**
   * Stable `fileId:branchId` identity for keying session-scoped MCP state
   * (node handles) that must survive EditorStore replacement, or null while
   * the session is still resolving.
   */
  getDocumentKey: () => string | null;
  listOpenDocuments: () => RendererOpenDocumentInfo[];
};

function createBindingAccess(
  binding: McpDocumentBinding,
  provider: McpBridgeDocumentProvider,
): BindingHandlerAccess {
  return {
    getDocumentKey: () => {
      try {
        return binding.getDocumentId();
      } catch {
        return null;
      }
    },
    getCollaborationContext: () => {
      const currentFile = binding.getFile();
      const currentBranch = binding.getBranch();
      if (!currentFile || !currentBranch) {
        throw new Error("Leaf collaboration context is not initialized.");
      }
      const renameFile = binding.renameFile?.bind(binding);
      return {
        currentFile,
        currentBranch,
        ...(renameFile ? { renameFile } : {}),
      };
    },
    getCurrentFileInfo: () => toFileInfo(binding),
    listOpenDocuments: () => collectOpenDocuments(provider),
  };
}

export async function handleRequest(
  store: EditorStore,
  msg: McpRequest,
  access?: BindingHandlerAccess,
  rawActivityAgent: McpAgentIdentity | string = normalizeMcpAgentIdentity(undefined),
): Promise<unknown> {
  const activityAgent = normalizeMcpAgentIdentity(rawActivityAgent);
  const resolvedAccess =
    access ??
    createBindingAccess(createWindowContextBinding(store), {
      getFocusedDocument: () => createWindowContextBinding(store),
      findDocument: () => null,
      listDocuments: () => [createWindowContextBinding(store)],
    });
  const handlers = createRendererHandlers({
    activityAgent,
    store,
    getCollaborationContext: resolvedAccess.getCollaborationContext,
    getCurrentFileInfo: resolvedAccess.getCurrentFileInfo,
    listOpenDocuments: resolvedAccess.listOpenDocuments,
  });
  // Agents see short #n handles for generated node IDs; handlers and
  // activity recording always see real IDs. Errors are aliased too so a
  // failure never leaks the long form back into the conversation. Handle
  // state keys on the document identity so a collaboration reconnect that
  // replaces the EditorStore never invalidates — or worse, renumbers —
  // handles the agent is still holding.
  const documentKey = resolvedAccess.getDocumentKey();
  const params = resolveInboundNodeHandles(store, msg.params, documentKey) as McpRequest["params"];
  const preparedActivity = prepareMcpAgentActivity(store, msg.method, params);
  let result: unknown;
  try {
    result = await dispatchRendererMcpCall(handlers, msg.method, params);
  } catch (error) {
    if (error instanceof Error) {
      error.message = aliasNodeIdsInMessage(store, error.message, documentKey);
    }
    throw error;
  }
  recordMcpAgentActivity(store, activityAgent, msg.method, params, result, preparedActivity);
  return aliasOutboundNodeIds(store, result, documentKey);
}

function createWindowContextBinding(store: EditorStore): McpDocumentBinding {
  const getContext = () => getLeafWindow().leafCollaboration ?? null;
  return {
    getDocumentId() {
      const context = getContext();
      const file = context?.currentFile;
      const branch = context?.currentBranch;
      return file && branch ? `${file.fileId}:${branch.branchId}` : null;
    },
    getStore: () => getContext()?.getCurrentSession()?.store ?? store,
    getFile: () => getContext()?.currentFile ?? null,
    getBranch: () => getContext()?.currentBranch ?? null,
  };
}
