import type { DesignNode } from "../../types";
import { measureWithVisibleLayout } from "../forced-layout";
import { isFlowLayoutDisplay } from "../layout-display";
import type { HtmlParseContext } from "./html-parse-context";
import { POSITION_OFFSET_KEYS } from "./html-styles";

export interface HtmlParseOptions {
  /**
   * Measure imported HTML inside a clone of its real target so percentages and
   * flex sizing resolve against the same containing block.
   */
  contextElement?: HTMLElement | null;
  /**
   * Convert viewport- and scroll-relative elements into normal relative flow.
   */
  flattenFixedAndSticky?: boolean;
}

export function createMeasurementRoot(
  html: string,
  options: HtmlParseOptions,
): {
  measurer: HTMLDivElement;
  roots: HTMLElement[];
  rootParent: HTMLElement;
} {
  const measurer = document.createElement("div");
  measurer.style.cssText =
    "position:absolute;left:-99999px;top:-99999px;visibility:hidden;pointer-events:none;";

  if (!options.contextElement) {
    measurer.innerHTML = html;
    return {
      measurer,
      roots: Array.from(measurer.children) as HTMLElement[],
      rootParent: measurer,
    };
  }

  const contextElement = options.contextElement;
  const contextClone = contextElement.cloneNode(false) as HTMLElement;
  // Elements retained inside `content-visibility: auto` subtrees report
  // collapsed geometry until layout is forced; detached stand-ins have no
  // geometry at all, so skip the measuring window for them.
  const [liveWidth, liveHeight] = contextElement.isConnected
    ? measureWithVisibleLayout(contextElement, () => [
        contextElement.offsetWidth,
        contextElement.offsetHeight,
      ])
    : [0, 0];
  if (liveWidth > 0) contextClone.style.width = `${liveWidth}px`;

  if (hasContentDrivenHeight(contextElement)) {
    contextClone.style.height = "auto";
    contextClone.style.minHeight = "0px";
  } else if (liveHeight > 0) {
    contextClone.style.height = `${liveHeight}px`;
  } else if (!isPixelLength(contextClone.style.height)) {
    // No live geometry and no authored pixel height to trust: let content
    // drive the clone instead of resolving percentages against nothing.
    contextClone.style.height = "auto";
    contextClone.style.minHeight = "0px";
  }
  if (contextClone.style.position === "absolute") contextClone.style.position = "relative";
  contextClone.style.left = "0px";
  contextClone.style.top = "0px";
  contextClone.style.transform = "none";
  contextClone.innerHTML = html;
  measurer.appendChild(contextClone);

  return {
    measurer,
    roots: Array.from(contextClone.children) as HTMLElement[],
    rootParent: contextClone,
  };
}

export function getMeasuredDimension(value: number, fallback: number): number {
  return value > 0 ? Number(value.toFixed(3)) : fallback;
}

/**
 * CSS properties whose numeric values are valid without a unit. Every other
 * numeric model value gets `px` appended, matching how React CSSProperties
 * serializes the same `node.styles` entries on the live renderer path —
 * assigning the bare string (e.g. `padding: "24"`) is invalid CSS that CSSOM
 * silently drops.
 */
const UNITLESS_STYLE_KEYS = new Set([
  "animationIterationCount",
  "aspectRatio",
  "columnCount",
  "flex",
  "flexGrow",
  "flexShrink",
  "fontWeight",
  "gridColumn",
  "gridColumnEnd",
  "gridColumnStart",
  "gridRow",
  "gridRowEnd",
  "gridRowStart",
  "lineHeight",
  "opacity",
  "order",
  "orphans",
  "scale",
  "tabSize",
  "widows",
  "zIndex",
  "zoom",
]);

function toCssValue(key: string, value: string | number): string {
  if (typeof value === "number" && value !== 0 && !UNITLESS_STYLE_KEYS.has(key)) {
    return `${value}px`;
  }
  return String(value);
}

function isPixelLength(value: string): boolean {
  return /^\d*\.?\d+px$/.test(value.trim());
}

/**
 * Build a detached stand-in for a write target that has no live DOM element —
 * a node on an inactive page or inside a culled offscreen subtree. Without a
 * context element, imported roots lose flow auto-sizing (their measured pixel
 * size freezes even though the author never declared one) and percentage
 * widths resolve against nothing. The stand-in carries the node's authored
 * styles plus concrete pixel dimensions so both keep working; `fallbackWidth`
 * (typically the nearest ancestor's measured width) covers targets whose own
 * model width is missing or unmeasured.
 */
export function createModelContextElement(node: DesignNode, fallbackWidth?: number): HTMLElement {
  const element = document.createElement("div");
  for (const [key, value] of Object.entries(node.styles)) {
    if (key.startsWith("--")) {
      element.style.setProperty(key, String(value));
    } else {
      (element.style as unknown as Record<string, string>)[key] = toCssValue(key, value);
    }
  }
  const modelWidth = typeof node.width === "number" && node.width > 0 ? node.width : fallbackWidth;
  if (!isPixelLength(element.style.width) && typeof modelWidth === "number" && modelWidth > 0) {
    element.style.width = `${modelWidth}px`;
  }
  // Mirror the live renderer, which pins the typed pixel height inline unless
  // the author declared a content-driven height.
  const authoredHeight = element.style.height.trim().toLowerCase();
  const isContentDrivenHeight = authoredHeight === "auto" || authoredHeight === "fit-content";
  if (
    !isPixelLength(authoredHeight) &&
    !isContentDrivenHeight &&
    typeof node.height === "number" &&
    node.height > 0
  ) {
    element.style.height = `${node.height}px`;
  }
  return element;
}

