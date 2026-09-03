import type { Point } from "../../types";

declare const coordinateSpace: unique symbol;

/**
 * Compile-time marker for a point's coordinate system.
 *
 * The marker has no runtime representation. Construct points at conversion
 * boundaries so canvas, screen, and parent-local values remain distinguishable
 * while still being assignable to APIs that accept a plain `Point`.
 */
export type CoordinatePoint<Space extends string> = Point & {
  readonly [coordinateSpace]: Space;
};

export type ScreenPoint = CoordinatePoint<"screen">;
export type CanvasPoint = CoordinatePoint<"canvas">;
export type ParentPoint = CoordinatePoint<"parent">;

function pointInSpace<Space extends string>(x: number, y: number): CoordinatePoint<Space> {
  return { x, y } as CoordinatePoint<Space>;
}

export function screenPoint(x: number, y: number): ScreenPoint {
  return pointInSpace<"screen">(x, y);
}

export function canvasPoint(x: number, y: number): CanvasPoint {
  return pointInSpace<"canvas">(x, y);
}

export function parentPoint(x: number, y: number): ParentPoint {
  return pointInSpace<"parent">(x, y);
}

export function asScreenPoint(point: Point): ScreenPoint {
  return pointInSpace<"screen">(point.x, point.y);
}

export function asCanvasPoint(point: Point): CanvasPoint {
  return pointInSpace<"canvas">(point.x, point.y);
}
