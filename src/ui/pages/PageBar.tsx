import { ContextMenu } from "@base-ui/react/context-menu";
import { observer } from "mobx-react-lite";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, PlusIcon } from "../icons";
import type { DragEvent } from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useEditorStore } from "../../core/state/EditorStore";
import type { EditorPage } from "../../core/types";
import { IconButton, Menu } from "../primitives";

export const PAGE_ROW_HEIGHT = 26;

// Rename field chrome. The inset is what the input's own border plus horizontal
// padding add before its text starts, and it stays smaller than the row's own
// padding so the pulled-out field still sits inside the row.
const NAME_INPUT_BORDER = 1;
const NAME_INPUT_PADDING_X = 6;
const NAME_INPUT_INSET = NAME_INPUT_BORDER + NAME_INPUT_PADDING_X;

type DropPosition = "above" | "below";

type PageBarProps = {
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
};

/**
 * Page list above the layer tree. Pages are the within-file
 * organisational axis; branches in the file menu remain the versioning axis.
 */
export const PageBar = observer((props: PageBarProps = {}) => {
  const { collapsed: controlledCollapsed, onCollapsedChange } = props;
  const store = useEditorStore();
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const collapsed = controlledCollapsed ?? internalCollapsed;
  const [editingPageId, setEditingPageId] = useState<string | null>(null);
  const [draggedPageId, setDraggedPageId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ pageId: string; position: DropPosition } | null>(
    null,
  );

  const addPage = useCallback(() => {
    const page = store.runtime.createPage();
    store.setActivePage(page.id);
    setEditingPageId(page.id);
  }, [store]);

  const clearDragState = useCallback(() => {
    setDraggedPageId(null);
    setDropTarget(null);
  }, []);

  const dropPage = useCallback(() => {
    const target = dropTarget;
    const sourceId = draggedPageId;
    clearDragState();
    if (!sourceId || !target || target.pageId === sourceId) return;

    const remaining = store.pages.map((page) => page.id).filter((pageId) => pageId !== sourceId);
    const targetIndex = remaining.indexOf(target.pageId);
    if (targetIndex === -1) return;
    remaining.splice(targetIndex + (target.position === "below" ? 1 : 0), 0, sourceId);
    store.runtime.reorderPages(remaining);
  }, [clearDragState, draggedPageId, dropTarget, store]);

  const toggleCollapsed = useCallback(() => {
    const nextCollapsed = !collapsed;
    if (controlledCollapsed === undefined) setInternalCollapsed(nextCollapsed);
    onCollapsedChange?.(nextCollapsed);
  }, [collapsed, controlledCollapsed, onCollapsedChange]);

  return (
    <div
      style={{
        height: collapsed ? "auto" : "100%",
        minHeight: 0,
        borderBottom: "1px solid var(--leaf-border)",
        padding: "6px 4px 8px",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "0 6px 2px",
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          aria-label={collapsed ? "Expand pages" : "Collapse pages"}
          onClick={toggleCollapsed}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            flex: 1,
            minWidth: 0,
            border: 0,
            padding: 0,
            background: "transparent",
            color: "var(--leaf-text)",
            fontSize: "var(--leaf-text-sm)",
            fontWeight: 400,
            fontFamily: "var(--leaf-font-sans)",
            textAlign: "left",
          }}
        >
          {collapsed ? <ChevronRightIcon size={12} /> : <ChevronDownIcon size={12} />}
          <span
            title={collapsed ? store.activePage.name : undefined}
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              textAlign: "left",
              whiteSpace: "nowrap",
            }}
          >
            {collapsed ? store.activePage.name : "Pages"}
          </span>
        </button>
        {!collapsed && (
          <IconButton
            aria-label="Add page"
            title="Add page"
            variant="ghost"
            size="sm"
            onClick={addPage}
            style={{ width: 20, height: 20, borderRadius: "var(--leaf-radius-sm)" }}
          >
            <PlusIcon size={12} />
          </IconButton>
        )}
      </div>

      {!collapsed && (
        <div
          data-page-list
          style={{
            display: "flex",
            flex: 1,
            minHeight: 0,
            flexDirection: "column",
            overflowX: "hidden",
            overflowY: "auto",
          }}
        >
          {store.pages.map((page) => (
            <PageRow
              key={page.id}
              page={page}
              isActive={page.id === store.activePageId}
              isEditing={editingPageId === page.id}
              isDragging={draggedPageId === page.id}
              dropPosition={dropTarget?.pageId === page.id ? dropTarget.position : null}
              onStartEditing={() => setEditingPageId(page.id)}
              onStopEditing={() => setEditingPageId(null)}
              onDragEnd={clearDragState}
              onDragOver={(position) => {
                if (!draggedPageId) return;
                setDropTarget({ pageId: page.id, position });
              }}
              onDrop={dropPage}
              onStartDrag={() => setDraggedPageId(page.id)}
              draggable
            />
          ))}
        </div>
      )}
    </div>
  );
});

