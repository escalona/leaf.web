import { observer } from "mobx-react-lite";
import type { CSSProperties, DragEvent, MouseEvent as ReactMouseEvent } from "react";
import { useRef, useState } from "react";
import {
  ArtboardIcon,
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  FrameIcon,
  type IconComponent,
  ImageIcon,
  LockIcon,
  LockOpenIcon,
  PenIcon,
  RectangleIcon,
  ShaderIcon,
  TextIcon,
  VectorIcon,
  WindowIcon,
} from "../icons";
import { isEventTargetEditable } from "../../core/lib/keyboard-shortcuts";
import { useEditorStore } from "../../core/state/EditorStore";
import { hasLockedAncestor, isNodeLocked } from "../viewport/selection-targets";
import { getLayerLabel } from "./layer-label";
import {
  LAYER_ROW_HEIGHT,
  LAYER_ROW_INDENT,
  type LayerDropInstruction,
  type LayerRow,
} from "./layer-model";

const typeIcons: Record<string, IconComponent> = {
  frame: FrameIcon,
  text: TextIcon,
  rectangle: RectangleIcon,
  svg: VectorIcon,
  "interactive-surface": WindowIcon,
  image: ImageIcon,
  path: PenIcon,
  shader: ShaderIcon,
};

const layerRowToggleStyle = {
  width: 24,
  height: 24,
  border: 0,
  borderRadius: 6,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  transition: "opacity 0.1s, background-color 0.1s, color 0.1s",
} satisfies CSSProperties;

