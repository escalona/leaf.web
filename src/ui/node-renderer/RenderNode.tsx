import { observer } from "mobx-react-lite";
import { memo } from "react";
import { useEditorStore } from "../../core/state/EditorStore";
import type { DesignNode } from "../../core/types";
import { isFlowLayoutDisplay } from "../../core/editor/layout-display";
import {
  getEffectiveModelDimension,
  hasUnsafeModelGeometry,
} from "../../core/editor/model-geometry";
import { nodeClipsChildrenPaint } from "../../core/editor/node-overflow";
import {
  applyTypedAppearanceStyles,
  buildBaseStyle,
  getMaterializedNodeProps,
} from "./node-renderer-style";
import { PathRenderer } from "./PathRenderer";
import { ShaderRenderer } from "./ShaderRenderer";
import {
  ImageNodeRenderer,
  InteractiveSurfaceNodeRenderer,
  SvgNodeRenderer,
} from "./MediaNodeRenderers";
import { TextNodeRenderer } from "./TextNodeRenderer";
import { GeneratedBackgroundPlaceholder, type RendererProps, useNodeRef } from "./renderer-helpers";
import { useResolvedNodeBackgroundImage } from "./node-background-image";

type NodeChildrenProps = {
  node: DesignNode;
  isFlowLayout: boolean;
  isInteractionSuppressed?: boolean;
  forceDetail?: boolean;
};

function getDescendantRenderMode(
  store: ReturnType<typeof useEditorStore>,
  child: DesignNode,
  isFlowChild: boolean,
) {
  if (store.isNodeInForcedRenderSubtree(child.id)) return "full";
  if (!store.shouldCullDescendants || isFlowChild) return "full";
  if (store.renderPinnedAncestorIds.has(child.id)) return "full";
  if (store.isDeferredDetailRoot(child.id) && child.type === "frame") return "shell";
  if (child.children.length > 0 && !nodeClipsChildrenPaint(child)) return "full";
  let currentId: string | undefined = child.id;
  while (currentId) {
    const current = store.getNode(currentId);
    if (store.isFlowChild(currentId) || (current && hasUnsafeModelGeometry(current))) {
      return "full";
    }
    currentId = store.parentMap.get(currentId);
  }
  const bounds = store.viewportCanvasBounds;
  if (!bounds) return "full";
  const position = store.getCanvasPosition(child.id);
  if (!position) return "full";
  const width = getEffectiveModelDimension(child.width, child.styles.width);
  const height = getEffectiveModelDimension(child.height, child.styles.height);
  const intersects =
    position.x + width >= bounds.left &&
    position.x <= bounds.right &&
    position.y + height >= bounds.top &&
    position.y <= bounds.bottom;
  if (intersects) {
    const detailBounds = store.viewportDetailBounds ?? bounds;
    const intersectsDetail =
      position.x + width >= detailBounds.left &&
      position.x <= detailBounds.right &&
      position.y + height >= detailBounds.top &&
      position.y <= detailBounds.bottom;
    if (!intersectsDetail && child.type === "frame" && child.children.length > 0) {
      return "shell";
    }
    return "full";
  }
  if (store.shouldKeepOffscreenFrameShells && child.type === "frame") {
    return "shell";
  }
  return "hidden";
}

const NodeChildren = memo(
  observer(
    ({ node, isFlowLayout, isInteractionSuppressed = false, forceDetail }: NodeChildrenProps) => {
      const store = useEditorStore();
      const visibleChildren =
        store.dragDetachedIds.size > 0
          ? node.children.filter((child) => !store.dragDetachedIds.has(child.id))
          : node.children;
      // Keep the entire dragged subtree out of hit-testing so drop target lookup
      // can see the frame underneath instead of every nested descendant.
      const childInteractionSuppressed = isInteractionSuppressed;

      return (
        <>
          {visibleChildren.map((child) => {
            const isFlowChild = isFlowLayout && child.styles.position !== "absolute";
            const renderMode = forceDetail
              ? "full"
              : getDescendantRenderMode(store, child, isFlowChild);
            if (renderMode === "hidden") return null;

            return (
              <RenderNode
                key={child.id}
                node={child}
                isFlowChild={isFlowChild}
                isInteractionSuppressed={childInteractionSuppressed}
                renderChildren={renderMode === "full"}
                forceDetail={forceDetail}
              />
            );
          })}
        </>
      );
    },
  ),
);

