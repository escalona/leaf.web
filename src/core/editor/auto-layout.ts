import { isFlexLayoutDisplay } from "./layout-display";
import { getEffectiveModelDimension, isFixedModelLength } from "./model-geometry";
import type { StylePatch } from "./style-mutation";
import type { EditorStore } from "../state/EditorStore";
import type { DesignNode, Rect } from "../types";

export type FlexAxis = "row" | "column";
export type FlexAlign = "flex-start" | "center" | "flex-end" | "stretch";

export interface EdgeValues<T> {
  top: T;
  right: T;
  bottom: T;
  left: T;
}

export interface InferredFlexLayout {
  flexDirection: FlexAxis;
  gap: number;
  alignItems: FlexAlign;
  padding: EdgeValues<number>;
}

/** Sub-pixel slack, so a 0.4px layout rounding error is not read as intent. */
const GEOMETRY_EPSILON = 1;

/** Flex declarations on the container that mean nothing once flex is gone. */
const CONTAINER_FLEX_KEYS = [
  "display",
  "flexDirection",
  "flexWrap",
  "flexFlow",
  "gap",
  "rowGap",
  "columnGap",
  "alignItems",
  "alignContent",
  "justifyContent",
  "placeItems",
  "placeContent",
];

/** Per-child declarations that only a flex parent gives meaning to. */
const CHILD_FLEX_KEYS = [
  "flex",
  "flexGrow",
  "flexShrink",
  "flexBasis",
  "alignSelf",
  "justifySelf",
  "order",
];

/**
 * Styles to drop when a flow child is detached into absolute placement.
 * Margins join the flex-only keys because an absolutely placed box still
 * honors them, which would re-offset the node from the measured rect its
 * position was baked from.
 */
export const FLOW_DETACH_KEYS = [
  ...CHILD_FLEX_KEYS,
  "margin",
  "marginTop",
  "marginRight",
  "marginBottom",
  "marginLeft",
  "marginBlock",
  "marginBlockStart",
  "marginBlockEnd",
  "marginInline",
  "marginInlineStart",
  "marginInlineEnd",
];

/**
 * Style residue that detaches a former flow child into absolute placement:
 * the flow parent no longer places or sizes the node, so flow-only
 * declarations must not leak into the absolutely placed box, and a non-fixed
 * width/height must be released so the measured box can be baked instead.
 */
export function buildFlowDetachResidue(node: DesignNode): StylePatch {
  const residue: StylePatch = { position: "absolute" };
  for (const key of FLOW_DETACH_KEYS) {
    if (node.styles[key] !== undefined) residue[key] = null;
  }
  for (const axis of ["width", "height"] as const) {
    if (node.styles[axis] !== undefined && !isFixedModelLength(node.styles[axis])) {
      residue[axis] = null;
    }
  }
  return residue;
}

const PADDING_LONGHANDS: EdgeValues<string> = {
  top: "paddingTop",
  right: "paddingRight",
  bottom: "paddingBottom",
  left: "paddingLeft",
};

const PADDING_LOGICAL_LONGHANDS: EdgeValues<string> = {
  top: "paddingBlockStart",
  right: "paddingInlineEnd",
  bottom: "paddingBlockEnd",
  left: "paddingInlineStart",
};

const PADDING_RESIDUE_KEYS = [
  "padding",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "paddingBlock",
  "paddingBlockStart",
  "paddingBlockEnd",
  "paddingInline",
  "paddingInlineStart",
  "paddingInlineEnd",
];

const GAP_KEYS = ["gap", "rowGap", "columnGap"];

// --- Measurement --------------------------------------------------------------

/**
 * The node's rendered box in canvas space.
 *
 * Layout-derived geometry only exists in the DOM, so this measures the live
 * element when there is one and falls back to model geometry otherwise (an
 * unmounted node, or a test environment where every rect is zero). The overlay
 * has its own richer version of this for drag frames; the panel needs no drag
 * bookkeeping, only the current truth.
 */
export function measureNodeCanvasRect(store: EditorStore, node: DesignNode): Rect {
  const element = store.domIndex.getElement(node);
  const viewportElement = element?.closest("[data-viewport]");
  if (element && viewportElement instanceof HTMLElement) {
    const elementRect = element.getBoundingClientRect();
    const viewportRect = viewportElement.getBoundingClientRect();
    if (elementRect.width > 0 || elementRect.height > 0) {
      return {
        x: (elementRect.left - viewportRect.left - store.panX) / store.zoom,
        y: (elementRect.top - viewportRect.top - store.panY) / store.zoom,
        width: elementRect.width / store.zoom,
        height: elementRect.height / store.zoom,
      };
    }
  }

  const position = store.getCanvasPosition(node.id) ?? { x: node.x, y: node.y };
  return {
    x: position.x,
    y: position.y,
    width: getEffectiveModelDimension(node.width, node.styles.width),
    height: getEffectiveModelDimension(node.height, node.styles.height),
  };
}

