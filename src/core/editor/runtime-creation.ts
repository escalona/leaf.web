import { createNode } from "../nodes/specs";
import type { DesignNode, ImageAssetRef, NodeType, Point } from "../types";
import { isFlowLayoutDisplay } from "./layout-display";
import type { RuntimeOperationContext } from "./runtime-operation-context";

export interface RootCreationOptions {
  pageId?: string;
}

export interface ArtboardCreationOptions extends RootCreationOptions {
  position?: Point;
  /** Prefer collision-free placement beside this root, as duplicates do. */
  preferredNear?: DesignNode;
}

export interface ImageCreationOptions extends RootCreationOptions {
  layout?: "absolute" | "flow";
}

export function addNode(
  context: RuntimeOperationContext,
  type: NodeType,
  position: Point,
  options: RootCreationOptions = {},
): DesignNode {
  return context.applyMutation({ type: "create-root" }, () => {
    const node = createNode(type, { x: position.x, y: position.y });
    return context.insertRootNode(node, options.pageId);
  });
}

export function createScriptNode(
  context: RuntimeOperationContext,
  type: NodeType,
  overrides: Partial<Omit<DesignNode, "children" | "type">> = {},
  parentId?: string,
  options: RootCreationOptions = {},
): DesignNode {
  return context.applyMutation({ type: "create-node" }, () => {
    if (overrides.id && context.store.getNode(overrides.id)) {
      throw new Error(`Node already exists: ${overrides.id}`);
    }
    const node = createNode(type, {
      ...overrides,
      styles: overrides.styles ? { ...overrides.styles } : {},
    });
    if (parentId) {
      const parent = context.requireNode(parentId);
      context.assertParentPageTarget(parentId, options.pageId);
      parent.children.push(node);
      context.store.registerNodeTree(node, parentId);
      return node;
    }
    return context.insertRootNode(node, options.pageId);
  });
}

export function createArtboard(
  context: RuntimeOperationContext,
  name: string,
  styles: Record<string, string | number>,
  options: ArtboardCreationOptions = {},
): DesignNode {
  return context.applyMutation({ type: "create-root" }, () => {
    if (!styles || typeof styles !== "object" || Array.isArray(styles)) {
      throw new Error("Artboard styles must be an object");
    }
    const width = resolveArtboardDimension("width", styles.width, 1440);
    const usesAutoHeight =
      typeof styles.height === "string" && styles.height.trim().toLowerCase() === "auto";
    const height = usesAutoHeight ? 900 : resolveArtboardDimension("height", styles.height, 900);
    const position = options.position
      ? requireFinitePoint(options.position, "Artboard position")
      : context.getAutomaticRootPosition({ width, height }, options.pageId, options.preferredNear);

    const nodeStyles: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(styles)) {
      if (key === "width" || key === "height" || key === "x" || key === "y") continue;
      nodeStyles[key] = value;
    }
    if (usesAutoHeight) {
      nodeStyles.height = "auto";
    }
    nodeStyles.display ??= "flex";
    nodeStyles.flexDirection ??= "column";

    const node = createNode("frame", {
      x: position.x,
      y: position.y,
      width,
      height,
      name,
      isArtboard: true,
      backgroundColor: (nodeStyles.backgroundColor as string) || "#ffffff",
      styles: nodeStyles,
    });

    return context.insertRootNode(node, options.pageId);
  });
}

export function createSvg(
  context: RuntimeOperationContext,
  content: string,
  size: { width: number; height: number },
  position: Point,
  name = "Ink Stroke",
  parentId?: string,
  options: RootCreationOptions = {},
): DesignNode {
  return context.applyMutation({ type: "create-node" }, () => {
    requireFinitePoint(position, "SVG position");
    let x = position.x;
    let y = position.y;

    if (parentId) {
      context.assertParentPageTarget(parentId, options.pageId);
      const parentCanvasPosition = context.store.getCanvasPosition(parentId);
      if (parentCanvasPosition) {
        x -= parentCanvasPosition.x;
        y -= parentCanvasPosition.y;
      }
    }

    const node = createNode("svg", {
      x,
      y,
      width: size.width,
      height: size.height,
      name,
      content,
      styles: parentId ? { position: "absolute" } : {},
    });

    if (parentId) {
      const parent = context.requireNode(parentId);
      parent.children.push(node);
      context.store.registerNodeTree(node, parentId);
      return node;
    }

    return context.insertRootNode(node, options.pageId);
  });
}

export function createImage(
  context: RuntimeOperationContext,
  source: string | ImageAssetRef,
  size: { width: number; height: number },
  position?: Point,
  name = "Image",
  parentId?: string,
  options: ImageCreationOptions = {},
): DesignNode {
  return context.applyMutation({ type: "create-node" }, () => {
    if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) {
      throw new Error("Image dimensions must be finite numbers");
    }
    const width = Math.max(1, Math.round(size.width));
    const height = Math.max(1, Math.round(size.height));
    const layout = options.layout ?? "absolute";
    if (layout !== "absolute" && layout !== "flow") {
      throw new Error(`Unsupported image layout: ${String(layout)}`);
    }

    const slot =
      parentId || position
        ? null
        : context.getAutomaticRootPosition({ width, height }, options.pageId);
    let x = position?.x ?? slot?.x ?? 0;
    let y = position?.y ?? slot?.y ?? 0;
    if (position) requireFinitePoint(position, "Image position");

    if (parentId) {
      context.assertParentPageTarget(parentId, options.pageId);
      const parent = context.requireNode(parentId);
      if (layout === "flow") {
        if (position) throw new Error("Flow image layout does not accept a canvas position");
        if (!isFlowLayoutDisplay(parent.styles.display)) {
          throw new Error("Flow image layout requires a flex or grid parent");
        }
        x = 0;
        y = 0;
      }
      const parentCanvasPosition = context.store.getCanvasPosition(parentId);
      if (layout === "absolute") {
        if (position && parentCanvasPosition) {
          x -= parentCanvasPosition.x;
          y -= parentCanvasPosition.y;
        } else if (!position) {
          x = 0;
          y = 0;
        }
      }
    } else if (layout === "flow") {
      throw new Error("Flow image layout requires a parentId");
    }

    const node = createNode("image", {
      x,
      y,
      width,
      height,
      name,
      content: typeof source === "string" ? source : "",
      imageAsset: typeof source === "string" ? null : { ...source },
      styles:
        parentId && layout === "absolute"
          ? { position: "absolute" }
          : layout === "flow"
            ? { flexShrink: 0 }
            : {},
    });

    if (parentId) {
      const parent = context.requireNode(parentId);
      parent.children.push(node);
      context.store.registerNodeTree(node, parentId);
      return node;
    }

    return context.insertRootNode(node, options.pageId);
  });
}

const ARTBOARD_PIXEL_DIMENSION_PATTERN = /^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:px)?$/i;

function resolveArtboardDimension(
  field: "height" | "width",
  value: string | number | undefined,
  fallback: number,
) {
  if (value === undefined) return fallback;
  const parsed =
    typeof value === "number"
      ? value
      : ARTBOARD_PIXEL_DIMENSION_PATTERN.test(value.trim())
        ? Number.parseFloat(value)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Artboard ${field} must be a positive finite pixel dimension`);
  }
  return parsed;
}

function requireFinitePoint(point: Point, label: string): Point {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error(`${label} must contain finite canvas coordinates`);
  }
  return point;
}