const FrameRenderer = observer(
  ({
    node,
    isFlowChild = false,
    isInteractionSuppressed = false,
    renderChildren = true,
    forceDetail = false,
  }: RendererProps) => {
    const store = useEditorStore();
    const ref = useNodeRef(node);

    const style = buildBaseStyle(store, node, isFlowChild, isInteractionSuppressed);
    applyTypedAppearanceStyles(node, style);
    useResolvedNodeBackgroundImage(node, style);

    // Default box shadow for artboards only
    if (node.isArtboard && !node.styles.boxShadow) {
      style.boxShadow = "0 1px 3px rgba(0,0,0,0.08), 0 4px 12px rgba(0,0,0,0.04)";
    }
    if (node.isArtboard && !node.styles.overflow) {
      style.overflow = "hidden";
    }
    if (node.children.length > 0 && nodeClipsChildrenPaint(node)) {
      style.contentVisibility = "auto";
    }

    // Determine if this frame lets browser CSS layout place its children.
    const display = node.styles.display as string | undefined;
    const isFlowLayout = isFlowLayoutDisplay(display);

    return (
      <div ref={ref} data-node-id={node.id} {...getMaterializedNodeProps(store, node.id, style)}>
        <GeneratedBackgroundPlaceholder node={node} />
        {renderChildren ? (
          <NodeChildren
            node={node}
            isFlowLayout={isFlowLayout}
            isInteractionSuppressed={isInteractionSuppressed}
            forceDetail={forceDetail}
          />
        ) : null}
      </div>
    );
  },
);

const RectangleRenderer = observer(
  ({
    node,
    isFlowChild = false,
    isInteractionSuppressed = false,
    renderChildren = true,
    forceDetail = false,
  }: RendererProps) => {
    const store = useEditorStore();
    const ref = useNodeRef(node);

    const style = buildBaseStyle(store, node, isFlowChild, isInteractionSuppressed);
    applyTypedAppearanceStyles(node, style);
    useResolvedNodeBackgroundImage(node, style);

    if (node.children.length > 0 && nodeClipsChildrenPaint(node)) {
      style.contentVisibility = "auto";
    }

    return (
      <div ref={ref} data-node-id={node.id} {...getMaterializedNodeProps(store, node.id, style)}>
        <GeneratedBackgroundPlaceholder node={node} />
        {renderChildren ? (
          <NodeChildren
            node={node}
            isFlowLayout={false}
            isInteractionSuppressed={isInteractionSuppressed}
            forceDetail={forceDetail}
          />
        ) : null}
      </div>
    );
  },
);

/** Component registry — maps node.type to a React component */
const componentRegistry: Record<string, React.ComponentType<RendererProps>> = {
  frame: FrameRenderer,
  text: TextNodeRenderer,
  rectangle: RectangleRenderer,
  svg: SvgNodeRenderer,
  "interactive-surface": InteractiveSurfaceNodeRenderer,
  image: ImageNodeRenderer,
  path: PathRenderer,
  shader: ShaderRenderer,
};

/** Recursive node renderer — the heart of Leaf's DOM-based rendering */
export const RenderNode = observer(
  ({
    node,
    isFlowChild = false,
    isInteractionSuppressed = false,
    renderChildren = true,
    forceDetail = false,
  }: RendererProps) => {
    if (node.visible === false) {
      return null;
    }

    const Component = componentRegistry[node.type];
    if (!Component) return null;
    return (
      <Component
        node={node}
        isFlowChild={isFlowChild}
        isInteractionSuppressed={isInteractionSuppressed}
        renderChildren={renderChildren}
        forceDetail={forceDetail}
      />
    );
  },
);