/** Children CSS flow actually places — an absolute child is not part of the stack. */
export function flowChildrenOf(node: DesignNode): DesignNode[] {
  return node.children.filter((child) => {
    const position = child.styles.position;
    return position !== "absolute" && position !== "fixed";
  });
}

// --- Geometric inference ------------------------------------------------------

function mainStart(rect: Rect, axis: FlexAxis) {
  return axis === "row" ? rect.x : rect.y;
}

function mainEnd(rect: Rect, axis: FlexAxis) {
  return axis === "row" ? rect.x + rect.width : rect.y + rect.height;
}

function crossStart(rect: Rect, axis: FlexAxis) {
  return axis === "row" ? rect.y : rect.x;
}

function crossEnd(rect: Rect, axis: FlexAxis) {
  return axis === "row" ? rect.y + rect.height : rect.x + rect.width;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Guess the axis children were hand-placed along.
 *
 * Whichever axis the children overlap least on is the axis they were arranged
 * on: a row of cards covers its horizontal span once and its vertical span n
 * times over.
 */
export function inferFlexAxis(rects: readonly Rect[]): FlexAxis {
  if (rects.length < 2) return "row";

  const spanX = Math.max(...rects.map((r) => r.x + r.width)) - Math.min(...rects.map((r) => r.x));
  const spanY = Math.max(...rects.map((r) => r.y + r.height)) - Math.min(...rects.map((r) => r.y));
  const sumWidth = rects.reduce((total, r) => total + r.width, 0);
  const sumHeight = rects.reduce((total, r) => total + r.height, 0);

  const horizontalCrowding = spanX > 0 ? sumWidth / spanX : Number.POSITIVE_INFINITY;
  const verticalCrowding = spanY > 0 ? sumHeight / spanY : Number.POSITIVE_INFINITY;
  return horizontalCrowding <= verticalCrowding ? "row" : "column";
}

/**
 * Padding the arrangement implies.
 *
 * The main axis takes the exact insets — that is where the content starts and
 * ends. The cross axis takes the smaller of the two insets on both sides,
 * because the leftover slack is what alignment is about; absorbing all of it
 * into padding would invent a lopsided box no one asked for.
 */
function inferPadding(container: Rect, rects: readonly Rect[], axis: FlexAxis): EdgeValues<number> {
  if (rects.length === 0) return { top: 0, right: 0, bottom: 0, left: 0 };
  const clamp = (value: number) => Math.max(0, Math.round(value));

  const mainLead = clamp(
    Math.min(...rects.map((rect) => mainStart(rect, axis))) - mainStart(container, axis),
  );
  const mainTrail = clamp(
    mainEnd(container, axis) - Math.max(...rects.map((rect) => mainEnd(rect, axis))),
  );
  const crossLead = clamp(
    Math.min(...rects.map((rect) => crossStart(rect, axis))) - crossStart(container, axis),
  );
  const crossTrail = clamp(
    crossEnd(container, axis) - Math.max(...rects.map((rect) => crossEnd(rect, axis))),
  );
  const cross = Math.min(crossLead, crossTrail);

  return axis === "row"
    ? { top: cross, right: mainTrail, bottom: cross, left: mainLead }
    : { top: mainLead, right: cross, bottom: mainTrail, left: cross };
}

function inferGap(rects: readonly Rect[], axis: FlexAxis): number {
  if (rects.length < 2) return 0;
  const sorted = [...rects].sort((a, b) => mainStart(a, axis) - mainStart(b, axis));
  const gaps: number[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    gaps.push(mainStart(sorted[index]!, axis) - mainEnd(sorted[index - 1]!, axis));
  }
  return Math.max(0, Math.round(median(gaps)));
}

function inferAlignItems(
  container: Rect,
  rects: readonly Rect[],
  axis: FlexAxis,
  padding: EdgeValues<number>,
): FlexAlign {
  if (rects.length === 0) return "flex-start";

  const contentStart = axis === "row" ? container.y + padding.top : container.x + padding.left;
  const contentEnd =
    axis === "row"
      ? container.y + container.height - padding.bottom
      : container.x + container.width - padding.right;

  const near = (a: number, b: number) => Math.abs(a - b) <= GEOMETRY_EPSILON;
  const startOffsets = rects.map((rect) => crossStart(rect, axis) - contentStart);
  const endOffsets = rects.map((rect) => contentEnd - crossEnd(rect, axis));

  // Stretch is never inferred: geometry cannot distinguish "filled the line"
  // from "happened to be that tall", and guessing it would resize children the
  // moment the container or its padding changes.
  if (startOffsets.every((offset) => near(offset, 0))) return "flex-start";
  if (endOffsets.every((offset) => near(offset, 0))) return "flex-end";
  if (startOffsets.every((offset, index) => near(offset, endOffsets[index]!))) return "center";
  return "flex-start";
}

/**
 * Read a flex layout out of where the children already sit.
 *
 * Converting a hand-placed frame to flex without this collapses everything to
 * the top-left corner, which is why Leaf's old block/row/column control was
 * effectively unusable on real content.
 */
export function inferFlexLayout(
  container: Rect,
  childRects: readonly Rect[],
  forcedDirection?: FlexAxis,
): InferredFlexLayout {
  const flexDirection = forcedDirection ?? inferFlexAxis(childRects);
  const padding = inferPadding(container, childRects, flexDirection);
  return {
    flexDirection,
    gap: inferGap(childRects, flexDirection),
    alignItems: inferAlignItems(container, childRects, flexDirection, padding),
    padding,
  };
}

// --- Padding and gap resolution ----------------------------------------------

function shorthandPart(value: string | number | undefined, side: keyof EdgeValues<unknown>) {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value;
  const parts = value.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === "") return undefined;
  const [first, second, third, fourth] = parts;
  switch (side) {
    case "top":
      return first;
    case "right":
      return second ?? first;
    case "bottom":
      return third ?? first;
    case "left":
      return fourth ?? second ?? first;
  }
}