function hasContentDrivenHeight(element: HTMLElement): boolean {
  const declared = element.style.height.trim().toLowerCase();
  return declared === "" || declared === "auto" || declared === "fit-content";
}

export function applyFlowChildAutoSizing(
  node: DesignNode,
  parentStyles?: Record<string, string>,
): void {
  if (!isFlowLayoutDisplay(parentStyles?.display)) return;
  // Out-of-flow children ignore the parent's flow sizing, and import bakes
  // their inset-derived geometry into x/y plus the measured pixel size. A
  // styles.width/height of "auto" would override that measured size in the
  // renderer and shrink-wrap an inset-stretched overlay to its content.
  if (node.styles.position === "absolute" || node.styles.position === "fixed") return;
  if (node.styles.width === undefined) node.styles.width = "auto";
  if (node.styles.height === undefined) node.styles.height = "auto";
}

export function collectElementAndAncestors(element: HTMLElement): HTMLElement[] {
  const elements: HTMLElement[] = [];
  let current: HTMLElement | null = element;
  while (current && current !== document.body) {
    elements.push(current);
    current = current.parentElement;
  }
  return elements;
}

export function withTransformsDisabled<T>(elements: HTMLElement[], measure: () => T): T {
  const seen = new Set<HTMLElement>();
  const originals: Array<{
    el: HTMLElement;
    value: string;
    priority: string;
    hadInlineValue: boolean;
  }> = [];

  for (const element of elements) {
    if (seen.has(element)) continue;
    seen.add(element);

    const computedTransform = getComputedStyle(element).transform;
    const value = element.style.getPropertyValue("transform");
    if (!value && (!computedTransform || computedTransform === "none")) continue;

    originals.push({
      el: element,
      value,
      priority: element.style.getPropertyPriority("transform"),
      hadInlineValue: value !== "",
    });
    element.style.setProperty("transform", "none", "important");
  }

  try {
    return measure();
  } finally {
    for (const original of originals.reverse()) {
      if (original.hadInlineValue) {
        original.el.style.setProperty("transform", original.value, original.priority);
      } else {
        original.el.style.removeProperty("transform");
      }
    }
  }
}

export function getLayoutRect(element: HTMLElement): DOMRect {
  return withTransformsDisabled(collectElementAndAncestors(element), () =>
    element.getBoundingClientRect(),
  );
}

function isFixedOrStickyPosition(position: string): boolean {
  const normalized = position.trim().toLowerCase();
  return normalized === "fixed" || normalized === "sticky" || normalized === "-webkit-sticky";
}

export function flattenFixedAndStickyPositions(
  roots: HTMLElement[],
  context: HtmlParseContext,
): void {
  const elements: Element[] = [];
  for (const root of roots) {
    elements.push(root, ...Array.from(root.querySelectorAll("*")));
  }

  for (const element of elements) {
    const style = (element as Element & { style?: CSSStyleDeclaration }).style;
    if (!style) continue;

    const authoredPosition = style.getPropertyValue("position");
    const computedPosition = getComputedStyle(element).position;
    if (!isFixedOrStickyPosition(authoredPosition) && !isFixedOrStickyPosition(computedPosition)) {
      continue;
    }

    context.flattenedPositionElements.add(element);
    style.setProperty("position", "relative", "important");
    for (const key of POSITION_OFFSET_KEYS) {
      style.removeProperty(key);
      style.setProperty(key, "auto", "important");
    }
  }
}

export function reconcileNodePosition(
  node: DesignNode,
  element: HTMLElement,
  parentElement: HTMLElement,
  parentDisplay: string | undefined,
): void {
  const position = getComputedStyle(element).position;
  const isOutOfFlow = position === "absolute" || position === "fixed";
  if (isFlowLayoutDisplay(parentDisplay) && !isOutOfFlow) return;

  const [elementRect, parentRect] = withTransformsDisabled(
    [...collectElementAndAncestors(element), ...collectElementAndAncestors(parentElement)],
    () => [element.getBoundingClientRect(), parentElement.getBoundingClientRect()],
  );

  if (position === "fixed") {
    node.x = Number(elementRect.left.toFixed(3));
    node.y = Number(elementRect.top.toFixed(3));
  } else {
    const parentStyle = getComputedStyle(parentElement);
    const borderLeft = Number.parseFloat(parentStyle.borderLeftWidth) || 0;
    const borderTop = Number.parseFloat(parentStyle.borderTopWidth) || 0;
    node.x = Number((elementRect.left - parentRect.left - borderLeft).toFixed(3));
    node.y = Number((elementRect.top - parentRect.top - borderTop).toFixed(3));
  }

  for (const key of POSITION_OFFSET_KEYS) delete node.styles[key];
}
