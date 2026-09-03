/**
 * HTML-to-DesignNode parser.
 *
 * Converts an HTML string (with inline styles) into a tree of DesignNode
 * objects. Elements with block children become "frame" nodes; leaf elements
 * with only text/inline content become "text" nodes. Inline SVG elements are
 * preserved as standalone "svg" nodes. Inline styles are
 * extracted into both typed DesignNode properties and the flexible `styles`
 * map.
 */
import { createNode } from "../../nodes/specs";
import type { DesignNode } from "../../types";
import { isFlowLayoutDisplay } from "../layout-display";
import { extractStyles, splitStyles, truncateName } from "./html-styles";
import { createHtmlParseContext, type HtmlParseContext } from "./html-parse-context";
import {
  assertAuthoredNodeIdsPreserved,
  assertUniqueParsedNodeIds,
  collectAuthoredNodeIds,
  getAuthoredNodeId,
} from "./html-identity";
import {
  applyFlowChildAutoSizing,
  createMeasurementRoot,
  flattenFixedAndStickyPositions,
  getLayoutRect,
  getMeasuredDimension,
  reconcileNodePosition,
  type HtmlParseOptions,
} from "./html-measurement";
import { createSvgNode } from "./html-svg";

export { camelCase, splitStyles, truncateName } from "./html-styles";
export type { HtmlParseOptions } from "./html-measurement";

// Inline elements that should be treated as part of a text node
const INLINE_TAGS = new Set([
  "SPAN",
  "STRONG",
  "B",
  "EM",
  "I",
  "A",
  "U",
  "S",
  "SMALL",
  "SUB",
  "SUP",
  "MARK",
  "CODE",
  "ABBR",
  "CITE",
  "Q",
  "BR",
]);

/**
 * Anchor `replace`-mode roots to the node they replace.
 *
 * Roots that authored their own out-of-flow position (absolute/fixed) keep the
 * x/y reconciled from import. Everything else is moved to the replaced node's
 * slot, so un-positioned replacement content lands where the old node sat
 * instead of at the parent's origin.
 */
export function anchorReplacementsToTarget<
  T extends { x: number; y: number; styles: Record<string, unknown> },
>(roots: T[], target: { x: number; y: number }): void {
  for (const root of roots) {
    const position = root.styles.position;
    if (position === "absolute" || position === "fixed") continue;
    root.x = target.x;
    root.y = target.y;
  }
}

/**
 * Parse an HTML string into an array of DesignNode trees.
 * Uses a hidden DOM container to compute layout dimensions.
 */
