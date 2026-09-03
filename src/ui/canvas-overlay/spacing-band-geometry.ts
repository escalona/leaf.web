import {
  isFlexContainer,
  resolveGaps,
  resolvePaddingSides,
  type EdgeValues,
} from "../../core/editor/auto-layout";
import { getEffectiveModelDimension } from "../../core/editor/model-geometry";
import { ABSOLUTE_LENGTH_PX, parsePlainPixelLength } from "../../core/editor/style-mutation";
import {
  flexContainerWraps,
  getFlexFlowChildren,
  groupFlexRectsIntoLines,
} from "../../core/editor/interaction/flex-insertion";
import type { EditorStore } from "../../core/state/EditorStore";
import type { DesignNode, DragInsertionAxis, Rect } from "../../core/types";
import { getNodeCanvasRect } from "./live-node-geometry";

/** Minimum screen-space thickness so a `gap: 0` band is still grabbable. */
const MIN_BAND_THICKNESS_SCREEN_PX = 6;

export type GapAxis = "row" | "column";

export type FlexGapBand = {
  /** Which CSS gap longhand the band adjusts (`rowGap` or `columnGap`). */
  gapAxis: GapAxis;
  /** Client axis the drag reads its pointer delta from. */
  pointerAxis: "x" | "y";
  /** Gap count between the packing origin and this band's far edge, minus one. */
  index: number;
  /** −1 when packing grows toward −axis (reversed directions, end packing). */
  sign: 1 | -1;
  /**
   * False when free-space distribution (`center`/`space-*`) decouples the
   * rendered spacing from the authored gap, so a gap drag could not track the
   * pointer. Non-draggable bands render their dash but get no hit rect.
   */
  draggable: boolean;
  /** True when the measured spacing was thinner than the grabbable minimum. */
  clamped: boolean;
  rect: Rect;
};

type SpacingLengthProperty =
  | "borderBottomWidth"
  | "borderLeftWidth"
  | "borderRightWidth"
  | "borderTopWidth"
  | "columnGap"
  | "paddingBottom"
  | "paddingLeft"
  | "paddingRight"
  | "paddingTop"
  | "rowGap";

function getComputedSpacingStyle(node: DesignNode, store: EditorStore) {
  const element = store.domIndex.getElement(node);
  if (!element || typeof getComputedStyle !== "function") return null;
  return getComputedStyle(element);
}

function getCanvasDimension(node: DesignNode, store: EditorStore, axis: "x" | "y") {
  const element = store.domIndex.getElement(node);
  const clientDimension = axis === "x" ? element?.clientWidth : element?.clientHeight;
  if (clientDimension) return clientDimension;
  const rect = element?.getBoundingClientRect();
  const renderedDimension = axis === "x" ? rect?.width : rect?.height;
  if (renderedDimension) return renderedDimension / store.zoom;
  return axis === "x"
    ? getEffectiveModelDimension(node.width, node.styles.width)
    : getEffectiveModelDimension(node.height, node.styles.height);
}

function percentageBasisFor(node: DesignNode, store: EditorStore, property: SpacingLengthProperty) {
  if (property === "rowGap") return getCanvasDimension(node, store, "y");
  if (property === "columnGap") return getCanvasDimension(node, store, "x");

  // CSS padding percentages resolve against the containing block's inline size.
  const parent = store.getParent(node.id);
  return parent ? getCanvasDimension(parent, store, "x") : getCanvasDimension(node, store, "x");
}

