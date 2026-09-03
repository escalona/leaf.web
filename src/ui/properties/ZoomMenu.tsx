import { observer } from "mobx-react-lite";
import { useState } from "react";
import { ChevronDownIcon } from "../icons";
import { useEditorStore } from "../../core/state/EditorStore";
import { Menu } from "../primitives";
import {
  zoomInStep,
  zoomOutStep,
  zoomToFit,
  zoomToLevel,
  zoomToSelection,
} from "../viewport/zoom-commands";

/**
 * Zoom percentage chip that opens the zoom command menu. Lives in
 * the right panel header (docked) or the floating canvas controls cluster.
 */
function getViewportElement() {
  return document.querySelector("[data-viewport]");
}

export const ZoomMenu = observer(() => {
  const store = useEditorStore();
  const [open, setOpen] = useState(false);
  const hasSelection = store.selectedIds.size > 0;

  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger
        render={
          <button
            type="button"
            data-zoom-menu-trigger
            aria-label="Zoom options"
            style={{
              height: 28,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "0 8px",
              borderRadius: 6,
              border: "none",
              background: open ? "var(--leaf-surface-sunken)" : "transparent",
              color: "var(--leaf-text-faint)",
              fontSize: "var(--leaf-text-sm)",
              fontFamily: "var(--leaf-font-sans)",
              fontWeight: 500,
              fontVariantNumeric: "tabular-nums",
            }}
          />
        }
      >
        <span>{Math.round(store.zoom * 100)}%</span>
        <ChevronDownIcon size={12} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end">
          <Menu.Popup>
            <Menu.Item
              onClick={() => {
                zoomInStep(store, getViewportElement());
              }}
            >
              Zoom in
              <span className="leaf-menu-shortcut">⌘+</span>
            </Menu.Item>
            <Menu.Item
              onClick={() => {
                zoomOutStep(store, getViewportElement());
              }}
            >
              Zoom out
              <span className="leaf-menu-shortcut">⌘−</span>
            </Menu.Item>
            <Menu.Item
              onClick={() => {
                zoomToLevel(store, 1, getViewportElement());
              }}
            >
              Zoom to 100%
              <span className="leaf-menu-shortcut">⇧0</span>
            </Menu.Item>
            <Menu.Item
              onClick={() => {
                zoomToFit(store, getViewportElement());
              }}
            >
              Zoom to fit
              <span className="leaf-menu-shortcut">⇧1</span>
            </Menu.Item>
            <Menu.Item
              disabled={!hasSelection}
              onClick={() => {
                zoomToSelection(store, getViewportElement());
              }}
            >
              Zoom to selection
              <span className="leaf-menu-shortcut">⇧2</span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
});
