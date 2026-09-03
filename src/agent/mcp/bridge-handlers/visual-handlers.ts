import { MAX_ZOOM, MIN_ZOOM } from "../../../core/editor/interaction/math";
import { measureCanvasLayout } from "../canvas-layout";
import { getReportedDimension, withMeasuredNodes } from "../node-inspection";
import {
  captureNodeScreenshot,
  captureNodeScreenshotBatch,
  capturePageScreenshot,
} from "../../../ui/render/screenshot-capture";
import { waitForAnimationFrames } from "../../../ui/render/render-settle";
import {
  MAX_SCREENSHOT_BATCH_NODES,
  MAX_SCREENSHOT_SCALE,
  MIN_SCREENSHOT_SCALE,
} from "../../../ui/render/screenshot-limits";
import type { RendererHandlerContext, RendererHandlerMap } from "./types";

export function createVisualHandlers(context: RendererHandlerContext) {
  const { store } = context;
  return {
    get_screenshot: async (params) => {
      const scale = (params.scale as number) ?? 1;
      if (!Number.isFinite(scale) || scale < MIN_SCREENSHOT_SCALE || scale > MAX_SCREENSHOT_SCALE) {
        throw new Error(
          `Screenshot scale must be between ${MIN_SCREENSHOT_SCALE} and ${MAX_SCREENSHOT_SCALE}.`,
        );
      }
      const transparent = (params.transparent as boolean) ?? false;

      const nodeIds = params.nodeIds as string[] | undefined;
      if (nodeIds !== undefined) {
        if (!Array.isArray(nodeIds) || nodeIds.length === 0) {
          throw new Error("get_screenshot nodeIds must be a non-empty array");
        }
        if (nodeIds.length > MAX_SCREENSHOT_BATCH_NODES) {
          throw new Error(
            `get_screenshot captures at most ${MAX_SCREENSHOT_BATCH_NODES} nodes per call`,
          );
        }
        const nodes = nodeIds.map((nodeId) => {
          const node = store.getNode(nodeId);
          if (!node) throw new Error(`Node not found: ${String(nodeId)}`);
          return node;
        });
        const results = await captureNodeScreenshotBatch(store, nodes, scale, transparent);
        // Each capture carries its node ID so the server can attribute images
        // without trusting positional order across bridge versions.
        return {
          captures: results.map((result, index) => ({ nodeId: nodeIds[index]!, ...result })),
        };
      }

      const node = store.getNode(params.nodeId as string);
      if (!node) throw new Error(`Node not found: ${String(params.nodeId)}`);
      return await captureNodeScreenshot(store, node, scale, transparent);
    },

    get_canvas_layout: async (params) => {
      return await measureCanvasLayout(store, (params.pageId as string | undefined) ?? undefined, {
        verboseLint: params.verboseLint === true,
      });
    },

    get_page_screenshot: async (params) => {
      const scale = (params.scale as number) ?? 1;
      if (!Number.isFinite(scale) || scale < MIN_SCREENSHOT_SCALE || scale > MAX_SCREENSHOT_SCALE) {
        throw new Error(
          `Screenshot scale must be between ${MIN_SCREENSHOT_SCALE} and ${MAX_SCREENSHOT_SCALE}.`,
        );
      }
      const padding = (params.padding as number) ?? 80;
      if (!Number.isFinite(padding) || padding < 0 || padding > 1000) {
        throw new Error("Page screenshot padding must be between 0 and 1000.");
      }
      return await capturePageScreenshot(
        store,
        (params.pageId as string | undefined) ?? store.activePageId,
        scale,
        (params.transparent as boolean) ?? false,
        padding,
      );
    },

    set_viewport: async (params) => {
      const { zoom, panX, panY, nodeId, margin } = params as {
        zoom?: number;
        panX?: number;
        panY?: number;
        nodeId?: string;
        margin?: number;
      };

      if (nodeId) {
        const node = store.getNode(nodeId);
        if (!node) throw new Error(`Node not found: ${nodeId}`);
        const viewportWidth = store.viewportWidth || window.innerWidth;
        const viewportHeight = store.viewportHeight || window.innerHeight;
        const { width, height, position } = await withMeasuredNodes(store, [{ node }], () => ({
          width: getReportedDimension(store, node, "width") ?? node.width,
          height: getReportedDimension(store, node, "height") ?? node.height,
          position: store.getCanvasPosition(nodeId) ?? { x: node.x, y: node.y },
        }));
        const marginPx = margin ?? 64;

        const fitZoom =
          zoom ??
          Math.min(
            (viewportWidth - marginPx * 2) / Math.max(width, 1),
            (viewportHeight - marginPx * 2) / Math.max(height, 1),
          );
        const nextZoom = Math.min(Math.max(fitZoom, MIN_ZOOM), MAX_ZOOM);
        store.setViewport({
          zoom: nextZoom,
          panX: viewportWidth / 2 - (position.x + width / 2) * nextZoom,
          panY: viewportHeight / 2 - (position.y + height / 2) * nextZoom,
        });
      } else {
        if (zoom === undefined && panX === undefined && panY === undefined) {
          throw new Error("set_viewport requires nodeId, or at least one of zoom/panX/panY");
        }
        store.setViewport({ zoom, panX, panY });
      }

      await waitForAnimationFrames(2);
      return {
        zoom: store.zoom,
        panX: store.panX,
        panY: store.panY,
        viewportWidth: store.viewportWidth || window.innerWidth,
        viewportHeight: store.viewportHeight || window.innerHeight,
      };
    },
  } satisfies RendererHandlerMap;
}