function axisShorthandPart(value: string | number | undefined, atEnd: boolean) {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value;
  const parts = value.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === "") return undefined;
  return atEnd ? (parts[1] ?? parts[0]) : parts[0];
}

/**
 * What each padding edge actually renders as.
 *
 * Longhand beats logical beats shorthand, which is the same precedence the
 * overlay uses to draw padding bands. Reading only `styles.padding` — what the
 * old panel did — reports 0 for every importer- or agent-authored node, since
 * those write longhands.
 */
export function resolvePaddingSides(
  styles: Record<string, string | number>,
): EdgeValues<string | number | undefined> {
  const read = (side: keyof EdgeValues<unknown>) => {
    const longhand = styles[PADDING_LONGHANDS[side]];
    if (longhand !== undefined) return longhand;
    const logical = styles[PADDING_LOGICAL_LONGHANDS[side]];
    if (logical !== undefined) return logical;
    const axisShorthand =
      side === "top" || side === "bottom"
        ? axisShorthandPart(styles.paddingBlock, side === "bottom")
        : axisShorthandPart(styles.paddingInline, side === "right");
    if (axisShorthand !== undefined) return axisShorthand;
    return shorthandPart(styles.padding, side);
  };

  return { top: read("top"), right: read("right"), bottom: read("bottom"), left: read("left") };
}

/** One uniform padding value, or undefined when the sides disagree. */
export function uniformPadding(
  sides: EdgeValues<string | number | undefined>,
): string | number | undefined {
  const values = [sides.top, sides.right, sides.bottom, sides.left];
  return values.every((value) => String(value ?? "") === String(values[0] ?? ""))
    ? values[0]
    : undefined;
}

/**
 * Write padding as the shorthand or as four longhands, clearing the other
 * spelling so the two can never disagree about what renders.
 */
export function paddingPatch(
  sides: EdgeValues<string | number | null>,
  linked: boolean,
): StylePatch {
  const patch: StylePatch = {};
  for (const key of PADDING_RESIDUE_KEYS) patch[key] = null;

  if (linked) {
    patch.padding = sides.top;
    return patch;
  }

  for (const side of ["top", "right", "bottom", "left"] as const) {
    patch[PADDING_LONGHANDS[side]] = sides[side];
  }
  return patch;
}

export function resolveGaps(styles: Record<string, string | number>): {
  row: string | number | undefined;
  column: string | number | undefined;
} {
  return {
    row: styles.rowGap ?? axisShorthandPart(styles.gap, false),
    column: styles.columnGap ?? axisShorthandPart(styles.gap, true),
  };
}

