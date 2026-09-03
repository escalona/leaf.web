import {
  activatePage,
  createPage,
  deletePage,
  duplicatePage,
  moveNodesToPage,
  renamePage,
  reorderPages,
} from "../page-operations";
import { collectPlacementWarnings, serializeNodeForMcp } from "../node-inspection";
import { waitForAnimationFrames } from "../../../ui/render/render-settle";
import type { RendererHandlerContext, RendererHandlerMap } from "./types";

export function createPageHandlers(context: RendererHandlerContext) {
  const { store } = context;

  async function moveNodes(nodeIds: string[], pageId: string) {
    for (const nodeId of nodeIds) {
      if (!store.getNode(nodeId)) throw new Error(`Node not found: ${nodeId}`);
    }
    const result = moveNodesToPage(store, nodeIds, pageId);
    const nodes = result.moved.flatMap((nodeId) => {
      const node = store.getNode(nodeId);
      return node ? [node] : [];
    });
    await waitForAnimationFrames(2);
    return {
      ...result,
      placements: nodes.map((node) => serializeNodeForMcp(store, node)),
      placementWarnings: await collectPlacementWarnings(store, nodes),
    };
  }

  return {
    edit_pages: async (params) => {
      const operations = params.operations as Array<Record<string, unknown>>;
      const results: unknown[] = [];
      const applyOperation = async (operation: Record<string, unknown>) => {
        switch (operation.action) {
          case "create": {
            const created = createPage(store, operation.name as string | undefined);
            results.push(
              operation.activate === true ? activatePage(store, created.page.id) : created,
            );
            break;
          }
          case "rename":
            results.push(renamePage(store, operation.pageId as string, operation.name as string));
            break;
          case "duplicate":
            results.push(duplicatePage(store, operation.pageId as string));
            break;
          case "reorder":
            results.push(reorderPages(store, operation.pageIds as string[]));
            break;
          case "set-active":
            results.push(activatePage(store, operation.pageId as string));
            break;
          case "move-nodes":
            results.push(
              await moveNodes(operation.nodeIds as string[], operation.pageId as string),
            );
            break;
          default:
            throw new Error(`Unknown edit_pages action: ${String(operation.action)}`);
        }
      };
      for (const [index, operation] of operations.entries()) {
        try {
          await applyOperation(operation);
        } catch (error) {
          // Earlier operations are already applied and synced; discarding
          // their results (a created page's ID, a duplicate's
          // descendantIdMap) would leave the agent unable to tell what
          // landed and invite duplicate retries of the whole batch.
          return {
            results,
            failedOperation: {
              index,
              action: String(operation.action),
              error: error instanceof Error ? error.message : String(error),
            },
          };
        }
      }
      return { results };
    },

    delete_page: async (params) => {
      return deletePage(store, params.pageId as string);
    },
  } satisfies RendererHandlerMap;
}
