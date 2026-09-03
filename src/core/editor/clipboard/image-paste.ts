/**
 * Helpers for pasting clipboard images onto the canvas.
 * Handles reading files, measuring dimensions, and laying out multiple images
 * at their natural sizes (capped per image) around the paste point.
 */
import type { Point, Size } from "../../types";

// ─── Clipboard ──────────────────────────────────────────────────

export function getClipboardImageFiles(clipboardData: Pick<DataTransfer, "items"> | null): File[] {
  if (!clipboardData) return [];

  const files: File[] = [];
  for (const item of Array.from(clipboardData.items)) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

export async function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Clipboard image did not decode to a data URL"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read image from clipboard"));
    reader.readAsDataURL(file);
  });
}

export async function measureImageSource(src: string): Promise<Size> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      resolve({
        width: image.naturalWidth || image.width,
        height: image.naturalHeight || image.height,
      });
    };
    image.onerror = () => reject(new Error("Failed to decode pasted image"));
    image.src = src;
  });
}

export async function measureImageFile(file: File): Promise<Size> {
  const objectUrl = URL.createObjectURL(file);
  try {
    return await measureImageSource(objectUrl);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

// ─── Sizing & layout ────────────────────────────────────────────

export function fitImageSizeToViewport(
  imageSize: Size,
  viewportCanvasSize: Size,
  maxVisibleFraction = 0.8,
): Size {
  const maxWidth = Math.max(1, viewportCanvasSize.width * maxVisibleFraction);
  const maxHeight = Math.max(1, viewportCanvasSize.height * maxVisibleFraction);
  const scale = Math.min(1, maxWidth / imageSize.width, maxHeight / imageSize.height);

  return {
    width: Math.max(1, Math.round(imageSize.width * scale)),
    height: Math.max(1, Math.round(imageSize.height * scale)),
  };
}

/**
 * Longest displayed dimension for a pasted image:
 * anything larger is scaled proportionally so its longest side lands here.
 */
export const MAX_PASTED_IMAGE_DIMENSION = 4096;

export function clampImageSizeToMaxDimension(
  size: Size,
  maxDimension = MAX_PASTED_IMAGE_DIMENSION,
): Size {
  const scale = Math.min(1, maxDimension / Math.max(size.width, size.height));
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

type PastedImageRowItem = { index: number; size: Size };
type PastedImageRow = { width: number; height: number; items: PastedImageRowItem[] };

/** Up to this many images paste as one horizontal row. */
const SINGLE_ROW_PASTE_LIMIT = 6;

function buildPastedImageRows(sizes: Size[], gap: number, itemsPerRow: number): PastedImageRow[] {
  if (sizes.length === 0) return [];

  const rows: PastedImageRow[] = [];
  let currentRow: PastedImageRow = { width: 0, height: 0, items: [] };

  sizes.forEach((size, index) => {
    if (currentRow.items.length === itemsPerRow) {
      rows.push(currentRow);
      currentRow = { width: 0, height: 0, items: [] };
    }

    currentRow.items.push({ index, size });
    currentRow.width =
      currentRow.items.length === 1 ? size.width : currentRow.width + gap + size.width;
    currentRow.height = Math.max(currentRow.height, size.height);
  });

  if (currentRow.items.length > 0) rows.push(currentRow);
  return rows;
}

export interface PastedImageLayout {
  sizes: Size[];
  positions: Point[];
}

/**
 * Images keep their natural sizes — pasting must not depend on zoom level or
 * viewport size, and large batches must stay legible. The only
 * scaling is the per-image `MAX_PASTED_IMAGE_DIMENSION` cap. Small batches
 * paste as one row; larger ones wrap into a balanced grid centered on the
 * paste point.
 */
export function layoutPastedImages(
  naturalSizes: Size[],
  canvasCenter: Point,
  gap = 24,
): PastedImageLayout {
  if (naturalSizes.length === 0) return { sizes: [], positions: [] };

  const cappedSizes = naturalSizes.map((size) => clampImageSizeToMaxDimension(size));
  const itemsPerRow =
    naturalSizes.length <= SINGLE_ROW_PASTE_LIMIT
      ? naturalSizes.length
      : Math.ceil(Math.sqrt(naturalSizes.length));
  const rows = buildPastedImageRows(cappedSizes, gap, itemsPerRow);

  const groupWidth = Math.max(...rows.map((row) => row.width));
  const groupHeight =
    rows.reduce((sum, row) => sum + row.height, 0) + gap * Math.max(0, rows.length - 1);

  const originX = Math.round(canvasCenter.x - groupWidth / 2);
  const originY = Math.round(canvasCenter.y - groupHeight / 2);
  const sizes: Size[] = [];
  const positions: Point[] = [];

  let rowTop = originY;
  for (const row of rows) {
    let x = originX + Math.floor((groupWidth - row.width) / 2);
    for (const item of row.items) {
      sizes[item.index] = item.size;
      positions[item.index] = {
        x,
        y: rowTop + Math.max(0, Math.floor((row.height - item.size.height) / 2)),
      };
      x += item.size.width + gap;
    }
    rowTop += row.height + gap;
  }

  return { sizes, positions };
}