export function gapPatch(
  row: string | number | null,
  column: string | number | null,
  linked: boolean,
): StylePatch {
  const patch: StylePatch = {};
  for (const key of GAP_KEYS) patch[key] = null;
  if (linked) patch.gap = row;
  else {
    patch.rowGap = row;
    patch.columnGap = column;
  }
  return patch;
}

// --- Flex operations ----------------------------------------------------------

function withHistory<T>(store: EditorStore, run: () => T): T {
  store.beginHistoryTransaction();
  try {
    return run();
  } finally {
    store.endHistoryTransaction();
  }
}

function hasAuthoredPadding(styles: Record<string, string | number>): boolean {
  return PADDING_RESIDUE_KEYS.some((key) => styles[key] !== undefined);
}

function hasNonZeroPadding(padding: EdgeValues<number>): boolean {
  return padding.top > 0 || padding.right > 0 || padding.bottom > 0 || padding.left > 0;
}

/**
 * Turn a node into a flex container that keeps its children roughly where they
 * already are.
 */
export function addFlexToNode(
  store: EditorStore,
  nodeId: string,
  options: { direction?: FlexAxis } = {},
): InferredFlexLayout | null {
  const node = store.getNode(nodeId);
  if (!node) return null;

  const containerRect = measureNodeCanvasRect(store, node);
  const children = flowChildrenOf(node);
  const childRects = children.map((child) => measureNodeCanvasRect(store, child));
  const layout = inferFlexLayout(containerRect, childRects, options.direction);

  return withHistory(store, () => {
    const patch: StylePatch = {
      display: "flex",
      flexDirection: layout.flexDirection,
      alignItems: layout.alignItems,
      ...gapPatch(layout.gap, layout.gap, true),
    };
    // Padding the user already authored is intent; inferred padding is a guess,
    // so it only fills a vacuum.
    if (!hasAuthoredPadding(node.styles) && hasNonZeroPadding(layout.padding)) {
      Object.assign(
        patch,
        paddingPatch(layout.padding, uniformPadding(layout.padding) !== undefined),
      );
    }
    store.runtime.updateStyles([{ nodeIds: [nodeId], styles: patch }]);

    // Flow placement ignores x/y. Leaving the old values behind would make them
    // resurface as stale positions the next time flex comes off.
    for (const child of children) {
      if (child.x !== 0 || child.y !== 0) store.runtime.updateNode(child.id, { x: 0, y: 0 });
    }
    return layout;
  });
}

/**
 * Take flex off a container, keeping every child exactly where it renders now.
 *
 * The children's laid-out boxes only exist in the DOM, so they have to be baked
 * into the model before the declarations that produced them are removed.
 */
