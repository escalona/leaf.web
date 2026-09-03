export const DEFAULT_MCP_AGENT_ID = "leaf-mcp-default";

export type McpAgentKind = "claude-code" | "codex" | "unknown";

export type McpAgentIdentity = {
  id: string;
  kind: McpAgentKind;
  label: string;
};

export const DEFAULT_MCP_AGENT_IDENTITY: McpAgentIdentity = {
  id: DEFAULT_MCP_AGENT_ID,
  kind: "unknown",
  label: "Agent",
};

export function normalizeMcpAgentId(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, 256)
    : DEFAULT_MCP_AGENT_ID;
}

function normalizeMcpAgentKind(value: unknown): McpAgentKind {
  return value === "claude-code" || value === "codex" ? value : "unknown";
}

function defaultAgentLabel(kind: McpAgentKind) {
  if (kind === "claude-code") return "Claude Code";
  if (kind === "codex") return "Codex";
  return "Agent";
}

export function normalizeMcpAgentIdentity(value: unknown): McpAgentIdentity {
  if (typeof value === "string") {
    return { ...DEFAULT_MCP_AGENT_IDENTITY, id: normalizeMcpAgentId(value) };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_MCP_AGENT_IDENTITY;
  }

  const candidate = value as Record<string, unknown>;
  const kind = normalizeMcpAgentKind(candidate.kind);
  const label =
    typeof candidate.label === "string" && candidate.label.trim().length > 0
      ? candidate.label.trim().slice(0, 64)
      : defaultAgentLabel(kind);
  return {
    id: normalizeMcpAgentId(candidate.id),
    kind,
    label,
  };
}
