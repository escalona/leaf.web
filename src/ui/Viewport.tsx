import { cursorCss } from "./icons";
import { action, runInAction } from "mobx";
import { observer } from "mobx-react-lite";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { computeCenteredCameraForBounds } from "../core/editor/interaction/math";
import type { CanvasPoint } from "../core/editor/interaction/coordinate-spaces";
import { isEventTargetEditable } from "../core/lib/keyboard-shortcuts";
import { useEditorStore, type EditorStore } from "../core/state/EditorStore";
import type { CollaborationPresencePeer } from "../core/state/collaboration-presence";
import { getEmptyPageCamera } from "../core/state/editor-camera-state";
import type { Rect } from "../core/types";
import { ArtboardLabels } from "./canvas-overlay/ArtboardLabels";
import { CommentPinsOverlay } from "./canvas-overlay/CommentPinsOverlay";
import { CanvasOverlay } from "./canvas-overlay/CanvasOverlay";
import { SelectionContextMenu, useSelectionContextMenu } from "./context-menu/SelectionContextMenu";
import {
  clearRemoteDragPreviews,
  syncRemoteDragPreviews,
} from "./canvas-overlay/remote-drag-preview";
import { VectorEditOverlay } from "./canvas-overlay/VectorEditOverlay";
import { usePaintedCanvasBackground } from "./properties/sections/PageSection";
import { GridPattern } from "./viewport/GridPattern";
import { ViewportCanvas } from "./viewport/ViewportCanvas";
import { ViewportInteractionCoordinator } from "./viewport/interaction-coordinator";
import { setTransformHud } from "./viewport/interaction-helpers";
import {
  getCanvasPointFromClient,
  hitTestSelectableNode,
  releaseInteractionPointerCapture,
} from "./viewport/pointer-utils";
import { resolveShallowSelectionTarget } from "./viewport/selection-targets";
import { useMovingDrag } from "./viewport/useMovingDrag";
import { getViewportTouchAction, useViewportCameraInput } from "./viewport/useViewportCameraInput";
import { useViewportInk } from "./viewport/useViewportInk";
import { useViewportPointerEnd } from "./viewport/useViewportPointerEnd";
import { useViewportPointerMove } from "./viewport/useViewportPointerMove";
import { useViewportPointerStart } from "./viewport/useViewportPointerStart";
import { useViewportClipboard } from "./viewport/useViewportClipboard";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";

export {
  buildFrameDropTargetLookup,
  findFrameDropTargetAtPoint,
  normalizeFlexNodeForDirectManipulation,
} from "./viewport/interaction-helpers";
export { getNodeModelCullRect } from "./viewport/culling";
export { getViewportTouchAction } from "./viewport/useViewportCameraInput";

const INITIAL_VIEWPORT_PADDING = 96;
const MIN_INITIAL_VIEWPORT_ZOOM = 0.5;

/**
 * Comment-tool cursor: the pin marker's teardrop from the icon set's cursor family, accent-filled
 * with a white halo. The hotspot is the sharp corner, exactly where the placed anchor lands.
 * Cursor images cannot read CSS variables, so the accent colour is baked in.
 */
const COMMENT_CURSOR = cursorCss("comment", { fill: "#3b82f6" }, "crosshair");
const MAX_INITIAL_VIEWPORT_ZOOM = 1;
const SHOULD_CENTER_INITIAL_VIEWPORT = import.meta.env.MODE !== "test";

/**
 * Public viewport façade. Camera input, pointer-state transitions, ink, direct
 * manipulation, and deferred move commits live in focused viewport modules;
 * this component preserves the DOM/layer order and wires those boundaries to
 * the active editor session.
 */