export function removeFlex(store: EditorStore, nodeId: string): void {
  const node = store.getNode(nodeId);
  if (!node) return;

  const containerRect = measureNodeCanvasRect(store, node);
  const children = flowChildrenOf(node);
  const childRects = children.map((child) => measureNodeCanvasRect(store, child));

  withHistory(store, () => {
    children.forEach((child, index) => {
      const rect = childRects[index]!;
      store.runtime.updateNode(child.id, {
        x: Math.round(rect.x - containerRect.x),
        y: Math.round(rect.y - containerRect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });

      const residue = CHILD_FLEX_KEYS.filter((key) => child.styles[key] !== undefined);
      // A content-driven size was the flex parent's doing; the baked pixels
      // above replace it. A fixed authored size was the user's and stays.
      for (const axis of ["width", "height"] as const) {
        if (child.styles[axis] !== undefined && !isFixedModelLength(child.styles[axis])) {
          residue.push(axis);
        }
      }
      if (residue.length > 0) store.runtime.removeNodeStyles([child.id], residue);
    });

    // Padding survives: it is not flex-specific, and re-adding flex should not
    // lose a spacing decision the user made.
    const containerResidue = CONTAINER_FLEX_KEYS.filter((key) => node.styles[key] !== undefined);
    if (containerResidue.length > 0) store.runtime.removeNodeStyles([nodeId], containerResidue);
  });
}

/**
 * Put the given nodes inside a new flex frame that reproduces their current
 * arrangement. Returns the new frame's id, or null when the nodes do not share
 * a parent.
 */
export function wrapInFlex(
  store: EditorStore,
  nodeIds: readonly string[],
  options: { direction?: FlexAxis; name?: string } = {},
): string | null {
  const nodes = nodeIds
    .map((id) => store.getNode(id))
    .filter((node): node is DesignNode => node !== undefined);
  if (nodes.length === 0) return null;

  const parentId = store.getParent(nodes[0]!.id)?.id;
  if (nodes.some((node) => store.getParent(node.id)?.id !== parentId)) return null;

  const parent = parentId ? store.getNode(parentId) : undefined;
  const siblings = parent ? parent.children : store.nodes;
  const firstIndex = Math.min(...nodes.map((node) => siblings.indexOf(node)));

  const rects = nodes.map((node) => measureNodeCanvasRect(store, node));
  const unionX = Math.min(...rects.map((rect) => rect.x));
  const unionY = Math.min(...rects.map((rect) => rect.y));
  const union: Rect = {
    x: unionX,
    y: unionY,
    width: Math.max(...rects.map((rect) => rect.x + rect.width)) - unionX,
    height: Math.max(...rects.map((rect) => rect.y + rect.height)) - unionY,
  };

  const layout = inferFlexLayout(union, rects, options.direction);
  const parentOrigin = parent
    ? measureNodeCanvasRect(store, parent)
    : { x: 0, y: 0, width: 0, height: 0 };

  const ordered = nodes
    .map((node, index) => ({ node, rect: rects[index]! }))
    .sort(
      (a, b) => mainStart(a.rect, layout.flexDirection) - mainStart(b.rect, layout.flexDirection),
    )
    .map((entry) => entry.node);

  return withHistory(store, () => {
    const frame = store.runtime.createScriptNode(
      "frame",
      {
        name: options.name ?? "Frame",
        x: Math.round(union.x - parentOrigin.x),
        y: Math.round(union.y - parentOrigin.y),
        width: Math.round(union.width),
        height: Math.round(union.height),
        backgroundColor: "transparent",
        borderWidth: 0,
        borderRadius: 0,
        styles: {
          display: "flex",
          flexDirection: layout.flexDirection,
          alignItems: layout.alignItems,
          gap: layout.gap,
          ...(layout.padding.top ||
          layout.padding.right ||
          layout.padding.bottom ||
          layout.padding.left
            ? {
                paddingTop: layout.padding.top,
                paddingRight: layout.padding.right,
                paddingBottom: layout.padding.bottom,
                paddingLeft: layout.padding.left,
              }
            : {}),
        },
      },
      parentId,
    );

    // Created at the end of its siblings; slide it back to where the wrapped
    // content used to sit so z-order and flow order survive the wrap.
    store.runtime.moveNodeToParent(frame.id, { x: union.x, y: union.y }, parentId, {
      index: firstIndex,
      mode: store.isFlowChild(frame.id) ? "flow" : "absolute",
    });

    ordered.forEach((node, index) => {
      store.runtime.moveNodeToParent(node.id, { x: 0, y: 0 }, frame.id, {
        index,
        mode: "flow",
      });
    });

    return frame.id;
  });
}

/**
 * Detach a flow child into absolute placement, or return it to the flow.
 *
 * Detaching bakes the rendered box into the model first, so the node does not
 * jump the moment CSS stops placing it.
 */
export function setAbsolutePosition(
  store: EditorStore,
  nodeIds: readonly string[],
  absolute: boolean,
): void {
  withHistory(store, () => {
    for (const nodeId of nodeIds) {
      const node = store.getNode(nodeId);
      if (!node) continue;
      const parent = store.getParent(nodeId);
      if (!parent) continue;

      if (!absolute) {
        store.runtime.updateNode(nodeId, { x: 0, y: 0 });
        store.runtime.removeNodeStyles([nodeId], ["position"]);
        continue;
      }

      const rect = measureNodeCanvasRect(store, node);
      const parentRect = measureNodeCanvasRect(store, parent);
      const residue = buildFlowDetachResidue(node);
      store.runtime.updateStyles([{ nodeIds: [nodeId], styles: residue }]);
      store.runtime.updateNode(nodeId, {
        x: Math.round(rect.x - parentRect.x),
        y: Math.round(rect.y - parentRect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });

      // An absolute child paints over its siblings; matching that in the tree
      // keeps the layers panel honest about what is on top.
      const lastIndex = parent.children.length - 1;
      if (parent.children.indexOf(node) !== lastIndex) {
        store.runtime.moveNodeToParent(nodeId, { x: rect.x, y: rect.y }, parent.id, {
          index: lastIndex,
          mode: "absolute",
        });
      }
    }
  });
}

export function isFlexContainer(node: DesignNode): boolean {
  return isFlexLayoutDisplay(node.styles.display);
}
