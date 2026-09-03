import { memo } from "react";
import {
  FONT_PREVIEW_DISPLAY_ROW_HEIGHT,
  FONT_PREVIEW_SOURCE_ROW_HEIGHT,
  type FontCatalogEntry,
  getFontPreviewChunkDimensions,
  getFontPreviewChunkUrl,
} from "../../core/fonts/catalog";

export const FontPreviewRow = memo(function FontPreviewRow({
  entry,
  fallbackFontFamily,
}: {
  entry: FontCatalogEntry;
  fallbackFontFamily?: string;
}) {
  if (entry.hasPreview && entry.previewChunk !== null) {
    const scale = FONT_PREVIEW_DISPLAY_ROW_HEIGHT / FONT_PREVIEW_SOURCE_ROW_HEIGHT;
    const chunkDimensions = getFontPreviewChunkDimensions(entry.previewChunk);
    return (
      <div
        style={{
          width: `${entry.previewWidth * scale}px`,
          maxWidth: "100%",
          height: FONT_PREVIEW_DISPLAY_ROW_HEIGHT,
          backgroundImage: `url(${getFontPreviewChunkUrl(entry.previewChunk)})`,
          backgroundSize: `${chunkDimensions.width * scale}px ${chunkDimensions.height * scale}px`,
          backgroundPosition: `${-entry.previewOffsetX * scale}px ${-entry.previewOffsetY * scale}px`,
          backgroundRepeat: "no-repeat",
        }}
      />
    );
  }

  return (
    <div
      style={{
        height: FONT_PREVIEW_DISPLAY_ROW_HEIGHT,
        display: "flex",
        alignItems: "center",
        fontFamily: fallbackFontFamily,
        fontSize: 16,
        lineHeight: 1.15,
        letterSpacing: "-0.01em",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {entry.previewText}
    </div>
  );
});
