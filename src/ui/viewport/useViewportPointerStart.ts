import { action } from "mobx";
import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import {
  asScreenPoint,
  screenPoint,
  type CanvasPoint,
} from "../../core/editor/interaction/coordinate-spaces";
import { getAngleFromCenter, computeSelectionBounds } from "../../core/editor/interaction/math";
import { isEventTargetEditable } from "../../core/lib/keyboard-shortcuts";
import { isMacOSPlatform } from "../../core/platform";
import type { EditorStore } from "../../core/state/EditorStore";
import type { CompassDirection, InkPoint, Point, Rect } from "../../core/types";
import { getRotatedBounds, SELECTION_TRANSFORM_HANDLE_ID } from "../canvas-overlay/CanvasOverlay";
import {
  resolveGapDragStart,
  resolvePaddingDragStart,
  type PaddingSide,
} from "../canvas-overlay/spacing-band-geometry";
import {
  getNodeCanvasExtent,
  getNodeLocalCanvasRect,
  getNodeOrientedBox,
} from "../canvas-overlay/live-node-geometry";
import {
  commentAnchorForCanvasPoint,
  commentAnchorTargetAtPoint,
} from "../canvas-overlay/comment-pin-geometry";
import { regionBetween, regionPinPoint } from "../../core/editor/comment-anchor-math";
import { findDrawParentFrameId, toParentRelativePoint } from "./draw-parenting";
import {
  getTopLevelDraggedIds,
  getTransformableSelectedIds,
  isAdditiveSelectionKey,
  isNodeLocked,
  resolveShallowSelectionTarget,
} from "./interaction-helpers";
import type { ViewportInteractionCoordinator } from "./interaction-coordinator";
import { timeLeafPerfTrace } from "../../core/lib/perf-trace";
import {
  getFallbackEmptyTextHeight,
  getNodeFromPointerTarget,
  getTextCaretSelectionFromPoint,
  hitTestSelectableNode,
  isCreationTool,
  setInteractionPointerCapture,
} from "./pointer-utils";
import { getPointDistance, getPointMidpoint } from "./useViewportCameraInput";
import { shouldUseRealPressure } from "./useViewportInk";

/** Union AABB of the transformable selection, rotation-aware. */
function getSelectionUnionBounds(
  store: EditorStore,
  viewportEl: Element | null,
  viewportRect?: DOMRectReadOnly,
): Rect | null {
  const aabbs: Rect[] = [];
  for (const id of getTransformableSelectedIds(store)) {
    const member = store.getNode(id);
    if (!member) continue;
    aabbs.push(getNodeCanvasExtent(member, store, viewportEl, viewportRect));
  }
  return computeSelectionBounds(aabbs);
}

export type PointerInteractionStart = {
  button: number;
  clientX: number;
  clientY: number;
  commitSource?: "down" | "move" | "up";
  currentTarget: HTMLElement;
  pointerId: number;
  pointerType?: string;
  pressure: number;
  accelKey: boolean;
  /** Raw Ctrl, which macOS overloads as the secondary-click modifier. */
  ctrlKey?: boolean;
  shiftKey: boolean;
  shouldCapture: boolean;
  target: EventTarget | null;
};