function resolveCssLengthPx(
  value: unknown,
  {
    computedStyle,
    node,
    property,
    store,
  }: {
    computedStyle: CSSStyleDeclaration | null;
    node: DesignNode;
    property: SpacingLengthProperty;
    store: EditorStore;
  },
): number | null {
  const plain = parsePlainPixelLength(value);
  if (plain !== null) return plain;
  if (typeof value !== "string") return null;

  const match = value.trim().match(/^(-?(?:\d+|\d*\.\d+))([a-z%]+)$/i);
  if (!match) return null;
  const magnitude = Number.parseFloat(match[1]!);
  const unit = match[2]!.toLowerCase();
  if (!Number.isFinite(magnitude)) return null;

  if (unit === "%") return (magnitude / 100) * percentageBasisFor(node, store, property);
  if (unit === "rem") {
    const rootFontSize =
      typeof document !== "undefined" && typeof getComputedStyle === "function"
        ? parsePlainPixelLength(getComputedStyle(document.documentElement).fontSize)
        : null;
    return magnitude * (rootFontSize ?? 16);
  }
  if (unit === "em") {
    return magnitude * (parsePlainPixelLength(computedStyle?.fontSize) ?? 16);
  }
  if (unit === "vw" && typeof window !== "undefined") return (magnitude / 100) * window.innerWidth;
  if (unit === "vh" && typeof window !== "undefined") return (magnitude / 100) * window.innerHeight;
  if (unit === "vmin" && typeof window !== "undefined") {
    return (magnitude / 100) * Math.min(window.innerWidth, window.innerHeight);
  }
  if (unit === "vmax" && typeof window !== "undefined") {
    return (magnitude / 100) * Math.max(window.innerWidth, window.innerHeight);
  }
  const absoluteScale = ABSOLUTE_LENGTH_PX[unit];
  return absoluteScale === undefined ? null : magnitude * absoluteScale;
}

function readRenderedLength(
  node: DesignNode,
  store: EditorStore,
  property: SpacingLengthProperty,
  authoredFallback: unknown,
  computedStyle = getComputedSpacingStyle(node, store),
  preferAuthoredPixels = true,
) {
  // Direct manipulation writes numeric CSS pixels. Prefer that fresh model
  // value over computed style from the DOM commit one frame behind it.
  const authoredPixels = parsePlainPixelLength(authoredFallback);
  if (preferAuthoredPixels && authoredPixels !== null) return authoredPixels;

  const computedValue = computedStyle?.[property];
  // JSDOM reports `normal` for gap longhands even when the shorthand is
  // authored; in browsers an authored resolved value wins this first branch.
  const computed =
    computedValue && computedValue !== "normal"
      ? resolveCssLengthPx(computedValue, { computedStyle, node, property, store })
      : null;
  return (
    computed ??
    authoredPixels ??
    resolveCssLengthPx(authoredFallback, { computedStyle, node, property, store }) ??
    0
  );
}

function resolvePaddingPixelSides(
  node: DesignNode,
  store: EditorStore,
  computedStyle = getComputedSpacingStyle(node, store),
): EdgeValues<number> {
  const authored = resolvePaddingSides(node.styles);
  return {
    top: readRenderedLength(node, store, "paddingTop", authored.top, computedStyle),
    right: readRenderedLength(node, store, "paddingRight", authored.right, computedStyle),
    bottom: readRenderedLength(node, store, "paddingBottom", authored.bottom, computedStyle),
    left: readRenderedLength(node, store, "paddingLeft", authored.left, computedStyle),
  };
}

function resolveBorderPixelSides(
  node: DesignNode,
  store: EditorStore,
  computedStyle = getComputedSpacingStyle(node, store),
): EdgeValues<number> {
  const fallback = node.styles.borderWidth ?? node.borderWidth;
  return {
    top: readRenderedLength(node, store, "borderTopWidth", fallback, computedStyle, false),
    right: readRenderedLength(node, store, "borderRightWidth", fallback, computedStyle, false),
    bottom: readRenderedLength(node, store, "borderBottomWidth", fallback, computedStyle, false),
    left: readRenderedLength(node, store, "borderLeftWidth", fallback, computedStyle, false),
  };
}

function hasNonIdentitySpacingTransform(node: DesignNode) {
  if ((((node.rotation ?? 0) % 360) + 360) % 360 !== 0) return true;
  const transform = String(node.styles.transform ?? "").trim();
  if (transform && transform !== "none") return true;
  const rotate = String(node.styles.rotate ?? "").trim();
  if (rotate && rotate !== "none" && !/^0(?:deg|rad|grad|turn)?$/i.test(rotate)) return true;
  const scale = String(node.styles.scale ?? "").trim();
  if (scale && scale !== "none" && !/^1(?:\s+1)?$/.test(scale)) return true;
  const zoom = node.styles.zoom;
  return zoom !== undefined && Number.parseFloat(String(zoom)) !== 1;
}

/** Whether axis-aligned spacing bands can safely share the DOM scene geometry. */
export function canRenderSpacingBands(node: DesignNode, store: EditorStore) {
  let current: DesignNode | undefined = node;
  while (current) {
    if (hasNonIdentitySpacingTransform(current)) return false;
    current = store.getParent(current.id);
  }
  return true;
}

