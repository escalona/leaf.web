import { buildInkShape } from "../../../core/editor/ink";
import { computeCenteredCameraForBounds } from "../../../core/editor/interaction/math";
import { isFlowLayoutDisplay } from "../../../core/editor/layout-display";
import { measureImageSource } from "../../../core/editor/clipboard/image-paste";
import { getFontFamilyInfo, loadFontsForNodeTree } from "../../../core/fonts/loader";
import { uploadImageAssetFromDataUrl } from "../../../core/state/image-assets";
import type { EditorStore } from "../../../core/state/EditorStore";
import {
  collectExternalSvgUseWarnings,
  collectFontLoadRequests,
  collectGenericLayerWarnings,
  collectInlineStyleWarnings,
  collectStyledInlineSpanWarnings,
  countCreatedNodes,
  parseHtmlForInspection,
  summarizeCreatedNode,
} from "../html-inspection";
import {
  collectPlacementWarnings,
  getMcpNodeType,
  requirePage,
  serializeNodeForMcp,
} from "../node-inspection";
import {
  assertImageGenerationAvailable,
  prepareArtboardImageGeneration,
  prepareWriteHtmlImageGenerations,
  startMcpImageGenerations,
} from "../image-generation";
import { waitForAnimationFrames } from "../../../ui/render/render-settle";
import type { RendererHandlerContext, RendererHandlerMap } from "./types";

function resolveImageInsertPosition(store: EditorStore, parentId?: string, x?: number, y?: number) {
  // With a parent, x/y are offsets inside that parent (matching how node.x/y
  // and update_styles treat child positions), defaulting to the parent origin.
  // The runtime converts back to a parent-local position from canvas space.
  const parentCanvasPosition = parentId ? store.getCanvasPosition(parentId) : undefined;
  if (parentCanvasPosition) {
    return {
      x: parentCanvasPosition.x + (x ?? 0),
      y: parentCanvasPosition.y + (y ?? 0),
    };
  }

  // Without a parent, x/y are canvas coordinates.
  if (x === undefined && y === undefined) return undefined;
  if (x === undefined || y === undefined) {
    throw new Error("A root image position requires both x and y.");
  }
  return { x, y };
}

function resolveImageNodeSize(
  naturalSize: { width: number; height: number },
  requestedWidth?: number,
  requestedHeight?: number,
) {
  if (requestedWidth !== undefined && requestedHeight !== undefined) {
    return {
      width: Math.max(1, Math.round(requestedWidth)),
      height: Math.max(1, Math.round(requestedHeight)),
    };
  }

  if (requestedWidth !== undefined) {
    const scale = requestedWidth / naturalSize.width;
    return {
      width: Math.max(1, Math.round(requestedWidth)),
      height: Math.max(1, Math.round(naturalSize.height * scale)),
    };
  }

  if (requestedHeight !== undefined) {
    const scale = requestedHeight / naturalSize.height;
    return {
      width: Math.max(1, Math.round(naturalSize.width * scale)),
      height: Math.max(1, Math.round(requestedHeight)),
    };
  }

  return {
    width: Math.max(1, Math.round(naturalSize.width)),
    height: Math.max(1, Math.round(naturalSize.height)),
  };
}

