import { getRotatedBounds } from "../../core/editor/interaction/math";
import { getEffectiveModelDimension } from "../../core/editor/model-geometry";
import { nodeClipsChildrenPaint } from "../../core/editor/node-overflow";
import type { DesignNode, Rect } from "../../core/types";
import type { CanvasBounds } from "./interaction-helpers";

const MEMBERSHIP_QUANTIZE_SCREEN_PX = 512;

export function areCanvasBoundsEqual(left: CanvasBounds | null, right: CanvasBounds | null) {
  return (
    left === right ||
    (!!left &&
      !!right &&
      left.left === right.left &&
      left.top === right.top &&
      left.right === right.right &&
      left.bottom === right.bottom)
  );
}

/** A render root's own model box. Roots are placed in canvas space already. */
export function getNodeModelBox(node: DesignNode): Rect {
  return {
    x: node.x,
    y: node.y,
    width: getEffectiveModelDimension(node.width, node.styles.width),
    height: getEffectiveModelDimension(node.height, node.styles.height),
  };
}

/**
 * The rect culling may reject a render root on. A turned root reaches outside
 * its model box, and this decides whether a subtree mounts at all, so it takes
 * the root's rotated extent rather than the box the model stores.
 */
export function getNodeModelCullRect(node: DesignNode): Rect {
  return getRotatedBounds(getNodeModelBox(node), node.rotation ?? 0);
}

export function nodeClipsChildrenForCulling(node: DesignNode) {
  return node.children.length === 0 || nodeClipsChildrenPaint(node);
}

export function expandDetailBoundsForPan(current: CanvasBounds, visible: CanvasBounds) {
  const expanded = unionCanvasBounds(current, visible);
  const visibleWidth = visible.right - visible.left;
  const visibleHeight = visible.bottom - visible.top;
  return expanded.right - expanded.left > visibleWidth * 3 ||
    expanded.bottom - expanded.top > visibleHeight * 3
    ? visible
    : expanded;
}

export function expandMembershipBoundsForPan(
  current: CanvasBounds,
  visible: CanvasBounds,
  target: CanvasBounds,
) {
  const expanded = unionCanvasBounds(current, visible);
  const targetWidth = target.right - target.left;
  const targetHeight = target.bottom - target.top;
  return expanded.right - expanded.left > targetWidth * 3 ||
    expanded.bottom - expanded.top > targetHeight * 3
    ? target
    : expanded;
}

export function advanceCanvasBoundsTowardTarget(
  current: CanvasBounds,
  target: CanvasBounds,
  step: number,
): CanvasBounds {
  const advance = (value: number, goal: number) =>
    value < goal ? Math.min(goal, value + step) : Math.max(goal, value - step);
  return {
    left: advance(current.left, target.left),
    top: advance(current.top, target.top),
    right: advance(current.right, target.right),
    bottom: advance(current.bottom, target.bottom),
  };
}

export function quantizeCanvasBoundsOutward(
  bounds: CanvasBounds,
  zoom: number,
  screenStep = MEMBERSHIP_QUANTIZE_SCREEN_PX,
): CanvasBounds {
  const step = screenStep / Math.max(zoom, 0.001);
  return {
    left: Math.floor(bounds.left / step) * step,
    top: Math.floor(bounds.top / step) * step,
    right: Math.ceil(bounds.right / step) * step,
    bottom: Math.ceil(bounds.bottom / step) * step,
  };
}

export function unionCanvasBounds(left: CanvasBounds, right: CanvasBounds): CanvasBounds {
  return {
    left: Math.min(left.left, right.left),
    top: Math.min(left.top, right.top),
    right: Math.max(left.right, right.right),
    bottom: Math.max(left.bottom, right.bottom),
  };
}
