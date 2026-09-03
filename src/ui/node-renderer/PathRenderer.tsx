import { observer } from "mobx-react-lite";
import { useCallback, useMemo, useRef, type CSSProperties } from "react";
import { isDrawablePathData } from "../../core/editor/vector/path-data";
import {
  getPathGeometry,
  getPathViewBox,
  isPathPaintStyleKey,
  resolvePathPaint,
} from "../../core/editor/vector/path-node";
import { useEditorStore } from "../../core/state/EditorStore";
import type { DesignNode } from "../../core/types";
import { buildBaseStyle, getMaterializedNodeProps } from "./node-renderer-style";

export interface PathRendererProps {
  node: DesignNode;
  isFlowChild?: boolean;
  isInteractionSuppressed?: boolean;
  renderChildren?: boolean;
  forceDetail?: boolean;
}

/**
 * Vector path renderer.
 *
 * The node box stays a plain positioned `div` like every other node, so
 * selection, dragging, and resizing keep working unchanged; only the paint
 * moves inside an `<svg>`. The `viewBox` comes from the path's own bounds, so
 * resizing the node scales the artwork rather than growing space around it.
 */
export const PathRenderer = observer(
  ({ node, isFlowChild = false, isInteractionSuppressed = false }: PathRendererProps) => {
    const store = useEditorStore();
    const disposeRegistration = useRef<(() => void) | null>(null);
    const ref = useCallback(
      (element: HTMLDivElement | null) => {
        disposeRegistration.current?.();
        disposeRegistration.current = element ? store.domIndex.register(node, element) : null;
      },
      [node, store.domIndex],
    );

    const style = buildBaseStyle(store, node, isFlowChild, isInteractionSuppressed);
    // A path's background is its fill and its border is its stroke. Leaving
    // those declarations on the wrapper would paint the bounding box instead.
    for (const key of Object.keys(style)) {
      if (isPathPaintStyleKey(key)) delete (style as Record<string, unknown>)[key];
    }
    // Strokes and smooth curves reach past the node box; clipping them would
    // shave the outer edge off every stroked path.
    if (!node.styles.overflow) style.overflow = "visible";

    const geometry = useMemo(() => getPathGeometry(node.content), [node.content]);
    const paint = resolvePathPaint(node);
    // Corrupt `d` (a truncated write, a template that never interpolated) draws
    // nothing in the browser, which would leave a node that cannot be seen or
    // clicked. Marking the box keeps it findable and fixable in the inspector.
    const isDrawable = useMemo(() => isDrawablePathData(node.content), [node.content]);

    // A `d` the anchor model cannot hold (an arc, several subpaths) still has
    // to draw. Falling back to the node box as the coordinate space renders it
    // 1:1 instead of blanking the node.
    const viewBox = geometry
      ? getPathViewBox(geometry.bounds)
      : `0 0 ${Math.max(node.width, 1)} ${Math.max(node.height, 1)}`;

    const svgStyle: CSSProperties = {
      display: "block",
      overflow: "visible",
      pointerEvents: "none",
    };

    return (
      <div ref={ref} data-node-id={node.id} {...getMaterializedNodeProps(store, node.id, style)}>
        {node.content ? (
          <svg
            width="100%"
            height="100%"
            viewBox={viewBox}
            preserveAspectRatio="none"
            style={svgStyle}
          >
            {isDrawable ? null : (
              <rect
                data-path-placeholder
                x={0}
                y={0}
                width={Math.max(node.width, 1)}
                height={Math.max(node.height, 1)}
                fill="none"
                stroke="#d4d4d8"
                strokeDasharray="4 4"
                vectorEffect="non-scaling-stroke"
              />
            )}
            <path
              d={isDrawable ? node.content : ""}
              fill={paint.fill}
              fillRule={paint.fillRule}
              stroke={paint.stroke ?? "none"}
              strokeWidth={paint.strokeWidth || undefined}
              strokeLinecap={paint.strokeLinecap}
              strokeLinejoin={paint.strokeLinejoin}
              strokeDasharray={paint.strokeDasharray}
              // The viewBox is stretched to the node box, so a scaled stroke
              // would be thicker along one axis than the other.
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        ) : null}
      </div>
    );
  },
);