const PageRow = observer(
  ({
    page,
    isActive,
    isEditing,
    isDragging,
    dropPosition,
    onStartEditing,
    onStopEditing,
    onDragEnd,
    onDragOver,
    onDrop,
    onStartDrag,
    draggable,
  }: {
    page: EditorPage;
    isActive: boolean;
    isEditing: boolean;
    isDragging: boolean;
    dropPosition: DropPosition | null;
    onStartEditing: () => void;
    onStopEditing: () => void;
    onDragEnd: () => void;
    onDragOver: (position: DropPosition) => void;
    onDrop: () => void;
    onStartDrag: () => void;
    draggable: boolean;
  }) => {
    const store = useEditorStore();
    const [isHovered, setIsHovered] = useState(false);
    const isOnlyPage = store.pages.length === 1;

    return (
      <ContextMenu.Root>
        <ContextMenu.Trigger
          data-page-id={page.id}
          draggable={draggable && !isEditing}
          onClick={() => store.setActivePage(page.id)}
          onDoubleClick={onStartEditing}
          onDragStart={(event: DragEvent<HTMLDivElement>) => {
            onStartDrag();
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", page.id);
          }}
          onDragEnd={onDragEnd}
          onDragOver={(event: DragEvent<HTMLDivElement>) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            const bounds = event.currentTarget.getBoundingClientRect();
            onDragOver(event.clientY < bounds.top + bounds.height / 2 ? "above" : "below");
          }}
          onDrop={(event: DragEvent<HTMLDivElement>) => {
            event.preventDefault();
            onDrop();
          }}
          onPointerEnter={() => setIsHovered(true)}
          onPointerLeave={() => setIsHovered(false)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            height: PAGE_ROW_HEIGHT,
            flexShrink: 0,
            padding: "0 8px 0 10px",
            borderRadius: 6,
            fontSize: "var(--leaf-text-sm)",
            fontFamily: "var(--leaf-font-sans)",
            color: isActive ? "var(--leaf-text)" : "var(--leaf-text-secondary)",
            fontWeight: 400,
            backgroundColor: isActive
              ? "var(--leaf-accent-soft)"
              : isHovered
                ? "var(--leaf-surface-raised)"
                : "transparent",
            opacity: isDragging ? 0.45 : 1,
            boxShadow:
              dropPosition === "above"
                ? "inset 0 2px 0 var(--leaf-accent)"
                : dropPosition === "below"
                  ? "inset 0 -2px 0 var(--leaf-accent)"
                  : undefined,
          }}
        >
          {isEditing ? (
            <PageNameInput
              page={page}
              onCommit={(name) => {
                // The row can commit (blur) after a collaborator deleted the
                // page out from under the rename; there is nothing to rename.
                const stillExists = store.pages.some((candidate) => candidate.id === page.id);
                if (name && stillExists) store.runtime.renamePage(page.id, name);
                onStopEditing();
              }}
              onCancel={onStopEditing}
            />
          ) : (
            <span
              title={page.name}
              style={{
                flex: 1,
                minWidth: 0,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {page.name}
            </span>
          )}
          {isActive && !isEditing && (
            <CheckIcon size={12} color="var(--leaf-accent)" style={{ flexShrink: 0 }} />
          )}
        </ContextMenu.Trigger>
        {/* Base UI's context-menu Portal/Positioner/Popup/Item are re-exports of
            the plain menu parts, so the kit's styled Menu parts slot in here. */}
        <Menu.Portal>
          <Menu.Positioner sideOffset={0}>
            <Menu.Popup>
              <Menu.Item onClick={onStartEditing}>Rename page</Menu.Item>
              <Menu.Item
                onClick={() => {
                  const duplicate = store.runtime.duplicatePage(page.id);
                  store.setActivePage(duplicate.id);
                }}
              >
                Duplicate page
              </Menu.Item>
              <Menu.Item
                danger
                disabled={isOnlyPage}
                onClick={() => store.runtime.deletePage(page.id)}
              >
                Delete page
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </ContextMenu.Root>
    );
  },
);

function PageNameInput({
  page,
  onCommit,
  onCancel,
}: {
  page: EditorPage;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(page.name);
  const cancelledRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus before paint (like the autoFocus this replaced) so a keystroke typed
  // right after opening the rename can't land on the canvas shortcut handlers.
  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      aria-label={`Rename ${page.name}`}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => {
        if (cancelledRef.current) return;
        onCommit(event.currentTarget.value.trim());
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          cancelledRef.current = true;
          onCancel();
        }
      }}
      // Kit `leaf-input` is 28px tall (taller than the 26px row) and
      // `leaf-input-filled` is the gray filled style, so neither matches this
      // in-row white bordered field; keep the bespoke styles with tokens.
      style={{
        flex: 1,
        minWidth: 0,
        border: `${NAME_INPUT_BORDER}px solid #cbd5e1`,
        borderRadius: 6,
        padding: `2px ${NAME_INPUT_PADDING_X}px`,
        // The field's border + padding would otherwise push the name right of
        // where the static label sits; pull the box outward by exactly that
        // much so the text never moves when the row enters rename mode.
        margin: `0 -${NAME_INPUT_INSET}px`,
        fontSize: "var(--leaf-text-sm)",
        fontFamily: "var(--leaf-font-sans)",
        fontWeight: "inherit",
        color: "var(--leaf-text)",
        backgroundColor: "var(--leaf-surface)",
        outline: "none",
      }}
    />
  );
}
