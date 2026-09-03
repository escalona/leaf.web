import type { DesignNode } from "../../core/types";

export type AgentCornerRadii = readonly [number, number, number, number];

function parseRadius(value: string | number | undefined, basis: number) {
  if (typeof value === "number") return Math.max(0, value);
  if (typeof value !== "string") return 0;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, value.trim().endsWith("%") ? (parsed / 100) * basis : parsed);
}

function expandRadiusShorthand(
  value: string | number | undefined,
  basis: number,
): AgentCornerRadii {
  if (typeof value === "number") return [value, value, value, value];
  if (typeof value !== "string") return [0, 0, 0, 0];
  const values = value
    .split("/")[0]!
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => parseRadius(part, basis));
  if (values.length === 0) return [0, 0, 0, 0];
  if (values.length === 1) return [values[0]!, values[0]!, values[0]!, values[0]!];
  if (values.length === 2) return [values[0]!, values[1]!, values[0]!, values[1]!];
  if (values.length === 3) return [values[0]!, values[1]!, values[2]!, values[1]!];
  return [values[0]!, values[1]!, values[2]!, values[3]!];
}

export function getAgentCornerRadii(node: DesignNode): AgentCornerRadii {
  const basis = Math.min(node.width, node.height);
  const shorthand = expandRadiusShorthand(node.styles.borderRadius ?? node.borderRadius, basis);
  const resolveCorner = (value: string | number | undefined, fallback: number) =>
    value === undefined ? fallback : parseRadius(value, basis);
  return [
    resolveCorner(node.styles.borderTopLeftRadius, shorthand[0]),
    resolveCorner(node.styles.borderTopRightRadius, shorthand[1]),
    resolveCorner(node.styles.borderBottomRightRadius, shorthand[2]),
    resolveCorner(node.styles.borderBottomLeftRadius, shorthand[3]),
  ];
}
