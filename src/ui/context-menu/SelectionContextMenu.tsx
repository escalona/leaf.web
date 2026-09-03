import { observer } from "mobx-react-lite";
import { ChevronRightIcon } from "../icons";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useEditorStore } from "../../core/state/EditorStore";
import { Menu } from "../primitives";
import {
  buildSelectionMenu,
  type SelectionMenuEntry,
  type SelectionMenuItem,
} from "./selection-menu-model";

export type ContextMenuAnchorPoint = { clientX: number; clientY: number };

/**
 * Open/close state for one right-click menu. Kept local to the surface that
 * owns the gesture — the canvas and the layers panel each have their own — so
 * no editor-wide UI state has to exist for a menu that lives for one click.
 */
export function useSelectionContextMenu() {
  const [anchorPoint, setAnchorPoint] = useState<ContextMenuAnchorPoint | null>(null);
  const openContextMenuAt = useCallback((clientX: number, clientY: number) => {
    setAnchorPoint({ clientX, clientY });
  }, []);
  const closeContextMenu = useCallback(() => setAnchorPoint(null), []);
  return { anchorPoint, closeContextMenu, openContextMenuAt };
}

/**
 * A zero-size rect at the cursor. Built by hand rather than with `DOMRect` so
 * the anchor works the same under jsdom as it does in the browser.
 */
function createPointAnchor({ clientX, clientY }: ContextMenuAnchorPoint) {
  const rect = {
    x: clientX,
    y: clientY,
    width: 0,
    height: 0,
    top: clientY,
    right: clientX,
    bottom: clientY,
    left: clientX,
    toJSON: () => ({}),
  } as DOMRect;
  return { getBoundingClientRect: () => rect };
}

function MenuItemContent({ item }: { item: SelectionMenuItem }) {
  return (
    <>
      <span>{item.label}</span>
      {item.shortcut && <span className="leaf-menu-shortcut">{item.shortcut}</span>}
    </>
  );
}

function SelectionMenuEntryView({
  entry,
  onRun,
}: {
  entry: SelectionMenuEntry;
  onRun: () => void;
}) {
  if ("items" in entry) {
    return (
      <Menu.SubmenuRoot>
        <Menu.SubmenuTrigger disabled={entry.disabled} data-menu-item={entry.id}>
          <span>{entry.label}</span>
          <span className="leaf-menu-submenu-chevron">
            <ChevronRightIcon size={12} />
          </span>
        </Menu.SubmenuTrigger>
        <Menu.Portal>
          <Menu.Positioner alignOffset={-4} side="inline-end" sideOffset={2}>
            <Menu.Popup>
              {entry.items.map((item) => (
                <Menu.Item
                  key={item.id}
                  data-menu-item={item.id}
                  disabled={item.disabled}
                  onClick={() => {
                    item.run();
                    onRun();
                  }}
                >
                  <MenuItemContent item={item} />
                </Menu.Item>
              ))}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.SubmenuRoot>
    );
  }

  return (
    <Menu.Item
      data-menu-item={entry.id}
      danger={entry.danger}
      disabled={entry.disabled}
      onClick={() => {
        entry.run();
        onRun();
      }}
    >
      <MenuItemContent item={entry} />
    </Menu.Item>
  );
}

/**
 * The right-click menu for the current selection, anchored to the cursor.
 *
 * Item availability comes from `buildSelectionMenu`, which reads the live
 * selection, so a menu opened over a locked node or a single node offers a
 * different set than one opened over a multi-selection.
 */
export const SelectionContextMenu = observer(
  ({
    anchorPoint,
    onClose,
  }: {
    anchorPoint: ContextMenuAnchorPoint | null;
    onClose: () => void;
  }) => {
    const store = useEditorStore();
    const anchor = useMemo(
      () => (anchorPoint ? createPointAnchor(anchorPoint) : undefined),
      [anchorPoint],
    );
    // Reading the selection during render is what subscribes this observer to
    // it, so a menu left open across an external selection change re-derives.
    const sections = anchorPoint ? buildSelectionMenu(store) : [];
    // Nothing left to offer means the menu is over, not merely invisible:
    // holding the anchor would let a later selection change bring it back at a
    // cursor position the user has long since left.
    const isEmpty = anchorPoint !== null && sections.length === 0;
    useEffect(() => {
      if (isEmpty) onClose();
    }, [isEmpty, onClose]);
    if (!anchorPoint || sections.length === 0) return null;

    return (
      <Menu.Root
        open
        onOpenChange={(open, eventDetails) => {
          // This is a click-opened menu with a virtual cursor anchor. Base UI
          // otherwise treats the triggerless popup like a hover menu and asks
          // to close it as soon as the pointer leaves. Dismiss only through
          // the menu's real close paths (outside press, Escape, or an item).
          if (!open && eventDetails.reason !== "trigger-hover") onClose();
        }}
      >
        <Menu.Portal>
          <Menu.Positioner
            align="start"
            anchor={anchor}
            data-selection-context-menu
            side="inline-end"
            sideOffset={2}
          >
            <Menu.Popup
              className="leaf-selection-context-menu-popup"
              onPointerDown={(event) => {
                // The popup is portalled into document.body, but React still
                // bubbles its pointer events through the Viewport component.
                // Keep a menu press from starting an empty-canvas gesture that
                // clears the selection before the item's click can run.
                event.stopPropagation();
              }}
            >
              {sections.map((section, index) => (
                // Fragments rather than wrapper elements: Base UI's popup keeps
                // its own list of items, and the separator is a sibling of the
                // items it divides.
                <Fragment key={section.id}>
                  {index > 0 && <Menu.Separator />}
                  {section.entries.map((entry) => (
                    <SelectionMenuEntryView key={entry.id} entry={entry} onRun={onClose} />
                  ))}
                </Fragment>
              ))}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    );
  },
);
