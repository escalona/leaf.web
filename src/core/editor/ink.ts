import { getStroke, type StrokeOptions } from "perfect-freehand";
import type { InkPoint, Rect } from "../types";

export interface InkPreview {
  bounds: Rect;
  outline: number[][];
  pathData: string;
}

export interface InkShape {
  bounds: Rect;
  svgMarkup: string;
}

const DEFAULT_INK_COLOR = "#111111";

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function clampPressure(pressure: number): number {
  return Math.min(Math.max(pressure, 0.05), 1);
}

const DEFAULT_INK_SIZE = 8;

export function getInkStrokeOptions(
  useRealPressure: boolean,
  last: boolean,
  size = DEFAULT_INK_SIZE,
): StrokeOptions {
  return {
    size,
    thinning: 0.5,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: !useRealPressure,
    last,
    start: { cap: true, taper: 0 },
    end: { cap: true, taper: 0 },
  };
}

export function getSvgPathFromStrokeOutline(outline: number[][]): string {
  const length = outline.length;
  if (length < 4) return "";

  let current = outline[0]!;
  let next = outline[1]!;
  const third = outline[2]!;

  let result =
    `M${round(current[0])},${round(current[1])} ` +
    `Q${round(next[0])},${round(next[1])} ` +
    `${round((next[0] + third[0]) / 2)},${round((next[1] + third[1]) / 2)} T`;

  for (let index = 2; index < length - 1; index++) {
    current = outline[index]!;
    next = outline[index + 1]!;
    result += ` ${round((current[0] + next[0]) / 2)},${round((current[1] + next[1]) / 2)}`;
  }

  return `${result} Z`;
}

export function appendInkPoints(points: InkPoint[], nextPoints: InkPoint[]): InkPoint[] {
  if (nextPoints.length === 0) return points;

  const merged = [...points];
  for (const point of nextPoints) {
    const lastPoint = merged[merged.length - 1];
    if (
      lastPoint &&
      lastPoint.x === point.x &&
      lastPoint.y === point.y &&
      lastPoint.pressure === point.pressure
    ) {
      continue;
    }
    merged.push(point);
  }

  return merged;
}

function getBoundsFromOutline(outline: number[][]): Rect {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const [x, y] of outline) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  return {
    x: round(minX),
    y: round(minY),
    width: round(Math.max(maxX - minX, 1)),
    height: round(Math.max(maxY - minY, 1)),
  };
}

function getStrokeOutline(
  points: InkPoint[],
  useRealPressure: boolean,
  last: boolean,
  size?: number,
): number[][] {
  return getStroke(
    points.map((point) => ({
      x: point.x,
      y: point.y,
      pressure: clampPressure(point.pressure),
    })),
    getInkStrokeOptions(useRealPressure, last, size),
  );
}

export function buildInkPreview(
  points: InkPoint[],
  options: { useRealPressure: boolean; last: boolean; size?: number },
): InkPreview | null {
  if (points.length === 0) return null;

  const outline = getStrokeOutline(points, options.useRealPressure, options.last, options.size);
  if (outline.length === 0) return null;

  return {
    bounds: getBoundsFromOutline(outline),
    outline,
    pathData: getSvgPathFromStrokeOutline(outline),
  };
}

export function buildInkShape(
  points: InkPoint[],
  useRealPressure: boolean,
  color = DEFAULT_INK_COLOR,
  size?: number,
): InkShape | null {
  const preview = buildInkPreview(points, { useRealPressure, last: true, size });
  if (!preview) return null;

  const translatedOutline = preview.outline.map(([x, y]) => [
    round(x - preview.bounds.x),
    round(y - preview.bounds.y),
  ]);

  const pathData = getSvgPathFromStrokeOutline(translatedOutline);
  const svgMarkup =
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `viewBox="0 0 ${preview.bounds.width} ${preview.bounds.height}" ` +
    `width="100%" height="100%" preserveAspectRatio="none" ` +
    `style="display:block;overflow:visible;pointer-events:none">` +
    `<path d="${pathData}" fill="${color}" />` +
    `</svg>`;

  return {
    bounds: preview.bounds,
    svgMarkup,
  };
}
