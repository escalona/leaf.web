import { action } from "mobx";
import { useCallback, useEffect, type RefObject } from "react";
import { getFlexFlowChildren } from "../../core/editor/interaction/flex-insertion";
import { getNodeCanvasRect } from "../canvas-overlay/live-node-geometry";
import type { EditorStore } from "../../core/state/EditorStore";
import { getFlexAxis, getTopLevelDraggedIds } from "./interaction-helpers";
import type { MovingDragCommit, ViewportInteractionCoordinator } from "./interaction-coordinator";
import { timeLeafPerfTrace } from "../../core/lib/perf-trace";

export function useMovingDrag({
  endHistoryTransaction,
  interaction,
  store,
  viewportRef,
}: {
  endHistoryTransaction: () => void;
  interaction: ViewportInteractionCoordinator;
  store: EditorStore;
  viewportRef: RefObject<HTMLDivElement | null>;
}) {
  const flushPendingMovingDragCommit = useCallback(
    () => interaction.flushPendingMovingDragCommit(),
    [interaction],
  );

  useEffect(
    () => () => {
      flushPendingMovingDragCommit();
    },
    [flushPendingMovingDragCommit],
  );

  const clearMovingDragGeometry = useCallback(() => {
    store.dragCanvasOffset.clear();
    store.dragDetachedIds.clear();
  }, [store]);

  const clearMovingDragState = useCallback(
    (options?: { preserveGeometry?: boolean }) => {
      if (!options?.preserveGeometry) clearMovingDragGeometry();
      store.dragPendingParentIds.clear();
      store.snapGuides = [];
      store.dragInsertionPreview = null;
      store.clearHoveredNode();
      interaction.clearTargetCaches();
    },
    [clearMovingDragGeometry, interaction, store],
  );

  const applyMovingDragCommits = useCallback(
    action((commits: MovingDragCommit[]) => {
      for (const commit of commits) {
        if (commit.type === "moveNodeToParent") {
          store.runtime.moveNodeToParent(
            commit.nodeId,
            commit.canvasPosition,
            commit.newParentId,
            commit.options,
          );
          continue;
        }

        store.runtime.updateNode(commit.nodeId, commit.position);
      }
    }),
    [store],
  );

  const captureMovingDragCommits = useCallback(() => {
    const state = interaction.dragState;
    if (state.type !== "moving") return [] as MovingDragCommit[];

    const draggedRootIds = getTopLevelDraggedIds(store, state.startPositions.keys());
    const commits: MovingDragCommit[] = [];

    for (const id of draggedRootIds) {
      const node = store.getNode(id);
      if (!node) continue;

      const currentParent = store.getParent(id);
      const currentFlexParent =
        currentParent?.type === "frame" && getFlexAxis(currentParent) ? currentParent : null;
      const insertionPreview =
        store.dragInsertionPreview?.nodeId === id ? store.dragInsertionPreview : null;
      const pendingParentId = store.dragPendingParentIds.get(id);
      const isDetached = store.dragDetachedIds.has(id);
      const isFlexGhost = !!(
        currentFlexParent &&
        !isDetached &&
        node.styles.position === "relative"
      );
      const flowRestore = state.flowRestoreStates.get(id);

      if (insertionPreview) {
        const canvasRect = getNodeCanvasRect(node, store, viewportRef.current);
        commits.push({
          type: "moveNodeToParent",
          nodeId: id,
          canvasPosition: { x: canvasRect.x, y: canvasRect.y },
          newParentId: insertionPreview.parentId,
          options: flowRestore
            ? { flowRestore, index: insertionPreview.index, mode: "flow" }
            : { index: insertionPreview.index, mode: "flow" },
        });
        continue;
      }

      if (isFlexGhost) {
        const canvasRect = getNodeCanvasRect(node, store, viewportRef.current);

        if (pendingParentId && pendingParentId !== currentParent?.id) {
          commits.push({
            type: "moveNodeToParent",
            nodeId: id,
            canvasPosition: { x: canvasRect.x, y: canvasRect.y },
            newParentId: pendingParentId,
          });
        } else if (pendingParentId === null) {
          commits.push({
            type: "moveNodeToParent",
            nodeId: id,
            canvasPosition: { x: canvasRect.x, y: canvasRect.y },
          });
        } else {
          const currentFlowIndex = getFlexFlowChildren(currentFlexParent.children).indexOf(node);
          if (currentFlowIndex !== -1) {
            commits.push({
              type: "moveNodeToParent",
              nodeId: id,
              canvasPosition: { x: canvasRect.x, y: canvasRect.y },
              newParentId: currentFlexParent.id,
              options: flowRestore
                ? { flowRestore, index: currentFlowIndex, mode: "flow" }
                : { index: currentFlowIndex, mode: "flow" },
            });
          }
        }
        continue;
      }

      if (isDetached) {
        const canvasRect = getNodeCanvasRect(node, store, viewportRef.current);

        if (pendingParentId && pendingParentId !== currentParent?.id) {
          commits.push({
            type: "moveNodeToParent",
            nodeId: id,
            canvasPosition: { x: canvasRect.x, y: canvasRect.y },
            newParentId: pendingParentId,
          });
        } else if (pendingParentId === null) {
          commits.push({
            type: "moveNodeToParent",
            nodeId: id,
            canvasPosition: { x: canvasRect.x, y: canvasRect.y },
          });
        } else if (currentParent) {
          const parentCanvasPosition = store.getCanvasPosition(currentParent.id) ?? {
            x: currentParent.x,
            y: currentParent.y,
          };
          commits.push({
            type: "updateNodePosition",
            nodeId: id,
            position: {
              x: canvasRect.x - parentCanvasPosition.x,
              y: canvasRect.y - parentCanvasPosition.y,
            },
          });
        }
      } else if (pendingParentId && pendingParentId !== currentParent?.id) {
        const canvasRect = getNodeCanvasRect(node, store, viewportRef.current);
        commits.push({
          type: "moveNodeToParent",
          nodeId: id,
          canvasPosition: { x: canvasRect.x, y: canvasRect.y },
          newParentId: pendingParentId,
        });
      }
    }

    return commits;
  }, [interaction, store, viewportRef]);

  const scheduleMovingDragCommit = useCallback(
    (
      commits: MovingDragCommit[],
      options?: {
        preserveGeometryUntilCommit?: boolean;
      },
    ) => {
      flushPendingMovingDragCommit();

      if (commits.length === 0) {
        if (options?.preserveGeometryUntilCommit) clearMovingDragGeometry();
        endHistoryTransaction();
        return;
      }

      interaction.deferMovingDragCommit(
        action(() => {
          applyMovingDragCommits(commits);
          if (options?.preserveGeometryUntilCommit) clearMovingDragGeometry();
          endHistoryTransaction();
        }),
      );
    },
    [
      applyMovingDragCommits,
      clearMovingDragGeometry,
      endHistoryTransaction,
      flushPendingMovingDragCommit,
      interaction,
    ],
  );

  const finishMovingDrag = useCallback(() => {
    const commits = timeLeafPerfTrace("drag.captureCommits", captureMovingDragCommits);
    const requiresDeferredStructure = commits.some((commit) => commit.type === "moveNodeToParent");
    timeLeafPerfTrace("drag.clearState", () => {
      clearMovingDragState({ preserveGeometry: requiresDeferredStructure });
    });
    interaction.dragState = { type: "idle" };
    if (requiresDeferredStructure) {
      scheduleMovingDragCommit(commits, { preserveGeometryUntilCommit: true });
      return;
    }
    timeLeafPerfTrace("drag.applyCommits", () => {
      applyMovingDragCommits(commits);
    });
    timeLeafPerfTrace("drag.clearState", clearMovingDragState);
    endHistoryTransaction();
  }, [
    applyMovingDragCommits,
    captureMovingDragCommits,
    clearMovingDragState,
    endHistoryTransaction,
    interaction,
    scheduleMovingDragCommit,
  ]);

  return {
    clearMovingDragState,
    finishMovingDrag,
    flushPendingMovingDragCommit,
  };
}
