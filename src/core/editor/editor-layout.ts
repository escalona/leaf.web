export const LAYERS_PANEL_WIDTH = 280;
export const LAYERS_PANEL_MIN_WIDTH = 240;
export const LAYERS_PANEL_MAX_WIDTH = 960;

export const PAGES_PANEL_HEIGHT = 180;
export const PAGES_PANEL_MIN_HEIGHT = 68;
export const PAGES_PANEL_MAX_HEIGHT = 720;

export const PROPERTIES_PANEL_WIDTH = 280;
export const PROPERTIES_PANEL_MIN_WIDTH = 240;
export const PROPERTIES_PANEL_MAX_WIDTH = 600;

export function clampLayersPanelWidth(width: number): number {
  return Math.min(LAYERS_PANEL_MAX_WIDTH, Math.max(LAYERS_PANEL_MIN_WIDTH, width));
}

export function clampPagesPanelHeight(height: number): number {
  return Math.min(PAGES_PANEL_MAX_HEIGHT, Math.max(PAGES_PANEL_MIN_HEIGHT, height));
}

export function clampPropertiesPanelWidth(width: number): number {
  return Math.min(PROPERTIES_PANEL_MAX_WIDTH, Math.max(PROPERTIES_PANEL_MIN_WIDTH, width));
}
