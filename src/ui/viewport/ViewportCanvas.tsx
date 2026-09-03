import { observer } from "mobx-react-lite";
import { reaction, runInAction } from "mobx";
import { startTransition, useLayoutEffect, useState } from "react";
import { screenPoint } from "../../core/editor/interaction/coordinate-spaces";
import { intersectsCanvasBounds } from "../../core/editor/interaction/math";
import { hasUnsafeModelGeometry } from "../../core/editor/model-geometry";
import { useEditorStore } from "../../core/state/EditorStore";
import type { DesignNode } from "../../core/types";
import { RenderNode } from "../node-renderer/NodeRenderer";
import { CameraLayer } from "./CameraLayer";
import {
  advanceCanvasBoundsTowardTarget,
  areCanvasBoundsEqual,
  expandDetailBoundsForPan,
  expandMembershipBoundsForPan,
  getNodeModelCullRect,
  nodeClipsChildrenForCulling,
  quantizeCanvasBoundsOutward,
  unionCanvasBounds,
} from "./culling";
import { getDragRenderRoots, type CanvasBounds } from "./interaction-helpers";
import { RootFrameZoomLod, shouldUseRootFrameZoomLod } from "./RootFrameZoomLod";

const CULL_VISIBLE_DETAIL_OVERSCAN_SCREEN_PX = 384;
const CULL_MEMBERSHIP_OVERSCAN_VIEWPORTS = 3;

/**
 * Isolated observer for the camera container + node tree.
 * Separates camera reactivity (zoom/pan) from the parent Viewport's
 * pointer-handler state so that node-tree mutations don't force
 * re-evaluation of cursor/pointer logic and vice versa.
 */
