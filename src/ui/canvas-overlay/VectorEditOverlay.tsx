import { action, reaction } from "mobx";
import { observer } from "mobx-react-lite";
import { useCallback, useEffect, useRef, useState } from "react";
import { screenPoint } from "../../core/editor/interaction/coordinate-spaces";
import { moveAnchor, moveHandle, removeAnchor } from "../../core/editor/vector/edit-ops";
import {
  canvasPointToPath,
  getPathScale,
  hitTestPath,
  mapPathToCanvas,
  refitPathToNode,
  type VectorHandleKind,
  type VectorRect,
} from "../../core/editor/vector/geometry";
import {
  formatPathData,
  type VectorPath,
  type VectorPoint,
} from "../../core/editor/vector/path-data";
import { getPathGeometry, resolvePathPaint } from "../../core/editor/vector/path-node";
import { vectorEdit } from "../../core/editor/vector/vector-edit-session";
import { useEditorStore } from "../../core/state/EditorStore";
import type { EditorStore } from "../../core/state/EditorStore";
import type { DesignNode } from "../../core/types";
import { isNodeLocked } from "../viewport/interaction-helpers";

/** Screen-space grab radius for anchors and handles. */
const HIT_RADIUS = 8;
/** Screen-space slack around a path box when picking one to edit. */
const PATH_PICK_SLOP = 4;
const ANCHOR_SIZE = 7;
const HANDLE_RADIUS = 3.5;
const ACCENT = "#1E90FF";

type VectorDrag =
  | { kind: "anchor"; index: number }
  | { kind: "handle"; index: number; handle: VectorHandleKind };

/**
 * Everything the drag recomputes from, frozen at pointer-down.
 *
 * Each frame re-derives the whole path from this base instead of accumulating
 * deltas, and re-fits the node box against the same base — so the path
 * coordinate space stays pinned to the canvas while its bounds change under
 * the cursor, and the anchors the user is not dragging do not drift.
 */
interface VectorDragBase {
  nodeId: string;
  path: VectorPath;
  bounds: VectorRect;
  origin: VectorPoint;
  node: { x: number; y: number; width: number; height: number };
  startCanvas: VectorPoint;
  drag: VectorDrag;
}

interface VectorEditTarget {
  node: { id: string; x: number; y: number; width: number; height: number };
  path: VectorPath;
  bounds: VectorRect;
  origin: VectorPoint;
}

function readEditTarget(store: EditorStore): VectorEditTarget | null {
  const nodeId = vectorEdit.nodeId;
  if (!nodeId) return null;
  const node = store.getNode(nodeId);
  if (!node || node.type !== "path") return null;
  const geometry = getPathGeometry(node.content);
  if (!geometry) return null;
  const origin = store.getCanvasPosition(nodeId);
  if (!origin) return null;
  return { node, path: geometry.path, bounds: geometry.bounds, origin };
}

/**
 * Write an edited path back to its node, re-fitting the node box around it.
 *
 * One `updateNode` rather than a content write plus a geometry write, so the
 * box and the artwork can never be observed a frame out of step.
 */
function applyPath(
  store: EditorStore,
  nodeId: string,
  node: { x: number; y: number; width: number; height: number },
  sourceBounds: VectorRect,
  path: VectorPath,
) {
  const refit = refitPathToNode(path, node, sourceBounds);
  if (!refit) return;
  store.runtime.updateNode(nodeId, {
    content: formatPathData(refit.path),
    x: refit.x,
    y: refit.y,
    width: refit.width,
    height: refit.height,
  });
}

/**
 * Whether a path may be handed to the vector editor at all.
 *
 * A locked node is not draggable anywhere else in the editor, and a node
 * outside the entered container is not selectable, so neither may become
 * editable — no matter which of the two pick paths found it.
 */
function isEditablePathTarget(store: EditorStore, nodeId: string): boolean {
  return store.isNodeWithinSelectionScope(nodeId) && !isNodeLocked(store, nodeId);
}

/**
 * The path node under a canvas point, by box rather than by painted pixels.
 *
 * `event.target` only finds a path where the browser thinks it was hit, which
 * for an unfilled shape means the stroke alone — and for a straight segment
 * means a zero-height box that can never be hit at all. Entering the editor has
 * to work anywhere inside the shape the anchors describe, so this measures the
 * node box directly and pads it by the stroke the path actually paints.
 * Topmost wins, matching how the canvas resolves overlapping nodes.
 */
