/**
 * The `path` node's view of the vector model.
 *
 * Both the renderer and the inspector read geometry and paint through here, so
 * a `d` an agent wrote via MCP is the same value the canvas draws and the same
 * value the anchor overlay drags.
 */

import type { DesignNode } from "../../types";
import { getPathLayoutBounds, type VectorRect } from "./geometry";
import { parsePathData, type VectorPath } from "./path-data";

export interface PathNodeGeometry {
  path: VectorPath;
  /** Layout bounds of the path in its own coordinates — the node's viewBox. */
  bounds: VectorRect;
}

export function getPathGeometry(d: string): PathNodeGeometry | null {
  const path = parsePathData(d);
  if (!path) return null;
  const bounds = getPathLayoutBounds(path);
  if (!bounds) return null;
  return { path, bounds };
}

/**
 * The `viewBox` that maps path coordinates onto the node box.
 *
 * Deriving it from the path's own bounds is what makes a resize scale the
 * artwork instead of just growing empty space around it, and it keeps a path
 * whose coordinates sit far from the origin visible.
 */
export function getPathViewBox(bounds: VectorRect): string {
  return `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`;
}

function readStyle(node: DesignNode, ...keys: string[]): string | number | undefined {
  for (const key of keys) {
    const value = node.styles[key];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

export type PathFillRule = "nonzero" | "evenodd";
export type PathLinecap = "butt" | "round" | "square";
export type PathLinejoin = "miter" | "round" | "bevel";

export interface PathPaint {
  fill: string;
  stroke: string | undefined;
  strokeWidth: number;
  fillRule: PathFillRule | undefined;
  strokeLinecap: PathLinecap | undefined;
  strokeLinejoin: PathLinejoin | undefined;
  strokeDasharray: string | undefined;
}

/** Keep an authored value only when SVG actually accepts it. */
function readEnum<T extends string>(
  node: DesignNode,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = readStyle(node, key);
  const text = value === undefined ? undefined : String(value);
  return allowed.includes(text as T) ? (text as T) : undefined;
}

/**
 * Resolve the path's paint.
 *
 * `fill`/`stroke` come first so SVG-native authoring works, then the node's box
 * paint — a path's background *is* its fill, and its border *is* its stroke, so
 * `FillSection`-shaped values keep meaning the same thing on a path.
 */
export function resolvePathPaint(node: DesignNode): PathPaint {
  const fill = readStyle(node, "fill", "backgroundColor");
  const stroke = readStyle(node, "stroke", "borderColor");
  const strokeWidth = readStyle(node, "strokeWidth", "borderWidth");

  const resolvedFill =
    fill !== undefined
      ? String(fill)
      : node.backgroundColor && node.backgroundColor !== "transparent"
        ? node.backgroundColor
        : "none";

  const resolvedStroke =
    stroke !== undefined
      ? String(stroke)
      : node.borderColor && node.borderColor !== "transparent"
        ? node.borderColor
        : undefined;

  const parsedStrokeWidth =
    strokeWidth !== undefined ? Number.parseFloat(String(strokeWidth)) : node.borderWidth;
  const authoredWidth = Number.isFinite(parsedStrokeWidth) ? parsedStrokeWidth : 0;
  // SVG's own `stroke-width` default is 1, and the `path` spec's typed
  // `borderWidth` default is 0. Without this, a stroke colour an agent wrote
  // (`<path stroke="…">` via MCP, or `update_styles` setting `borderColor`)
  // would paint nothing at all, because only the pen tool sets a width.
  const hasAuthoredWidth = strokeWidth !== undefined || node.borderWidth > 0;
  const width = resolvedStroke !== undefined && !hasAuthoredWidth ? 1 : authoredWidth;

  return {
    fill: resolvedFill,
    stroke: width > 0 ? resolvedStroke : undefined,
    strokeWidth: width,
    fillRule: readEnum(node, "fillRule", ["nonzero", "evenodd"]),
    strokeLinecap: readEnum(node, "strokeLinecap", ["butt", "round", "square"]),
    strokeLinejoin: readEnum(node, "strokeLinejoin", ["miter", "round", "bevel"]),
    strokeDasharray: (() => {
      const value = readStyle(node, "strokeDasharray");
      return value === undefined ? undefined : String(value);
    })(),
  };
}

/** Style keys the renderer paints onto the `<path>` rather than the node box. */
export function isPathPaintStyleKey(key: string): boolean {
  return (
    key.startsWith("background") || (key.startsWith("border") && !key.startsWith("borderRadius"))
  );
}
