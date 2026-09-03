import { observer } from "mobx-react-lite";
import type { AgentActivityState } from "../core/state/agent-activity";
import { AgentWorkingBadge } from "./AgentWorkingBadge";

const MAX_VISIBLE_AGENTS = 4;

export const AgentPresenceIndicator = observer(function AgentPresenceIndicator({
  activity,
}: {
  activity: AgentActivityState;
}) {
  const agents = activity.activeAgents;
  if (agents.length === 0) return null;

  const visibleAgents = agents.slice(0, MAX_VISIBLE_AGENTS);
  const hiddenAgentCount = Math.max(agents.length - visibleAgents.length, 0);
  return (
    <div
      data-agent-presence
      aria-label={`${agents.length} active ${agents.length === 1 ? "agent" : "agents"}`}
      style={{
        alignItems: "center",
        display: "flex",
        pointerEvents: "auto",
      }}
    >
      {visibleAgents.map((agent, index) => (
        <span
          key={agent.id}
          style={{
            display: "inline-flex",
            marginLeft: index === 0 ? 0 : -8,
            position: "relative",
            zIndex: index,
          }}
        >
          <AgentWorkingBadge agent={agent} size={30} />
        </span>
      ))}
      {hiddenAgentCount > 0 ? (
        <span
          aria-label={`${hiddenAgentCount} more active agents`}
          title={`${hiddenAgentCount} more active agents`}
          style={{
            alignItems: "center",
            backgroundColor: "#71717a",
            borderRadius: "50%",
            boxShadow: "0 0 0 2px var(--leaf-surface)",
            color: "white",
            display: "inline-flex",
            fontFamily: "var(--leaf-font-sans)",
            fontSize: 10,
            fontWeight: 650,
            height: 30,
            justifyContent: "center",
            marginLeft: -8,
            position: "relative",
            width: 30,
            zIndex: visibleAgents.length,
          }}
        >
          +{hiddenAgentCount}
        </span>
      ) : null}
    </div>
  );
});
