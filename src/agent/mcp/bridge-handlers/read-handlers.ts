import type { DesignNode } from "../../../core/types";
import { generateJsx, getComputedStyles } from "../../../core/editor/serialization";
import { getFontFamilyInfo, getLoadedGoogleFonts } from "../../../core/fonts/loader";
import { listPages } from "../page-operations";
import { withMcpPageRenderStore } from "../../../ui/render/render-replica";
import {
  collectSubtreeTargets,
  countNodes,
  formatCompactMcpNodePlacement,
  formatReportedDimension,
  getMcpImageGenerationStatus,
  getMcpNodeType,
  getReportedSize,
  getTextLayoutMetrics,
  measureTextNodes,
  requirePage,
  resolvePageScope,
  serializeNodeForMcp,
  serializeNodeFullForMcp,
  withMeasuredNodes,
} from "../node-inspection";
import type { RendererHandlerContext, RendererHandlerMap } from "./types";

export function createReadHandlers(context: RendererHandlerContext) {
  const { store, getCurrentFileInfo, listOpenDocuments } = context;
  return {
    list_pages: async (_params) => {
      return listPages(store);
    },

    get_basic_info: async (params) => {
      const { allPages, pages } = resolvePageScope(store, params);
      const pageContents = [];
      for (const page of pages) {
        pageContents.push(
          await withMcpPageRenderStore(store, page.id, async (renderStore) => {
            const renderPage = requirePage(renderStore, page.id);
            return await withMeasuredNodes(
              renderStore,
              renderPage.nodes.map((node) => ({ node })),
              () => ({
                pageId: page.id,
                pageName: page.name,
                active: page.id === store.activePageId,
                rootCount: renderPage.nodes.length,
                nodeCount: countNodes(renderPage.nodes),
                artboards: renderPage.nodes
                  .filter((node) => node.isArtboard)
                  .map((node) => serializeNodeForMcp(renderStore, node)),
                nodes: renderPage.nodes.map((node) => serializeNodeForMcp(renderStore, node)),
              }),
            );
          }),
        );
      }
      const selected = pageContents[0]!;

      return {
        nodeCount: pageContents.reduce((total, page) => total + page.nodeCount, 0),
        rootCount: pageContents.reduce((total, page) => total + page.rootCount, 0),
        activePageId: store.activePageId,
        pages: listPages(store).map(({ camera: _camera, ...page }) => page),
        zoom: store.zoom,
        panX: store.panX,
        panY: store.panY,
        activeTool: store.activeTool,
        ...(allPages
          ? { pageContents }
          : {
              pageId: selected.pageId,
              pageName: selected.pageName,
              pageActive: selected.active,
              artboards: selected.artboards,
              nodes: selected.nodes,
            }),
        loadedFonts: getLoadedGoogleFonts(),
        file: getCurrentFileInfo(),
      };
    },

    get_selection: async (_params) => {
      const selected = store.selectedNodes;
      const pageId = selected[0] ? store.getPageIdForNode(selected[0].id) : null;
      if (!pageId) return { count: 0, nodes: [] };
      return await withMcpPageRenderStore(store, pageId, async (renderStore) => {
        const renderNodes = selected.map((node) => renderStore.getNode(node.id)!);
        const targets = renderNodes.map((node) => ({ node, withTextLayout: true }));
        return await withMeasuredNodes(renderStore, targets, () => ({
          count: renderNodes.length,
          nodes: renderNodes.map((node) => serializeNodeFullForMcp(renderStore, node)),
        }));
      });
    },

    get_tree_summary: async (params) => {
      const depth = (params.depth as number) ?? 3;
      if (!Number.isInteger(depth) || depth < 0 || depth > 10) {
        throw new Error("Tree summary depth must be an integer between 0 and 10.");
      }
      const nodeId = params.nodeId as string | undefined;
      const pageId = params.pageId as string | undefined;
      const allPages = params.allPages === true;
      if (nodeId && (pageId || allPages)) {
        throw new Error("get_tree_summary nodeId cannot be combined with pageId or allPages.");
      }
      if (pageId && allPages) {
        throw new Error("get_tree_summary pageId and allPages cannot be combined.");
      }

      function formatTree(
        measurementStore: typeof store,
        node: DesignNode,
        indent: number,
        maxDepth: number,
        includeTextLayout: boolean,
      ): string {
        const prefix = "  ".repeat(indent);
        const type = getMcpNodeType(measurementStore, node);
        const size = getReportedSize(measurementStore, node);
        let line = `${prefix}[${type}] "${node.name}" (${node.id}) ${formatReportedDimension(size, "width")}×${formatReportedDimension(size, "height")}`;
        const placement = formatCompactMcpNodePlacement(measurementStore, node);
        if (placement) line += ` at ${placement}`;
        // A subtree cannot span pages, so the page is named once on the root
        // line instead of repeated on every descendant.
        if (indent === 0) {
          const ownerPageId = measurementStore.getPageIdForNode(node.id);
          const ownerPage = ownerPageId
            ? measurementStore.pages.find((candidate) => candidate.id === ownerPageId)
            : undefined;
          line += `; ${ownerPage ? `page "${ownerPage.name}" (${ownerPage.id})` : "unresolved page"}`;
        }
        if (size.measurementUnavailable) line += ` [${size.measurementUnavailable}]`;
        const textLayout = includeTextLayout ? getTextLayoutMetrics(measurementStore, node) : null;
        if (textLayout) {
          line += `; text content ${textLayout.contentWidth}×${textLayout.contentHeight}`;
          if (textLayout.overflowX || textLayout.overflowY) {
            const axes = [
              ...(textLayout.overflowX ? ["x"] : []),
              ...(textLayout.overflowY ? ["y"] : []),
            ];
            line += ` [text overflow: ${axes.join(", ")}]`;
          }
        }
        if (indent < maxDepth && node.children.length > 0) {
          for (const child of node.children) {
            line +=
              "\n" + formatTree(measurementStore, child, indent + 1, maxDepth, includeTextLayout);
          }
        } else if (node.children.length > 0) {
          line += ` [${node.children.length} children]`;
        }
        return line;
      }

      if (nodeId) {
        const node = store.getNode(nodeId);
        if (!node) throw new Error(`Node not found: ${nodeId}`);
        const ownerPageId = store.getPageIdForNode(node.id);
        if (!ownerPageId) throw new Error(`Cannot resolve page for node: ${nodeId}`);
        return await withMcpPageRenderStore(store, ownerPageId, async (renderStore) => {
          const renderNode = renderStore.getNode(nodeId);
          if (!renderNode) throw new Error(`Node not found: ${nodeId}`);
          const targets = collectSubtreeTargets(renderNode, depth, true);
          return await withMeasuredNodes(renderStore, targets, () =>
            formatTree(renderStore, renderNode, 0, depth, true),
          );
        });
      }

      const pages = allPages
        ? store.pages
        : [pageId ? requirePage(store, pageId) : store.activePage];
      const summaries: string[] = [];
      for (const page of pages) {
        summaries.push(
          await withMcpPageRenderStore(store, page.id, async (renderStore) => {
            const renderPage = requirePage(renderStore, page.id);
            const targets = renderPage.nodes.flatMap((node) =>
              collectSubtreeTargets(node, depth, false),
            );
            return await withMeasuredNodes(renderStore, targets, () => {
              const heading = `Page "${page.name}" (${page.id})${page.id === store.activePageId ? " [active]" : ""}`;
              const tree =
                renderPage.nodes.length > 0
                  ? renderPage.nodes
                      .map((node) => formatTree(renderStore, node, 0, depth, false))
                      .join("\n")
                  : "(empty)";
              return `${heading}\n${tree}`;
            });
          }),
        );
      }
      return summaries.join("\n\n");
    },

    get_node_info: async (params) => {
      const node = store.getNode(params.nodeId as string);
      if (!node) throw new Error(`Node not found: ${String(params.nodeId)}`);
      const pageId = store.getPageIdForNode(node.id);
      if (!pageId) throw new Error(`Cannot resolve page for node: ${node.id}`);
      return await withMcpPageRenderStore(store, pageId, async (renderStore) => {
        const renderNode = renderStore.getNode(node.id);
        if (!renderNode) throw new Error(`Node not found: ${node.id}`);
        return await withMeasuredNodes(
          renderStore,
          [{ node: renderNode, withTextLayout: true }],
          () => serializeNodeFullForMcp(renderStore, renderNode),
        );
      });
    },

    get_image_generation_status: async (params) => {
      const nodeIds = params.nodeIds as string[];
      const now = Date.now();
      return {
        statuses: nodeIds.map((nodeId) => {
          const node = store.getNode(nodeId);
          if (!node) return { nodeId, status: "missing" as const };
          const generation = getMcpImageGenerationStatus(store, node, now);
          if (!generation) return { nodeId, status: "none" as const };
          return {
            nodeId,
            ...generation,
            ...(node.imageAsset?.assetId ? { assetId: node.imageAsset.assetId } : {}),
          };
        }),
      };
    },

    get_computed_styles: async (params) => {
      const nodeIds = params.nodeIds as string[];
      const result: Record<string, Record<string, unknown>> = {};
      for (const id of nodeIds) {
        const node = store.getNode(id);
        if (!node) throw new Error(`Node not found: ${id}`);
        result[id] = getComputedStyles(node);
      }
      return result;
    },

    measure_text: async (params) => {
      return await measureTextNodes(store, params.nodeIds as string[]);
    },

    get_jsx: async (params) => {
      const node = store.getNode(params.nodeId as string);
      if (!node) throw new Error(`Node not found: ${String(params.nodeId)}`);
      return generateJsx(node, 0);
    },

    get_font_family_info: async (params) => {
      const familyNames = params.familyNames as string[];
      return getFontFamilyInfo(familyNames);
    },

    get_document_context: async (_params) => {
      // Electron intercepts this method with a main-process handler that
      // reports native .leaf document identity. This renderer fallback serves
      // web/dev mode from the collaboration context.
      const file = getCurrentFileInfo();
      if (!file) return null;
      return {
        dirty: null,
        displayName: file.name,
        documentId: `${file.fileId}:${file.branchId}`,
        filePath: null,
        kind: "collaboration",
      };
    },

    list_documents: async (_params) => {
      // Electron intercepts this method to enumerate native document windows.
      // Web/dev mode enumerates every open collaboration tab; background tabs
      // stay addressable by documentId without being focused.
      return { documents: listOpenDocuments() };
    },

    use_focused_document: async (_params) => {
      // Electron intercepts this method to rebind main-process window
      // targeting. Web/dev mode has a single window, so there is nothing
      // to retarget.
      const file = getCurrentFileInfo();
      return {
        document: file
          ? {
              dirty: null,
              displayName: file.name,
              documentId: `${file.fileId}:${file.branchId}`,
              filePath: null,
              kind: "collaboration",
            }
          : null,
        retargeted: false,
      };
    },
  } satisfies RendererHandlerMap;
}
