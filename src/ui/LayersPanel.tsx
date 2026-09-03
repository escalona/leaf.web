import { observer } from "mobx-react-lite";
import type { DragEvent, MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { defineKeyboardShortcuts, dispatchKeyboardShortcuts } from "../core/lib/keyboard-shortcuts";
import { useEditorStore, type EditorStore } from "../core/state/EditorStore";
import { SelectionContextMenu, useSelectionContextMenu } from "./context-menu/SelectionContextMenu";
import { FileMenu } from "./layers/FileMenu";
import { LayerRowItem } from "./layers/LayerRowItem";
import {
  applyInsertedLayerRows,
  buildLayerRowMetadata,
  expandSelectedAncestors,
  findRowIndexAtOrder,
  type LayerRowsCache,
} from "./layers/layer-row-cache";
import { PageBar } from "./pages/PageBar";
import { PanelResizeHandle } from "./PanelResizeHandle";
import { useLayerDragAutoScroll } from "./layers/layer-drag-auto-scroll";
import {
  buildVisibleLayerRows,
  getLayerDropTarget,
  LAYER_ROW_HEIGHT,
  LAYER_ROW_OVERSCAN,
  resolveLayerDropInstruction,
  type LayerDropInstruction,
  type LayerRow,
} from "./layers/layer-model";
import {
  LAYERS_PANEL_MAX_WIDTH,
  LAYERS_PANEL_MIN_WIDTH,
  PAGES_PANEL_MAX_HEIGHT,
  PAGES_PANEL_MIN_HEIGHT,
} from "../core/editor/editor-layout";
import { timeLeafPerfTrace } from "../core/lib/perf-trace";

export { resolveLayerDropInstruction } from "./layers/layer-model";

export const LAYERS_PANEL_BOTTOM_REVEAL_INSET = 32;

type LayersPanelKeyboardShortcutContext = {
  store: EditorStore;
  collapseSelectedLayers: () => void;
};

const LAYERS_PANEL_SHORTCUTS = defineKeyboardShortcuts<LayersPanelKeyboardShortcutContext>([
  {
    id: "collapse-selected-layers",
    description: "Collapse every layer inside the selected frames or groups.",
    combos: { code: "KeyL", alt: true },
    preventDefault: true,
    when: ({ store }) => store.selectedNodes.some((node) => node.children.length > 0),
    handler: ({ collapseSelectedLayers }) => {
      collapseSelectedLayers();
    },
  },
]);

export const LayersPanel = observer(
  ({
    fileName,
    onReturnToDashboard,
    onRenameFile,
  }: {
    fileName: string;
    onReturnToDashboard: () => void;
    onRenameFile: (name: string) => void;
  }) => {
    const store = useEditorStore();
    const scrollRef = useRef<HTMLDivElement>(null);
    const [pagesCollapsed, setPagesCollapsed] = useState(false);
    const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
    const [draggedLayerId, setDraggedLayerId] = useState<string | null>(null);
    const [dropInstruction, setDropInstruction] = useState<LayerDropInstruction | null>(null);
    const [dropTargetId, setDropTargetId] = useState<string | null>(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportHeight, setViewportHeight] = useState(0);
    const selectionAnchorIdRef = useRef<string | null>(null);
    const layerSelectionRef = useRef<{ store: EditorStore; selectionKey: string } | null>(null);
    const selectedIdsKey = [...store.selectedIds].join("\0");
    const handledSelectionKeyRef = useRef(selectedIdsKey);
    const [pendingRevealSelectionKey, setPendingRevealSelectionKey] = useState<string | null>(() =>
      store.selectedIds.size === 0 ? null : selectedIdsKey,
    );
    const rowsCacheRef = useRef<LayerRowsCache | null>(null);

    useEffect(() => {
      const element = scrollRef.current;
      if (!element) return;

      const updateViewportHeight = () => {
        setViewportHeight(element.clientHeight);
      };

      updateViewportHeight();

      if (typeof ResizeObserver === "undefined") {
        return;
      }

      const resizeObserver = new ResizeObserver(updateViewportHeight);
      resizeObserver.observe(element);
      return () => {
        resizeObserver.disconnect();
      };
    }, []);

    const renderTreeVersion = store.renderTreeVersion;
    const renderTreeMutation = store.renderTreeMutation;
    const rowsCache = useMemo(() => {
      const previous = rowsCacheRef.current;
      const incrementallyInsertedCache =
        previous && renderTreeMutation
          ? timeLeafPerfTrace("layers.insertRows", () =>
              applyInsertedLayerRows(previous, renderTreeMutation, store, collapsedIds),
            )
          : null;
      if (incrementallyInsertedCache) {
        return incrementallyInsertedCache;
      }

      const nextRows = timeLeafPerfTrace("layers.buildRows", () =>
        buildVisibleLayerRows(store.nodes, collapsedIds),
      );
      return {
        collapsedIds,
        version: renderTreeVersion,
        rows: nextRows,
        ...timeLeafPerfTrace("layers.rowMetadata", () => buildLayerRowMetadata(nextRows)),
      };
    }, [store, store.nodes.length, collapsedIds, renderTreeMutation, renderTreeVersion]);
    useLayoutEffect(() => {
      rowsCacheRef.current = rowsCache;
    }, [rowsCache]);
    const rows = rowsCache.rows;
    useLayoutEffect(() => {
      const layerSelection = layerSelectionRef.current;
      layerSelectionRef.current = null;
      if (layerSelection?.store === store && layerSelection.selectionKey === selectedIdsKey) {
        return;
      }

      selectionAnchorIdRef.current =
        rows.find((row) => store.selectedIds.has(row.node.id))?.node.id ?? null;
    }, [rows, selectedIdsKey, store]);
    const selectedRowIndex = useMemo(() => {
      let firstIndex = Number.POSITIVE_INFINITY;
      for (const selectedId of store.selectedIds) {
        const order = rowsCache.rowOrderById.get(selectedId);
        if (order !== undefined) {
          firstIndex = Math.min(firstIndex, findRowIndexAtOrder(rowsCache, order));
        }
      }
      return Number.isFinite(firstIndex) ? firstIndex : -1;
    }, [rowsCache, selectedIdsKey, store]);

    useEffect(() => {
      if (selectedIdsKey === handledSelectionKeyRef.current) return;
      handledSelectionKeyRef.current = selectedIdsKey;
      const selectedIds = new Set(store.selectedIds);
      const element = scrollRef.current;
      const selectedRowTop = selectedRowIndex * LAYER_ROW_HEIGHT;
      const effectiveClientHeight = element
        ? Math.max(LAYER_ROW_HEIGHT, element.clientHeight - LAYERS_PANEL_BOTTOM_REVEAL_INSET)
        : 0;
      if (element && selectedRowIndex >= 0) {
        const visibleTop = element.scrollTop;
        const visibleBottom = visibleTop + effectiveClientHeight;
        const selectedRowBottom = selectedRowTop + LAYER_ROW_HEIGHT;
        const nextScrollTop =
          selectedRowTop < visibleTop
            ? selectedRowTop
            : selectedRowBottom > visibleBottom
              ? Math.max(0, selectedRowBottom - effectiveClientHeight)
              : null;
        if (nextScrollTop !== null && nextScrollTop !== element.scrollTop) {
          element.scrollTop = nextScrollTop;
          setScrollTop(nextScrollTop);
        }
        setPendingRevealSelectionKey(null);
      } else {
        setPendingRevealSelectionKey(selectedIds.size === 0 ? null : selectedIdsKey);
      }
      if (selectedIds.size > 0) {
        setCollapsedIds((previous) =>
          expandSelectedAncestors(previous, selectedIds, store.parentMap),
        );
      }
    }, [rows, selectedIdsKey, selectedRowIndex, store]);

    useEffect(() => {
      const element = scrollRef.current;
      if (
        !element ||
        store.selectedIds.size === 0 ||
        pendingRevealSelectionKey !== selectedIdsKey
      ) {
        return;
      }

      if (selectedRowIndex === -1) return;

      const rowTop = selectedRowIndex * LAYER_ROW_HEIGHT;
      const rowBottom = rowTop + LAYER_ROW_HEIGHT;
      const visibleTop = element.scrollTop;
      const effectiveClientHeight = Math.max(
        LAYER_ROW_HEIGHT,
        element.clientHeight - LAYERS_PANEL_BOTTOM_REVEAL_INSET,
      );
      const visibleBottom = visibleTop + effectiveClientHeight;
      let nextScrollTop: number | null = null;

      if (rowTop < visibleTop) {
        nextScrollTop = rowTop;
      } else if (rowBottom > visibleBottom) {
        nextScrollTop = Math.max(0, rowBottom - effectiveClientHeight);
      }

      if (nextScrollTop !== null && nextScrollTop !== element.scrollTop) {
        element.scrollTop = nextScrollTop;
        setScrollTop(nextScrollTop);
      }

      setPendingRevealSelectionKey(null);
    }, [pendingRevealSelectionKey, rows, selectedIdsKey, selectedRowIndex, store]);

    const totalHeight = rows.length * LAYER_ROW_HEIGHT + LAYERS_PANEL_BOTTOM_REVEAL_INSET;
    let virtualScrollTop = scrollTop;
    const scrollElement = scrollRef.current;
    if (
      selectedIdsKey !== handledSelectionKeyRef.current &&
      selectedRowIndex >= 0 &&
      scrollElement
    ) {
      const selectedRowTop = selectedRowIndex * LAYER_ROW_HEIGHT;
      const effectiveClientHeight = Math.max(
        LAYER_ROW_HEIGHT,
        scrollElement.clientHeight - LAYERS_PANEL_BOTTOM_REVEAL_INSET,
      );
      const selectedRowBottom = selectedRowTop + LAYER_ROW_HEIGHT;
      if (selectedRowTop < scrollTop) virtualScrollTop = selectedRowTop;
      else if (selectedRowBottom > scrollTop + effectiveClientHeight) {
        virtualScrollTop = Math.max(0, selectedRowBottom - effectiveClientHeight);
      }
    }
    const startIndex = Math.max(
      0,
      Math.floor(virtualScrollTop / LAYER_ROW_HEIGHT) - LAYER_ROW_OVERSCAN,
    );
    const endIndex = Math.min(
      rows.length,
      Math.ceil((virtualScrollTop + viewportHeight) / LAYER_ROW_HEIGHT) + LAYER_ROW_OVERSCAN,
    );
    const visibleRows = rows.slice(startIndex, endIndex);
    const descendantOfSelectedIds = useMemo(() => {
      const result = new Set<string>();
      for (const row of visibleRows) {
        let parentId = store.parentMap.get(row.node.id);
        while (parentId) {
          if (store.selectedIds.has(parentId)) {
            result.add(row.node.id);
            break;
          }
          parentId = store.parentMap.get(parentId);
        }
      }
      return result;
    }, [selectedIdsKey, store, visibleRows]);

    const toggleCollapsed = useCallback((nodeId: string) => {
      setCollapsedIds((previous) => {
        const next = new Set(previous);
        if (next.has(nodeId)) {
          next.delete(nodeId);
        } else {
          next.add(nodeId);
        }
        return next;
      });
    }, []);

    const collapseSelectedLayers = useCallback(() => {
      setCollapsedIds((previous) => {
        const next = new Set(previous);
        const pending = [...store.selectedNodes];
        let changed = false;

        while (pending.length > 0) {
          const node = pending.pop()!;
          if (node.children.length === 0) continue;
          if (!next.has(node.id)) {
            next.add(node.id);
            changed = true;
          }
          pending.push(...node.children);
        }

        return changed ? next : previous;
      });
    }, [store]);

    const selectLayer = useCallback(
      (nodeId: string, modifiers: { additive: boolean; range: boolean }) => {
        if (modifiers.range) {
          const targetIndex = rows.findIndex((row) => row.node.id === nodeId);
          const explicitAnchorIndex = selectionAnchorIdRef.current
            ? rows.findIndex((row) => row.node.id === selectionAnchorIdRef.current)
            : -1;
          const selectedAnchorIndex =
            explicitAnchorIndex === -1
              ? rows.findIndex((row) => store.selectedIds.has(row.node.id))
              : -1;
          const anchorIndex =
            explicitAnchorIndex === -1 ? selectedAnchorIndex : explicitAnchorIndex;

          if (targetIndex !== -1 && anchorIndex !== -1) {
            selectionAnchorIdRef.current = rows[anchorIndex]!.node.id;
            const startIndex = Math.min(anchorIndex, targetIndex);
            const endIndex = Math.max(anchorIndex, targetIndex);
            const rangeIds = rows.slice(startIndex, endIndex + 1).map((row) => row.node.id);
            store.setSelectedIds(
              modifiers.additive ? [...store.selectedIds, ...rangeIds] : rangeIds,
            );
            layerSelectionRef.current = {
              store,
              selectionKey: [...store.selectedIds].join("\0"),
            };
            return;
          }
        }

        selectionAnchorIdRef.current = nodeId;
        store.selectNode(nodeId, modifiers.additive);
        layerSelectionRef.current = {
          store,
          selectionKey: [...store.selectedIds].join("\0"),
        };
      },
      [rows, store],
    );

    useEffect(() => {
      const context = { store, collapseSelectedLayers };
      const onKeyDown = (event: KeyboardEvent) => {
        dispatchKeyboardShortcuts({
          event,
          eventType: "keydown",
          shortcuts: LAYERS_PANEL_SHORTCUTS,
          context,
        });
      };

      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
    }, [collapseSelectedLayers, store]);

    const dragAutoScroll = useLayerDragAutoScroll(scrollRef);
    const stopDragAutoScroll = dragAutoScroll.stop;

    const clearLayerDropState = useCallback(() => {
      stopDragAutoScroll();
      setDraggedLayerId(null);
      setDropInstruction(null);
      setDropTargetId(null);
    }, [stopDragAutoScroll]);

    const onStartDrag = useCallback(
      (nodeId: string, event: DragEvent<HTMLDivElement>) => {
        store.selectNode(nodeId);
        setDraggedLayerId(nodeId);
        setDropInstruction(null);
        setDropTargetId(null);
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", nodeId);
      },
      [store],
    );

    const onDragOver = useCallback(
      (row: LayerRow, event: DragEvent<HTMLDivElement>) => {
        if (!draggedLayerId) return;

        const instruction = resolveLayerDropInstruction(event, row);
        if (!getLayerDropTarget(store, draggedLayerId, row.node, instruction)) {
          event.dataTransfer.dropEffect = "none";
          if (dropInstruction !== null || dropTargetId !== null) {
            setDropInstruction(null);
            setDropTargetId(null);
          }
          return;
        }

        event.preventDefault();
        event.dataTransfer.dropEffect = "move";

        if (instruction !== dropInstruction || dropTargetId !== row.node.id) {
          setDropInstruction(instruction);
          setDropTargetId(row.node.id);
        }
      },
      [draggedLayerId, dropInstruction, dropTargetId, store],
    );

    const onDrop = useCallback(
      (row: LayerRow, event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        const sourceId = draggedLayerId;
        const instruction = dropTargetId === row.node.id ? dropInstruction : null;
        if (!sourceId || !instruction) {
          clearLayerDropState();
          return;
        }

        const sourceNode = store.getNode(sourceId);
        const targetNode = store.getNode(row.node.id);
        if (!sourceNode || !targetNode) {
          clearLayerDropState();
          return;
        }

        const sourceCanvasPosition = store.getCanvasPosition(sourceId) ?? {
          x: sourceNode.x,
          y: sourceNode.y,
        };
        const dropTarget = getLayerDropTarget(store, sourceId, targetNode, instruction);
        if (!dropTarget) {
          clearLayerDropState();
          return;
        }

        store.beginHistoryTransaction();
        store.runtime.moveNodeToParent(sourceId, sourceCanvasPosition, dropTarget.parentId, {
          index: dropTarget.index,
          mode: dropTarget.mode,
        });
        store.endHistoryTransaction();
        clearLayerDropState();
      },
      [clearLayerDropState, draggedLayerId, dropInstruction, dropTargetId, store],
    );
    const onToggleSidebar = useCallback(() => store.toggleSidebar(), [store]);

    const { anchorPoint, closeContextMenu, openContextMenuAt } = useSelectionContextMenu();

    const onRowContextMenu = useCallback(
      (row: LayerRow, event: ReactMouseEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
        // Unlike the canvas, this row is a valid target even when the node is
        // locked — reaching a locked layer here is the whole point of the
        // lock, and Unlock is the command the menu will offer.
        if (!store.selectedIds.has(row.node.id)) store.selectNode(row.node.id);
        openContextMenuAt(event.clientX, event.clientY);
      },
      [openContextMenuAt, store],
    );

    return (
      <div
        data-layers-panel
        style={{
          width: store.sidebarWidth,
          backgroundColor: "#fff",
          borderRight: "1px solid #e4e4e7",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          overflow: "hidden",
          position: "relative",
        }}
      >
        <FileMenu
          fileName={fileName}
          onReturnToDashboard={onReturnToDashboard}
          onRenameFile={onRenameFile}
          onToggleSidebar={onToggleSidebar}
        />

        <div
          data-pages-panel
          style={{
            height: pagesCollapsed ? "auto" : store.pagesPanelHeight,
            minHeight: pagesCollapsed ? 0 : PAGES_PANEL_MIN_HEIGHT,
            flexShrink: pagesCollapsed ? 0 : 1,
            position: "relative",
          }}
        >
          <PageBar collapsed={pagesCollapsed} onCollapsedChange={setPagesCollapsed} />
          {!pagesCollapsed && (
            <PanelResizeHandle
              edge="bottom"
              label="Resize pages list"
              name="pages"
              min={PAGES_PANEL_MIN_HEIGHT}
              max={PAGES_PANEL_MAX_HEIGHT}
              value={store.pagesPanelHeight}
              onResize={(next) => store.setPagesPanelHeight(next)}
            />
          )}
        </div>

        <div
          className="panel-scroll"
          role="tree"
          aria-label="Layers"
          ref={scrollRef}
          onDragOver={draggedLayerId ? dragAutoScroll.handleDragOver : undefined}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              stopDragAutoScroll();
              setDropInstruction(null);
              setDropTargetId(null);
            }
          }}
          onScroll={(event) => {
            setScrollTop(event.currentTarget.scrollTop);
          }}
          style={{
            flex: 1,
            minHeight: 52,
            overflowX: "auto",
            overflowY: "auto",
            paddingTop: 4,
            overscrollBehavior: "contain",
          }}
        >
          <div
            style={{
              position: "relative",
              height: totalHeight,
              // Rows are never truncated, so the list is as wide as its widest
              // name and the panel scrolls sideways to reach the rest. Every
              // row spans that width, which keeps the trailing toggles pinned
              // to the same edge no matter how far the list is scrolled.
              width: rowsCache.contentWidth,
              minWidth: "100%",
            }}
          >
            {visibleRows.map((row, index) => {
              const rowIndex = startIndex + index;
              return (
                <LayerRowItem
                  key={row.node.id}
                  activeDropInstruction={dropTargetId === row.node.id ? dropInstruction : null}
                  isDragging={draggedLayerId === row.node.id}
                  isDescendantOfSelected={descendantOfSelectedIds.has(row.node.id)}
                  isSelected={store.selectedIds.has(row.node.id)}
                  row={row}
                  showsDisclosureColumn={rowsCache.hasExpandableRows}
                  top={rowIndex * LAYER_ROW_HEIGHT}
                  isCollapsed={collapsedIds.has(row.node.id)}
                  onContextMenu={onRowContextMenu}
                  onDragEnd={clearLayerDropState}
                  onDragOver={onDragOver}
                  onDrop={onDrop}
                  onSelect={selectLayer}
                  onStartDrag={onStartDrag}
                  onToggleCollapse={toggleCollapsed}
                />
              );
            })}
          </div>
        </div>
        <PanelResizeHandle
          edge="end"
          label="Resize layers sidebar"
          name="sidebar"
          min={LAYERS_PANEL_MIN_WIDTH}
          max={LAYERS_PANEL_MAX_WIDTH}
          value={store.sidebarWidth}
          onResize={(next) => store.setSidebarWidth(next)}
        />
        <SelectionContextMenu anchorPoint={anchorPoint} onClose={closeContextMenu} />
      </div>
    );
  },
);
