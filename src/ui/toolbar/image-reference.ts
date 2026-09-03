import { fitImageSizeToViewport } from "../../core/editor/clipboard/image-paste";
import { screenPoint } from "../../core/editor/interaction/coordinate-spaces";
import type { DesignNode, Size } from "../../core/types";
import type { EditorStore } from "../../core/state/EditorStore";
import { blobToDataUrl, dataUrlToBlob, resolveImageAssetUrl } from "../../core/state/image-assets";
import type { ImageGenerationReferencePreview } from "./toolbar-model";

const OPENAI_REFERENCE_IMAGE_MAX_EDGE = 3840;
const OPENAI_REFERENCE_IMAGE_MAX_PIXELS = 8_294_400;
const OPENAI_REFERENCE_IMAGE_JPEG_QUALITY = 0.92;
const OPENAI_REFERENCE_IMAGE_WEBP_QUALITY = 0.92;

export function isImageNodeWithSource(node: DesignNode) {
  return node.type === "image" && (node.imageAsset || node.content);
}

export async function contentUrlToDataUrl(source: string) {
  if (source.startsWith("data:image/")) return source;
  if (!/^https?:\/\//i.test(source)) return null;

  const response = await fetch(source);
  if (!response.ok) return null;

  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) return null;
  return await blobToDataUrl(blob);
}

function getImageMimeTypeFromDataUrl(dataUrl: string) {
  const match = /^data:([^;,]+)/i.exec(dataUrl);
  return match?.[1]?.toLowerCase() ?? "application/octet-stream";
}

function getOpenAiReferenceImageSize(width: number, height: number): Size {
  const pixelCount = width * height;
  const scale = Math.min(
    1,
    OPENAI_REFERENCE_IMAGE_MAX_EDGE / width,
    OPENAI_REFERENCE_IMAGE_MAX_EDGE / height,
    Math.sqrt(OPENAI_REFERENCE_IMAGE_MAX_PIXELS / pixelCount),
  );

  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

function getReferenceOutputMimeType(inputMimeType: string) {
  if (inputMimeType === "image/jpeg" || inputMimeType === "image/jpg") return "image/jpeg";
  if (inputMimeType === "image/webp") return "image/webp";
  return "image/png";
}

function getReferenceOutputQuality(outputMimeType: string) {
  if (outputMimeType === "image/jpeg") return OPENAI_REFERENCE_IMAGE_JPEG_QUALITY;
  if (outputMimeType === "image/webp") return OPENAI_REFERENCE_IMAGE_WEBP_QUALITY;
  return undefined;
}

function canvasToBlob(canvas: HTMLCanvasElement | OffscreenCanvas, type: string, quality?: number) {
  if ("convertToBlob" in canvas) {
    return canvas.convertToBlob({ type, quality });
  }

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
          return;
        }
        reject(new Error("Reference image canvas did not produce a Blob."));
      },
      type,
      quality,
    );
  });
}

function createReferenceCanvas(width: number, height: number) {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export async function normalizeOpenAiReferenceDataUrl(dataUrl: string) {
  if (typeof createImageBitmap === "undefined") return dataUrl;

  const inputMimeType = getImageMimeTypeFromDataUrl(dataUrl);
  const outputMimeType = getReferenceOutputMimeType(inputMimeType);
  const sourceBlob = await dataUrlToBlob(dataUrl);
  const bitmap = await createImageBitmap(sourceBlob);

  try {
    const size = getOpenAiReferenceImageSize(bitmap.width, bitmap.height);
    const canvas = createReferenceCanvas(size.width, size.height);
    const context = canvas.getContext("2d") as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!context) return dataUrl;

    if (outputMimeType === "image/jpeg") {
      context.fillStyle = "#fff";
      context.fillRect(0, 0, size.width, size.height);
    }
    context.drawImage(bitmap, 0, 0, size.width, size.height);

    const normalizedBlob = await canvasToBlob(
      canvas,
      outputMimeType,
      getReferenceOutputQuality(outputMimeType),
    );
    return await blobToDataUrl(normalizedBlob);
  } finally {
    bitmap.close();
  }
}

export async function resolveImageReference(
  node: DesignNode,
): Promise<ImageGenerationReferencePreview | null> {
  const assetDataUrl = node.imageAsset
    ? await resolveImageAssetUrl(node.imageAsset, { shouldResolveToOriginal: true })
    : null;
  const dataUrl = assetDataUrl ?? (await contentUrlToDataUrl(node.content));

  if (!dataUrl?.startsWith("data:image/")) return null;

  return {
    id: node.id,
    name: node.name,
    dataUrl: await normalizeOpenAiReferenceDataUrl(dataUrl),
    width: node.imageAsset?.width ?? node.width,
    height: node.imageAsset?.height ?? node.height,
  };
}

export function createGeneratedImagePlaceholders({
  count,
  size,
  store,
  toolbarElement,
}: {
  count: number;
  size: Size;
  store: EditorStore;
  toolbarElement: HTMLDivElement | null;
}) {
  const viewportRect = toolbarElement?.parentElement?.getBoundingClientRect();
  const viewportCanvasSize = viewportRect
    ? { width: viewportRect.width / store.zoom, height: viewportRect.height / store.zoom }
    : { width: size.width, height: size.height };
  const columns = Math.min(count, Math.max(1, Math.ceil(Math.sqrt(count))));
  const rows = Math.max(1, Math.ceil(count / columns));
  const gap = 24;
  const cellSize = {
    width: Math.max(1, (viewportCanvasSize.width - gap * (columns - 1)) / columns),
    height: Math.max(1, (viewportCanvasSize.height - gap * (rows - 1)) / rows),
  };
  const fittedSize = fitImageSizeToViewport(size, cellSize, count === 1 ? 0.72 : 0.9);
  const canvasCenter = store.screenToCanvas(
    screenPoint(
      (viewportRect?.width ?? window.innerWidth) / 2,
      (viewportRect?.height ?? window.innerHeight) / 2,
    ),
  );
  const totalWidth = fittedSize.width * columns + gap * (columns - 1);
  const totalHeight = fittedSize.height * rows + gap * (rows - 1);
  const startX = Math.round(canvasCenter.x - totalWidth / 2);
  const startY = Math.round(canvasCenter.y - totalHeight / 2);

  return Array.from({ length: count }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return store.runtime.createImage(
      "",
      fittedSize,
      {
        x: startX + column * (fittedSize.width + gap),
        y: startY + row * (fittedSize.height + gap),
      },
      count === 1 ? "Generating Image" : `Generating Image ${index + 1}`,
    );
  });
}
