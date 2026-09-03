import type { DesignNode } from "../types";

const TEXT_MIN_WIDTH = 16;

/**
 * Everything that changes advance width or line breaking.
 *
 * A measurement clone that stands in for the rendered element would also carry
 * box-model properties — `display`, `padding`, `box-sizing`, `border-width`,
 * the flex alignment trio, `text-overflow`, `-webkit-line-clamp`.
 * Ours is a bare probe whose box is dictated by the caller's `maxWidth`, so
 * copying those would fight the harness instead of describing the text.
 *
 * `direction`/`unicode-bidi` are left off for the same reason: the probe uses
 * `dir="auto"`, which an inline `direction` would defeat, and bidi reordering
 * does not change the sum of advances anyway.
 *
 * The three wrapping properties are resolved separately, because they are the
 * only ones where the probe has to supply its own default.
 */
const TEXT_LAYOUT_PROPERTIES = [
  "font-family",
  "font-feature-settings",
  "font-kerning",
  "font-optical-sizing",
  "font-size",
  "font-size-adjust",
  "font-stretch",
  "font-style",
  "font-synthesis",
  "font-variant",
  "font-variation-settings",
  "font-weight",
  "hyphenate-character",
  "hyphenate-limit-chars",
  "hyphens",
  "letter-spacing",
  "line-break",
  "line-height",
  "tab-size",
  "text-align",
  "text-align-last",
  "text-box",
  "text-emphasis-style",
  "text-indent",
  "text-orientation",
  "text-rendering",
  "text-transform",
  "text-wrap",
  "word-spacing",
  "writing-mode",
  "-webkit-text-size-adjust",
  "-webkit-text-stroke-width",
] as const;