type PackingOrigin = "start" | "end" | null;

/**
 * Which end of the main axis flex packs children against, in canvas space.
 * Null when free-space distribution (`center`/`space-*`) decouples the
 * rendered spacing from the authored gap, so no gap drag can track the
 * pointer. Direction reversal and end-justification each flip the origin;
 * together they cancel out.
 */
function mainPackingOrigin(node: DesignNode): PackingOrigin {
  const justify = String(node.styles.justifyContent ?? "normal");
  const packsStart = ["normal", "flex-start", "start", "stretch"].includes(justify);
  const packsEnd = justify === "flex-end" || justify === "end";
  if (!packsStart && !packsEnd) return null;
  const reversed = String(node.styles.flexDirection ?? "row").endsWith("-reverse");
  return packsEnd !== reversed ? "end" : "start";
}

/** The cross-axis analogue of `mainPackingOrigin`, for between-lines bands. */
function crossPackingOrigin(node: DesignNode): PackingOrigin {
  const align = String(node.styles.alignContent ?? "normal");
  const packsStart = ["normal", "flex-start", "start", "stretch"].includes(align);
  const packsEnd = align === "flex-end" || align === "end";
  if (!packsStart && !packsEnd) return null;
  const wrapReverse = String(node.styles.flexWrap ?? "nowrap") === "wrap-reverse";
  return packsEnd !== wrapReverse ? "end" : "start";
}

function mainStart(rect: Rect, axis: DragInsertionAxis) {
  return axis === "row" ? rect.x : rect.y;
}

function mainEnd(rect: Rect, axis: DragInsertionAxis) {
  return axis === "row" ? rect.x + rect.width : rect.y + rect.height;
}

function crossStart(rect: Rect, axis: DragInsertionAxis) {
  return axis === "row" ? rect.y : rect.x;
}

function crossEnd(rect: Rect, axis: DragInsertionAxis) {
  return axis === "row" ? rect.y + rect.height : rect.x + rect.width;
}

function separatedRect(
  start: number,
  end: number,
  cross: { start: number; end: number },
  separationAxis: "x" | "y",
  minThickness: number,
): { clamped: boolean; rect: Rect } {
  let lead = start;
  let thickness = end - start;
  const clamped = thickness < minThickness;
  if (clamped) {
    lead = (start + end) / 2 - minThickness / 2;
    thickness = minThickness;
  }
  const rect =
    separationAxis === "x"
      ? { x: lead, y: cross.start, width: thickness, height: Math.max(0, cross.end - cross.start) }
      : { x: cross.start, y: lead, width: Math.max(0, cross.end - cross.start), height: thickness };
  return { clamped, rect };
}

/**
 * The DOM measurements gap and padding bands share for one container: the
 * viewport rect is read once and reused for every child measurement, and the
 * container's rect, padding, border, and computed style are derived once.
 */
type SpacingMeasureContext = {
  border: EdgeValues<number>;
  minThickness: number;
  padding: EdgeValues<number>;
  parentRect: Rect;
  viewportRect: DOMRectReadOnly | undefined;
};

function measureSpacingContext(
  node: DesignNode,
  store: EditorStore,
  viewportEl: Element | null,
  zoom: number,
): SpacingMeasureContext {
  const viewportRect = viewportEl?.getBoundingClientRect();
  const computedStyle = getComputedSpacingStyle(node, store);
  return {
    border: resolveBorderPixelSides(node, store, computedStyle),
    minThickness: MIN_BAND_THICKNESS_SCREEN_PX / zoom,
    padding: resolvePaddingPixelSides(node, store, computedStyle),
    parentRect: getNodeCanvasRect(node, store, viewportEl, viewportRect),
    viewportRect,
  };
}

/**
 * The spacing bands between a flex container's flow children, in canvas
 * space. Bands come from the measured space between adjacent rendered boxes
 * rather than the authored `gap`, so `space-between` and margin-driven
 * layouts show their real spacing — but only bands whose packing origin makes
 * a gap drag track the pointer are marked draggable.
 */
