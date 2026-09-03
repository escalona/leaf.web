import type { AgentActivityKind } from "../../../core/state/agent-activity";
import type { EditorStore } from "../../../core/state/EditorStore";
import type { McpAgentIdentity } from "../../../core/state/agent-identity";

type PreparedAgentActivity = {
  nodeIds: string[];
};

type ActivityRecord = {
  activityKind: AgentActivityKind;
  nodeIds: string[];
};

const READ_NODE_ID_PARAM_METHODS = new Set(["get_node_info", "get_jsx", "get_screenshot"]);

const READ_NODE_IDS_PARAM_METHODS = new Set([
  "get_computed_styles",
  "get_screenshot",
  "measure_text",
]);

const EDIT_UPDATE_METHODS = new Set(["set_text_content", "rename_nodes", "set_node_visibility"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((candidate): candidate is string => typeof candidate === "string")
    : [];
}

function idsFromObjects(value: unknown, key = "id") {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const record = asRecord(candidate);
    return record && typeof record[key] === "string" ? [record[key] as string] : [];
  });
}

function updateNodeIds(params: Record<string, unknown>) {
  return idsFromObjects(params.updates, "nodeId");
}

function styleUpdateNodeIds(params: Record<string, unknown>) {
  if (!Array.isArray(params.updates)) return [];
  return params.updates.flatMap((candidate) => {
    const record = asRecord(candidate);
    return record ? stringArray(record.nodeIds) : [];
  });
}

function collectSubtreeIds(store: EditorStore, rootIds: readonly string[]) {
  const ids: string[] = [];
  const visit = (nodeId: string) => {
    const node = store.getNode(nodeId);
    if (!node) return;
    ids.push(node.id);
    for (const child of node.children) visit(child.id);
  };
  for (const rootId of rootIds) visit(rootId);
  return ids;
}

function pageRootIds(store: EditorStore, pageId: unknown) {
  const resolvedPageId = typeof pageId === "string" ? pageId : store.activePageId;
  return store.pages.find((page) => page.id === resolvedPageId)?.nodes.map((node) => node.id) ?? [];
}

function allPageRootIds(store: EditorStore) {
  return store.pages.flatMap((page) => page.nodes.map((node) => node.id));
}

/**
 * Deleted nodes are gone by the time activity is recorded, so their IDs are
 * captured before dispatch. (The former reveal-geometry capture — a DOM read
 * per written node — went away with the reveal animation.)
 */
export function prepareMcpAgentActivity(
  store: EditorStore,
  method: string,
  params: Record<string, unknown>,
): PreparedAgentActivity | null {
  let nodeIds: string[] = [];
  if (method === "delete_nodes") {
    nodeIds = stringArray(params.nodeIds);
  } else if (method === "delete_page") {
    nodeIds = pageRootIds(store, params.pageId);
  }
  if (nodeIds.length === 0) return null;
  return { nodeIds };
}

function resolveReadActivity(
  store: EditorStore,
  method: string,
  params: Record<string, unknown>,
  result: unknown,
): ActivityRecord | null {
  let nodeIds: string[] = [];
  if (method === "get_selection") {
    nodeIds = idsFromObjects(asRecord(result)?.nodes);
  } else if (method === "get_tree_summary") {
    nodeIds =
      typeof params.nodeId === "string"
        ? [params.nodeId]
        : params.allPages === true
          ? allPageRootIds(store)
          : pageRootIds(store, params.pageId);
  } else if (READ_NODE_ID_PARAM_METHODS.has(method) && typeof params.nodeId === "string") {
    nodeIds = [params.nodeId];
  } else if (READ_NODE_IDS_PARAM_METHODS.has(method)) {
    nodeIds = stringArray(params.nodeIds);
  } else if (method === "find_nodes") {
    nodeIds = idsFromObjects(asRecord(result)?.matches);
  } else if (method === "set_viewport" && typeof params.nodeId === "string") {
    nodeIds = [params.nodeId];
  } else if (method === "get_canvas_layout" || method === "get_page_screenshot") {
    nodeIds = pageRootIds(store, params.pageId);
  }
  return nodeIds.length > 0 ? { activityKind: "read", nodeIds } : null;
}

function resolveWriteActivity(
  store: EditorStore,
  method: string,
  params: Record<string, unknown>,
  result: unknown,
  prepared: PreparedAgentActivity | null,
): ActivityRecord | null {
  const resultRecord = asRecord(result);
  let nodeIds: string[] = [];

  if (method === "create_artboard" || method === "create_image") {
    if (typeof resultRecord?.id === "string") nodeIds = [resultRecord.id];
  } else if (method === "write_html") {
    nodeIds = collectSubtreeIds(store, idsFromObjects(resultRecord?.created));
  } else if (method === "create_ink") {
    nodeIds = idsFromObjects(resultRecord?.created);
  } else if (method === "duplicate_nodes") {
    nodeIds = idsFromObjects(result, "newId");
  } else if (method === "update_styles") {
    nodeIds = styleUpdateNodeIds(params);
  } else if (EDIT_UPDATE_METHODS.has(method)) {
    nodeIds = updateNodeIds(params);
  } else if (method === "move_nodes") {
    nodeIds = idsFromObjects(params.moves, "nodeId");
  } else if (method === "edit_pages") {
    const operations = Array.isArray(params.operations) ? params.operations : [];
    const results = asRecord(result)?.results;
    const resultList = Array.isArray(results) ? results : [];
    for (const [index, operation] of operations.entries()) {
      const op = asRecord(operation);
      if (op?.action === "move-nodes") {
        nodeIds.push(...stringArray(op.nodeIds));
      } else if (op?.action === "duplicate") {
        const duplicatedPageId = asRecord(asRecord(resultList[index])?.page)?.id;
        if (typeof duplicatedPageId === "string") {
          nodeIds.push(...pageRootIds(store, duplicatedPageId));
        }
      }
    }
  } else if (method === "delete_nodes") {
    const deletedNodeIds = stringArray(resultRecord?.deleted);
    nodeIds = (prepared?.nodeIds ?? []).filter((nodeId) => deletedNodeIds.includes(nodeId));
  } else if (method === "delete_page") {
    nodeIds = typeof resultRecord?.deletedPageId === "string" ? (prepared?.nodeIds ?? []) : [];
  }

  return nodeIds.length > 0 ? { activityKind: "write", nodeIds } : null;
}

export function recordMcpAgentActivity(
  store: EditorStore,
  agent: McpAgentIdentity,
  method: string,
  params: Record<string, unknown>,
  result: unknown,
  prepared: PreparedAgentActivity | null,
) {
  // Any successful document-bound call is the agent's "hello": presence shows
  // the connected agent before it leases a node. An explicit finish is the
  // agent leaving, so it must not re-announce itself on the way out.
  if (method !== "finish_working_on_nodes") store.agentActivity.announce(agent);
  const record =
    resolveReadActivity(store, method, params, result) ??
    resolveWriteActivity(store, method, params, result, prepared);
  if (!record) return;
  store.agentActivity.record(agent, record.nodeIds, record.activityKind);
}
