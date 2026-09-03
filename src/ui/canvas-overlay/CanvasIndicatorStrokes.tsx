import { useLayoutEffect, useRef } from "react";
import type { Rect } from "../../core/types";

export type CanvasOverlayRectEntry = {
  rect: Rect;
  /** Degrees clockwise about the rect's center. Absent means axis-aligned. */
  rotation?: number;
};

function resetCanvasTransform(ctx: CanvasRenderingContext2D) {
  if (typeof ctx.resetTransform === "function") {
    ctx.resetTransform();
    return;
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function strokeCanvasRect(ctx: CanvasRenderingContext2D, rect: Rect, rotation = 0) {
  if (!rotation) {
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    ctx.stroke();
    return;
  }

  // Rotate about the rect's own center so the outline sits on the node the way
  // the CSS transform paints it.
  ctx.save();
  ctx.translate(rect.x + rect.width / 2, rect.y + rect.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.beginPath();
  ctx.rect(-rect.width / 2, -rect.height / 2, rect.width, rect.height);
  ctx.stroke();
  ctx.restore();
}

export function CanvasIndicatorStrokes({
  viewportWidth,
  viewportHeight,
  zoom,
  panX,
  panY,
  hoveredRect,
  parentOutlineRects,
  enteredContainerRect,
  selectedRects,
  textEditingRect = null,
}: {
  viewportWidth: number;
  viewportHeight: number;
  zoom: number;
  panX: number;
  panY: number;
  hoveredRect: CanvasOverlayRectEntry | null;
  parentOutlineRects: CanvasOverlayRectEntry[];
  enteredContainerRect: Rect | null;
  selectedRects: CanvasOverlayRectEntry[];
  /** Thin dashed frame around nested text while it is being edited inline. */
  textEditingRect?: CanvasOverlayRectEntry | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const getContextDescriptor = Object.getOwnPropertyDescriptor(
      HTMLCanvasElement.prototype,
      "getContext",
    );
    const getContextSource =
      typeof getContextDescriptor?.value === "function"
        ? Function.prototype.toString.call(getContextDescriptor.value)
        : "";

    // Test DOM environments often expose a stub that logs on every getContext() call.
    if (
      /\b(jsdom|happy-dom)\b/i.test(typeof navigator === "undefined" ? "" : navigator.userAgent) ||
      /notImplemented|canvas npm package/i.test(getContextSource)
    ) {
      return;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = Math.max(0, viewportWidth);
    const height = Math.max(0, viewportHeight);
    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.ceil(width * dpr));
    const pixelHeight = Math.max(1, Math.ceil(height * dpr));

    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }

    resetCanvasTransform(ctx);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (width === 0 || height === 0) return;

    ctx.scale(dpr, dpr);
    ctx.transform(zoom, 0, 0, zoom, panX, panY);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const strokeWidth = 2 / zoom;

    if (hoveredRect) {
      ctx.save();
      ctx.strokeStyle = "#1E90FF";
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = strokeWidth;
      strokeCanvasRect(ctx, hoveredRect.rect, hoveredRect.rotation);
      ctx.restore();
    }

    if (parentOutlineRects.length > 0) {
      ctx.save();
      ctx.strokeStyle = "#60a5fa";
      ctx.globalAlpha = 0.65;
      ctx.lineWidth = strokeWidth;
      ctx.setLineDash([6 / zoom, 4 / zoom]);
      for (const { rect, rotation } of parentOutlineRects) {
        strokeCanvasRect(ctx, rect, rotation);
      }
      ctx.restore();
    }

    if (enteredContainerRect) {
      ctx.save();
      ctx.strokeStyle = "#2563eb";
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = strokeWidth;
      ctx.setLineDash([8 / zoom, 5 / zoom]);
      strokeCanvasRect(ctx, enteredContainerRect);
      ctx.restore();
    }

    if (selectedRects.length > 0) {
      ctx.save();
      ctx.strokeStyle = "#1E90FF";
      ctx.lineWidth = strokeWidth * 0.8;
      for (const { rect, rotation } of selectedRects) {
        strokeCanvasRect(ctx, rect, rotation);
      }
      ctx.restore();
    }

    if (textEditingRect) {
      ctx.save();
      ctx.strokeStyle = "#1E90FF";
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1 / zoom;
      ctx.setLineDash([3 / zoom, 3 / zoom]);
      strokeCanvasRect(ctx, textEditingRect.rect, textEditingRect.rotation);
      ctx.restore();
    }
  }, [
    enteredContainerRect,
    hoveredRect,
    panX,
    panY,
    parentOutlineRects,
    selectedRects,
    textEditingRect,
    viewportHeight,
    viewportWidth,
    zoom,
  ]);

  return (
    <canvas
      aria-hidden="true"
      ref={canvasRef}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
      }}
    />
  );
}