function computeFlexGapBands(
  node: DesignNode,
  store: EditorStore,
  viewportEl: Element | null,
  context: SpacingMeasureContext,
): FlexGapBand[] {
  const flowChildren = getFlexFlowChildren(node.children);
  if (flowChildren.length < 2) return [];

  const direction = String(node.styles.flexDirection ?? "row");
  const axis: DragInsertionAxis = direction.startsWith("column") ? "column" : "row";
  const mainOrigin = mainPackingOrigin(node);

  const { border, minThickness, padding, parentRect, viewportRect } = context;
  const content = {
    left: parentRect.x + border.left + padding.left,
    right: parentRect.x + parentRect.width - border.right - padding.right,
    top: parentRect.y + border.top + padding.top,
    bottom: parentRect.y + parentRect.height - border.bottom - padding.bottom,
  };
  const childRects = flowChildren.map((child) =>
    getNodeCanvasRect(child, store, viewportEl, viewportRect),
  );
  const wraps = flexContainerWraps(node);
  const lines = wraps
    ? groupFlexRectsIntoLines(childRects, axis).map((line) => line.rects)
    : [childRects];

  const bands: FlexGapBand[] = [];

  for (const lineRects of lines) {
    const sorted = [...lineRects].sort((a, b) => mainStart(a, axis) - mainStart(b, axis));
    // A wrapped line's bands span only that line; a single line spans the
    // whole padded content box, matching how the container renders its gap.
    const cross =
      lines.length > 1
        ? {
            start: Math.min(...sorted.map((rect) => crossStart(rect, axis))),
            end: Math.max(...sorted.map((rect) => crossEnd(rect, axis))),
          }
        : axis === "row"
          ? { start: content.top, end: content.bottom }
          : { start: content.left, end: content.right };
    const gapCount = sorted.length - 1;
    for (let index = 0; index < gapCount; index += 1) {
      const { clamped, rect } = separatedRect(
        mainEnd(sorted[index]!, axis),
        mainStart(sorted[index + 1]!, axis),
        cross,
        axis === "row" ? "x" : "y",
        minThickness,
      );
      bands.push({
        gapAxis: axis === "row" ? "column" : "row",
        pointerAxis: axis === "row" ? "x" : "y",
        index: mainOrigin === "end" ? gapCount - 1 - index : index,
        sign: mainOrigin === "end" ? -1 : 1,
        draggable: mainOrigin !== null,
        clamped,
        rect,
      });
    }
  }

  if (lines.length > 1) {
    const crossOrigin = crossPackingOrigin(node);
    const orderedLines = lines
      .map((lineRects) => ({
        start: Math.min(...lineRects.map((rect) => crossStart(rect, axis))),
        end: Math.max(...lineRects.map((rect) => crossEnd(rect, axis))),
      }))
      .sort((a, b) => a.start - b.start);
    const main =
      axis === "row"
        ? { start: content.left, end: content.right }
        : { start: content.top, end: content.bottom };
    const lineGapCount = orderedLines.length - 1;
    for (let index = 0; index < lineGapCount; index += 1) {
      const { clamped, rect } = separatedRect(
        orderedLines[index]!.end,
        orderedLines[index + 1]!.start,
        main,
        axis === "row" ? "y" : "x",
        minThickness,
      );
      bands.push({
        gapAxis: axis === "row" ? "row" : "column",
        pointerAxis: axis === "row" ? "y" : "x",
        index: crossOrigin === "end" ? lineGapCount - 1 - index : index,
        sign: crossOrigin === "end" ? -1 : 1,
        draggable: crossOrigin !== null,
        clamped,
        rect,
      });
    }
  }

  return bands;
}

export type PaddingSide = "top" | "right" | "bottom" | "left";

export type PaddingBand = {
  side: PaddingSide;
  /** Client axis the drag reads its pointer delta from. */
  pointerAxis: "x" | "y";
  /** +1 when growing padding drags toward +axis (top/left), −1 otherwise. */
  sign: 1 | -1;
  rect: Rect;
};

/**
 * The draggable padding strips just inside a flex container's edges, in
 * canvas space. Left/right strips span the full frame height; top/bottom
 * strips span the width between them so corners stay unambiguous. Zero
 * padding keeps a minimum grabbable thickness, like a zero gap.
 */
