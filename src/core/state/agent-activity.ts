import { computed, makeAutoObservable } from "mobx";
import { type McpAgentIdentity, normalizeMcpAgentIdentity } from "./agent-identity";

export const AGENT_ACTIVITY_EXPIRY_MS = 40_000;
export const AGENT_COLOR = "oklch(0.7 0.15 258)";

export type AgentActivityKind = "read" | "write";

export type AgentNodeActivity = {
  readAt?: number;
  writtenAt?: number;
};

function timerKey(agentId: string, nodeId: string) {
  return `${agentId}\u0000${nodeId}`;
}

/**
 * Per-agent ephemeral working indicators. The former per-operation reveal
 * animation (gradient sweeps, comet field, staggered outlines, first-half
 * write hiding) was removed deliberately: it rendered through React on every
 * animation frame for seconds after each visible agent operation, which
 * dominated foreground editor responsiveness while an agent worked.
 *
 * Two leases share the same forty-second window. The agent-level presence
 * lease (`identities`) starts on the agent's first successful tool call, so
 * the avatar group shows a connected agent before it touches a node, and the
 * per-node working leases (`activities`) start on node-scoped reads/writes.
 * Neither transport has a disconnect signal, so both expire by timeout unless
 * the agent finishes explicitly.
 */
export class AgentActivityState {
  activities = new Map<string, Map<string, AgentNodeActivity>>();
  identities = new Map<string, McpAgentIdentity>();

  private activityTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private presenceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor() {
    makeAutoObservable<AgentActivityState, "activityTimers" | "presenceTimers">(
      this,
      {
        activityTimers: false,
        presenceTimers: false,
        activeAgents: computed.struct,
        activeNodeIds: computed.struct,
      },
      { autoBind: true },
    );
  }

  get activeAgentCount() {
    return this.identities.size;
  }

  get hasActiveAgents() {
    return this.activeAgentCount > 0;
  }

  get activeAgents() {
    return Array.from(this.identities.values());
  }

  get activeNodeIds() {
    const ids = new Set<string>();
    for (const activityByNode of this.activities.values()) {
      for (const nodeId of activityByNode.keys()) ids.add(nodeId);
    }
    return ids;
  }

  /**
   * Mark an agent as connected without leasing any node. Every successful
   * tool call renews this presence lease; node activity renews it implicitly.
   */
  announce(agent: string | McpAgentIdentity) {
    const identity = normalizeMcpAgentIdentity(agent);
    this.identities.set(identity.id, identity);
    this.resetPresenceTimer(identity.id);
    return identity;
  }

  record(
    agent: string | McpAgentIdentity,
    nodeIds: readonly string[],
    activityKind: AgentActivityKind,
  ) {
    const uniqueNodeIds = [...new Set(nodeIds)].filter(Boolean);
    if (uniqueNodeIds.length === 0) return;

    const agentId = this.announce(agent).id;
    const now = Date.now();
    let activityByNode = this.activities.get(agentId);
    if (!activityByNode) {
      this.activities.set(agentId, new Map());
      activityByNode = this.activities.get(agentId)!;
    }

    for (const nodeId of uniqueNodeIds) {
      const previous = activityByNode.get(nodeId) ?? {};
      activityByNode.set(nodeId, {
        ...previous,
        ...(activityKind === "read" ? { readAt: now } : { writtenAt: now }),
      });
      this.resetActivityTimer(agentId, nodeId);
    }
  }

  /**
   * Release node leases immediately. Omitting `nodeIds` is the agent saying it
   * is done, which also ends its presence; a scoped release keeps the agent
   * present until its presence lease expires or it finishes outright.
   */
  finish(agentId: string, nodeIds?: readonly string[]) {
    const activityByNode = this.activities.get(agentId);
    const releasedNodeIds =
      activityByNode === undefined
        ? []
        : nodeIds === undefined
          ? [...activityByNode.keys()]
          : [...new Set(nodeIds)].filter((nodeId) => activityByNode.has(nodeId));
    for (const nodeId of releasedNodeIds) {
      activityByNode?.delete(nodeId);
      this.clearActivityTimer(agentId, nodeId);
    }
    if (activityByNode?.size === 0) this.activities.delete(agentId);
    if (nodeIds === undefined) this.removePresence(agentId);
    return releasedNodeIds;
  }

  dispose() {
    for (const timer of this.activityTimers.values()) clearTimeout(timer);
    for (const timer of this.presenceTimers.values()) clearTimeout(timer);
    this.activityTimers.clear();
    this.presenceTimers.clear();
    this.activities.clear();
    this.identities.clear();
  }

  private resetActivityTimer(agentId: string, nodeId: string) {
    this.clearActivityTimer(agentId, nodeId);
    const key = timerKey(agentId, nodeId);
    this.activityTimers.set(
      key,
      setTimeout(() => this.expireActivity(agentId, nodeId), AGENT_ACTIVITY_EXPIRY_MS),
    );
  }

  private clearActivityTimer(agentId: string, nodeId: string) {
    const key = timerKey(agentId, nodeId);
    const timer = this.activityTimers.get(key);
    if (timer) clearTimeout(timer);
    this.activityTimers.delete(key);
  }

  private expireActivity(agentId: string, nodeId: string) {
    this.activityTimers.delete(timerKey(agentId, nodeId));
    const activityByNode = this.activities.get(agentId);
    if (!activityByNode) return;
    activityByNode.delete(nodeId);
    if (activityByNode.size === 0) this.activities.delete(agentId);
  }

  private resetPresenceTimer(agentId: string) {
    const timer = this.presenceTimers.get(agentId);
    if (timer) clearTimeout(timer);
    this.presenceTimers.set(
      agentId,
      setTimeout(() => this.expirePresence(agentId), AGENT_ACTIVITY_EXPIRY_MS),
    );
  }

  private removePresence(agentId: string) {
    const timer = this.presenceTimers.get(agentId);
    if (timer) clearTimeout(timer);
    this.presenceTimers.delete(agentId);
    this.identities.delete(agentId);
  }

  private expirePresence(agentId: string) {
    // Node leases renew presence, so they never outlive it; release any
    // stragglers rather than leaving an indicator without an owner.
    const activityByNode = this.activities.get(agentId);
    if (activityByNode) {
      for (const nodeId of activityByNode.keys()) this.clearActivityTimer(agentId, nodeId);
      this.activities.delete(agentId);
    }
    this.removePresence(agentId);
  }
}