export function parseHtmlToNodes(html: string, options: HtmlParseOptions = {}): DesignNode[] {
  // Parse the HTML string
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div>${html}</div>`, "text/html");
  const wrapper = doc.body.firstElementChild as HTMLElement;
  if (!wrapper || wrapper.children.length === 0) {
    return [];
  }

  const { measurer, roots, rootParent } = createMeasurementRoot(html, options);
  const parseContext = createHtmlParseContext();
  const authoredNodeIds = collectAuthoredNodeIds(roots, parseContext);
  document.body.appendChild(measurer);

  try {
    if (options.flattenFixedAndSticky) {
      flattenFixedAndStickyPositions(roots, parseContext);
    }

    const nodes: DesignNode[] = [];
    const contextStyles = options.contextElement
      ? extractStyles(options.contextElement)
      : undefined;
    for (const el of roots) {
      const node = walkElement(el, contextStyles, parseContext);
      if (node) {
        reconcileNodePosition(node, el, rootParent, contextStyles?.display);
        nodes.push(node);
      }
    }
    const parsedNodeIds = assertUniqueParsedNodeIds(nodes);
    assertAuthoredNodeIdsPreserved(authoredNodeIds, parsedNodeIds);
    return nodes;
  } finally {
    document.body.removeChild(measurer);
  }
}

/**
 * Recursively convert a DOM element into a DesignNode.
 */
function walkElement(
  el: HTMLElement,
  parentStyles?: Record<string, string>,
  context?: HtmlParseContext,
): DesignNode | null {
  // Skip script/style tags. Standalone <br> elements are line breaks, not nodes.
  if (el.tagName === "SCRIPT" || el.tagName === "STYLE" || el.tagName === "BR") return null;

  if (el.tagName === "IMG") {
    return createImageFromElement(el, parentStyles, context);
  }

  // SVG elements are preserved as single SVG nodes (not decomposed into children)
  if (el instanceof SVGElement || el.tagName.toLowerCase() === "svg") {
    return createSvgNode(el, context);
  }

  // Determine if this element should be a frame (container) or text (leaf)
  const hasBlockChildren = hasBlockLevelChild(el);
  const display = el.style.display;
  const isFlowLayout = isFlowLayoutDisplay(display);
  const hasMultipleChildren =
    Array.from(el.children).filter((child) => child.tagName !== "BR").length > 1;
  const hasStyledChildren = hasStyledInlineChildren(el);
  const hasIdentityBearingDescendant = context?.identityBearingAncestors.has(el) ?? false;

  if (
    hasBlockChildren ||
    isFlowLayout ||
    hasMultipleChildren ||
    hasStyledChildren ||
    hasIdentityBearingDescendant
  ) {
    return createFrameFromElement(el, parentStyles, context);
  }

  // An element with no children and no text is a decorative shape — a swatch, a
  // divider, a dot. Falling through to the text branch would give it a text
  // node's identity: a Type icon in the layer tree and a typography section in
  // the inspector, over something that can never hold text.
  if (el.textContent?.trim() === "" && el.children.length === 0) {
    return createRectangleFromElement(el, parentStyles, context);
  }

  return createTextFromElement(el, parentStyles, context);
}

/**
 * Check if an element has any block-level (non-inline) child elements.
 */
function hasBlockLevelChild(el: HTMLElement): boolean {
  for (let i = 0; i < el.children.length; i++) {
    const child = el.children[i] as HTMLElement;
    if (!INLINE_TAGS.has(child.tagName)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if an element has inline children with their own inline styles.
 * Such children are individually styled and deserve their own nodes in the tree.
 * Exported for import inspection: this is the exact predicate that makes a
 * mixed-style paragraph fragment into separate block-level text nodes.
 */
export function hasStyledInlineChildren(el: HTMLElement): boolean {
  for (let i = 0; i < el.children.length; i++) {
    const child = el.children[i] as HTMLElement;
    if (INLINE_TAGS.has(child.tagName) && child.style && child.style.length > 0) {
      return true;
    }
  }
  return false;
}

function getElementDimension(
  el: HTMLElement,
  styles: Record<string, string>,
  key: "width" | "height",
) {
  const rect = getLayoutRect(el);
  const measured = key === "width" ? rect.width : rect.height;
  if (measured > 0) return getMeasuredDimension(measured, measured);

  const styleValue = Number.parseFloat(styles[key] ?? "");
  if (Number.isFinite(styleValue) && styleValue > 0) return styleValue;

  const attrValue = Number.parseFloat(el.getAttribute(key) ?? "");
  if (Number.isFinite(attrValue) && attrValue > 0) return attrValue;

  return key === "width" ? 300 : 200;
}

function createImageFromElement(
  el: HTMLElement,
  parentStyles?: Record<string, string>,
  context?: HtmlParseContext,
): DesignNode {
  const styles = extractStyles(el, context);
  const { typed, cssMap } = splitStyles(styles);
  const src = el.getAttribute("src") || "";
  const alt = el.getAttribute("alt")?.trim();
  const title = el.getAttribute("title")?.trim();
  const name = el.getAttribute("layer-name") || alt || title || "Image";
  const authoredId = getAuthoredNodeId(el);

  const node = createNode("image", {
    ...(authoredId ? { id: authoredId } : {}),
    name,
    width: getElementDimension(el, styles, "width"),
    height: getElementDimension(el, styles, "height"),
    backgroundColor: typed.backgroundColor || "transparent",
    borderRadius: typed.borderRadius || 0,
    borderColor: typed.borderColor || "transparent",
    borderWidth: typed.borderWidth || 0,
    content: src,
    imageAsset: null,
    styles: cssMap,
  });

  applyFlowChildAutoSizing(node, parentStyles);
  return node;
}

/**
 * Create a "frame" DesignNode from a DOM element that contains block children.
 */
function createFrameFromElement(
  el: HTMLElement,
  parentStyles?: Record<string, string>,
  context?: HtmlParseContext,
): DesignNode {
  const styles = extractStyles(el, context);
  // Childless frames get the same flex-column default as populated ones, so a
  // container created empty and filled by later insert-children calls lays out
  // like an artboard instead of silently having no display mode.
  if (!styles.display) {
    styles.display = "flex";
    styles.flexDirection = "column";
  }
  const rect = getLayoutRect(el);
  const name = el.getAttribute("layer-name") || "Frame";
  const authoredId = getAuthoredNodeId(el);

  const children: DesignNode[] = [];

  // Process child nodes
  for (let i = 0; i < el.childNodes.length; i++) {
    const child = el.childNodes[i];

    if (child.nodeType === Node.ELEMENT_NODE) {
      const childEl = child as HTMLElement;
      const childNode = walkElement(childEl, styles, context);
      if (childNode) {
        reconcileNodePosition(childNode, childEl, el, styles.display);
        children.push(childNode);
      }
    } else if (child.nodeType === Node.TEXT_NODE) {
      const text = (child.textContent || "").trim();
      if (text) {
        // Bare text inside a frame becomes a text node. It has no element of
        // its own to read styles from, so hand it the typography it inherits —
        // text nodes always render explicit font/colour, so leaving these unset
        // paints the node defaults (16px, normal, black) over what the parent
        // declared. See resolveInheritedTextStyles.
        const textNode = makeTextNode(text, {}, resolveInheritedTextStyles(el));
        applyFlowChildAutoSizing(textNode, styles);
        children.push(textNode);
      }
    }
  }

  const { typed, cssMap } = splitStyles(styles);

  const node: DesignNode = createNode("frame", {
    ...(authoredId ? { id: authoredId } : {}),
    name,
    width: getMeasuredDimension(rect.width, 300),
    height: getMeasuredDimension(rect.height, 200),
    children,
    backgroundColor: typed.backgroundColor || "transparent",
    borderRadius: typed.borderRadius || 0,
    borderColor: typed.borderColor || "transparent",
    borderWidth: typed.borderWidth || 0,
    content: "",
    fontSize: typed.fontSize || 16,
    fontFamily: typed.fontFamily || "Inter, system-ui, sans-serif",
    color: typed.color || "#000000",
    fontWeight: typed.fontWeight || "normal",
    styles: cssMap,
  });

  applyFlowChildAutoSizing(node, parentStyles);
  return node;
}

/**
 * Typography a synthesized text node has to carry explicitly.
 *
 * The text renderer always emits these four properties, so a text node that
 * leaves them unset does not inherit from its parent — it paints the node
 * defaults instead. Every other inherited property (letter-spacing,
 * line-height, text-align, font-style…) is only emitted when present, so those
 * still cascade through the DOM and must NOT be copied here.
 */
const INHERITED_TEXT_STYLE_KEYS = ["color", "fontSize", "fontFamily", "fontWeight"] as const;

/**
 * Resolve the typography a bare text child inherits from its authored
 * ancestors.
 *
 * Walks up from the element holding the text, taking the nearest declared value
 * for each property. The write target's own element is part of the chain — it
 * is the measurement clone's root — so text dropped into a styled frame picks
 * up that frame's font. Nothing is invented: a property no ancestor declares is
 * left undefined and the text node keeps its default.
 */
function resolveInheritedTextStyles(el: HTMLElement): {
  color?: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: string;
} {
  const declared: Record<string, string> = {};
  let current: HTMLElement | null = el;
  while (current && current !== document.body) {
    const styles = extractStyles(current);
    for (const key of INHERITED_TEXT_STYLE_KEYS) {
      if (declared[key] === undefined && styles[key] !== undefined) {
        declared[key] = styles[key]!;
      }
    }
    current = current.parentElement;
  }
  const { typed } = splitStyles(declared);
  return {
    color: typed.color,
    fontSize: typed.fontSize,
    fontFamily: typed.fontFamily,
    fontWeight: typed.fontWeight,
  };
}

/** A plain pixel length from an authored style value, if it is one. */
function parsePixelStyle(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^(-?\d*\.?\d+)px$/.exec(value.trim());
  if (!match) return null;
  const parsed = Number.parseFloat(match[1]!);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Create a "rectangle" DesignNode from an element that holds neither children
 * nor text — a swatch, rule, dot, or spacer. The alternative is a text node
 * that can never contain text.
 */
function createRectangleFromElement(
  el: HTMLElement,
  parentStyles?: Record<string, string>,
  context?: HtmlParseContext,
): DesignNode {
  const styles = extractStyles(el, context);
  const rect = getLayoutRect(el);
  const authoredId = getAuthoredNodeId(el);
  const { typed, cssMap } = splitStyles(styles);

  // Prefer the measured box, but fall back to an authored pixel size before a
  // magic default — a decorative shape almost always states its own size, and
  // the measured box is zero whenever layout has not run.
  const authoredWidth = parsePixelStyle(styles.width);
  const authoredHeight = parsePixelStyle(styles.height);

  const node = createNode("rectangle", {
    ...(authoredId ? { id: authoredId } : {}),
    name: el.getAttribute("layer-name") || "Rectangle",
    width: getMeasuredDimension(rect.width, authoredWidth ?? 100),
    height: getMeasuredDimension(rect.height, authoredHeight ?? 100),
    children: [],
    backgroundColor: typed.backgroundColor || "transparent",
    borderRadius: typed.borderRadius || 0,
    borderColor: typed.borderColor || "transparent",
    borderWidth: typed.borderWidth || 0,
    content: "",
    styles: cssMap,
  });

  applyFlowChildAutoSizing(node, parentStyles);
  return node;
}

/**
 * Extract an element's text while treating each <br> as an exact segment
 * boundary. Trimming the text within each segment removes source indentation
 * without trimming leading, trailing, or consecutive authored line breaks.
 */
function extractTextWithLineBreaks(el: HTMLElement): string {
  const segments = [""];

  const collectSegments = (parent: Node): void => {
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        segments[segments.length - 1] += child.textContent ?? "";
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const childEl = child as HTMLElement;
        if (childEl.tagName === "BR") {
          segments.push("");
        } else {
          collectSegments(childEl);
        }
      }
    }
  };

  collectSegments(el);
  return segments.map((segment) => segment.trim()).join("\n");
}

/**
 * Create a "text" DesignNode from a DOM element with only text/inline content.
 */
function createTextFromElement(
  el: HTMLElement,
  parentStyles?: Record<string, string>,
  context?: HtmlParseContext,
): DesignNode {
  const styles = extractStyles(el, context);
  const rect = getLayoutRect(el);
  const textContent = extractTextWithLineBreaks(el);
  const name = el.getAttribute("layer-name") || truncateName(textContent) || "Text";
  const authoredId = getAuthoredNodeId(el);

  const { typed, cssMap } = splitStyles(styles);

  const node = makeTextNode(textContent, cssMap, {
    ...(authoredId ? { id: authoredId } : {}),
    name,
    width: rect.width > 0 ? getMeasuredDimension(rect.width, 0) : undefined,
    height: rect.height > 0 ? getMeasuredDimension(rect.height, 0) : undefined,
    backgroundColor: typed.backgroundColor,
    borderRadius: typed.borderRadius,
    borderColor: typed.borderColor,
    borderWidth: typed.borderWidth,
    color: typed.color,
    fontSize: typed.fontSize,
    fontFamily: typed.fontFamily,
    fontWeight: typed.fontWeight,
  });

  applyFlowChildAutoSizing(node, parentStyles);
  return node;
}

/**
 * Helper to create a text DesignNode.
 */
function makeTextNode(
  content: string,
  cssMap: Record<string, string | number>,
  overrides: {
    id?: string;
    name?: string;
    width?: number;
    height?: number;
    backgroundColor?: string;
    borderRadius?: number;
    borderColor?: string;
    borderWidth?: number;
    color?: string;
    fontSize?: number;
    fontFamily?: string;
    fontWeight?: string;
  } = {},
): DesignNode {
  return createNode("text", {
    ...(overrides.id ? { id: overrides.id } : {}),
    name: overrides.name || truncateName(content) || "Text",
    width: overrides.width || 200,
    height: overrides.height || 40,
    backgroundColor: overrides.backgroundColor ?? "transparent",
    borderRadius: overrides.borderRadius ?? 0,
    borderColor: overrides.borderColor ?? "transparent",
    borderWidth: overrides.borderWidth ?? 0,
    content,
    fontSize: overrides.fontSize || 16,
    fontFamily: overrides.fontFamily || "Inter, system-ui, sans-serif",
    color: overrides.color || "#000000",
    fontWeight: overrides.fontWeight || "normal",
    styles: cssMap,
  });
}
