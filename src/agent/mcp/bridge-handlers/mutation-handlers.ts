import type { DesignNode } from "../../../core/types";
import type { StylePatch } from "../../../core/editor/style-mutation";
import type { EditorStore } from "../../../core/state/EditorStore";
import { ensureFontsLoaded } from "../../../core/fonts/loader";
import {
  collectPlacementWarnings,
  isAncestorOf,
  requirePage,
  serializeNodeForMcp,
  withMeasuredNodes,
} from "../node-inspection";
import { withMcpPageRenderStore } from "../../../ui/render/render-replica";
import { waitForAnimationFrames } from "../../../ui/render/render-settle";
import {
  assertImageGenerationAvailable,
  assertMcpImageGenerationTargets,
  prepareStyleImageGenerations,
  startMcpImageGenerations,
} from "../image-generation";
import type { RendererHandlerContext, RendererHandlerMap } from "./types";

const POSITION_OFFSET_STYLE_KEYS = new Set(["left", "top", "right", "bottom", "inset"]);

type StyleUpdateEntry = { nodeIds: string[]; styles: StylePatch };
type PositionUpdate = { nodeId: string; x?: number; y?: number };

function parsePixelOffset(key: string, value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const match = /^(-?\d+(?:\.\d+)?)(?:px)?$/.exec(value.trim());
    if (match) return Number(match[1]);
  }
  throw new Error(
    `update_styles ${key} must be a pixel value (120 or "120px") because Leaf stores absolute placement as model x/y. Use move_nodes for other coordinate spaces. No changes were made.`,
  );
}

/**
 * Leaf places absolute nodes through a renderer-owned translate of model x/y,
 * and the HTML importer folds authored left/top into those fields. A raw CSS
 * `top` written through update_styles would stack on that translate and shove
 * the node off its slot, so fold left/top the same way the importer does and
 * refuse the offsets that have no model equivalent.
 */
function extractPositionOffsets(store: EditorStore, updates: StyleUpdateEntry[]) {
  const styleUpdates: StyleUpdateEntry[] = [];
  const positionUpdates: PositionUpdate[] = [];
  for (const { nodeIds, styles } of updates) {
    const offsets: Record<string, unknown> = {};
    const rest: StylePatch = {};
    for (const [key, value] of Object.entries(styles)) {
      if (POSITION_OFFSET_STYLE_KEYS.has(key)) offsets[key] = value;
      else rest[key] = value;
    }
    const offsetKeys = Object.keys(offsets);
    if (offsetKeys.length === 0) {
      styleUpdates.push({ nodeIds, styles });
      continue;
    }
    for (const key of offsetKeys) {
      if (key !== "left" && key !== "top") {
        throw new Error(
          `update_styles does not accept ${key}: Leaf places absolute nodes by model x/y. Set left/top (folded into x/y) or use move_nodes. No changes were made.`,
        );
      }
    }
    if (Object.keys(rest).length > 0) styleUpdates.push({ nodeIds, styles: rest });
    const x = offsets.left == null ? undefined : parsePixelOffset("left", offsets.left);
    const y = offsets.top == null ? undefined : parsePixelOffset("top", offsets.top);
    if (x === undefined && y === undefined) continue;
    for (const nodeId of nodeIds) {
      if (!store.getNode(nodeId)) throw new Error(`Node not found: ${nodeId}`);
      if (store.isFlowChild(nodeId)) {
        throw new Error(
          `Cannot manually position normal-flow node ${nodeId}. Make it absolute or arrange it through its flex/grid parent. No changes were made.`,
        );
      }
      positionUpdates.push({
        nodeId,
        ...(x !== undefined ? { x } : {}),
        ...(y !== undefined ? { y } : {}),
      });
    }
  }
  return { styleUpdates, positionUpdates };
}

