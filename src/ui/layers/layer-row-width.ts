import { getLayerLabel } from "./layer-label";
import { LAYER_ROW_INDENT, type LayerRow } from "./layer-model";

const LAYER_ROW_LABEL_FONT = "12px Inter, system-ui, sans-serif";
const LAYER_ROW_LABEL_OFFSET = 30;
/** The 14px disclosure arrow plus the 6px gap that follows it. */
export const LAYER_ROW_DISCLOSURE_WIDTH = 20;
// Fixed columns after it: the 6px gap, the 24px lock and visibility toggles
// with their own 6px gap, and 10px padding.
const LAYER_ROW_TRAILING_WIDTH = 70;
const MEASURED_LABEL_CACHE_LIMIT = 4096;

const measuredLabelWidths = new Map<string, number>();
let measureContext: CanvasRenderingContext2D | null | undefined;

function measureLabelWidth(label: string) {
  const cached = measuredLabelWidths.get(label);
  if (cached !== undefined) return cached;

  if (measureContext === undefined) {
    measureContext = document.createElement("canvas").getContext("2d");
    if (measureContext) measureContext.font = LAYER_ROW_LABEL_FONT;
  }
  // A canvas-less host (jsdom) falls back to an average glyph advance: the
  // panel only needs its scroll width to be close, and a row whose label
  // outruns the estimate still widens the scroll area by overflowing.
  const width = measureContext ? measureContext.measureText(label).width : label.length * 6.6;

  if (measuredLabelWidths.size >= MEASURED_LABEL_CACHE_LIMIT) measuredLabelWidths.clear();
  measuredLabelWidths.set(label, width);
  return width;
}

/**
 * Width the row needs to show its whole name. Rows are not truncated, so the
 * widest row sets the horizontal scroll width of the panel.
 */
export function getLayerRowWidth(row: LayerRow) {
  return Math.ceil(
    LAYER_ROW_LABEL_OFFSET +
      row.depth * LAYER_ROW_INDENT +
      measureLabelWidth(getLayerLabel(row.node)) +
      LAYER_ROW_TRAILING_WIDTH,
  );
}

export function withDisclosureColumn(contentWidth: number, hasExpandableRows: boolean) {
  return hasExpandableRows ? contentWidth + LAYER_ROW_DISCLOSURE_WIDTH : contentWidth;
}

export function getLayerRowsContentWidth(rows: readonly LayerRow[], initialWidth = 0) {
  let contentWidth = initialWidth;
  for (const row of rows) contentWidth = Math.max(contentWidth, getLayerRowWidth(row));
  return contentWidth;
}
