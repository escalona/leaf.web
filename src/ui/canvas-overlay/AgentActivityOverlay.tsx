import { AGENT_COLOR } from "../../core/state/agent-activity";
import type { EditorStore } from "../../core/state/EditorStore";
import type { Rect } from "../../core/types";
import type { AgentCornerRadii } from "./agent-activity-geometry";

export type AgentWorkingRect = {
  cornerRadii?: AgentCornerRadii;
  labelWidthPx?: number;
  nodeId: string;
  rect: Rect;
  rotation?: number;
};

/**
 * Working indicators for agent-touched artboards: a softly pulsing outline
 * plus a three-dot activity cluster at the frame's top-right.
 *
 * All motion is CSS-keyframe-driven over a static DOM. The former reveal HUD
 * (gradient sweeps, a 32×2 comet field, staggered outlines, and an animation
 * clock that re-rendered this tree every frame) was removed deliberately: it
 * dominated foreground editor responsiveness for seconds after every visible
 * agent operation. Liveness now costs the compositor, not the main thread —
 * do not reintroduce per-animation-frame React or JS rendering here.
 */

const DOT_COUNT = 3;
const DOT_RADIUS_SCREEN_PX = 2.5;
const DOT_SPACING_SCREEN_PX = 8;
const DOT_BASELINE_GAP_SCREEN_PX = 10;

const AGENT_ACTIVITY_KEYFRAMES = `
.leaf-agent-working-outline {
  animation: leaf-agent-working-outline-pulse 2.4s ease-in-out infinite;
}
.leaf-agent-activity-dot {
  animation: leaf-agent-activity-dot-pulse 1.2s ease-in-out infinite;
}
@keyframes leaf-agent-working-outline-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}
@keyframes leaf-agent-activity-dot-pulse {
  0%, 100% { opacity: 0.25; }
  40% { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .leaf-agent-working-outline,
  .leaf-agent-activity-dot {
    animation: none;
  }
}
`;

export function getAgentWorkingDisplayNodeIds(store: EditorStore) {
  return [
    ...new Set(
      Array.from(store.agentActivity.activeNodeIds).flatMap((nodeId) => {
        const node = store.getNode(nodeId);
        if (
          !node ||
          !isEffectivelyVisible(store, nodeId) ||
          store.getPageIdForNode(nodeId) !== store.activePageId
        ) {
          return [];
        }
        // Hand-drawn files have no artboards, so a lease with no artboard
        // ancestor coalesces to its root node instead of painting nothing.
        return [store.getArtboard(nodeId)?.id ?? getRootNodeId(store, nodeId)];
      }),
    ),
  ];
}

function getRootNodeId(store: EditorStore, nodeId: string) {
  let rootId = nodeId;
  for (let parent = store.getParent(rootId); parent; parent = store.getParent(rootId)) {
    rootId = parent.id;
  }
  return rootId;
}

function isEffectivelyVisible(store: EditorStore, nodeId: string) {
  let node = store.getNode(nodeId);
  while (node) {
    if (node.visible === false) return false;
    node = store.getParent(node.id);
  }
  return true;
}

function roundedRectPath(rect: Rect, radii: AgentCornerRadii, expansion: number) {
  const x = rect.x - expansion;
  const y = rect.y - expansion;
  const width = rect.width + expansion * 2;
  const height = rect.height + expansion * 2;
  const maximum = Math.min(width, height) / 2;
  const [topLeft, topRight, bottomRight, bottomLeft] = radii.map((radius) =>
    radius > 0 ? Math.min(radius + expansion, maximum) : 0,
  ) as [number, number, number, number];
  return [
    `M ${x + topLeft} ${y}`,
    `H ${x + width - topRight}`,
    topRight > 0 ? `Q ${x + width} ${y} ${x + width} ${y + topRight}` : "",
    `V ${y + height - bottomRight}`,
    bottomRight > 0 ? `Q ${x + width} ${y + height} ${x + width - bottomRight} ${y + height}` : "",
    `H ${x + bottomLeft}`,
    bottomLeft > 0 ? `Q ${x} ${y + height} ${x} ${y + height - bottomLeft}` : "",
    `V ${y + topLeft}`,
    topLeft > 0 ? `Q ${x} ${y} ${x + topLeft} ${y}` : "",
    "Z",
  ]
    .filter(Boolean)
    .join(" ");
}

function rotationTransform(rect: Rect, rotation?: number) {
  return rotation
    ? `rotate(${rotation} ${rect.x + rect.width / 2} ${rect.y + rect.height / 2})`
    : undefined;
}

export function AgentActivityOverlay({
  workingRects,
  zoom,
}: {
  workingRects: AgentWorkingRect[];
  zoom: number;
}) {
  const dotRadius = DOT_RADIUS_SCREEN_PX / zoom;
  const dotSpacing = DOT_SPACING_SCREEN_PX / zoom;
  const dotGap = DOT_BASELINE_GAP_SCREEN_PX / zoom;
  return (
    <>
      {workingRects.length > 0 && <style>{AGENT_ACTIVITY_KEYFRAMES}</style>}
      {workingRects.map((entry) => (
        <g
          key={entry.nodeId}
          data-working-on-node={entry.nodeId}
          pointerEvents="none"
          transform={rotationTransform(entry.rect, entry.rotation)}
        >
          <path
            className="leaf-agent-working-outline"
            d={roundedRectPath(entry.rect, entry.cornerRadii ?? [0, 0, 0, 0], 1 / zoom)}
            fill="none"
            stroke={AGENT_COLOR}
            strokeWidth={2 / zoom}
          />
          <g data-agent-activity-dots>
            {Array.from({ length: DOT_COUNT }, (_, index) => (
              <circle
                key={index}
                className="leaf-agent-activity-dot"
                style={{ animationDelay: `${index * 0.2}s` }}
                cx={
                  entry.rect.x + entry.rect.width - dotRadius - (DOT_COUNT - 1 - index) * dotSpacing
                }
                cy={entry.rect.y - dotGap}
                r={dotRadius}
                fill={AGENT_COLOR}
              />
            ))}
          </g>
        </g>
      ))}
    </>
  );
}
