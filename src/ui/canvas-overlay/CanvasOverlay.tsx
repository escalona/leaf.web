import { cursorCss } from "../icons";
import { observer } from "mobx-react-lite";
import { memo, useEffect, useState } from "react";
import {
  isLeafPresenceStateOnPage,
  type LeafPresenceTransformPreview,
} from "../../core/shared/collaboration/presence";
import { isNodeLocked, transformHud } from "../viewport/interaction-helpers";
import { isCreationTool } from "../viewport/pointer-utils";
import { useEditorStore } from "../../core/state/EditorStore";
import type { CompassDirection, DesignNode, Rect } from "../../core/types";
import type { CollaborationPresencePeer } from "../../core/state/collaboration-presence";
import { AgentActivityOverlay, getAgentWorkingDisplayNodeIds } from "./AgentActivityOverlay";
import { getAgentCornerRadii } from "./agent-activity-geometry";
import {
  FRAME_TITLE_BASELINE_GAP,
  FRAME_TITLE_FONT_SIZE,
  SELECTED_FRAME_TITLE_COLOR,
} from "./ArtboardLabels";
import { CanvasIndicatorStrokes } from "./CanvasIndicatorStrokes";
import {
  canRenderSpacingBands,
  getSpacingBands,
  resolveGapDragStart,
  resolvePaddingValue,
  type FlexGapBand,
  type PaddingBand,
} from "./spacing-band-geometry";
import { FONT_STACK } from "../floating-styles";
import { AlignToolbar, TransformHudBadge } from "./OverlayControls";
import { RemoteCursors } from "./RemoteCursors";
import {
  getNodeCanvasRect,
  getNodeLocalCanvasRect,
  getNodeOrientedBox,
} from "./live-node-geometry";
import {
  DETAILED_SELECTION_LIMIT,
  getDragInsertionIndicator,
  getHandlePositions,
  getLargeSelectionOutline,
  getParentOutlineRects,
  getRotateHandlePositions,
  getSelectionTransformBox,
  isRemoteCursorVisible,
  remotePresenceColor,
  SELECTION_TRANSFORM_HANDLE_ID,
  shouldRenderResizeHandles,
} from "./selection-overlay-geometry";

export {
  getNodeCanvasRect,
  getNodeLocalCanvasRect,
  getNodeOrientedBox,
} from "./live-node-geometry";
export {
  getHandlePositions,
  getLargeSelectionOutline,
  getRotateHandlePositions,
  getRotatedBounds,
  getSelectionTransformBox,
  SELECTION_TRANSFORM_HANDLE_ID,
  shouldRenderResizeHandles,
} from "./selection-overlay-geometry";
export type { CanvasBounds, SelectionTransformBox } from "./selection-overlay-geometry";

const MAX_REMOTE_SELECTION_RECTS = 32;
const MAX_REMOTE_PRESENCE_PEERS = 50;

const cursorMap: Record<CompassDirection, string> = {
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
};

// The icon set's rotate cursor: a quarter arc with an arrow head at both ends, 2px white halo,
// hotspot at the image centre. At 0° the arc is concave toward the top-left; rotateCursorMap
// orients each handle so the concave side faces the selection centre the gesture rotates around.
function createRotateCursor(degrees: number) {
  return cursorCss("rotate", { fill: "#1f2937", rotate: degrees }, "crosshair");
}

/** Double-headed corner rotate arrows with a visible non-hand fallback. */
const rotateCursorMap: Record<CompassDirection, string> = {
  nw: createRotateCursor(180),
  ne: createRotateCursor(270),
  se: createRotateCursor(0),
  sw: createRotateCursor(90),
  n: createRotateCursor(225),
  e: createRotateCursor(315),
  s: createRotateCursor(45),
  w: createRotateCursor(135),
};

/**
 * The non-interactive chrome of one spacing band: the optional light fill,
 * the centered dash, and the value badge beside the dash. The transparent
 * hit rect that claims the pointer is rendered by the caller.
 */
