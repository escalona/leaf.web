import { reaction } from "mobx";
import { useLayoutEffect, useRef } from "react";
import { hasUnsafeModelGeometry } from "../../core/editor/model-geometry";
import { useEditorStore, type EditorStore } from "../../core/state/EditorStore";
import { getNodeModelBox, getNodeModelCullRect, nodeClipsChildrenForCulling } from "./culling";

// A 2k-node HTML document already carries enough nested DOM/layout work to miss
// 120 Hz frames. Use the transient artboard preview before that typical-large
// size instead of reserving it only for stress documents.
const ROOT_FRAME_ZOOM_LOD_NODE_THRESHOLD = 1500;

export function shouldUseRootFrameZoomLod(store: EditorStore) {
  void store.renderTreeVersion;
  return (
    store.nodeMap.size > ROOT_FRAME_ZOOM_LOD_NODE_THRESHOLD &&
    store.nodes.length > 20 &&
    store.nodes.every(
      (node) =>
        node.type === "frame" && !hasUnsafeModelGeometry(node) && nodeClipsChildrenForCulling(node),
    )
  );
}

/**
 * During zoom on a large multi-artboard canvas, draw cheap screen-space root
 * coverage behind the compositor-scaled DOM. This fallback can cover roots that
 * have not entered the retained detail window yet, but it never replaces or
 * hides rich DOM content.
 */
export function RootFrameZoomLod() {
  const store = useEditorStore();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useLayoutEffect(() => {
    let drawFrame = 0;
    let hideFrame = 0;

    const draw = () => {
      drawFrame = 0;
      const canvas = canvasRef.current;
      if (!canvas || !store.isZooming || !shouldUseRootFrameZoomLod(store)) return;
      const width = Math.max(1, Math.ceil(store.viewportWidth));
      const height = Math.max(1, Math.ceil(store.viewportHeight));
      // Motion LOD intentionally uses one backing pixel per CSS pixel. A Retina
      // 2D buffer quadruples fill/clear work for a preview shown only during input.
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const context = canvas.getContext("2d", { desynchronized: true });
      canvas.dataset.zoomLodReady = context ? "true" : "false";
      if (!context) return;
      canvas.style.display = "block";
      context.clearRect(0, 0, width, height);
      context.lineWidth = 1;
      context.strokeStyle = "rgba(0, 0, 0, 0.12)";

      for (const node of store.nodes) {
        if (node.visible === false) continue;
        // Visibility is decided on the turned extent; the fill below draws the
        // root's own box, turned, so the preview covers what the DOM covers.
        const extent = getNodeModelCullRect(node);
        if (
          extent.x * store.zoom + store.panX + extent.width * store.zoom < 0 ||
          extent.y * store.zoom + store.panY + extent.height * store.zoom < 0 ||
          extent.x * store.zoom + store.panX > width ||
          extent.y * store.zoom + store.panY > height
        ) {
          continue;
        }
        const rect = getNodeModelBox(node);
        const x = rect.x * store.zoom + store.panX;
        const y = rect.y * store.zoom + store.panY;
        const nodeWidth = rect.width * store.zoom;
        const nodeHeight = rect.height * store.zoom;
        const styleBackground = node.styles.backgroundColor;
        // Canvas ignores unsupported CSS values such as gradients and otherwise
        // retains the previous fillStyle. Reset first so one root can never
        // inherit a neighboring root's fallback color.
        context.fillStyle = "#ffffff";
        context.fillStyle =
          typeof styleBackground === "string" ? styleBackground : node.backgroundColor || "#ffffff";
        const rotation = node.rotation ?? 0;
        if (rotation) {
          context.save();
          context.translate(x + nodeWidth / 2, y + nodeHeight / 2);
          context.rotate((rotation * Math.PI) / 180);
          context.translate(-nodeWidth / 2, -nodeHeight / 2);
          context.fillRect(0, 0, nodeWidth, nodeHeight);
          if (node.isArtboard && nodeWidth >= 2 && nodeHeight >= 2) {
            context.strokeRect(0.5, 0.5, nodeWidth - 1, nodeHeight - 1);
          }
          context.restore();
          continue;
        }
        context.fillRect(x, y, nodeWidth, nodeHeight);
        if (node.isArtboard && nodeWidth >= 2 && nodeHeight >= 2) {
          context.strokeRect(x + 0.5, y + 0.5, nodeWidth - 1, nodeHeight - 1);
        }
      }
    };

    const scheduleDraw = () => {
      if (drawFrame) return;
      drawFrame = requestAnimationFrame(draw);
    };

    const dispose = reaction(
      () => ({
        active: store.isZooming && shouldUseRootFrameZoomLod(store),
        panX: store.panX,
        panY: store.panY,
        zoom: store.zoom,
        viewportWidth: store.viewportWidth,
        viewportHeight: store.viewportHeight,
        renderTreeVersion: store.renderTreeVersion,
      }),
      ({ active }) => {
        if (hideFrame) {
          cancelAnimationFrame(hideFrame);
          hideFrame = 0;
        }
        if (active) {
          if (canvasRef.current?.style.display !== "block") draw();
          else scheduleDraw();
          return;
        }
        hideFrame = requestAnimationFrame(() => {
          hideFrame = 0;
          if (canvasRef.current) canvasRef.current.style.display = "none";
        });
      },
      { fireImmediately: true },
    );
    return () => {
      dispose();
      if (drawFrame) cancelAnimationFrame(drawFrame);
      if (hideFrame) cancelAnimationFrame(hideFrame);
    };
  }, [store]);

  return (
    <canvas
      ref={canvasRef}
      data-root-frame-zoom-lod
      data-zoom-lod-ready="false"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        display: "none",
        zIndex: 0,
      }}
    />
  );
}