export function createCreationHandlers(context: RendererHandlerContext) {
  const { store, getCollaborationContext } = context;
  return {
    create_image: async (params) => {
      const {
        dataUrl,
        name,
        width,
        height,
        x,
        y,
        parentId,
        layout = "absolute",
        locked,
        pageId,
      } = params as {
        dataUrl: string;
        name?: string;
        width?: number;
        height?: number;
        x?: number;
        y?: number;
        parentId?: string;
        layout?: string;
        locked?: boolean;
        pageId?: string;
      };

      if (layout !== "absolute" && layout !== "flow") {
        throw new Error(`Unsupported image layout: ${String(layout)}`);
      }
      let promoteParentToFrame = false;
      if (parentId) {
        const parent = store.getNode(parentId);
        if (!parent) throw new Error(`Parent not found: ${parentId}`);
        if (parent.type === "rectangle") {
          // A childless imported <div> lands as a rectangle. Agents routinely
          // want to drop a photo into that box, so promote it to a frame (a
          // rectangle is a frame that happens to hold nothing) instead of
          // failing and forcing a spacer-child rewrite.
          promoteParentToFrame = true;
        } else if (parent.type !== "frame") {
          throw new Error(
            `create_image parent ${parentId} is a ${parent.type}; images can only be inserted into frame, artboard, or rectangle parents.`,
          );
        }
        if (pageId && store.getPageIdForNode(parentId) !== pageId) {
          throw new Error(`Parent ${parentId} does not belong to page ${pageId}`);
        }
      } else if (pageId) {
        requirePage(store, pageId);
      }
      if (layout === "flow" && !parentId) {
        throw new Error('create_image layout:"flow" requires parentId.');
      }
      if (layout === "flow" && (x !== undefined || y !== undefined)) {
        throw new Error(
          'create_image layout:"flow" participates in parent layout and forbids x/y.',
        );
      }
      if (layout === "flow") {
        const parent = store.getNode(parentId!)!;
        if (!isFlowLayoutDisplay(parent.styles.display)) {
          throw new Error(
            `create_image layout:"flow" requires parent ${parent.id} to use display:flex or display:grid.`,
          );
        }
      }
      if (!parentId && (x === undefined) !== (y === undefined)) {
        throw new Error(
          "A root create_image requires x and y together, or neither for auto placement.",
        );
      }

      const naturalSize = await measureImageSource(dataUrl);
      const asset = await uploadImageAssetFromDataUrl(dataUrl, naturalSize, name);
      const size = resolveImageNodeSize(naturalSize, width, height);
      const position =
        layout === "flow" ? undefined : resolveImageInsertPosition(store, parentId, x, y);
      if (promoteParentToFrame) store.runtime.updateNode(parentId!, { type: "frame" });
      const node = store.runtime.createImage(
        asset,
        size,
        position,
        name ?? asset.sourceName ?? "Image",
        parentId,
        { pageId, layout },
      );
      if (locked === true) store.runtime.updateNode(node.id, { locked: true });
      await waitForAnimationFrames(2);
      return {
        ...serializeNodeForMcp(store, node),
        placementWarnings: await collectPlacementWarnings(store, [node]),
        ...(promoteParentToFrame ? { parentPromotedToFrame: parentId } : {}),
      };
    },

    create_artboard: async (params) => {
      const {
        name,
        styles: requestedStyles,
        x,
        y,
        nextTo,
        pageId,
      } = params as {
        name: string;
        styles: Record<string, string | number>;
        x?: number;
        y?: number;
        nextTo?: string;
        pageId?: string;
      };
      if ((x === undefined) !== (y === undefined)) {
        throw new Error(
          "create_artboard requires x and y together, or neither for auto placement.",
        );
      }
      if (nextTo !== undefined && x !== undefined) {
        throw new Error("create_artboard accepts either nextTo or exact x/y placement, not both.");
      }
      const preparedGeneration = prepareArtboardImageGeneration(requestedStyles);
      assertImageGenerationAvailable(preparedGeneration.url ? [preparedGeneration.url] : []);
      const styles = preparedGeneration.styles;
      const destinationPage = pageId ? requirePage(store, pageId) : store.activePage;
      let preferredNear;
      if (nextTo !== undefined) {
        preferredNear = destinationPage.nodes.find((root) => root.id === nextTo);
        if (!preferredNear) {
          throw new Error(
            `create_artboard nextTo must reference a root node on the destination page: ${nextTo}`,
          );
        }
      }
      const shouldFrameFirstArtboard =
        destinationPage.id === store.activePageId && destinationPage.nodes.length === 0;
      const node = store.runtime.createArtboard(name, styles, {
        ...(x !== undefined && y !== undefined ? { position: { x, y } } : {}),
        ...(preferredNear ? { preferredNear } : {}),
        pageId,
      });
      await waitForAnimationFrames(2);
      if (shouldFrameFirstArtboard) {
        const camera = computeCenteredCameraForBounds(
          { x: node.x, y: node.y, width: node.width, height: node.height },
          {
            width: store.viewportWidth || window.innerWidth,
            height: store.viewportHeight || window.innerHeight,
          },
          { padding: 50, maxZoom: 1 },
        );
        if (camera) store.setViewport(camera);
      }
      const imageGeneration = preparedGeneration.url
        ? startMcpImageGenerations(store, [
            { nodeId: node.id, target: "background", url: preparedGeneration.url },
          ])
        : {};
      return {
        ...serializeNodeForMcp(store, node),
        placementWarnings: await collectPlacementWarnings(store, [node]),
        ...imageGeneration,
      };
    },

    rename_file: async (params) => {
      const rawName = params.name;
      const name = typeof rawName === "string" ? rawName.trim() : "";
      if (!name) throw new Error("rename_file requires a non-empty name. No changes were made.");
      let access;
      try {
        access = getCollaborationContext();
      } catch {
        access = null;
      }
      if (!access?.renameFile) {
        throw new Error(
          "rename_file is not available for this document: its runtime cannot rename files. No changes were made.",
        );
      }
      const previousName = access.currentFile.name;
      const renamed = await access.renameFile(name);
      return { fileId: renamed.fileId, name: renamed.name, previousName };
    },

    write_html: async (params) => {
      const {
        html: requestedHtml,
        targetNodeId,
        mode,
        flattenFixedAndSticky,
        returnTree,
      } = params as {
        html: string;
        targetNodeId: string;
        mode: "insert-children" | "replace";
        flattenFixedAndSticky?: boolean;
        returnTree?: boolean;
      };
      const preparedGeneration = prepareWriteHtmlImageGenerations(requestedHtml);
      assertImageGenerationAvailable(preparedGeneration.requests);
      const html = preparedGeneration.html;
      const target = store.getNode(targetNodeId);
      if (!target) throw new Error(`Node not found: ${targetNodeId}`);
      const parentId =
        mode === "insert-children" ? targetNodeId : (store.getParent(targetNodeId)?.id ?? null);

      const inspectionDoc = parseHtmlForInspection(html);
      const inspectionWrapper = inspectionDoc.body.firstElementChild;
      const importableRoots = inspectionWrapper
        ? Array.from(inspectionWrapper.children).filter(
            (element) => !["SCRIPT", "STYLE", "BR"].includes(element.tagName),
          )
        : [];
      if (importableRoots.length === 0) {
        if (html.trim()) {
          throw new Error(
            "write_html did not find any importable element roots. Pass real HTML elements (not escaped &lt;...&gt; text, bare text, scripts, styles, or <br> alone). No changes were made.",
          );
        }
        throw new Error(
          "write_html requires at least one importable HTML element. Use delete_nodes when the intent is to remove a layer. No changes were made.",
        );
      }
      const { families, requests } = collectFontLoadRequests(inspectionDoc);
      const fontWarnings: string[] = [];
      if (families.length > 0) {
        const fontInfo = await getFontFamilyInfo(families);
        for (const [family, info] of Object.entries(fontInfo)) {
          if (!info.available) {
            fontWarnings.push(
              `Font family "${family}" was not found locally or on Google Fonts — text using it renders with a fallback font. Use get_font_family_info to check candidates, or pick an available family.`,
            );
          }
        }
      }
      const fontFaceSet = (
        document as Document & {
          fonts?: { load: (font: string) => Promise<unknown>; ready: Promise<unknown> };
        }
      ).fonts;
      if (fontFaceSet) {
        await Promise.all(
          requests.map((request) => fontFaceSet.load(request).catch(() => undefined)),
        );
        await fontFaceSet.ready;
      }

      const styleWarnings = [
        ...collectInlineStyleWarnings(inspectionDoc),
        ...collectStyledInlineSpanWarnings(inspectionDoc),
      ];
      const svgWarnings = collectExternalSvgUseWarnings(inspectionDoc);
      const created = store.runtime.writeHtml(html, targetNodeId, mode, {
        flattenFixedAndSticky: flattenFixedAndSticky ?? false,
      });
      if (created.length === 0) {
        throw new Error(
          "write_html produced zero Leaf nodes. Wrap the content in a renderable element and retry.",
        );
      }
      // Load any Google Fonts referenced in the new nodes
      loadFontsForNodeTree(created);
      await waitForAnimationFrames(2);
      const layerWarnings = collectGenericLayerWarnings(created);
      const imageGeneration = startMcpImageGenerations(store, preparedGeneration.requests);
      return {
        mode,
        targetNodeId,
        parentId,
        replacedNodeId: mode === "replace" ? targetNodeId : null,
        createdNodeCount: countCreatedNodes(created),
        created: created.map((n) => ({
          id: n.id,
          type: getMcpNodeType(store, n),
          name: n.name,
          childCount: n.children.length,
        })),
        ...(returnTree !== false && {
          createdTree: created.map((node) => summarizeCreatedNode(store, node)),
        }),
        ...(fontWarnings.length > 0 && { fontWarnings }),
        ...(styleWarnings.length > 0 && { styleWarnings }),
        ...(svgWarnings.length > 0 && { svgWarnings }),
        ...(layerWarnings.length > 0 && { layerWarnings }),
        ...imageGeneration,
      };
    },

    create_ink: async (params) => {
      const { strokes, parentId, pageId } = params as {
        strokes: Array<{
          points: Array<{ x: number; y: number; pressure?: number }>;
          color?: string;
          size?: number;
          name?: string;
        }>;
        parentId?: string;
        pageId?: string;
      };
      const created = strokes.map((stroke) => {
        const useRealPressure = stroke.points.some((point) => point.pressure !== undefined);
        const inkPoints = stroke.points.map((p) => ({
          x: p.x,
          y: p.y,
          pressure: p.pressure ?? 0.5,
        }));
        const shape = buildInkShape(inkPoints, useRealPressure, stroke.color, stroke.size);
        if (!shape) throw new Error("Failed to build ink shape from provided points");
        return store.runtime.createSvg(
          shape.svgMarkup,
          shape.bounds,
          { x: shape.bounds.x, y: shape.bounds.y },
          stroke.name ?? "Ink Stroke",
          parentId,
          { pageId },
        );
      });
      await waitForAnimationFrames(2);
      return {
        created: created.map((node) => serializeNodeForMcp(store, node)),
        placementWarnings: await collectPlacementWarnings(store, created),
      };
    },
  } satisfies RendererHandlerMap;
}