export const ViewportCanvas = observer(
  ({ suppressNativeSelection }: { suppressNativeSelection: boolean }) => {
    const store = useEditorStore();

    // Mark this store as having a live canvas so DOM-dependent MCP reads know
    // whether waiting on live elements can ever succeed (see render-replica).
    useLayoutEffect(() => {
      store.registerCanvasMount();
      return () => store.releaseCanvasMount();
    }, [store]);

    // During camera motion, expand the rendered region to cover every newly visible
    // area without evicting the region Chrome has already rasterized. After motion
    // settles, converge back to the normal overscan window during idle time.
    const [viewportCanvasBounds, setViewportCanvasBounds] = useState<CanvasBounds | null>(null);
    const [progressiveDetailRootIds, setProgressiveDetailRootIds] = useState<Set<string>>(
      () => new Set(),
    );
    useLayoutEffect(() => {
      let appliedBounds: CanvasBounds | null = null;
      let appliedDetailBounds: CanvasBounds | null = null;
      let idleHandle: number | null = null;
      let promotionFrame = 0;
      const promotedRootIds = new Set<string>();
      let cameraBoundsExpanded = false;

      const cancelConvergence = () => {
        if (idleHandle === null) return;
        if (typeof cancelIdleCallback === "function") cancelIdleCallback(idleHandle);
        else window.clearTimeout(idleHandle);
        idleHandle = null;
      };

      const cancelPromotion = () => {
        if (!promotionFrame) return;
        cancelAnimationFrame(promotionFrame);
        promotionFrame = 0;
      };

      const releasePromotedRoots = () => {
        if (promotedRootIds.size === 0) return;
        promotedRootIds.clear();
        setProgressiveDetailRootIds(new Set());
      };

      const applyBounds = (bounds: CanvasBounds | null) => {
        appliedBounds = bounds;
        runInAction(() => store.setViewportCanvasBounds(bounds));
        setViewportCanvasBounds((previous) =>
          areCanvasBoundsEqual(previous, bounds) ? previous : bounds,
        );
      };

      const applyDetailBounds = (bounds: CanvasBounds | null) => {
        appliedDetailBounds = bounds;
        runInAction(() => store.setViewportDetailBounds(bounds));
      };

      const convergeToBounds = (
        target: CanvasBounds,
        detailTarget: CanvasBounds,
        onComplete?: () => void,
      ) => {
        const attempt = (deadline?: IdleDeadline) => {
          idleHandle = null;
          if (store.isZooming || store.isPanning) return;
          if (deadline && !deadline.didTimeout && deadline.timeRemaining() < 8) {
            schedule();
            return;
          }
          const step = 128 / Math.max(store.zoom, 0.001);
          const nextBounds = appliedBounds
            ? advanceCanvasBoundsTowardTarget(appliedBounds, target, step)
            : target;
          const nextDetailBounds = appliedDetailBounds
            ? advanceCanvasBoundsTowardTarget(appliedDetailBounds, detailTarget, step)
            : detailTarget;
          applyBounds(nextBounds);
          applyDetailBounds(nextDetailBounds);
          if (
            !areCanvasBoundsEqual(nextBounds, target) ||
            !areCanvasBoundsEqual(nextDetailBounds, detailTarget)
          ) {
            schedule();
          } else {
            onComplete?.();
          }
        };
        const schedule = () => {
          if (typeof requestIdleCallback === "function") {
            idleHandle = requestIdleCallback(attempt, { timeout: 250 });
          } else {
            idleHandle = window.setTimeout(() => attempt(), 16);
          }
        };
        schedule();
      };

      const promoteVisibleRootDetail = (
        visibleTarget: CanvasBounds,
        target: CanvasBounds,
        settledDetailTarget: CanvasBounds,
      ) => {
        cancelPromotion();
        const centerX = (visibleTarget.left + visibleTarget.right) / 2;
        const centerY = (visibleTarget.top + visibleTarget.bottom) / 2;
        const candidates = store.nodes
          .filter((node) => {
            if (node.children.length === 0 || promotedRootIds.has(node.id)) return false;
            const rect = getNodeModelCullRect(node);
            if (!intersectsCanvasBounds(rect, visibleTarget)) return false;
            return !appliedDetailBounds || !intersectsCanvasBounds(rect, appliedDetailBounds);
          })
          .sort((left, right) => {
            const leftRect = getNodeModelCullRect(left);
            const rightRect = getNodeModelCullRect(right);
            const leftDistance =
              Math.abs(leftRect.x + leftRect.width / 2 - centerX) +
              Math.abs(leftRect.y + leftRect.height / 2 - centerY);
            const rightDistance =
              Math.abs(rightRect.x + rightRect.width / 2 - centerX) +
              Math.abs(rightRect.y + rightRect.height / 2 - centerY);
            return leftDistance - rightDistance;
          });
        let nextIndex = 0;

        const finish = () => {
          // Keep promoted roots detailed while the ordinary rectangular detail
          // window catches up. Releasing the local pins after convergence cannot
          // mount or unmount any subtree.
          convergeToBounds(target, settledDetailTarget, () => {
            promotionFrame = requestAnimationFrame(() => {
              promotionFrame = 0;
              releasePromotedRoots();
            });
          });
        };

        const promoteBatch = () => {
          promotionFrame = 0;
          if (store.isZooming || store.isPanning) return;
          const end = Math.min(candidates.length, nextIndex + 1);
          while (nextIndex < end) promotedRootIds.add(candidates[nextIndex++]!.id);
          startTransition(() => setProgressiveDetailRootIds(new Set(promotedRootIds)));
          if (nextIndex < candidates.length) {
            promotionFrame = requestAnimationFrame(promoteBatch);
          } else {
            finish();
          }
        };

        if (candidates.length === 0) finish();
        else promotionFrame = requestAnimationFrame(promoteBatch);
      };

      const dispose = reaction(
        (): {
          target: CanvasBounds | null;
          settledDetailTarget: CanvasBounds | null;
          visibleDetailTarget: CanvasBounds | null;
          isPanning: boolean;
          isZooming: boolean;
          useRootFrameZoomLod: boolean;
        } => {
          const viewportWidth = store.viewportWidth;
          const viewportHeight = store.viewportHeight;
          const isPanning = store.isPanning;
          const isZooming = store.isZooming;
          const useRootFrameZoomLod = shouldUseRootFrameZoomLod(store);
          if (viewportWidth <= 0 || viewportHeight <= 0) {
            return {
              target: appliedBounds,
              settledDetailTarget: appliedDetailBounds,
              visibleDetailTarget: appliedDetailBounds,
              isPanning,
              isZooming,
              useRootFrameZoomLod,
            };
          }
          const overscanX = Math.max(viewportWidth * CULL_MEMBERSHIP_OVERSCAN_VIEWPORTS, 3600);
          const overscanY = Math.max(viewportHeight * CULL_MEMBERSHIP_OVERSCAN_VIEWPORTS, 3600);
          const topLeft = store.screenToCanvas(screenPoint(-overscanX, -overscanY));
          const bottomRight = store.screenToCanvas(
            screenPoint(viewportWidth + overscanX, viewportHeight + overscanY),
          );
          const settledDetailOverscanX = Math.max(viewportWidth, 1200);
          const settledDetailOverscanY = Math.max(viewportHeight, 1200);
          const settledDetailTopLeft = store.screenToCanvas(
            screenPoint(-settledDetailOverscanX, -settledDetailOverscanY),
          );
          const settledDetailBottomRight = store.screenToCanvas(
            screenPoint(
              viewportWidth + settledDetailOverscanX,
              viewportHeight + settledDetailOverscanY,
            ),
          );
          const detailTopLeft = store.screenToCanvas(
            screenPoint(
              -CULL_VISIBLE_DETAIL_OVERSCAN_SCREEN_PX,
              -CULL_VISIBLE_DETAIL_OVERSCAN_SCREEN_PX,
            ),
          );
          const detailBottomRight = store.screenToCanvas(
            screenPoint(
              viewportWidth + CULL_VISIBLE_DETAIL_OVERSCAN_SCREEN_PX,
              viewportHeight + CULL_VISIBLE_DETAIL_OVERSCAN_SCREEN_PX,
            ),
          );
          return {
            target: quantizeCanvasBoundsOutward(
              {
                left: topLeft.x,
                top: topLeft.y,
                right: bottomRight.x,
                bottom: bottomRight.y,
              },
              store.zoom,
            ),
            settledDetailTarget: quantizeCanvasBoundsOutward(
              {
                left: settledDetailTopLeft.x,
                top: settledDetailTopLeft.y,
                right: settledDetailBottomRight.x,
                bottom: settledDetailBottomRight.y,
              },
              store.zoom,
            ),
            visibleDetailTarget: quantizeCanvasBoundsOutward(
              {
                left: detailTopLeft.x,
                top: detailTopLeft.y,
                right: detailBottomRight.x,
                bottom: detailBottomRight.y,
              },
              store.zoom,
              256,
            ),
            isPanning,
            isZooming,
            useRootFrameZoomLod,
          };
        },
        ({
          target,
          settledDetailTarget,
          visibleDetailTarget,
          isPanning,
          isZooming,
          useRootFrameZoomLod,
        }) => {
          cancelConvergence();
          cancelPromotion();
          if (isPanning || isZooming) {
            cameraBoundsExpanded = true;
            const expandedBounds =
              isZooming &&
              (store.canLatchCullBoundsDuringZoom || useRootFrameZoomLod) &&
              appliedBounds
                ? appliedBounds
                : isZooming
                  ? (visibleDetailTarget ?? target)
                  : isPanning && visibleDetailTarget && appliedBounds && target
                    ? expandMembershipBoundsForPan(appliedBounds, visibleDetailTarget, target)
                    : visibleDetailTarget && appliedBounds
                      ? unionCanvasBounds(appliedBounds, visibleDetailTarget)
                      : (visibleDetailTarget ?? target);
            applyBounds(expandedBounds);
            if (isPanning && !isZooming) {
              applyDetailBounds(
                visibleDetailTarget && appliedDetailBounds
                  ? expandDetailBoundsForPan(appliedDetailBounds, visibleDetailTarget)
                  : visibleDetailTarget,
              );
            } else if (!appliedDetailBounds) applyDetailBounds(visibleDetailTarget ?? target);
            return;
          }
          const shouldConvergeAfterMotion = cameraBoundsExpanded;
          cameraBoundsExpanded = false;
          if (shouldConvergeAfterMotion && target && settledDetailTarget && appliedBounds) {
            // Keep retained real detail visible, then add newly visible roots in
            // small batches instead of mounting a whole low-zoom document in one
            // blocking React commit.
            if (visibleDetailTarget) {
              applyBounds(unionCanvasBounds(appliedBounds, visibleDetailTarget));
              promoteVisibleRootDetail(visibleDetailTarget, target, settledDetailTarget);
            } else {
              convergeToBounds(target, settledDetailTarget);
            }
          } else {
            releasePromotedRoots();
            applyBounds(target);
            applyDetailBounds(settledDetailTarget);
          }
        },
        {
          equals: (left, right) =>
            left.isPanning === right.isPanning &&
            left.isZooming === right.isZooming &&
            left.useRootFrameZoomLod === right.useRootFrameZoomLod &&
            areCanvasBoundsEqual(left.target, right.target) &&
            areCanvasBoundsEqual(left.settledDetailTarget, right.settledDetailTarget) &&
            areCanvasBoundsEqual(left.visibleDetailTarget, right.visibleDetailTarget),
          fireImmediately: true,
        },
      );
      return () => {
        cancelConvergence();
        cancelPromotion();
        releasePromotedRoots();
        dispose();
        runInAction(() => {
          store.setViewportCanvasBounds(null);
          store.setViewportDetailBounds(null);
        });
      };
    }, [store]);

    const dragRenderRoots = getDragRenderRoots(store)
      .map((node) => {
        const forceDetail = progressiveDetailRootIds.has(node.id);
        if (
          forceDetail ||
          store.dragDetachedIds.has(node.id) ||
          store.isForcedRender(node.id) ||
          store.renderPinnedAncestorIds.has(node.id)
        ) {
          return { forceDetail, node, renderChildren: true };
        }
        if (store.isDeferredDetailRoot(node.id)) {
          return { forceDetail: false, node, renderChildren: false };
        }
        if (!viewportCanvasBounds) return null;
        if (hasUnsafeModelGeometry(node) || !nodeClipsChildrenForCulling(node)) {
          return { forceDetail: false, node, renderChildren: true };
        }
        const cullRect = getNodeModelCullRect(node);
        const intersects = intersectsCanvasBounds(cullRect, viewportCanvasBounds);
        if (intersects) {
          const detailBounds = store.viewportDetailBounds ?? viewportCanvasBounds;
          const intersectsDetail = intersectsCanvasBounds(cullRect, detailBounds);
          return {
            forceDetail: false,
            node,
            renderChildren: intersectsDetail || node.type !== "frame" || node.children.length === 0,
          };
        }
        if (store.canLatchCullBoundsDuringZoom && node.type === "frame") {
          return { forceDetail: false, node, renderChildren: false };
        }
        return null;
      })
      .filter(
        (entry): entry is { forceDetail: boolean; node: DesignNode; renderChildren: boolean } =>
          entry !== null,
      );

    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          contain: "layout paint",
          overflow: "clip",
          pointerEvents: "none",
        }}
      >
        <RootFrameZoomLod />
        <CameraLayer suppressNativeSelection={suppressNativeSelection}>
          {dragRenderRoots.map(({ forceDetail, node, renderChildren }) => (
            <RenderNode
              key={node.id}
              node={node}
              renderChildren={renderChildren}
              forceDetail={forceDetail}
            />
          ))}
        </CameraLayer>
      </div>
    );
  },
);