function SpacingBandVisual({
  badgeText,
  horizontal,
  kind,
  nodeId,
  rect,
  showFill,
  zoom,
}: {
  badgeText: string | null;
  /** Whether the band's long axis runs horizontally. */
  horizontal: boolean;
  kind: "gap" | "padding";
  nodeId: string;
  rect: Rect;
  showFill: boolean;
  zoom: number;
}) {
  // Color coding: pink for gaps, selection blue for padding.
  const accent = kind === "padding" ? "#1E90FF" : "#ec4899";
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const dashLength = Math.min(24 / zoom, horizontal ? rect.width : rect.height);
  const dashThickness = 1.25 / zoom;
  const badgeHeight = 20 / zoom;
  const badgeWidth =
    badgeText === null ? 0 : Math.max(28 / zoom, (badgeText.length * 7 + 16) / zoom);
  const badgeCenterX = horizontal ? centerX + dashLength / 2 + 8 / zoom + badgeWidth / 2 : centerX;
  const badgeCenterY = horizontal ? centerY : centerY + dashLength / 2 + 8 / zoom + badgeHeight / 2;
  return (
    <>
      {showFill && (
        <rect
          {...{ [`data-${kind}-band-fill`]: nodeId }}
          x={rect.x}
          y={rect.y}
          width={rect.width}
          height={rect.height}
          fill={accent}
          fillOpacity={0.16}
          pointerEvents="none"
        />
      )}
      <rect
        {...{ [`data-${kind}-band-dash`]: nodeId }}
        x={horizontal ? centerX - dashLength / 2 : centerX - dashThickness / 2}
        y={horizontal ? centerY - dashThickness / 2 : centerY - dashLength / 2}
        width={horizontal ? dashLength : dashThickness}
        height={horizontal ? dashThickness : dashLength}
        rx={dashThickness / 2}
        fill={accent}
        pointerEvents="none"
      />
      {badgeText !== null && (
        <g {...{ [`data-${kind}-band-badge`]: badgeText }} pointerEvents="none">
          <rect
            x={badgeCenterX - badgeWidth / 2}
            y={badgeCenterY - badgeHeight / 2}
            width={badgeWidth}
            height={badgeHeight}
            rx={badgeHeight / 2}
            fill={accent}
          />
          <text
            x={badgeCenterX}
            y={badgeCenterY}
            fill="#ffffff"
            style={{ fontFamily: FONT_STACK }}
            fontSize={11 / zoom}
            textAnchor="middle"
            dominantBaseline="middle"
          >
            {badgeText}
          </text>
        </g>
      )}
    </>
  );
}

type RemotePresenceOutlinesProps = {
  presencePeers: readonly CollaborationPresencePeer[];
  viewportEl: HTMLElement | null;
  zoom: number;
};