export function createMutationHandlers(context: RendererHandlerContext) {
  const { activityAgent, store } = context;
  return {
    update_styles: async (params) => {
      const updates = params.updates as StyleUpdateEntry[];
      const { styleUpdates, positionUpdates } = extractPositionOffsets(store, updates);
      const prepared = prepareStyleImageGenerations(styleUpdates);
      assertImageGenerationAvailable(prepared.requests);
      assertMcpImageGenerationTargets(store, prepared.requests);
      const updated = store.runtime.updateStyles(prepared.updates, ensureFontsLoaded);
      for (const { nodeId, x, y } of positionUpdates) {
        store.runtime.updateNode(nodeId, {
          ...(x !== undefined ? { x } : {}),
          ...(y !== undefined ? { y } : {}),
        });
        if (!updated.includes(nodeId)) updated.push(nodeId);
      }
      return {
        updated,
        ...(positionUpdates.length > 0
          ? { positionedFromOffsets: positionUpdates.map(({ nodeId }) => nodeId) }
          : {}),
        ...startMcpImageGenerations(store, prepared.requests),
      };
    },

    set_text_content: async (params) => {
      const updates = params.updates as Array<{
        nodeId: string;
        textContent: string;
      }>;
      return { updated: store.runtime.setTextContent(updates) };
    },

    duplicate_nodes: async (params) => {
      const nodesToDupe = params.nodes as Array<{
        id: string;
        parentId?: string;
      }>;
      const duplicated = store.runtime.duplicateNodes(nodesToDupe);
      await waitForAnimationFrames(2);
      const createdNodes = duplicated.flatMap(({ newId }) => {
        const node = store.getNode(newId);
        return node ? [node] : [];
      });
      const placementWarnings = await collectPlacementWarnings(store, createdNodes);
      return duplicated.map((result) => {
        const node = store.getNode(result.newId);
        return {
          ...result,
          ...(node ? { placement: serializeNodeForMcp(store, node) } : {}),
          placementWarnings: placementWarnings.filter(
            (warning) => warning.nodeId === result.newId || warning.otherNodeId === result.newId,
          ),
        };
      });
    },

    delete_nodes: async (params) => {
      const nodeIds = params.nodeIds as string[];
      return { deleted: store.runtime.deleteNodes(nodeIds) };
    },

    rename_nodes: async (params) => {
      const updates = params.updates as Array<{
        nodeId: string;
        name: string;
      }>;
      return { renamed: store.runtime.renameNodes(updates) };
    },

    move_nodes: async (params) => {
      const moves = params.moves as Array<{
        nodeId: string;
        parentId?: string | null;
        index?: number;
        x?: number;
        y?: number;
        coordinateSpace?: "canvas" | "parent";
      }>;
      const prepared = moves.map(({ nodeId, parentId, index, x, y, coordinateSpace }) => {
        const node = store.getNode(nodeId);
        if (!node) throw new Error(`Node not found: ${nodeId}`);
        if (parentId != null && !store.getNode(parentId)) {
          throw new Error(`Parent not found: ${parentId}`);
        }
        if (parentId != null && isAncestorOf(store, nodeId, parentId)) {
          throw new Error(`Cannot move ${nodeId} into its own descendant ${parentId}`);
        }
        const hasPosition = x !== undefined || y !== undefined;
        if (hasPosition && (x === undefined || y === undefined)) {
          throw new Error(`Position for ${nodeId} must provide x and y together.`);
        }
        if (hasPosition && (!Number.isFinite(x) || !Number.isFinite(y))) {
          throw new Error(`Position for ${nodeId} must use finite x/y coordinates.`);
        }
        return {
          node,
          nodeId,
          parentId,
          index,
          x,
          y,
          coordinateSpace: coordinateSpace ?? "canvas",
          hasPosition,
          // Omitted parentId keeps the current parent; only an explicit
          // parentId (including null for the canvas root) or index reparents.
          reparent: parentId !== undefined || index !== undefined,
        };
      });

      const reparents = prepared.filter(({ reparent }) => reparent);
      const measurable = reparents
        .map(({ node }) => node)
        .filter((node) => store.getPageIdForNode(node.id) === store.activePageId);
      const canvasPositions = await withMeasuredNodes(
        store,
        measurable.map((node) => ({ node })),
        () =>
          new Map(
            reparents.map(({ node }) => [
              node.id,
              store.getCanvasPosition(node.id) ?? { x: node.x, y: node.y },
            ]),
          ),
      );

      for (const { nodeId, parentId, index } of reparents) {
        const canvasPosition = canvasPositions.get(nodeId)!;
        const destinationParentId =
          parentId === undefined ? store.getParent(nodeId)?.id : (parentId ?? undefined);
        // moveNodeToParent expects canvas coordinates and converts them to the
        // new parent's local space. Passing node.x/y here teleports nested
        // nodes because those model values are parent-relative.
        store.runtime.moveNodeToParent(nodeId, canvasPosition, destinationParentId, {
          index,
        });
      }
      if (reparents.length > 0) await waitForAnimationFrames(2);

      const positioned = prepared.filter(({ hasPosition }) => hasPosition);
      for (const { nodeId } of positioned) {
        if (store.isFlowChild(nodeId)) {
          throw new Error(
            `Cannot manually position normal-flow node ${nodeId}. Make it absolute or arrange it through its flex/grid parent.`,
          );
        }
      }
      const depthOf = (node: DesignNode) => {
        let depth = 0;
        let parent = store.getParent(node.id);
        while (parent) {
          depth += 1;
          parent = store.getParent(parent.id);
        }
        return depth;
      };
      const applicationOrder = positioned
        .map((entry) => ({ ...entry, depth: depthOf(entry.node) }))
        .sort((first, second) => first.depth - second.depth);
      let appliedDepth: number | null = null;
      for (const { coordinateSpace, node, x, y, depth } of applicationOrder) {
        if (appliedDepth !== null && depth !== appliedDepth) {
          // A shallower update can move a normal-flow ancestor whose canvas
          // position is DOM-derived. Let React commit and layout settle before
          // converting deeper canvas coordinates into parent-local offsets.
          await waitForAnimationFrames(2);
        }
        const parent = store.getParent(node.id);
        if (coordinateSpace === "parent" || !parent) {
          store.runtime.updateNode(node.id, { x: x!, y: y! });
          appliedDepth = depth;
          continue;
        }
        const parentCanvas = store.getCanvasPosition(parent.id);
        if (!parentCanvas) {
          throw new Error(`Cannot resolve canvas placement for parent ${parent.id}.`);
        }
        store.runtime.updateNode(node.id, {
          x: x! - parentCanvas.x,
          y: y! - parentCanvas.y,
        });
        appliedDepth = depth;
      }
      await waitForAnimationFrames(2);

      const moved = prepared.map(({ nodeId }) => nodeId);
      const finalNodes = moved.flatMap((nodeId) => {
        const node = store.getNode(nodeId);
        return node ? [node] : [];
      });
      return {
        moved,
        placements: prepared.flatMap((entry) => {
          const node = store.getNode(entry.nodeId);
          if (!node) return [];
          const serialized = serializeNodeForMcp(store, node);
          if (entry.hasPosition || !entry.reparent) return [serialized];
          const before = canvasPositions.get(node.id)!;
          return [
            {
              ...serialized,
              previousCanvasX: before.x,
              previousCanvasY: before.y,
              // canvasX/canvasY are omitted when they coincide with x/y.
              canvasPositionPreserved:
                Math.abs((serialized.canvasX ?? serialized.x) - before.x) < 0.01 &&
                Math.abs((serialized.canvasY ?? serialized.y) - before.y) < 0.01,
            },
          ];
        }),
        placementWarnings: await collectPlacementWarnings(store, finalNodes),
      };
    },

    set_node_visibility: async (params) => {
      const updates = params.updates as Array<{
        nodeId: string;
        visible?: boolean;
        locked?: boolean;
      }>;
      const updated: string[] = [];
      for (const { nodeId, visible, locked } of updates) {
        if (!store.getNode(nodeId)) throw new Error(`Node not found: ${nodeId}`);
        const patch: Partial<DesignNode> = {};
        if (visible !== undefined) patch.visible = visible;
        if (locked !== undefined) patch.locked = locked;
        if (Object.keys(patch).length === 0) continue;
        store.runtime.updateNode(nodeId, patch);
        updated.push(nodeId);
      }
      return {
        updated,
        nodes: updated.flatMap((nodeId) => {
          const node = store.getNode(nodeId);
          return node ? [serializeNodeForMcp(store, node)] : [];
        }),
      };
    },

    find_nodes: async (params) => {
      const {
        name,
        type,
        text,
        rootId,
        pageId,
        allPages = false,
        limit = 100,
      } = params as {
        name?: string;
        type?: string;
        text?: string;
        rootId?: string;
        pageId?: string;
        allPages?: boolean;
        limit?: number;
      };
      if (allPages && (pageId || rootId)) {
        throw new Error("find_nodes allPages cannot be combined with pageId or rootId.");
      }
      const scopedPage = pageId ? requirePage(store, pageId) : null;
      // `name` and `text` are documented as regular expressions, so a caller
      // pattern like `*Draft` reaches V8 verbatim. Name the offending field
      // instead of letting a bare "Invalid regular expression" reach the agent.
      const compilePattern = (pattern: string, field: string) => {
        try {
          return new RegExp(pattern, "i");
        } catch (error) {
          throw new Error(`find_nodes ${field} is not a valid regular expression: ${pattern}`, {
            cause: error,
          });
        }
      };
      const namePattern = name ? compilePattern(name, "name") : null;
      const textPattern = text ? compilePattern(text, "text") : null;

      // Collect one past the limit so overflow is actually observed: stopping at
      // exactly `limit` makes "found N with limit N" indistinguishable from
      // "skipped the rest". A truncated search therefore keeps walking until the
      // (limit + 1)-th match instead of short-circuiting at the limit — one extra
      // regex test per remaining node, the same order of work the already-common
      // non-truncated case does anyway.
      const collected: DesignNode[] = [];
      const visit = (node: DesignNode) => {
        if (collected.length > limit) return;
        const matchesName = !namePattern || namePattern.test(node.name);
        const matchesType = !type || node.type === type;
        const matchesText = !textPattern || textPattern.test(node.content);
        if (matchesName && matchesType && matchesText) collected.push(node);
        for (const child of node.children) visit(child);
      };

      if (rootId) {
        const root = store.getNode(rootId);
        if (!root) throw new Error(`Node not found: ${rootId}`);
        if (scopedPage && store.getPageIdForNode(rootId) !== scopedPage.id) {
          throw new Error(`Node ${rootId} does not belong to page ${scopedPage.id}.`);
        }
        visit(root);
      } else if (allPages) {
        for (const page of store.pages) {
          for (const root of page.nodes) visit(root);
        }
      } else {
        for (const root of (scopedPage ?? store.activePage).nodes) visit(root);
      }

      // Slice before measuring: the overflow node must never reach
      // `withMeasuredNodes`, which would force-render and await frames for a node
      // that is not part of the response.
      const truncated = collected.length > limit;
      const matches = truncated ? collected.slice(0, limit) : collected;

      const serializedById = new Map<string, ReturnType<typeof serializeNodeForMcp>>();
      const matchesByPage = new Map<string, DesignNode[]>();
      for (const node of matches) {
        const ownerPageId = store.getPageIdForNode(node.id);
        if (!ownerPageId) continue;
        const pageMatches = matchesByPage.get(ownerPageId) ?? [];
        pageMatches.push(node);
        matchesByPage.set(ownerPageId, pageMatches);
      }
      for (const [ownerPageId, pageMatches] of matchesByPage) {
        await withMcpPageRenderStore(store, ownerPageId, async (renderStore) => {
          const renderNodes = pageMatches.flatMap((node) => {
            const renderNode = renderStore.getNode(node.id);
            return renderNode ? [renderNode] : [];
          });
          await withMeasuredNodes(
            renderStore,
            renderNodes.map((node) => ({ node })),
            () => {
              for (const renderNode of renderNodes) {
                serializedById.set(renderNode.id, serializeNodeForMcp(renderStore, renderNode));
              }
            },
          );
        });
      }
      return {
        matches: matches.flatMap((node) => {
          const serialized = serializedById.get(node.id);
          return serialized ? [serialized] : [];
        }),
        truncated,
        searchedPageIds: allPages
          ? store.pages.map((page) => page.id)
          : [
              scopedPage?.id ?? (rootId ? store.getPageIdForNode(rootId) : store.activePageId),
            ].filter((candidate): candidate is string => candidate !== null),
      };
    },

    finish_working_on_nodes: async (params) => {
      const requested = params.nodeIds as string[] | undefined;
      // The agent is done; echoing every released node ID back is pure payload.
      const releasedNodeIds = store.agentActivity.finish(activityAgent.id, requested);
      return { releasedCount: releasedNodeIds.length };
    },
  } satisfies RendererHandlerMap;
}