export const Viewport = observer(
  ({ presencePeers = [] }: { presencePeers?: readonly CollaborationPresencePeer[] }) => {
    const store = useEditorStore();
    const canvasBackground = usePaintedCanvasBackground(store);
    const viewportRef = useRef<HTMLDivElement>(null);
    const initiallyCenteredStoresRef = useRef<WeakSet<EditorStore>>(new WeakSet());
    const [interaction] = useState(() => new ViewportInteractionCoordinator());
    const [marqueeRect, setMarqueeRect] = useState<Rect | null>(null);

    const getCanvasPoint = useCallback(
      (clientX: number, clientY: number): CanvasPoint | null =>
        getCanvasPointFromClient(store, viewportRef.current, clientX, clientY),
      [store],
    );

    const beginHistoryTransaction = useCallback(
      () => interaction.beginHistoryTransaction(store),
      [interaction, store],
    );

    const endHistoryTransaction = useCallback(
      () => interaction.endHistoryTransaction(store),
      [interaction, store],
    );

    useViewportClipboard({
      beginHistoryTransaction,
      endHistoryTransaction,
      store,
      viewportRef,
    });

    const { clearInkSession, commitInkSession, createInkPoint, extendInkSession, inkSession } =
      useViewportInk({
        getCanvasPoint,
        interaction,
        store,
        viewportRef,
      });

    const clearGestureInteractionState = useCallback(
      action(() => {
        clearInkSession();
        setTransformHud(null);
        store.dragCanvasOffset.clear();
        store.dragDetachedIds.clear();
        store.dragPendingParentIds.clear();
        store.snapGuides = [];
        store.dragInsertionPreview = null;
        setMarqueeRect(null);
        store.marqueeSelecting = false;
        store.clearHoveredNode();
        store.spacingBandHighlight = null;
        interaction.clearTargetCaches();
        interaction.dragState = { type: "idle" };
        interaction.activePointerId = null;
        interaction.activeTouchPoints.clear();
        interaction.pendingTouchStart = null;
        interaction.pinchState = null;
        store.setPointerGestureActive(false);
      }),
      [clearInkSession, interaction, store],
    );

    const resetGestureInteractionState = useCallback(() => {
      endHistoryTransaction();
      clearGestureInteractionState();
    }, [clearGestureInteractionState, endHistoryTransaction]);

    const cancelGestureInteractionState = useCallback(
      action((options: { restoreCamera?: boolean } = {}) => {
        const state = interaction.dragState;
        const hasTrackedPointer =
          store.pointerGestureActive ||
          interaction.activePointerId !== null ||
          interaction.activeTouchPoints.size > 0 ||
          interaction.pendingTouchStart !== null ||
          interaction.pinchState !== null;
        if (state.type === "idle" && !hasTrackedPointer) return false;

        // Camera panning is session-local and never enters history, so restore
        // its captured start value explicitly. Every durable gesture frame is
        // rolled back atomically by the open document transaction below.
        if (options.restoreCamera !== false && state.type === "panning") {
          store.panX = state.startPan.x;
          store.panY = state.startPan.y;
        }
        if (options.restoreCamera !== false && interaction.pinchState) {
          store.zoom = interaction.pinchState.initialZoom;
          store.panX = interaction.pinchState.initialPan.x;
          store.panY = interaction.pinchState.initialPan.y;
        }
        const activePointerId = interaction.activePointerId;
        if (activePointerId !== null) {
          releaseInteractionPointerCapture(viewportRef.current, activePointerId);
        }
        interaction.cancelHistoryTransaction(store);
        clearGestureInteractionState();
        return true;
      }),
      [clearGestureInteractionState, interaction, store, viewportRef],
    );

    useEffect(
      () => () => {
        if (!cancelGestureInteractionState()) {
          interaction.closeHistoryTransactionOnUnmount(store);
          clearGestureInteractionState();
        }
      },
      [cancelGestureInteractionState, clearGestureInteractionState, interaction, store],
    );

    const previousActivePageIdRef = useRef(store.activePageId);
    useEffect(() => {
      if (previousActivePageIdRef.current === store.activePageId) return;
      previousActivePageIdRef.current = store.activePageId;

      // Ordinary page switches are blocked while this flag is set. An
      // authoritative page removal can still move the editor, so retire the
      // old page's pointer stream before any late events reach the new page.
      // The page switch has already installed the destination's parked camera,
      // so cancelling must not restore the outgoing gesture's camera over it.
      if (!cancelGestureInteractionState({ restoreCamera: false })) {
        clearGestureInteractionState();
      }
    }, [cancelGestureInteractionState, clearGestureInteractionState, store.activePageId]);

    const { markPanning, markZooming } = useViewportCameraInput({
      interaction,
      resetGestureInteractionState,
      setMarqueeRect,
      store,
      viewportRef,
    });

    const handleShortcutEscape = useCallback(() => {
      // A previewed history version locks the document, so leaving the
      // preview is the first thing Escape can usefully do. Any gesture that
      // slipped in under it goes too; the preview banner is the only chrome.
      if (store.isHistoryPreviewing) {
        cancelGestureInteractionState();
        store.exitHistoryPreview();
        return;
      }

      if (cancelGestureInteractionState()) return;

      if (store.editingTextNodeId) {
        store.finishTextEditing();
        return;
      }

      if (store.activeInteractiveSurfaceId) {
        store.deactivateInteractiveSurface();
      } else if (store.enteredContainerId) {
        store.exitContainer();
      } else {
        store.deselectAll();
        store.setTool("select");
      }
    }, [cancelGestureInteractionState, store]);

    const handleSpacebarStateChange = useCallback(
      (pressed: boolean) => {
        interaction.spacePressed = pressed;
      },
      [interaction],
    );

    // The idle pointer-move pass is the only other clearer of the spacing
    // band highlight; when the pointer exits onto a panel or another window
    // no such move ever fires, so the pink section and badge would persist.
    // During a captured drag leave events are spurious — keep the pin.
    const handlePointerLeave = useCallback(() => {
      if (interaction.dragState.type === "idle" && store.spacingBandHighlight) {
        store.spacingBandHighlight = null;
      }
    }, [interaction, store]);

    // The coordinator tracks the viewport's own gestures; the store flag also
    // covers drags that run on their own listeners, such as vector editing.
    const isPointerGestureActive = useCallback(
      () => interaction.dragState.type !== "idle" || store.pointerGestureActive,
      [interaction, store],
    );

    const { anchorPoint, closeContextMenu, openContextMenuAt } = useSelectionContextMenu();

    const onContextMenu = useCallback(
      (event: ReactMouseEvent<HTMLDivElement>) => {
        // An inline text edit mounts a real textarea inside the viewport, and
        // there the native menu is the useful one: cut, paste, spellcheck. Leaf
        // takes neither the event nor the focus away from an editable surface.
        if (isEventTargetEditable(event.target)) return;
        // The native menu never applies to canvas content, so it is suppressed
        // for the whole viewport even where Leaf has nothing to offer.
        event.preventDefault();
        if (interaction.dragState.type !== "idle") return;

        const rawHitNode = hitTestSelectableNode(store, event.clientX, event.clientY);
        const hitNode = rawHitNode ? resolveShallowSelectionTarget(store, rawHitNode) : null;
        // Locked nodes are not hittable, so an empty hit is either bare canvas
        // or something the pointer is not allowed to act on. Either way there
        // is no target: the layers panel is where a locked node is reached.
        if (!rawHitNode || !hitNode) return;

        // A right-click resolves its target exactly as a press does, scope pop
        // included: without it the menu would act on a node that marquee and
        // drop scoping still consider out of bounds.
        store.retargetContainerScope(rawHitNode.id);
        // Right-clicking outside the selection retargets it, the way pressing
        // there would; right-clicking inside a multi-selection keeps it whole.
        if (!store.selectedIds.has(hitNode.id)) store.selectNode(hitNode.id);
        openContextMenuAt(event.clientX, event.clientY);
      },
      [interaction, openContextMenuAt, store],
    );

    useKeyboardShortcuts({
      viewportRef,
      onEscape: handleShortcutEscape,
      onSpaceChange: handleSpacebarStateChange,
      isPointerGestureActive,
    });

    // Layout effect so the live element offsets and the overlay's outline
    // fallback update from the same peer snapshot before the frame paints.
    useLayoutEffect(() => {
      syncRemoteDragPreviews(store, presencePeers, viewportRef.current);
    }, [store, presencePeers]);
    useLayoutEffect(() => () => clearRemoteDragPreviews(store), [store]);

    const shouldCenterInitialViewport = store.shouldCenterInitialViewport;
    const initialViewportTargetBounds = shouldCenterInitialViewport
      ? store.initialViewportTargetBounds
      : null;
    useLayoutEffect(() => {
      if (
        !SHOULD_CENTER_INITIAL_VIEWPORT ||
        !shouldCenterInitialViewport ||
        initiallyCenteredStoresRef.current.has(store)
      ) {
        return;
      }

      const rect = viewportRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return;

      // An empty page gets its camera now rather than when content appears:
      // deferring it would re-center on the user's own first drawing. This is
      // the same fallback a page switch installs for a page with no bounds.
      const camera = initialViewportTargetBounds
        ? computeCenteredCameraForBounds(
            initialViewportTargetBounds,
            { width: rect.width, height: rect.height },
            {
              padding: INITIAL_VIEWPORT_PADDING,
              minZoom: MIN_INITIAL_VIEWPORT_ZOOM,
              maxZoom: MAX_INITIAL_VIEWPORT_ZOOM,
            },
          )
        : getEmptyPageCamera(rect);
      if (!camera) return;

      runInAction(() => {
        store.zoom = camera.zoom;
        store.panX = camera.panX;
        store.panY = camera.panY;
        store.shouldCenterInitialViewport = false;
      });
      initiallyCenteredStoresRef.current.add(store);
    }, [
      store,
      shouldCenterInitialViewport,
      initialViewportTargetBounds?.x,
      initialViewportTargetBounds?.y,
      initialViewportTargetBounds?.width,
      initialViewportTargetBounds?.height,
    ]);

    const { clearMovingDragState, finishMovingDrag, flushPendingMovingDragCommit } = useMovingDrag({
      endHistoryTransaction,
      interaction,
      store,
      viewportRef,
    });

    const { commitPendingTouchStart, onPointerDown, startPointerInteraction } =
      useViewportPointerStart({
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
      });

    const onPointerMove = useViewportPointerMove({
      commitPendingTouchStart,
      createInkPoint,
      extendInkSession,
      getCanvasPoint,
      interaction,
      markPanning,
      markZooming,
      setMarqueeRect,
      store,
      viewportRef,
    });

    const onPointerEnd = useViewportPointerEnd({
      clearInkSession,
      clearMovingDragState,
      commitInkSession,
      createInkPoint,
      endHistoryTransaction,
      extendInkSession,
      finishMovingDrag,
      interaction,
      cancelGestureInteractionState,
      resetGestureInteractionState,
      setMarqueeRect,
      startPointerInteraction,
      store,
    });

    let cursor = "default";
    if (
      interaction.spacePressed ||
      interaction.dragState.type === "panning" ||
      store.activeTool === "pan"
    ) {
      cursor = "grab";
    }
    if (store.activeTool !== "select" && store.activeTool !== "pan") cursor = "crosshair";
    if (store.activeTool === "comment") cursor = COMMENT_CURSOR;
    const suppressNativeSelection = store.activeTool === "ink";

    return (
      <div
        ref={viewportRef}
        data-viewport
        style={{
          flex: 1,
          position: "relative",
          overflow: "hidden",
          backgroundColor: canvasBackground,
          cursor,
          touchAction: getViewportTouchAction(store.activeInteractiveSurfaceId),
          userSelect: suppressNativeSelection ? "none" : undefined,
          WebkitUserSelect: suppressNativeSelection ? "none" : undefined,
          WebkitTouchCallout: suppressNativeSelection ? "none" : undefined,
        }}
        onContextMenu={onContextMenu}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onPointerLeave={handlePointerLeave}
      >
        <GridPattern />
        <ViewportCanvas suppressNativeSelection={suppressNativeSelection} />
        <ArtboardLabels />
        <CommentPinsOverlay presencePeers={presencePeers} />
        <CanvasOverlay
          inkPreviewPath={inkSession?.pathData ?? null}
          marqueeRect={marqueeRect}
          presencePeers={presencePeers}
        />
        <VectorEditOverlay />
        <SelectionContextMenu anchorPoint={anchorPoint} onClose={closeContextMenu} />
      </div>
    );
  },
);
