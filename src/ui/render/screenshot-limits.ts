export const MIN_SCREENSHOT_SCALE = 0.1;
export const MAX_SCREENSHOT_SCALE = 2;
export const MAX_SCREENSHOT_OUTPUT_PIXELS = 32 * 1024 * 1024;
export const MAX_SCREENSHOT_BATCH_NODES = 8;
/**
 * Aggregate base64 payload allowed for inline image content blocks in a single
 * tool response. The pixel limit above bounds each capture individually, but a
 * batch (or one large PNG) could still legally embed tens of megabytes; past
 * this budget the remaining captures degrade to the saved-file path so the
 * response stays consumable.
 */
export const MAX_INLINE_SCREENSHOT_RESPONSE_BYTES = 10 * 1024 * 1024;

export function assertScreenshotCaptureWithinLimits(width: number, height: number, scale: number) {
  if (!Number.isFinite(scale) || scale < MIN_SCREENSHOT_SCALE || scale > MAX_SCREENSHOT_SCALE) {
    throw new Error(
      `Screenshot scale must be between ${MIN_SCREENSHOT_SCALE} and ${MAX_SCREENSHOT_SCALE}.`,
    );
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0) {
    throw new Error("Screenshot dimensions must be finite non-negative numbers.");
  }

  const outputWidth = Math.ceil(width * scale);
  const outputHeight = Math.ceil(height * scale);
  if (
    outputWidth > 0 &&
    outputHeight > 0 &&
    outputWidth > Math.floor(MAX_SCREENSHOT_OUTPUT_PIXELS / outputHeight)
  ) {
    throw new Error(
      `Screenshot output would be ${outputWidth}×${outputHeight} pixels, exceeding Leaf's ${MAX_SCREENSHOT_OUTPUT_PIXELS.toLocaleString("en-US")}-pixel capture limit. Capture a smaller node or use a lower scale.`,
    );
  }
}