function computePaddingBands(context: SpacingMeasureContext): PaddingBand[] {
  const { border, minThickness, padding: sides, parentRect } = context;
  const thickness = (side: PaddingSide) => Math.max(sides[side], minThickness);
  const top = thickness("top");
  const right = thickness("right");
  const bottom = thickness("bottom");
  const left = thickness("left");
  const paddingBox = {
    x: parentRect.x + border.left,
    y: parentRect.y + border.top,
    width: Math.max(0, parentRect.width - border.left - border.right),
    height: Math.max(0, parentRect.height - border.top - border.bottom),
  };
  const innerX = paddingBox.x + left;
  const innerWidth = Math.max(0, paddingBox.width - left - right);

  return [
    {
      side: "top",
      pointerAxis: "y",
      sign: 1,
      rect: { x: innerX, y: paddingBox.y, width: innerWidth, height: top },
    },
    {
      side: "right",
      pointerAxis: "x",
      sign: -1,
      rect: {
        x: paddingBox.x + paddingBox.width - right,
        y: paddingBox.y,
        width: right,
        height: paddingBox.height,
      },
    },
    {
      side: "bottom",
      pointerAxis: "y",
      sign: -1,
      rect: {
        x: innerX,
        y: paddingBox.y + paddingBox.height - bottom,
        width: innerWidth,
        height: bottom,
      },
    },
    {
      side: "left",
      pointerAxis: "x",
      sign: 1,
      rect: { x: paddingBox.x, y: paddingBox.y, width: left, height: paddingBox.height },
    },
  ];
}

/**
 * All spacing bands for one flex container, from a single measurement pass.
 * `includeClampedGapBands: false` drops zero-ish gap bands whose hit rects
 * would otherwise overlap children flush against each other — used when the
 * bands belong to a promoted parent rather than the selected node itself.
 */
export function getSpacingBands(
  node: DesignNode,
  store: EditorStore,
  viewportEl: Element | null,
  zoom: number,
  {
    includeClampedGapBands = true,
    includePaddingBands = true,
  }: { includeClampedGapBands?: boolean; includePaddingBands?: boolean } = {},
): { gapBands: FlexGapBand[]; paddingBands: PaddingBand[] } {
  if (!isFlexContainer(node)) return { gapBands: [], paddingBands: [] };
  const context = measureSpacingContext(node, store, viewportEl, zoom);
  const gapBands = computeFlexGapBands(node, store, viewportEl, context).filter(
    (band) => includeClampedGapBands || !band.clamped,
  );
  return {
    gapBands,
    paddingBands: includePaddingBands ? computePaddingBands(context) : [],
  };
}

/** The rendered numeric padding for one side, for badges and drag baselines. */
export function resolvePaddingValue(
  node: DesignNode,
  side: PaddingSide,
  store: EditorStore,
): number {
  return resolvePaddingPixelSides(node, store)[side];
}

/**
 * Capture the durable padding state a strip drag starts from. A drag edits
 * only the dragged side; the other three are preserved for the write-back.
 */
export function resolvePaddingDragStart(node: DesignNode, side: PaddingSide, store: EditorStore) {
  const authoredSides = resolvePaddingSides(node.styles);
  return {
    startPadding: resolvePaddingPixelSides(node, store)[side],
    startSides: {
      top: authoredSides.top ?? 0,
      right: authoredSides.right ?? 0,
      bottom: authoredSides.bottom ?? 0,
      left: authoredSides.left ?? 0,
    },
  };
}

/**
 * Capture the durable gap state a band drag starts from. A container with no
 * gap longhands and no wrapping keeps the panel's linked single `gap`;
 * anything else writes longhands and preserves the untouched axis.
 */
export function resolveGapDragStart(node: DesignNode, gapAxis: GapAxis, store: EditorStore) {
  const gaps = resolveGaps(node.styles);
  const current = gapAxis === "row" ? gaps.row : gaps.column;
  const other = gapAxis === "row" ? gaps.column : gaps.row;
  const hasLonghand = node.styles.rowGap !== undefined || node.styles.columnGap !== undefined;
  const linkedShorthand = String(gaps.row ?? "") === String(gaps.column ?? "");
  const property = gapAxis === "row" ? "rowGap" : "columnGap";
  return {
    startGap: readRenderedLength(node, store, property, current),
    linked: !hasLonghand && linkedShorthand && !flexContainerWraps(node),
    otherGap: other ?? null,
  };
}