export function useViewportPointerStart({
  beginHistoryTransaction,
  createInkPoint,
  endHistoryTransaction,
  extendInkSession,
  flushPendingMovingDragCommit,
  getCanvasPoint,
  interaction,
  setMarqueeRect,
  store,
  viewportRef,
}: {
  beginHistoryTransaction: () => void;
  createInkPoint: (
    clientX: number,
    clientY: number,
    pressure: number,
    useRealPressure: boolean,
    preserveRawPressure: boolean,
  ) => InkPoint | null;
  endHistoryTransaction: () => void;
  extendInkSession: (
    samples: InkPoint[],
    useRealPressure: boolean,
    pointerId: number,
    last: boolean,
  ) => void;
  flushPendingMovingDragCommit: () => void;
  getCanvasPoint: (clientX: number, clientY: number) => CanvasPoint | null;
  interaction: ViewportInteractionCoordinator;
  setMarqueeRect: Dispatch<SetStateAction<Rect | null>>;
  store: EditorStore;
  viewportRef: RefObject<HTMLDivElement | null>;
}) {
  const startPointerInteraction = useCallback(
    action(
      ({
        button,
        clientX,
        clientY,
        commitSource = "down",
        currentTarget,
        pointerId,
        pointerType = "mouse",
        pressure,
        accelKey,
        ctrlKey = false,
        shiftKey,
        shouldCapture,
        target,
      }: PointerInteractionStart) => {
        flushPendingMovingDragCommit();
        if (isEventTargetEditable(target)) return;
        // macOS reads Ctrl+primary-click as a secondary click and fires
        // `contextmenu` for it. Beginning a drag here would swallow that event
        // through the viewport's idle-drag guard, so the press is left alone
        // and the context-menu path takes it.
        if (button === 0 && ctrlKey && isMacOSPlatform()) return;
        if (button !== 0 && button !== 1) return;
        const rect = viewportRef.current?.getBoundingClientRect();
        if (!rect) return;

        if (store.editingTextNodeId) store.finishTextEditing();

        const pointerScreenPoint = screenPoint(clientX - rect.left, clientY - rect.top);
        const capturePointer = () => {
          interaction.activePointerId = pointerId;
          store.setPointerGestureActive(true);
          if (shouldCapture) setInteractionPointerCapture(currentTarget, pointerId);
        };
        const beginMovingDrag = (extra: {
          activateOnClickId?: string;
          deselectOnClick?: boolean;
        }) => {
          beginHistoryTransaction();
          const startPositions = new Map<string, Point>();
          for (const id of getTopLevelDraggedIds(store, store.selectedIds)) {
            const node = store.getNode(id);
            if (node) startPositions.set(id, { x: node.x, y: node.y });
          }
          interaction.dragState = {
            type: "moving",
            flowRestoreStates: new Map(),
            startMouse: { x: clientX, y: clientY },
            startPositions,
            flexReparented: false,
            started: false,
            ...extra,
          };
          interaction.clearTargetCaches();
          capturePointer();
        };

        if (button === 1 || interaction.spacePressed || store.activeTool === "pan") {
          interaction.dragState = {
            type: "panning",
            startMouse: { x: clientX, y: clientY },
            startPan: { x: store.panX, y: store.panY },
          };
          capturePointer();
          return;
        }

        const targetElement = target instanceof Element ? target : null;
        if (targetElement?.closest("[data-overlay-ui]")) return;

        // The comment tool places a draft, not a node: no history transaction
        // (comments never enter the canvas undo stack), no coordinator drag
        // state, no capture. It must branch before the generic draw-tool
        // fallthrough below, which would otherwise create a design node. The
        // composer opens at press; dragging past the threshold converts the
        // draft to a region whose pin follows the drag direction. The gesture
        // is owned by window-level listeners because the viewport never
        // captured this pointer.
        if (store.activeTool === "comment") {
          const originCanvas = store.screenToCanvas(asScreenPoint(pointerScreenPoint));
          // Same anchor rule as dropping a dragged pin: locked nodes are valid
          // anchors, hidden nodes never are.
          const hit = commentAnchorTargetAtPoint(store, clientX, clientY);
          // Captured at placement: the composer survives a page switch, and
          // posting must land on the page the user pointed at.
          const draftPageId = store.activePageId;
          store.setPendingCommentDraft({
            anchor: commentAnchorForCanvasPoint(store, hit, originCanvas, viewportRef.current),
            canvasPoint: { x: originCanvas.x, y: originCanvas.y },
            pageId: draftPageId,
          });
          const origin = { x: originCanvas.x, y: originCanvas.y };
          const startClient = { x: clientX, y: clientY };
          let dragging = false;
          const onMove = action((event: PointerEvent) => {
            if (event.pointerId !== pointerId) return;
            // Escape and page changes clear the captured draft. Once cleared,
            // this window-level listener must stay inert until pointerup rather
            // than recreating the draft on the next move.
            if (!store.pendingCommentDraft || store.activePageId !== draftPageId) return;
            if (
              !dragging &&
              Math.hypot(event.clientX - startClient.x, event.clientY - startClient.y) < 4
            ) {
              return;
            }
            dragging = true;
            const rect = viewportRef.current?.getBoundingClientRect();
            if (!rect) return;
            const current = store.screenToCanvas(
              asScreenPoint(screenPoint(event.clientX - rect.left, event.clientY - rect.top)),
            );
            const region = regionBetween(origin, current);
            store.setPendingCommentDraft({
              anchor: { type: "region", ...region },
              canvasPoint: regionPinPoint(region, region.pinX, region.pinY),
              pageId: draftPageId,
            });
          });
          const cleanup = () => {
            window.removeEventListener("pointermove", onMove, true);
            window.removeEventListener("pointerup", onEnd, true);
            window.removeEventListener("pointercancel", onCancel, true);
          };
          const onEnd = (event: PointerEvent) => {
            if (event.pointerId !== pointerId) return;
            cleanup();
          };
          const onCancel = action((event: PointerEvent) => {
            if (event.pointerId !== pointerId) return;
            cleanup();
            store.setPendingCommentDraft(null);
          });
          window.addEventListener("pointermove", onMove, true);
          window.addEventListener("pointerup", onEnd, true);
          window.addEventListener("pointercancel", onCancel, true);
          return;
        }

        // Under an armed creation tool the overlay renders no transform chrome,
        // and a stale handle element must not turn the press into a transform
        // of the old selection either: the tool branches below own the press.
        const transformChromeArmed = !isCreationTool(store.activeTool);

        const rotateDirection = transformChromeArmed
          ? targetElement?.getAttribute("data-rotate-handle-dir")
          : null;
        if (rotateDirection) {
          const center = {
            x: Number(targetElement?.getAttribute("data-rotate-center-x")),
            y: Number(targetElement?.getAttribute("data-rotate-center-y")),
          };
          const pointerCanvas = getCanvasPoint(clientX, clientY);
          const rotatableIds = getTransformableSelectedIds(store);
          if (pointerCanvas && rotatableIds.length > 0 && Number.isFinite(center.x)) {
            const startRotations = new Map<string, number>();
            const startCenters = new Map<string, Point>();
            const startModels = new Map<string, Point>();
            const startAncestorRotations = new Map<string, number>();
            const memberRects: Rect[] = [];
            for (const id of rotatableIds) {
              const rotatingNode = store.getNode(id);
              if (!rotatingNode) continue;
              const memberRect = getNodeLocalCanvasRect(rotatingNode, store, viewportRef.current);
              startRotations.set(id, rotatingNode.rotation ?? 0);
              startAncestorRotations.set(
                id,
                store.getWorldRotation(id) - (rotatingNode.rotation ?? 0),
              );
              startCenters.set(id, {
                x: memberRect.x + memberRect.width / 2,
                y: memberRect.y + memberRect.height / 2,
              });
              startModels.set(id, { x: rotatingNode.x, y: rotatingNode.y });
              memberRects.push(memberRect);
            }
            // The angle the gizmo box is drawn at, which for a single node is
            // its total turn — own plus inherited — and 0 for the axis-aligned
            // box around a multi-node selection.
            const soleRotatingId =
              startRotations.size === 1 ? startRotations.keys().next().value : undefined;
            const startBoundsRotation = soleRotatingId ? store.getWorldRotation(soleRotatingId) : 0;
            beginHistoryTransaction();
            interaction.dragState = {
              type: "rotating",
              center,
              startPointerAngle: getAngleFromCenter(center, pointerCanvas),
              startBoundsRotation,
              startRotations,
              startCenters,
              startModels,
              startAncestorRotations,
              rect: computeSelectionBounds(memberRects) ?? {
                x: center.x,
                y: center.y,
                width: 0,
                height: 0,
              },
            };
            capturePointer();
            return;
          }
        }

        const gapBandNodeId = transformChromeArmed
          ? targetElement?.getAttribute("data-gap-band-node")
          : null;
        if (gapBandNodeId && targetElement) {
          const gapNode = store.getNode(gapBandNodeId);
          const bandIndex = Number(targetElement.getAttribute("data-gap-band-index"));
          const bandKey = Number(targetElement.getAttribute("data-gap-band-key"));
          if (
            gapNode &&
            !isNodeLocked(store, gapBandNodeId) &&
            Number.isFinite(bandIndex) &&
            Number.isFinite(bandKey)
          ) {
            const gapAxis =
              targetElement.getAttribute("data-gap-band-gap-axis") === "column"
                ? ("column" as const)
                : ("row" as const);
            const { startGap, linked, otherGap } = resolveGapDragStart(gapNode, gapAxis, store);
            // Pin the highlight to the dragged band: pointer capture stops
            // idle hover updates, and the badge doubles as the live readout.
            store.spacingBandHighlight = { nodeId: gapBandNodeId, kind: "gap", bandKey, gapAxis };
            beginHistoryTransaction();
            interaction.dragState = {
              type: "resizing-gap",
              nodeId: gapBandNodeId,
              gapAxis,
              pointerAxis:
                targetElement.getAttribute("data-gap-band-pointer-axis") === "y" ? "y" : "x",
              divisor: Math.max(1, bandIndex + 1),
              sign: targetElement.getAttribute("data-gap-band-sign") === "-1" ? -1 : 1,
              startMouse: { x: clientX, y: clientY },
              startGap,
              linked,
              otherGap,
            };
            capturePointer();
            return;
          }
        }

        const paddingBandNodeId = transformChromeArmed
          ? targetElement?.getAttribute("data-padding-band-node")
          : null;
        if (paddingBandNodeId && targetElement) {
          const paddingNode = store.getNode(paddingBandNodeId);
          const bandKey = Number(targetElement.getAttribute("data-padding-band-key"));
          const sideAttribute = targetElement.getAttribute("data-padding-band-side");
          const side =
            sideAttribute === "top" ||
            sideAttribute === "right" ||
            sideAttribute === "bottom" ||
            sideAttribute === "left"
              ? (sideAttribute as PaddingSide)
              : null;
          if (
            paddingNode &&
            side &&
            !isNodeLocked(store, paddingBandNodeId) &&
            Number.isFinite(bandKey)
          ) {
            const { startPadding, startSides } = resolvePaddingDragStart(paddingNode, side, store);
            store.spacingBandHighlight = {
              nodeId: paddingBandNodeId,
              kind: "padding",
              bandKey,
              side,
            };
            beginHistoryTransaction();
            interaction.dragState = {
              type: "resizing-padding",
              nodeId: paddingBandNodeId,
              side,
              pointerAxis:
                targetElement.getAttribute("data-padding-band-pointer-axis") === "y" ? "y" : "x",
              sign: targetElement.getAttribute("data-padding-band-sign") === "-1" ? -1 : 1,
              startMouse: { x: clientX, y: clientY },
              startPadding,
              startSides,
            };
            capturePointer();
            return;
          }
        }

        const handleDirection = transformChromeArmed
          ? targetElement?.getAttribute("data-handle-dir")
          : null;
        const handleNodeId = targetElement?.getAttribute("data-handle-node");
        if (handleDirection && handleNodeId === SELECTION_TRANSFORM_HANDLE_ID) {
          const startRects = new Map<string, Rect>();
          const startModels = new Map<string, Point>();
          const startAncestorRotations = new Map<string, number>();
          const startBounds: Rect[] = [];
          let hasRotatedMember = false;
          for (const id of getTransformableSelectedIds(store)) {
            const member = store.getNode(id);
            if (!member || store.isFlowChild(id)) continue;
            const { rect, rotation } = getNodeOrientedBox(member, store, viewportRef.current);
            startRects.set(id, rect);
            startModels.set(id, { x: member.x, y: member.y });
            // The union is scaled in canvas space but the member's position is
            // written in its parent's frame, and only the inherited part of the
            // turn separates the two.
            startAncestorRotations.set(id, rotation - (member.rotation ?? 0));
            startBounds.push(getRotatedBounds(rect, rotation));
            if (rotation) hasRotatedMember = true;
          }
          const startUnion = computeSelectionBounds(startBounds);
          if (startUnion && startRects.size > 0) {
            beginHistoryTransaction();
            interaction.dragState = {
              type: "resizing-selection",
              direction: handleDirection as CompassDirection,
              startMouse: { x: clientX, y: clientY },
              startUnion,
              startRects,
              startModels,
              startAncestorRotations,
              lockProportions: hasRotatedMember,
              baked: false,
            };
            capturePointer();
            return;
          }
        }

        if (handleDirection && handleNodeId) {
          const node = store.getNode(handleNodeId);
          if (node && !isNodeLocked(store, handleNodeId)) {
            beginHistoryTransaction();
            interaction.dragState = {
              type: "resizing",
              nodeId: handleNodeId,
              direction: handleDirection as CompassDirection,
              startMouse: { x: clientX, y: clientY },
              startRect: {
                x: node.x,
                y: node.y,
                width: node.width,
                height: node.height,
              },
              rotation: node.rotation ?? 0,
              ancestorRotation: store.getWorldRotation(handleNodeId) - (node.rotation ?? 0),
              flexReparented: false,
              isCreating: false,
            };
            capturePointer();
            return;
          }
        }

        if (store.activeTool === "ink") {
          store.clearHoveredNode();

          if (pointerType === "touch") {
            if (commitSource === "move") {
              interaction.dragState = {
                type: "panning",
                startMouse: { x: clientX, y: clientY },
                startPan: { x: store.panX, y: store.panY },
              };
            }
            return;
          }

          const useRealPressure = shouldUseRealPressure(pointerType, pressure);
          const initialPoint = createInkPoint(
            clientX,
            clientY,
            pressure,
            useRealPressure,
            pointerType === "pen",
          );
          if (!initialPoint) return;

          beginHistoryTransaction();
          extendInkSession([initialPoint], useRealPressure, pointerId, false);
          interaction.dragState = { type: "inking", pointerId, useRealPressure };
          capturePointer();
          return;
        }

        if (store.activeTool === "text") {
          beginHistoryTransaction();
          const canvasPoint = store.screenToCanvas(asScreenPoint(pointerScreenPoint));
          const drawParentId = findDrawParentFrameId(store, viewportRef.current, canvasPoint);
          const drawOrigin = toParentRelativePoint(store, drawParentId, canvasPoint);
          const node = drawParentId
            ? store.runtime.createScriptNode(
                "text",
                { x: drawOrigin.x, y: drawOrigin.y, styles: { position: "absolute" } },
                drawParentId,
              )
            : store.runtime.addNode("text", canvasPoint);
          store.selectNode(node.id);
          store.runtime.updateNode(node.id, {
            content: "",
            textAutoSize: true,
            width: 16,
            height: Math.max(1, getFallbackEmptyTextHeight(node)),
          });
          store.setTool("select");
          // The editing session opens its own (nested) history transaction
          // before the creation one closes, so creation and typing settle as a
          // single undo step — and a session abandoned with nothing typed can
          // cancel the whole thing, leaving no history entry at all.
          store.beginTextEditing(node.id, {
            isCreating: true,
            selection: { type: "end" },
          });
          endHistoryTransaction();
          return;
        }

        if (store.activeTool !== "select") {
          beginHistoryTransaction();
          const canvasPoint = store.screenToCanvas(asScreenPoint(pointerScreenPoint));
          const drawParentId = findDrawParentFrameId(store, viewportRef.current, canvasPoint);
          const drawOrigin = toParentRelativePoint(store, drawParentId, canvasPoint);
          const node = drawParentId
            ? store.runtime.createScriptNode(
                store.activeTool,
                { x: drawOrigin.x, y: drawOrigin.y, styles: { position: "absolute" } },
                drawParentId,
              )
            : store.runtime.addNode(store.activeTool, canvasPoint);
          store.selectNode(node.id);
          store.runtime.updateNode(node.id, { width: 0, height: 0 });
          interaction.dragState = {
            type: "resizing",
            nodeId: node.id,
            direction: "se",
            startMouse: { x: clientX, y: clientY },
            startRect: { x: node.x, y: node.y, width: 0, height: 0 },
            rotation: 0,
            // A freshly drawn node carries no turn of its own, but a turned
            // draw parent still decides which way the drag grows it.
            ancestorRotation: store.getWorldRotation(node.id),
            flexReparented: false,
            isCreating: true,
          };
          capturePointer();
          return;
        }

        const frameTitleNodeId = targetElement
          ?.closest("[data-frame-title-node]")
          ?.getAttribute("data-frame-title-node");
        const rawHitNode =
          (frameTitleNodeId ? store.getNode(frameTitleNodeId) : null) ??
          getNodeFromPointerTarget(store, target) ??
          hitTestSelectableNode(store, clientX, clientY);
        // Click resolves the same shallow target the hover ring previews.
        const hitNode = rawHitNode ? resolveShallowSelectionTarget(store, rawHitNode) : null;
        if (rawHitNode && hitNode) {
          // A click outside the entered container pops that scope to the
          // nearest frame containing the hit instead of being swallowed.
          // Only real node clicks retarget: misses fall through to the
          // pan/marquee/backdrop paths below with the scope intact.
          store.retargetContainerScope(rawHitNode.id);
          // Embed/script activation targets resolve from the raw deep hit
          // so a click can reach an interaction root the shallow target
          // (its enclosing frame) would hide.
          const interactionTargetId = store.getInteractionTargetId(rawHitNode.id);
          if (store.activeInteractiveSurfaceId) {
            if (interactionTargetId && interactionTargetId !== store.activeInteractiveSurfaceId) {
              store.selectNode(interactionTargetId);
              store.activateInteraction(interactionTargetId);
            } else if (!interactionTargetId) {
              store.deactivateInteractiveSurface();
            }
            interaction.lastClickTime = 0;
            interaction.lastClickNodeId = null;
            return;
          }

          const isAdditiveSelection = isAdditiveSelectionKey(shiftKey, accelKey);
          const interactionTargetSelected =
            !!interactionTargetId &&
            store.selectedIds.size === 1 &&
            store.selectedInteractionTargetId === interactionTargetId;
          const activateOnClickId =
            interactionTargetId &&
            interactionTargetSelected &&
            !isAdditiveSelection &&
            !frameTitleNodeId
              ? interactionTargetId
              : undefined;

          const now = Date.now();
          const clickNodeId = interactionTargetId ?? hitNode.id;
          const isDoubleClick =
            clickNodeId === interaction.lastClickNodeId && now - interaction.lastClickTime < 400;
          if (interactionTargetId && isDoubleClick && !isAdditiveSelection && !frameTitleNodeId) {
            store.activateInteraction(interactionTargetId);
            interaction.lastClickTime = 0;
            interaction.lastClickNodeId = null;
            return;
          }
          // Double-click drills on the raw deep hit: text under the cursor
          // becomes the selection in one gesture instead of needing one
          // click-pair per nesting level. A caret takes a second double-click
          // on the already-selected text, so the freshly selected node still
          // offers its context menu, drag, and transform chrome first. Root
          // text reaches the caret in one double-click all the same: its
          // first click is the selection.
          if (rawHitNode.type === "text" && isDoubleClick) {
            const isSoleSelection =
              store.selectedIds.size === 1 && store.selectedIds.has(rawHitNode.id);
            if (isSoleSelection) {
              store.beginTextEditing(rawHitNode.id, {
                selection: getTextCaretSelectionFromPoint(target, clientX, clientY),
              });
            } else {
              store.selectNode(rawHitNode.id);
            }
            interaction.lastClickTime = 0;
            interaction.lastClickNodeId = null;
            return;
          }
          if (
            isDoubleClick &&
            hitNode.type === "frame" &&
            hitNode.children.length > 0 &&
            store.selectedIds.size === 1 &&
            store.selectedIds.has(hitNode.id)
          ) {
            store.enterContainer(hitNode.id);
            // Drill the selection to the child under the cursor so each
            // double-click descends one level instead of only opening the
            // container.
            let drillChildId: string | null = null;
            let pathId: string | undefined = rawHitNode.id;
            while (pathId && pathId !== hitNode.id) {
              if (store.parentMap.get(pathId) === hitNode.id) {
                drillChildId = pathId;
                break;
              }
              pathId = store.parentMap.get(pathId);
            }
            if (drillChildId) store.selectNode(drillChildId);
            interaction.lastClickTime = 0;
            interaction.lastClickNodeId = null;
            return;
          }
          interaction.lastClickTime = now;
          interaction.lastClickNodeId = clickNodeId;

          if (isAdditiveSelection || !store.selectedIds.has(hitNode.id)) {
            store.selectNode(hitNode.id, isAdditiveSelection);
          }
          beginMovingDrag({ activateOnClickId });
          return;
        }

        if (store.activeInteractiveSurfaceId) {
          store.deactivateInteractiveSurface();
          interaction.lastClickTime = 0;
          interaction.lastClickNodeId = null;
          return;
        }
        if (pointerType === "touch" && commitSource === "move" && store.activeTool === "select") {
          interaction.dragState = {
            type: "panning",
            startMouse: { x: clientX, y: clientY },
            startPan: { x: store.panX, y: store.panY },
          };
          return;
        }

        // Empty canvas inside a multi-selection's bounds drags the whole
        // selection as a unit (the post-paste "grab the group" gesture).
        // A plain click still deselects — the
        // moving drag carries deselectOnClick for the no-movement case.
        if (
          store.activeTool === "select" &&
          !isAdditiveSelectionKey(shiftKey, accelKey) &&
          store.selectedIds.size > 1
        ) {
          const pointerCanvas = store.screenToCanvas(asScreenPoint(pointerScreenPoint));
          const selectionBounds = getSelectionUnionBounds(store, viewportRef.current, rect);
          if (
            selectionBounds &&
            pointerCanvas.x >= selectionBounds.x &&
            pointerCanvas.x <= selectionBounds.x + selectionBounds.width &&
            pointerCanvas.y >= selectionBounds.y &&
            pointerCanvas.y <= selectionBounds.y + selectionBounds.height
          ) {
            beginMovingDrag({ deselectOnClick: true });
            return;
          }
        }

        const initialSelectedIds = new Set(store.selectedIds);
        beginHistoryTransaction();
        const isAdditiveSelection = isAdditiveSelectionKey(shiftKey, accelKey);
        const baseSelectedIds = isAdditiveSelection
          ? new Set(store.selectedIds)
          : new Set<string>();
        if (isAdditiveSelection) store.clearHoveredNode();
        else store.deselectAll();
        setMarqueeRect(null);
        interaction.dragState = {
          type: "marquee",
          initialSelectedIds,
          baseSelectedIds,
          selectionTargets: null,
          startCanvas: store.screenToCanvas(asScreenPoint(pointerScreenPoint)),
          startMouse: { x: clientX, y: clientY },
          started: false,
        };
        capturePointer();
      },
    ),
    [
      beginHistoryTransaction,
      createInkPoint,
      endHistoryTransaction,
      extendInkSession,
      flushPendingMovingDragCommit,
      getCanvasPoint,
      interaction,
      setMarqueeRect,
      store,
      viewportRef,
    ],
  );

  const commitPendingTouchStart = useCallback(
    (currentTarget: HTMLElement) => {
      const pending = interaction.pendingTouchStart;
      if (!pending) return;
      interaction.pendingTouchStart = null;
      startPointerInteraction({
        ...pending,
        commitSource: "move",
        currentTarget,
        pointerType: "touch",
        pressure: pending.pressure,
        accelKey: pending.accelKey,
        shouldCapture: false,
      });
    },
    [interaction, startPointerInteraction],
  );

  const onPointerDown = useCallback(
    action((event: React.PointerEvent<HTMLDivElement>) => {
      flushPendingMovingDragCommit();

      if (event.pointerType === "touch") {
        if (
          interaction.dragState.type !== "idle" &&
          interaction.pendingTouchStart === null &&
          interaction.pinchState === null
        ) {
          return;
        }

        interaction.activeTouchPoints.set(event.pointerId, {
          x: event.clientX,
          y: event.clientY,
        });
        // A touch owns editor input from the initial contact, before movement
        // decides whether it becomes a tap, pan, or pinch. Protect history and
        // page navigation for that complete lifecycle rather than only after
        // a deferred touch has committed to a mouse-like drag.
        store.setPointerGestureActive(true);
        setInteractionPointerCapture(event.currentTarget, event.pointerId);

        if (!interaction.pinchState && interaction.activeTouchPoints.size >= 2) {
          const rect = viewportRef.current?.getBoundingClientRect();
          const [first, second] = Array.from(interaction.activeTouchPoints.values());
          if (rect && first && second && interaction.dragState.type === "idle") {
            const midpoint = getPointMidpoint(first, second, rect);
            interaction.pendingTouchStart = null;
            interaction.pinchState = {
              mode: "not sure",
              initialDistance: getPointDistance(first, second),
              initialZoom: store.zoom,
              initialPan: { x: store.panX, y: store.panY },
              initialMidpoint: midpoint,
              previousMidpoint: midpoint,
              source: "touch",
            };
            setMarqueeRect(null);
            store.dragCanvasOffset.clear();
            store.dragInsertionPreview = null;
            interaction.dragState = { type: "idle" };
          }
          return;
        }

        if (interaction.pinchState) return;
        interaction.pendingTouchStart = {
          pointerId: event.pointerId,
          clientX: event.clientX,
          clientY: event.clientY,
          button: event.button,
          pressure: event.pressure,
          shiftKey: event.shiftKey,
          accelKey: event.metaKey || event.ctrlKey,
          target: event.target,
        };
        return;
      }

      if (interaction.pinchState) return;
      timeLeafPerfTrace("pointer.down", () => {
        startPointerInteraction({
          button: event.button,
          clientX: event.clientX,
          clientY: event.clientY,
          commitSource: "down",
          currentTarget: event.currentTarget,
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          pressure: event.pressure,
          accelKey: event.metaKey || event.ctrlKey,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          shouldCapture: true,
          target: event.target,
        });
      });
    }),
    [
      flushPendingMovingDragCommit,
      interaction,
      setMarqueeRect,
      startPointerInteraction,
      store,
      viewportRef,
    ],
  );

  return {
    commitPendingTouchStart,
    onPointerDown,
    startPointerInteraction,
  };
}