export const LayerRowItem = observer(
  ({
    activeDropInstruction,
    isDragging,
    isDescendantOfSelected,
    isSelected,
    isCollapsed,
    onContextMenu,
    onDragEnd,
    onDragOver,
    onDrop,
    onSelect,
    onStartDrag,
    row,
    showsDisclosureColumn,
    top,
    onToggleCollapse,
  }: {
    activeDropInstruction: LayerDropInstruction | null;
    isDragging: boolean;
    isDescendantOfSelected: boolean;
    isSelected: boolean;
    isCollapsed: boolean;
    onContextMenu: (row: LayerRow, event: ReactMouseEvent<HTMLDivElement>) => void;
    onDragEnd: () => void;
    onDragOver: (row: LayerRow, event: DragEvent<HTMLDivElement>) => void;
    onDrop: (row: LayerRow, event: DragEvent<HTMLDivElement>) => void;
    onSelect: (nodeId: string, modifiers: { additive: boolean; range: boolean }) => void;
    onStartDrag: (nodeId: string, event: DragEvent<HTMLDivElement>) => void;
    row: LayerRow;
    showsDisclosureColumn: boolean;
    top: number;
    onToggleCollapse: (nodeId: string) => void;
  }) => {
    const store = useEditorStore();
    const { depth, hasChildren, node } = row;
    const [isRowHovered, setIsRowHovered] = useState(false);
    const [isKeyboardFocused, setIsKeyboardFocused] = useState(false);
    const [isEditingName, setIsEditingName] = useState(false);
    const [draftName, setDraftName] = useState(node.name);
    const cancelRenameRef = useRef(false);

    const IconComponent = node.isArtboard ? ArtboardIcon : typeIcons[node.type];
    const isVisible = node.visible !== false;
    // The padlock reports the lock the canvas actually enforces, which a frame
    // hands down to everything inside it — an open padlock on a child the
    // pointer refuses to touch would be the row lying about the document.
    const isLocked = isNodeLocked(store, node.id);
    const isLockInherited = hasLockedAncestor(store, node.id);
    const layerLabel = getLayerLabel(node);
    const isRowHighlighted = isRowHovered || isKeyboardFocused;
    const rowBackgroundColor =
      activeDropInstruction === "make-child"
        ? "#eff6ff"
        : isKeyboardFocused
          ? "#fafafa"
          : isSelected
            ? "#eff6ff"
            : isDescendantOfSelected
              ? "#f5f9ff"
              : isRowHovered
                ? "#fafafa"
                : "transparent";
    // A lock or a hidden layer keeps its toggle visible unhovered: both states
    // change what the canvas will let you do, so the row has to say so without
    // being pointed at.
    const showsToggles = isRowHighlighted || isLocked || !isVisible;

    const startEditingName = () => {
      store.selectNode(node.id);
      cancelRenameRef.current = false;
      setDraftName(node.name);
      setIsEditingName(true);
    };

    const cancelEditingName = () => {
      cancelRenameRef.current = true;
      setDraftName(node.name);
      setIsEditingName(false);
    };

    const commitEditingName = (nextValue = draftName) => {
      const shouldCancel = cancelRenameRef.current;
      cancelRenameRef.current = false;
      setIsEditingName(false);

      if (shouldCancel) {
        setDraftName(node.name);
        return;
      }

      const trimmed = nextValue.trim();
      if (!trimmed || trimmed === node.name) {
        setDraftName(node.name);
        return;
      }

      store.runtime.renameNodes([{ nodeId: node.id, name: trimmed }]);
    };

    const toggleLayerVisibility = () => {
      store.runtime.updateNode(node.id, { visible: !isVisible });
    };

    const toggleLayerLock = () => {
      store.runtime.updateNode(node.id, { locked: node.locked !== true });
    };

    return (
      <div
        style={{
          position: "absolute",
          top,
          left: 0,
          right: 0,
          height: LAYER_ROW_HEIGHT,
          contentVisibility: "auto",
          containIntrinsicSize: `${LAYER_ROW_HEIGHT}px`,
        }}
      >
        <div
          data-layer-row-id={node.id}
          role="treeitem"
          aria-selected={isSelected}
          aria-level={depth + 1}
          aria-expanded={hasChildren ? !isCollapsed : undefined}
          tabIndex={isSelected ? 0 : -1}
          draggable={!isEditingName && !isLocked}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(node.id, {
              additive: e.metaKey || e.ctrlKey,
              range: e.shiftKey,
            });
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            onSelect(node.id, {
              additive: event.metaKey || event.ctrlKey,
              range: event.shiftKey,
            });
          }}
          onFocus={(event) => {
            if (event.target !== event.currentTarget) return;
            setIsKeyboardFocused(event.currentTarget.matches(":focus-visible"));
          }}
          onBlur={(event) => {
            if (event.target === event.currentTarget) setIsKeyboardFocused(false);
          }}
          onContextMenu={(event) => {
            // The rename input keeps the native menu: opening ours would move
            // focus off the input, and that blur commits the rename.
            if (isEventTargetEditable(event.target)) return;
            onContextMenu(row, event);
          }}
          onDragEnd={onDragEnd}
          onDragOver={(event) => onDragOver(row, event)}
          onDrop={(event) => onDrop(row, event)}
          onDragStart={(event) => onStartDrag(node.id, event)}
          onPointerEnter={() => {
            setIsRowHovered(true);
            store.setHoveredNode(node.id);
          }}
          onPointerLeave={() => {
            setIsRowHovered(false);
            if (store.hoveredId === node.id) store.clearHoveredNode();
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            height: LAYER_ROW_HEIGHT,
            width: "100%",
            padding: "0 10px",
            paddingLeft: 10 + depth * LAYER_ROW_INDENT,
            fontSize: 12,
            fontFamily: "Inter, system-ui, sans-serif",
            color: isSelected ? "#18181b" : "#52525b",
            backgroundColor: rowBackgroundColor,
            fontWeight: 400,
            transition: "background-color 0.1s, box-shadow 0.1s, opacity 0.1s",
            opacity: isDragging ? 0.45 : isVisible ? 1 : 0.55,
            outline: "none",
            boxShadow:
              activeDropInstruction === "reorder-above"
                ? "inset 0 2px 0 #3b82f6"
                : activeDropInstruction === "reorder-below"
                  ? "inset 0 -2px 0 #3b82f6"
                  : activeDropInstruction === "make-child"
                    ? "inset 0 0 0 1px #93c5fd"
                    : undefined,
          }}
        >
          {hasChildren ? (
            <button
              type="button"
              aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${node.name}`}
              data-layer-collapse-id={node.id}
              onClick={(e) => {
                e.stopPropagation();
                onToggleCollapse(node.id);
              }}
              style={{
                width: 14,
                height: 14,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#a1a1aa",
                userSelect: "none",
                flexShrink: 0,
                padding: 0,
                border: "none",
                background: "transparent",
              }}
            >
              <ChevronRightIcon
                size={12}
                style={{
                  transform: isCollapsed ? "rotate(0deg)" : "rotate(90deg)",
                  transition: "transform 0.15s",
                }}
              />
            </button>
          ) : showsDisclosureColumn ? (
            <span style={{ width: 14, flexShrink: 0 }} />
          ) : null}

          <span
            style={{
              width: 14,
              height: 14,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              color: isSelected ? "#3b82f6" : "#a1a1aa",
            }}
          >
            {IconComponent && <IconComponent size={12} />}
          </span>

          {isEditingName ? (
            <input
              autoFocus
              aria-label={`Rename ${node.name}`}
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              onBlur={(event) => commitEditingName(event.currentTarget.value)}
              onClick={(event) => {
                event.stopPropagation();
              }}
              onDoubleClick={(event) => {
                event.stopPropagation();
              }}
              onFocus={(event) => {
                event.currentTarget.select();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelEditingName();
                }
              }}
              style={{
                flex: "0 1 auto",
                minWidth: 0,
                width: 200,
                border: "1px solid #cbd5e1",
                borderRadius: 6,
                padding: "2px 6px",
                fontSize: 12,
                fontWeight: 500,
                fontFamily: "Inter, system-ui, sans-serif",
                color: "#18181b",
                backgroundColor: "#ffffff",
                outline: "none",
              }}
            />
          ) : (
            <span
              title={layerLabel}
              onDoubleClick={(event) => {
                event.stopPropagation();
                startEditingName();
              }}
              style={{
                flexShrink: 0,
                whiteSpace: "nowrap",
              }}
            >
              {layerLabel}
            </span>
          )}

          {/* Names are never truncated, so the row can run far past the panel.
              The toggles stay reachable by sticking to the visible edge, with
              the row's own background masking the name sliding underneath. */}
          <div
            style={{
              position: "sticky",
              right: 0,
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              gap: 6,
              flexShrink: 0,
              paddingLeft: 6,
              backgroundColor: showsToggles
                ? rowBackgroundColor === "transparent"
                  ? "#fff"
                  : rowBackgroundColor
                : "transparent",
              pointerEvents: showsToggles ? "auto" : "none",
              transition: "background-color 0.1s",
            }}
          >
            <button
              type="button"
              aria-label={isLocked ? `Unlock ${layerLabel}` : `Lock ${layerLabel}`}
              data-layer-lock-id={node.id}
              // An inherited lock is not this row's to release, so the padlock
              // shows the state without offering a click that would do nothing.
              disabled={isLockInherited}
              title={
                isLockInherited
                  ? "Locked by a parent layer"
                  : isLocked
                    ? "Unlock layer"
                    : "Lock layer"
              }
              draggable={false}
              onClick={(event) => {
                event.stopPropagation();
                toggleLayerLock();
              }}
              onDoubleClick={(event) => {
                event.stopPropagation();
              }}
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              style={{
                ...layerRowToggleStyle,
                color: isLocked ? "#52525b" : "#a1a1aa",
                backgroundColor: isRowHighlighted || isLocked ? "#f4f4f5" : "transparent",
                opacity: isRowHighlighted || isLocked ? (isLockInherited ? 0.55 : 1) : 0,
              }}
            >
              {isLocked ? <LockIcon size={12} /> : <LockOpenIcon size={12} />}
            </button>

            <button
              type="button"
              aria-label={isVisible ? `Hide ${layerLabel}` : `Show ${layerLabel}`}
              title={isVisible ? "Hide layer" : "Show layer"}
              draggable={false}
              onClick={(event) => {
                event.stopPropagation();
                toggleLayerVisibility();
              }}
              onDoubleClick={(event) => {
                event.stopPropagation();
              }}
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              style={{
                ...layerRowToggleStyle,
                color: isVisible ? "#71717a" : "#a1a1aa",
                backgroundColor: isRowHighlighted || !isVisible ? "#f4f4f5" : "transparent",
                opacity: isRowHighlighted || !isVisible ? 1 : 0,
              }}
            >
              {isVisible ? <EyeIcon size={12} /> : <EyeOffIcon size={12} />}
            </button>
          </div>
        </div>
      </div>
    );
  },
);
