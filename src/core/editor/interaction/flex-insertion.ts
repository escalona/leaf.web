import type { DesignNode, DragInsertionAxis, Point, Rect } from "../../types";

interface FlowNode {
  id: string;
  styles: Record<string, unknown>;
  visible?: boolean;
}

/** Sub-pixel tolerance for grouping rects into the same cross-axis flex line. */
const FLEX_LINE_EPSILON = 1;

type FlexLine = {
  crossEnd: number;
  crossStart: number;
  rects: Rect[];
  startIndex: number;
};

function getCrossEnd(rect: Rect, axis: DragInsertionAxis) {
  return axis === "row" ? rect.y + rect.height : rect.x + rect.width;
}

function getCrossStart(rect: Rect, axis: DragInsertionAxis) {
  return axis === "row" ? rect.y : rect.x;
}

function getMainMidpoint(rect: Rect, axis: DragInsertionAxis) {
  return axis === "row" ? rect.x + rect.width / 2 : rect.y + rect.height / 2;
}

function findInsertionIndexInLine(rects: Rect[], point: Point, axis: DragInsertionAxis) {
  const pointCoordinate = axis === "row" ? point.x : point.y;

  for (let index = 0; index < rects.length; index++) {
    if (pointCoordinate < getMainMidpoint(rects[index]!, axis)) {
      return index;
    }
  }

  return rects.length;
}

export function flexContainerWraps(node: Pick<DesignNode, "styles">) {
  return String(node.styles.flexWrap ?? "nowrap") !== "nowrap";
}

export function getFlexFlowChildren<T extends FlowNode>(
  children: readonly T[],
  excludeId?: string,
): T[] {
  return children.filter(
    (child) =>
      child.id !== excludeId &&
      // Hidden nodes are skipped by the renderer entirely, so CSS flow never
      // places them; counting them would fabricate geometry from stale model
      // coordinates (phantom gap bands, off-by-one insertion lines).
      child.visible !== false &&
      child.styles.position !== "absolute" &&
      child.styles.position !== "fixed",
  );
}

export function clampInsertionIndex(index: number | undefined, length: number) {
  if (index === undefined) return length;
  return Math.max(0, Math.min(length, index));
}

export function getFlowInsertionChildIndex<T extends FlowNode>(
  children: readonly T[],
  flowIndex: number,
) {
  const flowChildren = getFlexFlowChildren(children);
  if (flowChildren.length === 0) return children.length;

  if (flowIndex <= 0) {
    return children.indexOf(flowChildren[0]!);
  }

  if (flowIndex >= flowChildren.length) {
    return children.indexOf(flowChildren.at(-1)!) + 1;
  }

  return children.indexOf(flowChildren[flowIndex]!);
}

export function groupFlexRectsIntoLines(rects: Rect[], axis: DragInsertionAxis): FlexLine[] {
  const lines: FlexLine[] = [];
  let nextStartIndex = 0;

  for (const rect of rects) {
    const crossStart = getCrossStart(rect, axis);
    const crossEnd = getCrossEnd(rect, axis);
    const currentLine = lines.at(-1);

    if (
      !currentLine ||
      crossStart > currentLine.crossEnd + FLEX_LINE_EPSILON ||
      crossEnd < currentLine.crossStart - FLEX_LINE_EPSILON
    ) {
      lines.push({
        crossEnd,
        crossStart,
        rects: [rect],
        startIndex: nextStartIndex,
      });
      nextStartIndex += 1;
      continue;
    }

    currentLine.rects.push(rect);
    currentLine.crossStart = Math.min(currentLine.crossStart, crossStart);
    currentLine.crossEnd = Math.max(currentLine.crossEnd, crossEnd);
    nextStartIndex += 1;
  }

  return lines;
}

export function findFlexInsertionIndex(
  childRects: Rect[],
  point: Point,
  axis: DragInsertionAxis,
  wraps = false,
) {
  if (!wraps || childRects.length === 0) {
    return findInsertionIndexInLine(childRects, point, axis);
  }

  const lines = groupFlexRectsIntoLines(childRects, axis);
  if (lines.length === 0) return 0;

  const pointCross = axis === "row" ? point.y : point.x;
  let targetLine = lines.at(-1)!;

  for (const line of lines) {
    const midpoint = (line.crossStart + line.crossEnd) / 2;
    if (pointCross < midpoint) {
      targetLine = line;
      break;
    }
  }

  return targetLine.startIndex + findInsertionIndexInLine(targetLine.rects, point, axis);
}

export interface MoveNodeContext {
  nodeId: string;
  nodePosition: string | undefined;
  nodeX: number;
  nodeY: number;
  currentIndex: number;
  currentSiblings: readonly FlowNode[];
  currentParentId: string | undefined;
  newParentChildren: readonly FlowNode[] | undefined;
  newParentId: string | undefined;
  rootSiblingCount: number;
}

export interface MoveNodePlan {
  isNoOp: boolean;
  sameContainer: boolean;
  mode: "absolute" | "flow";
  shouldNormalizeToFlow: boolean;
  nextFlowIndex: number | null;
  insertionIndex: number;
}

export function planNodeMove(
  ctx: MoveNodeContext,
  options?: { index?: number; mode?: "absolute" | "flow" },
): MoveNodePlan {
  const sameContainer =
    ctx.currentParentId === ctx.newParentId || (!ctx.currentParentId && !ctx.newParentId);
  const mode = options?.mode ?? "absolute";
  const nextIndex = clampInsertionIndex(
    options?.index,
    sameContainer
      ? ctx.currentSiblings.length - 1
      : (ctx.newParentChildren?.length ?? ctx.rootSiblingCount),
  );
  const shouldNormalizeToFlow = mode === "flow" && !!ctx.newParentId;
  const alreadyFlow =
    ctx.nodePosition !== "absolute" &&
    ctx.nodePosition !== "relative" &&
    ctx.nodeX === 0 &&
    ctx.nodeY === 0;
  const currentFlowIndex =
    shouldNormalizeToFlow && sameContainer
      ? getFlexFlowChildren(ctx.currentSiblings).findIndex((c) => c.id === ctx.nodeId)
      : -1;
  const nextFlowIndex = shouldNormalizeToFlow
    ? clampInsertionIndex(
        options?.index,
        getFlexFlowChildren(ctx.newParentChildren!, ctx.nodeId).length,
      )
    : null;
  const isNoOp = sameContainer
    ? shouldNormalizeToFlow
      ? currentFlowIndex === nextFlowIndex && alreadyFlow
      : ctx.currentIndex === nextIndex
    : false;

  return {
    isNoOp,
    sameContainer,
    mode,
    shouldNormalizeToFlow,
    nextFlowIndex,
    insertionIndex: nextIndex,
  };
}

export function resolveFlexInsertionLine(
  childRects: Rect[],
  axis: DragInsertionAxis,
  index: number,
  wraps = false,
) {
  const lines = wraps ? groupFlexRectsIntoLines(childRects, axis) : [];
  if (lines.length === 0) {
    return {
      indexWithinLine: index,
      rects: childRects,
    };
  }

  for (const line of lines) {
    if (index <= line.startIndex) {
      return {
        indexWithinLine: 0,
        rects: line.rects,
      };
    }
    if (index < line.startIndex + line.rects.length) {
      return {
        indexWithinLine: index - line.startIndex,
        rects: line.rects,
      };
    }
  }

  const lastLine = lines.at(-1)!;
  return {
    indexWithinLine: lastLine.rects.length,
    rects: lastLine.rects,
  };
}
