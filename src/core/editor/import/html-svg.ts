import { createNode } from "../../nodes/specs";
import type { DesignNode, Rect } from "../../types";
import {
  canDecomposeSvgChildren,
  extractSvgPaintStyles,
  isSvgVisualElement,
  svgElementNodeName,
} from "../svg-decomposition";
import { getAuthoredNodeId } from "./html-identity";
import { collectElementAndAncestors, withTransformsDisabled } from "./html-measurement";
import type { HtmlParseContext } from "./html-parse-context";
import { POSITION_OFFSET_KEYS } from "./html-styles";

const SVG_FALLBACK_WIDTH = 400;
const SVG_FALLBACK_HEIGHT = 300;

function measureSvgSubtree(element: Element): Map<Element, DOMRect> {
  const rects = new Map<Element, DOMRect>();
  try {
    withTransformsDisabled(collectElementAndAncestors(element as HTMLElement), () => {
      rects.set(element, element.getBoundingClientRect());
      for (const descendant of Array.from(element.querySelectorAll("*"))) {
        rects.set(descendant, descendant.getBoundingClientRect());
      }
    });
  } catch {
    // No layout is available; callers fall back to authored user-space geometry.
  }
  return rects;
}

interface SvgUserSpace {
  minX: number;
  minY: number;
  scaleX: number;
  scaleY: number;
}

