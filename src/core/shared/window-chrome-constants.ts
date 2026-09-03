/**
 * Window-chrome geometry shared by the Electron main process (window
 * construction in electron/window-chrome.ts) and renderer chrome. Keep this
 * module free of renderer-only imports: the main process loads it at startup.
 */

/**
 * Height of every renderer-drawn title strip shown when the native macOS
 * title bar is hidden (`titleBarStyle: "hiddenInset"`) — the standalone
 * AppTitleBar and the integrated workspace tab bar alike, so window chrome
 * never changes height when one surface replaces the other.
 */
export const TITLE_BAR_HEIGHT = 48;

/**
 * Native macOS window-control inset. The ~12px-tall traffic lights span
 * y 18–30, centering them in the TITLE_BAR_HEIGHT strip above.
 */
export const TRAFFIC_LIGHT_POSITION = { x: 18, y: 18 };

/** Horizontal reserve that keeps renderer chrome clear of the traffic lights. */
export const TRAFFIC_LIGHT_INSET_WIDTH = 84;