function parseCssPixel(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readComputedProperty(computed: CSSStyleDeclaration | null, property: string): string {
  if (!computed) return "";
  try {
    return computed.getPropertyValue(property).trim();
  } catch {
    return "";
  }
}

/**
 * `normal` is both the CSS initial value and what an unstyled probe reports, so
 * it cannot be told apart from "the author never said". Fall back to the
 * measurement harness's own value there and honour anything else, which is what
 * makes `white-space: nowrap` or `pre` text finally measure the way it paints.
 */
function resolveWrappingProperty(
  computed: CSSStyleDeclaration | null,
  property: string,
  fallback: string,
) {
  const value = readComputedProperty(computed, property);
  return value === "" || value === "normal" ? fallback : value;
}

/** Extra advance per character, in px. Non-resolvable units contribute none. */
function parseLetterSpacingPx(value: string, fontSize: number): number {
  if (!value || value === "normal") return 0;
  const magnitude = Number.parseFloat(value);
  if (!Number.isFinite(magnitude)) return 0;
  if (value.endsWith("rem")) return magnitude * 16;
  if (value.endsWith("em")) return magnitude * fontSize;
  return value.endsWith("%") ? (magnitude / 100) * fontSize : magnitude;
}

function normalizeTextForDom(text: string) {
  return text
    .replace(/\r?\n|\r/g, "\n")
    .split("\n")
    .map((line) => line || " ")
    .join("\n");
}

function getFallbackLineHeight(fontSize: number, lineHeight: string) {
  const numeric = Number.parseFloat(lineHeight);
  if (Number.isFinite(numeric)) {
    return lineHeight.trim().toLowerCase().endsWith("px") ? numeric : fontSize * numeric;
  }

  return fontSize * 1.4;
}

function getFallbackTextSize(
  text: string,
  fontSize: number,
  lineHeight: number,
  letterSpacing: number,
  maxWidth: number | null,
) {
  const lines = normalizeTextForDom(text).split("\n");
  const charWidth = Math.max(1, fontSize * 0.56 + letterSpacing);
  const longestLine = Math.max(...lines.map((line) => line.length), 1);
  const naturalWidth = Math.max(TEXT_MIN_WIDTH, Math.ceil(longestLine * charWidth) + 1);
  const width = maxWidth === null ? naturalWidth : Math.max(TEXT_MIN_WIDTH, maxWidth);
  const wrappedLines =
    maxWidth === null
      ? lines.length
      : lines.reduce((count, line) => {
          const charsPerLine = Math.max(1, Math.floor(width / charWidth));
          return count + Math.max(1, Math.ceil(Math.max(line.length, 1) / charsPerLine));
        }, 0);
  return {
    width,
    height: Math.max(Math.ceil(lineHeight), Math.ceil(wrappedLines * lineHeight)),
  };
}

export function measurePlainTextForElement(
  sourceElement: HTMLElement,
  text: string,
  options: { maxWidth: number | null },
) {
  const ownerDocument = sourceElement.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const computed = ownerWindow?.getComputedStyle(sourceElement) ?? null;
  const fontSize = parseCssPixel(readComputedProperty(computed, "font-size")) ?? 16;
  const lineHeight = getFallbackLineHeight(fontSize, readComputedProperty(computed, "line-height"));
  const letterSpacing = parseLetterSpacingPx(
    readComputedProperty(computed, "letter-spacing"),
    fontSize,
  );
  const normalizedText = normalizeTextForDom(text);
  const measurer = ownerDocument.createElement("div");
  const clampedWidth =
    options.maxWidth === null ? null : Math.max(TEXT_MIN_WIDTH, options.maxWidth);

  measurer.textContent = normalizedText;
  measurer.setAttribute("dir", "auto");

  for (const property of TEXT_LAYOUT_PROPERTIES) {
    const value = readComputedProperty(computed, property);
    if (value !== "") measurer.style.setProperty(property, value);
  }

  Object.assign(measurer.style, {
    position: "fixed",
    top: "-10000px",
    left: "-10000px",
    visibility: "hidden",
    pointerEvents: "none",
    contain: "layout style",
    boxSizing: "border-box",
    minWidth: `${TEXT_MIN_WIDTH}px`,
    width: clampedWidth === null ? "max-content" : `${clampedWidth}px`,
    maxWidth: clampedWidth === null ? "none" : `${clampedWidth}px`,
    padding: "0",
    border: "0",
    margin: "0",
    whiteSpace: resolveWrappingProperty(computed, "white-space", "pre-wrap"),
    overflowWrap: resolveWrappingProperty(
      computed,
      "overflow-wrap",
      options.maxWidth === null ? "normal" : "break-word",
    ),
    wordBreak: resolveWrappingProperty(computed, "word-break", "normal"),
  });

  ownerDocument.body.appendChild(measurer);
  try {
    const rect = measurer.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) {
      const measuredWidth = Math.ceil(rect.width);
      return {
        width: Math.max(
          TEXT_MIN_WIDTH,
          measuredWidth + (options.maxWidth === null && measuredWidth > TEXT_MIN_WIDTH ? 1 : 0),
        ),
        height: Math.max(Math.ceil(lineHeight), Math.ceil(rect.height)),
      };
    }
  } finally {
    measurer.remove();
  }

  return getFallbackTextSize(normalizedText, fontSize, lineHeight, letterSpacing, options.maxWidth);
}

export function getTextHorizontalAnchor(node: DesignNode): "start" | "center" | "end" {
  const align = String(node.styles.textAlign ?? "").toLowerCase();
  if (align === "center" || align === "middle") return "center";
  if (align === "right" || align === "end") return "end";
  return "start";
}

export function getAnchoredTextSizePatch(
  node: DesignNode,
  size: { width: number; height: number },
) {
  const width = Math.max(TEXT_MIN_WIDTH, Math.ceil(size.width));
  const height = Math.max(1, Math.ceil(size.height));
  const deltaWidth = width - node.width;
  const patch: Partial<DesignNode> = { width, height };

  if (node.textAutoSize && deltaWidth !== 0) {
    const anchor = getTextHorizontalAnchor(node);
    if (anchor === "center") patch.x = node.x - deltaWidth / 2;
    else if (anchor === "end") patch.x = node.x - deltaWidth;
  }

  return patch;
}