function readUserUnit(element: Element, name: string): number {
  const parsed = Number.parseFloat(element.getAttribute(name) ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function resolveSvgUserSpace(element: Element, width: number, height: number): SvgUserSpace {
  const parts = (element.getAttribute("viewBox") ?? "")
    .split(/[\s,]+/)
    .map((part) => Number.parseFloat(part))
    .filter((part) => Number.isFinite(part));
  if (parts.length !== 4 || parts[2]! <= 0 || parts[3]! <= 0) {
    return { minX: 0, minY: 0, scaleX: 1, scaleY: 1 };
  }
  return {
    minX: parts[0]!,
    minY: parts[1]!,
    scaleX: width / parts[2]!,
    scaleY: height / parts[3]!,
  };
}

function estimateSvgUserBox(element: Element): Rect | null {
  const points = () =>
    (element.getAttribute("points") ?? "")
      .split(/[\s,]+/)
      .map((part) => Number.parseFloat(part))
      .filter((part) => Number.isFinite(part));

  switch (element.localName.toLowerCase()) {
    case "rect":
    case "image":
      return {
        x: readUserUnit(element, "x"),
        y: readUserUnit(element, "y"),
        width: readUserUnit(element, "width"),
        height: readUserUnit(element, "height"),
      };
    case "circle": {
      const radius = readUserUnit(element, "r");
      return {
        x: readUserUnit(element, "cx") - radius,
        y: readUserUnit(element, "cy") - radius,
        width: radius * 2,
        height: radius * 2,
      };
    }
    case "ellipse": {
      const radiusX = readUserUnit(element, "rx");
      const radiusY = readUserUnit(element, "ry");
      return {
        x: readUserUnit(element, "cx") - radiusX,
        y: readUserUnit(element, "cy") - radiusY,
        width: radiusX * 2,
        height: radiusY * 2,
      };
    }
    case "line": {
      const x1 = readUserUnit(element, "x1");
      const x2 = readUserUnit(element, "x2");
      const y1 = readUserUnit(element, "y1");
      const y2 = readUserUnit(element, "y2");
      return {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1),
      };
    }
    case "polyline":
    case "polygon": {
      const coordinates = points();
      if (coordinates.length < 2) return null;
      const xs: number[] = [];
      const ys: number[] = [];
      for (let index = 0; index + 1 < coordinates.length; index += 2) {
        xs.push(coordinates[index]!);
        ys.push(coordinates[index + 1]!);
      }
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      return {
        x: minX,
        y: minY,
        width: Math.max(...xs) - minX,
        height: Math.max(...ys) - minY,
      };
    }
    default:
      return null;
  }
}

interface SvgDecompositionContext {
  rects: Map<Element, DOMRect>;
  rootRect: DOMRect | undefined;
  userSpace: SvgUserSpace;
  rootWidth: number;
  rootHeight: number;
}

function measureSvgElementBox(element: Element, context: SvgDecompositionContext): Rect {
  const rect = context.rects.get(element);
  if (context.rootRect && rect && (rect.width > 0 || rect.height > 0)) {
    return {
      x: Number((rect.left - context.rootRect.left).toFixed(3)),
      y: Number((rect.top - context.rootRect.top).toFixed(3)),
      width: Number(rect.width.toFixed(3)),
      height: Number(rect.height.toFixed(3)),
    };
  }

  const userBox = estimateSvgUserBox(element);
  if (userBox && userBox.width > 0 && userBox.height > 0) {
    const { minX, minY, scaleX, scaleY } = context.userSpace;
    return {
      x: Number(((userBox.x - minX) * scaleX).toFixed(3)),
      y: Number(((userBox.y - minY) * scaleY).toFixed(3)),
      width: Number((userBox.width * scaleX).toFixed(3)),
      height: Number((userBox.height * scaleY).toFixed(3)),
    };
  }

  return { x: 0, y: 0, width: context.rootWidth, height: context.rootHeight };
}

function detachSvgVisualChildren(
  liveElement: Element,
  cloneElement: Element,
  context: SvgDecompositionContext,
): DesignNode[] {
  if (!canDecomposeSvgChildren(liveElement)) return [];

  const liveChildren = Array.from(liveElement.children);
  const cloneChildren = Array.from(cloneElement.children);
  const nodes: DesignNode[] = [];

  for (let index = 0; index < liveChildren.length; index += 1) {
    const live = liveChildren[index]!;
    const clone = cloneChildren[index];
    if (!clone || !isSvgVisualElement(live)) continue;
    nodes.push(createSvgElementNode(live, clone, context));
    clone.remove();
  }

  return nodes;
}

function createSvgElementNode(
  live: Element,
  clone: Element,
  context: SvgDecompositionContext,
): DesignNode {
  const children = detachSvgVisualChildren(live, clone, context);
  const styles = extractSvgPaintStyles(clone);
  const box = measureSvgElementBox(live, context);

  return createNode("svg", {
    name: svgElementNodeName(live),
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    children,
    content: clone.outerHTML,
    styles,
  });
}

export function createSvgNode(element: Element, context?: HtmlParseContext): DesignNode {
  const authoredId = getAuthoredNodeId(element);

  const rects = measureSvgSubtree(element);
  const rootRect = rects.get(element);
  const authoredWidth = parseInt(element.getAttribute("width") || "0", 10);
  const authoredHeight = parseInt(element.getAttribute("height") || "0", 10);
  const width =
    rootRect && rootRect.width > 0
      ? Math.round(rootRect.width)
      : authoredWidth > 0
        ? authoredWidth
        : SVG_FALLBACK_WIDTH;
  const height =
    rootRect && rootRect.height > 0
      ? Math.round(rootRect.height)
      : authoredHeight > 0
        ? authoredHeight
        : SVG_FALLBACK_HEIGHT;

  const clone = element.cloneNode(true) as Element & { style?: CSSStyleDeclaration };
  if (context?.flattenedPositionElements.has(element)) {
    clone.style?.setProperty("position", "relative");
    for (const key of POSITION_OFFSET_KEYS) clone.style?.removeProperty(key);
  }

  const children = detachSvgVisualChildren(element, clone, {
    rects,
    rootRect,
    userSpace: resolveSvgUserSpace(element, width, height),
    rootWidth: width,
    rootHeight: height,
  });

  return createNode("svg", {
    ...(authoredId ? { id: authoredId } : {}),
    name: element.getAttribute("layer-name") || "SVG",
    width,
    height,
    children,
    content: clone.outerHTML,
  });
}