function areTransformPreviewsEqual(
  a: LeafPresenceTransformPreview | null,
  b: LeafPresenceTransformPreview | null,
) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.interactionId !== b.interactionId || a.kind !== b.kind) return false;
  if (a.deltas.length !== b.deltas.length) return false;
  for (let index = 0; index < a.deltas.length; index++) {
    const da = a.deltas[index]!;
    const db = b.deltas[index]!;
    if (
      da.nodeId !== db.nodeId ||
      da.x !== db.x ||
      da.y !== db.y ||
      da.width !== db.width ||
      da.height !== db.height ||
      da.rotation !== db.rotation
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Presence packets arrive as fresh peer arrays even when only a cursor moved,
 * so prop identity says nothing. Compare the fields the outlines actually
 * draw from; cursor-only fast-lane frames then skip the geometry pass.
 */
function arePresenceOutlineInputsEqual(
  prev: RemotePresenceOutlinesProps,
  next: RemotePresenceOutlinesProps,
) {
  if (prev.zoom !== next.zoom || prev.viewportEl !== next.viewportEl) return false;
  if (prev.presencePeers.length !== next.presencePeers.length) return false;
  for (let index = 0; index < prev.presencePeers.length; index++) {
    const a = prev.presencePeers[index]!;
    const b = next.presencePeers[index]!;
    if (a.sessionId !== b.sessionId || a.actorId !== b.actorId) return false;
    if (a.state.selectedNodeIds.length !== b.state.selectedNodeIds.length) return false;
    for (let id = 0; id < a.state.selectedNodeIds.length; id++) {
      if (a.state.selectedNodeIds[id] !== b.state.selectedNodeIds[id]) return false;
    }
    if (!areTransformPreviewsEqual(a.state.transform, b.state.transform)) return false;
  }
  return true;
}

/**
 * Remote peers' selection and transform outlines. The geometry pass below
 * re-measures node rects, so the outer memo drops the parent re-renders the
 * ~30/s cursor fast lane causes when no geometry input changed; the observer
 * still re-renders directly on the store state it reads (model edits, drag
 * offsets, remoteDragPreviews churn).
 */
const RemotePresenceOutlines = memo(
  observer(({ presencePeers, viewportEl, zoom }: RemotePresenceOutlinesProps) => {
    const store = useEditorStore();
    return (
      <>
        {presencePeers.slice(0, MAX_REMOTE_PRESENCE_PEERS).map((peer) => {
          const transformNodeIds = new Set(
            peer.state.transform?.deltas.map((delta) => delta.nodeId) ?? [],
          );
          const selectedRects = peer.state.selectedNodeIds
            .filter((nodeId) => !transformNodeIds.has(nodeId))
            .slice(0, MAX_REMOTE_SELECTION_RECTS)
            .map((nodeId) => store.getNode(nodeId))
            .filter((node): node is DesignNode => !!node)
            .map((node) => getNodeCanvasRect(node, store, viewportEl));
          // Deltas in remoteDragPreviews move the real element live, so only the
          // remainder (resizes, and drags clipped out of their frame) render the
          // overlay ghost rect.
          const transformRects = (peer.state.transform?.deltas ?? [])
            .filter((delta) => !store.remoteDragPreviews.has(delta.nodeId))
            .slice(0, MAX_REMOTE_SELECTION_RECTS)
            .map((delta) => {
              const node = store.getNode(delta.nodeId);
              if (!node) return null;
              const rect = getNodeCanvasRect(node, store, viewportEl);
              return {
                x: rect.x + (delta.x ?? 0),
                y: rect.y + (delta.y ?? 0),
                width: Math.max(0, rect.width + (delta.width ?? 0)),
                height: Math.max(0, rect.height + (delta.height ?? 0)),
              };
            })
            .filter((rect): rect is Rect => rect !== null);
          const color = remotePresenceColor(peer);
          return (
            <g key={peer.sessionId} data-remote-presence={peer.sessionId} pointerEvents="none">
              {selectedRects.map((rect, index) => (
                <rect
                  key={`selection-${index}`}
                  x={rect.x}
                  y={rect.y}
                  width={rect.width}
                  height={rect.height}
                  fill="none"
                  stroke={color}
                  strokeWidth={2 / zoom}
                  strokeDasharray={`${5 / zoom} ${4 / zoom}`}
                  opacity={0.8}
                />
              ))}
              {transformRects.map((rect, index) => (
                <rect
                  key={`transform-${index}`}
                  data-remote-transform-preview="true"
                  x={rect.x}
                  y={rect.y}
                  width={rect.width}
                  height={rect.height}
                  fill={color}
                  fillOpacity={0.08}
                  stroke={color}
                  strokeWidth={2 / zoom}
                />
              ))}
            </g>
          );
        })}
      </>
    );
  }),
  arePresenceOutlineInputsEqual,
);

/**
 * Mixed canvas/SVG overlay for editor chrome.
 * Stroke-only selection indicators render to a single canvas for lower DOM
 * overhead, while interactive and animated chrome stays in SVG.
 */
export const CanvasOverlay = observer(
  ({
    inkPreviewPath,
    marqueeRect,
    presencePeers = [],
  }: {
    inkPreviewPath?: string | null;
    marqueeRect?: Rect | null;
    presencePeers?: readonly CollaborationPresencePeer[];
  }) => {
    const store = useEditorStore();
    const { zoom, panX, panY, selectedNodes, hoveredId, selectedIds } = store;
    const strokeWidth = 2 / zoom;

    const [viewportEl, setViewportEl] = useState<HTMLElement | null>(null);
    useEffect(() => {
      setViewportEl(document.querySelector<HTMLElement>("[data-viewport]"));
    }, []);

    // MCP activity on a descendant coalesces to its containing artboard, while
    // local AI-assisted actions retain their explicitly chosen indicator node.
    const agentWorkingDisplayIds = getAgentWorkingDisplayNodeIds(store);
    const workingDisplayIds = new Set([...store.workingOnIds, ...agentWorkingDisplayIds]);
    const workingRects = Array.from(workingDisplayIds)
      .map((id) => store.getNode(id))
      .filter(
        (node): node is DesignNode =>
          !!node && store.getPageIdForNode(node.id) === store.activePageId,
      )
      .map((node) => ({
        cornerRadii: getAgentCornerRadii(node),
        labelWidthPx:
          Array.from(document.querySelectorAll<HTMLElement>("[data-artboard-label]"))
            .find((element) => element.dataset.artboardLabel === node.id)
            ?.getBoundingClientRect().width ?? 0,
        nodeId: node.id,
        ...getNodeOrientedBox(node, store, viewportEl),
      }));
    // Hovered node outline (if not selected)
    const hoveredNode = hoveredId && !selectedIds.has(hoveredId) ? store.getNode(hoveredId) : null;

    const usesBoundedSelectionRendering = selectedNodes.length > DETAILED_SELECTION_LIMIT;
    const visibleCanvasBounds = {
      left: -panX / zoom,
      top: -panY / zoom,
      right: (store.viewportWidth - panX) / zoom,
      bottom: (store.viewportHeight - panY) / zoom,
    };
    const largeSelectionOutline = usesBoundedSelectionRendering
      ? getLargeSelectionOutline(
          selectedNodes,
          store,
          viewportEl,
          visibleCanvasBounds,
          DETAILED_SELECTION_LIMIT,
        )
      : null;
    const largeSelectionFallbackLabel = largeSelectionOutline?.needsFallbackIndicator
      ? `${selectedNodes.length.toLocaleString()} selected`
      : null;
    // An inline text session drops the selection chrome: a caret needs no
    // handles, and the node under it reads as an edit target, not a
    // selection. Nested text keeps a thin dashed frame so its bounds stay
    // legible against the parent; root text sits alone and shows no frame.
    const editingTextNode = store.editingTextNodeId
      ? (store.getNode(store.editingTextNodeId) ?? null)
      : null;
    const textEditingOutlineNode =
      editingTextNode && store.parentMap.has(editingTextNode.id) ? editingTextNode : null;
    const boundedSelectedNodes = usesBoundedSelectionRendering
      ? []
      : selectedNodes.filter(
          (node) =>
            store.editingTextNodeId !== node.id && !store.isInteractionActiveForNode(node.id),
        );

    // Spacing bands: a single selected flex container exposes its
    // own gaps, and a selected flex child exposes its parent's gaps. The
    // chrome is hover-gated — dashes appear while the pointer is over the
    // container, and hovering a gap promotes it to the full pink section.
    // A promoted parent gets no padding strips and no clamped (zero-ish) gap
    // bands: their minimum-thickness hit rects overlap children flush against
    // the edges and would steal the sibling clicks that promotion exists for.
    // An armed creation tool keeps the selection outline but drops every
    // transform affordance: the next press draws, so nothing here may catch it.
    const transformChromeArmed = !isCreationTool(store.activeTool);
    const gapBandTargets: Array<{ node: DesignNode; isSelectedTarget: boolean }> = [];
    if (
      !marqueeRect &&
      transformChromeArmed &&
      selectedNodes.length === 1 &&
      shouldRenderResizeHandles(store)
    ) {
      const selected = selectedNodes[0]!;
      if (!isNodeLocked(store, selected.id) && !store.isInteractionActiveForNode(selected.id)) {
        gapBandTargets.push({ node: selected, isSelectedTarget: true });
        if (store.isFlexChild(selected.id)) {
          const flexParent = store.getParent(selected.id);
          if (
            flexParent &&
            !isNodeLocked(store, flexParent.id) &&
            !store.isInteractionActiveForNode(flexParent.id)
          ) {
            gapBandTargets.push({ node: flexParent, isSelectedTarget: false });
          }
        }
      }
    }
    // "Pointer over the container" means the hovered node is the container or
    // inside it, or the pointer sits on one of the container's own bands
    // (bands are overlay chrome, so node hover resolves to null there).
    const isPointerOverContainer = (containerId: string) => {
      if (store.spacingBandHighlight?.nodeId === containerId) return true;
      let id: string | undefined = hoveredId ?? undefined;
      while (id) {
        if (id === containerId) return true;
        id = store.parentMap.get(id);
      }
      return false;
    };
    const spacingBandGroups: Array<{
      node: DesignNode;
      gapBands: FlexGapBand[];
      paddingBands: PaddingBand[];
    }> = [];
    for (const { node, isSelectedTarget } of gapBandTargets) {
      if (!isPointerOverContainer(node.id) || !canRenderSpacingBands(node, store)) continue;
      const { gapBands, paddingBands } = getSpacingBands(node, store, viewportEl, zoom, {
        includeClampedGapBands: isSelectedTarget,
        includePaddingBands: isSelectedTarget,
      });
      if (gapBands.length > 0 || paddingBands.length > 0) {
        spacingBandGroups.push({ node, gapBands, paddingBands });
      }
    }

    const needsLiveGeometry =
      spacingBandGroups.length > 0 ||
      workingDisplayIds.size > 0 ||
      !!store.dragInsertionPreview ||
      !!largeSelectionOutline?.usesLiveGeometry ||
      !!textEditingOutlineNode ||
      (!usesBoundedSelectionRendering &&
        boundedSelectedNodes.some((node) => !store.dragCanvasOffset.has(node.id))) ||
      (!!hoveredNode && !store.hoveredCanvasRect);

    // Ignore ResizeObserver churn unless the overlay is actively tracking live DOM geometry.
    if (needsLiveGeometry) {
      store.domIndex.resizeTick.get();
    }

    const hoveredWorldRotation = hoveredNode ? store.getWorldRotation(hoveredNode.id) : 0;
    const hoveredRect = hoveredNode
      ? {
          rect:
            store.hoveredCanvasRect && !hoveredWorldRotation
              ? store.hoveredCanvasRect
              : getNodeLocalCanvasRect(hoveredNode, store, viewportEl),
          rotation: hoveredWorldRotation,
        }
      : null;

    // Compute rects for selected nodes; active interactions handle their own chrome.
    const selectedRects = boundedSelectedNodes.map((node) => ({
      node,
      ...getNodeOrientedBox(node, store, viewportEl),
    }));
    const canvasSelectedRects = largeSelectionOutline?.rect
      ? [{ rect: largeSelectionOutline.rect }]
      : selectedRects;
    const textEditingRect = textEditingOutlineNode
      ? getNodeOrientedBox(textEditingOutlineNode, store, viewportEl)
      : null;
    const parentOutlineRects = usesBoundedSelectionRendering
      ? []
      : getParentOutlineRects(boundedSelectedNodes, selectedIds, store, viewportEl);
    const enteredContainer = store.enteredContainerId
      ? (store.getNode(store.enteredContainerId) ?? null)
      : null;
    const enteredContainerRect =
      enteredContainer && enteredContainer.type === "frame"
        ? getNodeCanvasRect(enteredContainer, store, viewportEl)
        : null;
    const insertionIndicator = getDragInsertionIndicator(store, viewportEl, zoom);
    // Presence is page-scoped: a peer working on another page paints no
    // cursor, selection, or transform preview here.
    const activePagePeers = presencePeers.filter((peer) =>
      isLeafPresenceStateOnPage(peer.state, store.activePageId),
    );
    // Cursor state rides the ~30/s presence fast lane; keep its projection
    // allocation-light here and leave the geometry-heavy selection/transform
    // outlines to the memoized RemotePresenceOutlines component below.
    const remoteCursorPeers = activePagePeers.slice(0, MAX_REMOTE_PRESENCE_PEERS).map((peer) => ({
      color: remotePresenceColor(peer),
      cursor: isRemoteCursorVisible(peer.state.cursor, visibleCanvasBounds, zoom)
        ? peer.state.cursor
        : null,
      label: peer.displayName?.trim() || peer.actorId.slice(0, 24),
      sessionId: peer.sessionId,
    }));
    const isMarqueeSelecting = !!marqueeRect;
    const hasSingleSelection = selectedNodes.length === 1 && selectedRects.length === 1;
    // Root frames carry a permanent name from `ArtboardLabels`, which turns blue
    // on its own when selected. Nested frames have no such label, so selection is
    // the only time their name is drawn — in the same blue, plain text.
    const nestedFrameTitles =
      isMarqueeSelecting || !hasSingleSelection
        ? []
        : selectedRects.filter(({ node }) => node.type === "frame" && store.parentMap.has(node.id));
    const transformableRects = selectedRects.filter(({ node }) => !isNodeLocked(store, node.id));
    // The box wraps only the members a gesture can actually touch, so mixing one
    // locked node into a selection narrows the box instead of removing it. A
    // fully locked selection still shows nothing: the box is null for an empty list.
    const transformBox = getSelectionTransformBox(transformableRects);
    const showTransformBox =
      !isMarqueeSelecting &&
      transformChromeArmed &&
      !!transformBox &&
      shouldRenderResizeHandles(store);
    const hud = transformHud.get();
    const showAlignToolbar =
      !isMarqueeSelecting && !usesBoundedSelectionRendering && transformableRects.length > 1;

    return (
      <>
        <CanvasIndicatorStrokes
          viewportWidth={store.viewportWidth}
          viewportHeight={store.viewportHeight}
          zoom={zoom}
          panX={panX}
          panY={panY}
          hoveredRect={hoveredRect}
          parentOutlineRects={parentOutlineRects}
          enteredContainerRect={enteredContainerRect}
          selectedRects={canvasSelectedRects}
          textEditingRect={textEditingRect}
        />
        <svg
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
            overflow: "visible",
          }}
        >
          {largeSelectionFallbackLabel && (
            <g data-large-selection-summary={selectedNodes.length} pointerEvents="none">
              <rect
                x={12}
                y={12}
                width={Math.max(92, largeSelectionFallbackLabel.length * 7 + 24)}
                height={28}
                rx={14}
                fill="#1E90FF"
                opacity={0.96}
              />
              <text
                x={24}
                y={26}
                fill="#ffffff"
                fontFamily="Inter, system-ui, sans-serif"
                fontSize={12}
                dominantBaseline="middle"
              >
                {largeSelectionFallbackLabel}
              </text>
            </g>
          )}
          <g transform={`matrix(${zoom}, 0, 0, ${zoom}, ${panX}, ${panY})`}>
            {inkPreviewPath && (
              <path d={inkPreviewPath} fill="#18181b" opacity={0.96} pointerEvents="none" />
            )}

            <RemotePresenceOutlines
              presencePeers={activePagePeers}
              viewportEl={viewportEl}
              zoom={zoom}
            />

            <RemoteCursors peers={remoteCursorPeers} zoom={zoom} />

            <AgentActivityOverlay workingRects={workingRects} zoom={zoom} />

            {marqueeRect && (
              <rect
                data-marquee-selection="true"
                x={marqueeRect.x}
                y={marqueeRect.y}
                width={marqueeRect.width}
                height={marqueeRect.height}
                fill="#1E90FF"
                fillOpacity={0.12}
                stroke="#1E90FF"
                strokeWidth={strokeWidth}
                strokeDasharray={`${6 / zoom} ${4 / zoom}`}
              />
            )}

            {store.snapGuides.map((guide, index) =>
              guide.axis === "x" ? (
                <line
                  key={`snap-x-${index}`}
                  x1={guide.position}
                  y1={guide.from}
                  x2={guide.position}
                  y2={guide.to}
                  stroke="#ec4899"
                  strokeWidth={strokeWidth}
                  opacity={0.9}
                />
              ) : (
                <line
                  key={`snap-y-${index}`}
                  x1={guide.from}
                  y1={guide.position}
                  x2={guide.to}
                  y2={guide.position}
                  stroke="#ec4899"
                  strokeWidth={strokeWidth}
                  opacity={0.9}
                />
              ),
            )}

            {spacingBandGroups.map(({ node, gapBands, paddingBands }) => {
              const highlight =
                store.spacingBandHighlight?.nodeId === node.id ? store.spacingBandHighlight : null;
              // The highlight's bandKey is a render-order index into arrays
              // rebuilt from live geometry each frame, so a mid-drag reflow
              // (rewrap) can repoint it. Trust it only when the band at that
              // index still matches the highlight's semantic identity, and
              // fall back to the first band of the same axis/side otherwise.
              const keyedGapBand = highlight?.kind === "gap" ? gapBands[highlight.bandKey] : null;
              const hoveredGapBand =
                highlight?.kind === "gap"
                  ? keyedGapBand?.gapAxis === highlight.gapAxis
                    ? keyedGapBand
                    : gapBands.find((band) => band.gapAxis === highlight.gapAxis)
                  : undefined;
              const hoveredPaddingBand =
                highlight?.kind === "padding"
                  ? paddingBands.find((band) => band.side === highlight.side)
                  : undefined;
              return (
                <g key={`spacing-bands-${node.id}`} data-gap-bands={node.id}>
                  {gapBands.map((band, bandKey) => (
                    <g key={`gap-band-${bandKey}`}>
                      <SpacingBandVisual
                        kind="gap"
                        nodeId={node.id}
                        rect={band.rect}
                        horizontal={band.pointerAxis === "y"}
                        // Hovering one gap lights up every section that shares
                        // its value; the badge marks only the hovered one.
                        showFill={hoveredGapBand?.gapAxis === band.gapAxis}
                        badgeText={
                          band === hoveredGapBand
                            ? `${Math.round(resolveGapDragStart(node, band.gapAxis, store).startGap)}`
                            : null
                        }
                        zoom={zoom}
                      />
                      {band.draggable && (
                        <rect
                          x={band.rect.x}
                          y={band.rect.y}
                          width={band.rect.width}
                          height={band.rect.height}
                          fill="transparent"
                          style={{
                            pointerEvents: "all",
                            cursor: band.pointerAxis === "x" ? "col-resize" : "row-resize",
                          }}
                          data-gap-band-node={node.id}
                          data-gap-band-key={bandKey}
                          data-gap-band-gap-axis={band.gapAxis}
                          data-gap-band-pointer-axis={band.pointerAxis}
                          data-gap-band-index={band.index}
                          data-gap-band-sign={band.sign}
                        />
                      )}
                    </g>
                  ))}
                  {paddingBands.map((band, bandKey) => (
                    <g key={`padding-band-${bandKey}`}>
                      <SpacingBandVisual
                        kind="padding"
                        nodeId={node.id}
                        rect={band.rect}
                        horizontal={band.pointerAxis === "y"}
                        // Padding drags edit one side, so only the hovered
                        // strip lights — unlike gaps, which share a value.
                        showFill={band.side === hoveredPaddingBand?.side}
                        badgeText={
                          band === hoveredPaddingBand
                            ? `${Math.round(resolvePaddingValue(node, band.side, store))}`
                            : null
                        }
                        zoom={zoom}
                      />
                      <rect
                        x={band.rect.x}
                        y={band.rect.y}
                        width={band.rect.width}
                        height={band.rect.height}
                        fill="transparent"
                        style={{
                          pointerEvents: "all",
                          cursor: band.pointerAxis === "x" ? "col-resize" : "row-resize",
                        }}
                        data-padding-band-node={node.id}
                        data-padding-band-key={bandKey}
                        data-padding-band-side={band.side}
                        data-padding-band-pointer-axis={band.pointerAxis}
                        data-padding-band-sign={band.sign}
                      />
                    </g>
                  ))}
                </g>
              );
            })}

            {insertionIndicator && (
              <g data-drag-insertion-indicator={store.dragInsertionPreview?.nodeId ?? ""}>
                <rect
                  data-drag-insertion-line={store.dragInsertionPreview?.nodeId ?? ""}
                  x={insertionIndicator.line.x}
                  y={insertionIndicator.line.y}
                  width={insertionIndicator.line.width}
                  height={insertionIndicator.line.height}
                  fill="#1E90FF"
                />
              </g>
            )}

            {nestedFrameTitles.map(({ node, rect }) => (
              <text
                key={`frame-title-${node.id}`}
                data-frame-title-node={node.id}
                x={rect.x}
                y={rect.y - FRAME_TITLE_BASELINE_GAP / zoom}
                fill={SELECTED_FRAME_TITLE_COLOR}
                fontFamily={FONT_STACK}
                fontSize={FRAME_TITLE_FONT_SIZE / zoom}
                style={{ pointerEvents: "all", cursor: "default", userSelect: "none" }}
              >
                {node.name}
              </text>
            ))}

            {/* One transform box for the selection: resize + rotate handles */}
            {showTransformBox && transformBox && (
              <g
                data-selection-transform-box={transformBox.handleNodeId}
                transform={
                  transformBox.rotation
                    ? `rotate(${transformBox.rotation} ${
                        transformBox.rect.x + transformBox.rect.width / 2
                      } ${transformBox.rect.y + transformBox.rect.height / 2})`
                    : undefined
                }
              >
                {transformBox.handleNodeId === SELECTION_TRANSFORM_HANDLE_ID && (
                  <rect
                    data-selection-bounds="true"
                    x={transformBox.rect.x}
                    y={transformBox.rect.y}
                    width={transformBox.rect.width}
                    height={transformBox.rect.height}
                    fill="none"
                    stroke="#1E90FF"
                    strokeWidth={strokeWidth}
                    strokeDasharray={`${4 / zoom} ${3 / zoom}`}
                    pointerEvents="none"
                  />
                )}
                {getRotateHandlePositions(transformBox.rect, zoom).map((handle) => (
                  <rect
                    key={`rotate-${handle.dir}`}
                    x={handle.rect.x}
                    y={handle.rect.y}
                    width={handle.rect.width}
                    height={handle.rect.height}
                    fill="transparent"
                    style={{ pointerEvents: "all", cursor: rotateCursorMap[handle.dir] }}
                    data-rotate-handle-dir={handle.dir}
                    data-handle-node={transformBox.handleNodeId}
                    data-rotate-center-x={transformBox.rect.x + transformBox.rect.width / 2}
                    data-rotate-center-y={transformBox.rect.y + transformBox.rect.height / 2}
                  />
                ))}
                {getHandlePositions(transformBox.rect, zoom).map((handle) => (
                  <rect
                    key={`${transformBox.handleNodeId}-${handle.dir}`}
                    x={handle.rect.x}
                    y={handle.rect.y}
                    width={handle.rect.width}
                    height={handle.rect.height}
                    fill="white"
                    stroke="#1E90FF"
                    strokeWidth={strokeWidth}
                    style={{
                      pointerEvents: "all",
                      cursor: cursorMap[handle.dir],
                    }}
                    data-handle-dir={handle.dir}
                    data-handle-node={transformBox.handleNodeId}
                  />
                ))}
              </g>
            )}

            {hud && <TransformHudBadge hud={hud} zoom={zoom} />}
          </g>
        </svg>
        {showAlignToolbar && <AlignToolbar viewportEl={viewportEl} />}
      </>
    );
  },
);
