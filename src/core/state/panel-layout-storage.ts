/**
 * Locally durable editor chrome sizes — the layers sidebar width, pages list
 * height, and properties panel width. One shared layout for the whole app:
 * panel sizes are a workspace preference, not document state, so every store
 * initializes from here and writes back through its setters. Losing the entry
 * only resets the panels to their defaults.
 */
import {
  clampLayersPanelWidth,
  clampPagesPanelHeight,
  clampPropertiesPanelWidth,
  LAYERS_PANEL_WIDTH,
  PAGES_PANEL_HEIGHT,
  PROPERTIES_PANEL_WIDTH,
} from "../editor/editor-layout";

const STORAGE_KEY = "leaf-panel-layout";

export type PanelLayout = {
  sidebarWidth: number;
  pagesPanelHeight: number;
  propertiesPanelWidth: number;
};

const DEFAULT_LAYOUT: PanelLayout = {
  sidebarWidth: LAYERS_PANEL_WIDTH,
  pagesPanelHeight: PAGES_PANEL_HEIGHT,
  propertiesPanelWidth: PROPERTIES_PANEL_WIDTH,
};

function size(value: unknown, clamp: (size: number) => number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp(value) : fallback;
}

export function loadPanelLayout(): PanelLayout {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") {
      const layout = parsed as Record<string, unknown>;
      return {
        sidebarWidth: size(layout.sidebarWidth, clampLayersPanelWidth, LAYERS_PANEL_WIDTH),
        pagesPanelHeight: size(layout.pagesPanelHeight, clampPagesPanelHeight, PAGES_PANEL_HEIGHT),
        propertiesPanelWidth: size(
          layout.propertiesPanelWidth,
          clampPropertiesPanelWidth,
          PROPERTIES_PANEL_WIDTH,
        ),
      };
    }
  } catch {
    // Unavailable or corrupt storage reads as the default layout.
  }
  return { ...DEFAULT_LAYOUT };
}

export function persistPanelLayout(layout: PanelLayout): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Best-effort only.
  }
}