export function findPathNodeAtCanvasPoint(
  store: EditorStore,
  point: VectorPoint,
  slop: number,
): DesignNode | null {
  let hit: DesignNode | null = null;

  const visit = (node: DesignNode) => {
    if (node.visible === false) return;
    if (node.type === "path" && isEditablePathTarget(store, node.id)) {
      const origin = store.getCanvasPosition(node.id);
      if (origin) {
        const tolerance = slop + Math.max(0, resolvePathPaint(node).strokeWidth) / 2;
        const withinX =
          point.x >= origin.x - tolerance && point.x <= origin.x + node.width + tolerance;
        const withinY =
          point.y >= origin.y - tolerance && point.y <= origin.y + node.height + tolerance;
        if (withinX && withinY) hit = node;
      }
    }
    for (const child of node.children) visit(child);
  };

  for (const root of store.nodes) visit(root);
  return hit;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/**
 * The anchors and handles of the path being edited.
 *
 * A standalone overlay rather than part of `CanvasOverlay`: it is additive
 * chrome on the same camera transform, and keeping it separate means vector
 * editing cannot perturb selection rendering. It owns its own pointer and key
 * listeners so the whole tool works from a single mount point.
 */
export const VectorEditOverlay = observer(() => {
  const store = useEditorStore();
  const [viewportEl, setViewportEl] = useState<HTMLElement | null>(null);
  const dragRef = useRef<VectorDragBase | null>(null);
  /** Space is the viewport's temporary pan; a drag must not eat that gesture. */
  const spaceHeldRef = useRef(false);

  useEffect(() => {
    setViewportEl(document.querySelector<HTMLElement>("[data-viewport]"));
  }, []);

  /**
   * The drag follows the same begin/commit/cancel boundary as the viewport's
   * own gestures: one history transaction for its lifetime, the editor-wide
   * pointer-gesture flag raised while it runs so mutating shortcuts stay
   * inert, and a cancel that restores the pre-drag geometry rather than
   * committing whatever frame the pointer happened to be on.
   */
  const commitDrag = useCallback(
    action(() => {
      if (!dragRef.current) return;
      dragRef.current = null;
      store.endHistoryTransaction();
      store.setPointerGestureActive(false);
    }),
    [store],
  );

  const cancelDrag = useCallback(
    action(() => {
      const base = dragRef.current;
      if (!base) return;
      dragRef.current = null;
      // The base is the frozen pre-drag state, so restoring it explicitly is
      // exact even without a persistence adapter; cancelling the transaction
      // then discards the whole gesture from history the way the viewport's
      // move and resize gestures do.
      store.runtime.updateNode(base.nodeId, {
        content: formatPathData(base.path),
        x: base.node.x,
        y: base.node.y,
        width: base.node.width,
        height: base.node.height,
      });
      store.cancelHistoryTransaction();
      store.setPointerGestureActive(false);
    }),
    [store],
  );

  // Leaving the select tool abandons the session; without this the anchors
  // would keep taking clicks meant for whatever tool is now armed.
  useEffect(() => {
    const disposeTool = reaction(
      () => store.activeTool,
      (tool) => {
        if (tool !== "select") vectorEdit.exit();
      },
    );
    const disposeSelection = reaction(
      () => (vectorEdit.nodeId ? store.selectedIds.has(vectorEdit.nodeId) : true),
      (stillSelected) => {
        if (!stillSelected) vectorEdit.exit();
      },
    );
    // A tool key or deselection can end the session mid-drag; the drag must
    // not keep running on the window and commit against an exited session.
    const disposeExit = reaction(
      () => vectorEdit.isActive,
      (active) => {
        if (!active) cancelDrag();
      },
    );
    return () => {
      disposeTool();
      disposeSelection();
      disposeExit();
    };
  }, [cancelDrag, store]);

  useEffect(() => {
    if (!viewportEl) return;

    const toCanvas = (event: PointerEvent | MouseEvent): VectorPoint => {
      const rect = viewportEl.getBoundingClientRect();
      return store.screenToCanvas(screenPoint(event.clientX - rect.left, event.clientY - rect.top));
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || spaceHeldRef.current) return;
      if (!vectorEdit.isActive) return;
      const target = readEditTarget(store);
      if (!target) {
        vectorEdit.exit();
        return;
      }

      const point = toCanvas(event);
      const canvasPath = mapPathToCanvas(target.path, target.node, target.origin, target.bounds);
      const hit = hitTestPath(canvasPath, point, HIT_RADIUS / store.zoom);
      // A click on empty canvas leaves vector editing and is allowed through,
      // so the same click still selects whatever is under it.
      if (!hit) {
        vectorEdit.exit();
        return;
      }

      event.stopPropagation();
      event.preventDefault();
      vectorEdit.selectAnchor(hit.index, hit.type === "anchor" && event.shiftKey);
      store.beginHistoryTransaction();
      store.setPointerGestureActive(true);
      dragRef.current = {
        nodeId: target.node.id,
        path: target.path,
        bounds: target.bounds,
        origin: target.origin,
        node: {
          x: target.node.x,
          y: target.node.y,
          width: target.node.width,
          height: target.node.height,
        },
        startCanvas: point,
        drag:
          hit.type === "anchor"
            ? { kind: "anchor", index: hit.index }
            : { kind: "handle", index: hit.index, handle: hit.handle },
      };
    };

    const onPointerMove = (event: PointerEvent) => {
      const base = dragRef.current;
      if (!base) return;
      event.stopPropagation();
      event.preventDefault();

      const point = toCanvas(event);
      const scale = getPathScale(base.node, base.bounds);
      const next =
        base.drag.kind === "anchor"
          ? moveAnchor(
              base.path,
              base.drag.index,
              (point.x - base.startCanvas.x) / (scale.x || 1),
              (point.y - base.startCanvas.y) / (scale.y || 1),
            )
          : moveHandle(
              base.path,
              base.drag.index,
              base.drag.handle,
              canvasPointToPath(point, base.node, base.origin, base.bounds),
              // Alt breaks the mirror, turning a smooth anchor into a cusp.
              { mirror: !event.altKey },
            );
      applyPath(store, base.nodeId, base.node, base.bounds, next);
    };

    const onPointerUp = (event: PointerEvent) => {
      if (!dragRef.current) return;
      event.stopPropagation();
      commitDrag();
    };

    // The browser interrupting the pointer stream is a cancel, not a release,
    // matching how the viewport treats pointercancel for its own gestures.
    const onPointerCancel = (event: PointerEvent) => {
      if (!dragRef.current) return;
      event.stopPropagation();
      cancelDrag();
    };

    const onDoubleClick = (event: MouseEvent) => {
      if (store.activeTool !== "select") return;
      const targetNodeId =
        event.target instanceof Element
          ? event.target.closest("[data-node-id]")?.getAttribute("data-node-id")
          : undefined;
      const targetNode = targetNodeId ? store.getNode(targetNodeId) : undefined;
      // A double-click on the painted geometry is already unambiguous, as long
      // as that path is one the user is allowed to touch — a locked or
      // out-of-scope hit falls through to whatever editable path sits under the
      // pointer, the way the canvas resolves a locked hit. Falling through also
      // covers the reverse case — an unfilled shape whose interior lets the
      // frame behind it take the click — but only when the click landed on a
      // container or on nothing, so a double-click meant for the text or image
      // drawn over a path still belongs to it.
      const directPath =
        targetNode?.type === "path" && isEditablePathTarget(store, targetNode.id)
          ? targetNode
          : null;
      const node =
        directPath ??
        (!targetNode || targetNode.type === "frame" || targetNode.type === "path"
          ? findPathNodeAtCanvasPoint(store, toCanvas(event), PATH_PICK_SLOP / store.zoom)
          : null);
      if (!node) return;
      event.stopPropagation();
      event.preventDefault();
      store.selectNode(node.id);
      vectorEdit.enter(node.id);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") spaceHeldRef.current = false;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space") spaceHeldRef.current = true;
      if (isEditableTarget(event.target)) return;

      if (vectorEdit.isActive) {
        // Escape mid-drag steps back one level: it abandons the drag and keeps
        // the session, so the next Escape is the one that leaves editing.
        if (event.key === "Escape" && dragRef.current) {
          event.preventDefault();
          event.stopPropagation();
          cancelDrag();
          return;
        }
        if (event.key === "Escape" || event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          vectorEdit.exit();
          return;
        }
        if (event.key !== "Backspace" && event.key !== "Delete") return;
        const target = readEditTarget(store);
        const indices = [...vectorEdit.selectedAnchors].sort((a, b) => b - a);
        if (!target || indices.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        let path = target.path;
        for (const index of indices) path = removeAnchor(path, index);
        store.beginHistoryTransaction();
        try {
          applyPath(store, target.node.id, target.node, target.bounds, path);
        } finally {
          store.endHistoryTransaction();
        }
        vectorEdit.clearAnchorSelection();
        return;
      }

      if (event.key !== "Enter" || store.activeTool !== "select") return;
      const selected = store.selectedNodes;
      if (selected.length !== 1 || selected[0]?.type !== "path") return;
      event.preventDefault();
      event.stopPropagation();
      vectorEdit.enter(selected[0].id);
    };

    // Anchors are grabbed on the canvas, but a drag has to keep tracking after
    // the cursor leaves it — hence pointer down on the viewport and the rest on
    // the window. Capture phase is what lets a live gesture take precedence
    // over the viewport's own selection and marquee handling.
    viewportEl.addEventListener("pointerdown", onPointerDown, true);
    viewportEl.addEventListener("dblclick", onDoubleClick, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerCancel, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);

    return () => {
      viewportEl.removeEventListener("pointerdown", onPointerDown, true);
      viewportEl.removeEventListener("dblclick", onDoubleClick, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      // Unmounting mid-drag mirrors the viewport: an in-flight gesture is
      // cancelled rather than committed from wherever the pointer was.
      cancelDrag();
    };
  }, [cancelDrag, commitDrag, store, viewportEl]);

  const { zoom, panX, panY } = store;
  const editTarget = vectorEdit.isActive ? readEditTarget(store) : null;
  if (!editTarget) return null;

  const editPath = mapPathToCanvas(
    editTarget.path,
    editTarget.node,
    editTarget.origin,
    editTarget.bounds,
  );

  const anchorSize = ANCHOR_SIZE / zoom;
  const handleRadius = HANDLE_RADIUS / zoom;
  const strokeWidth = 1 / zoom;

  const renderAnchor = (point: VectorPoint, key: string, selected: boolean) => (
    <rect
      key={key}
      data-vector-anchor={key}
      x={point.x - anchorSize / 2}
      y={point.y - anchorSize / 2}
      width={anchorSize}
      height={anchorSize}
      fill={selected ? ACCENT : "#ffffff"}
      stroke={ACCENT}
      strokeWidth={strokeWidth}
    />
  );

  const renderHandles = (path: VectorPath, prefix: string) =>
    path.anchors.flatMap((anchor, index) =>
      (["in", "out"] as const).flatMap((kind) => {
        const control = kind === "in" ? anchor.inHandle : anchor.outHandle;
        if (!control) return [];
        return [
          <g key={`${prefix}-handle-${index}-${kind}`} data-vector-handle={`${index}-${kind}`}>
            <line
              x1={anchor.x}
              y1={anchor.y}
              x2={control.x}
              y2={control.y}
              stroke={ACCENT}
              strokeWidth={strokeWidth}
              opacity={0.7}
            />
            <circle
              cx={control.x}
              cy={control.y}
              r={handleRadius}
              fill="#ffffff"
              stroke={ACCENT}
              strokeWidth={strokeWidth}
            />
          </g>,
        ];
      }),
    );

  return (
    <svg
      data-vector-edit-overlay={editTarget.node.id}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        overflow: "visible",
      }}
    >
      <g transform={`matrix(${zoom}, 0, 0, ${zoom}, ${panX}, ${panY})`}>
        <path
          data-vector-edit-path
          d={formatPathData(editPath)}
          fill="none"
          stroke={ACCENT}
          strokeWidth={strokeWidth}
        />
        {renderHandles(editPath, "edit")}
        {editPath.anchors.map((anchor, index) =>
          renderAnchor(anchor, `edit-anchor-${index}`, vectorEdit.selectedAnchors.includes(index)),
        )}
      </g>
    </svg>
  );
});
