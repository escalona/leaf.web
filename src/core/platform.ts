import { useSyncExternalStore } from "react";

export {
  TITLE_BAR_HEIGHT,
  TRAFFIC_LIGHT_INSET_WIDTH,
  TRAFFIC_LIGHT_POSITION,
} from "./shared/window-chrome-constants";

/**
 * The bridge object the desktop shell's preload installs on `window.leaf`.
 * Core reads only the runtime facts under `desktop`; the typed native-document,
 * auth, and net surfaces are consumed by `src/desktop`, which owns their
 * contracts, so nothing in core depends on desktop code.
 */
export type LeafWindow = Window & {
  leaf?: {
    consumeNativeDocumentApi?: unknown;
    desktopAuth?: unknown;
    desktopNet?: unknown;
    desktop?: {
      isElectron?: boolean;
      isNativeDocumentWindow?: boolean;
      platform?: string;
      isFullScreen?: () => boolean;
      onFullScreenChange?: (listener: (fullScreen: boolean) => void) => () => void;
    };
  };
};

export function isElectronRuntime() {
  if (typeof window === "undefined") return false;
  return (window as LeafWindow).leaf?.desktop?.isElectron === true;
}

/**
 * Running on macOS, in the desktop shell or in a browser tab. Distinct from
 * `usesMacOSInsetTitleBar`, which asks about Electron window chrome: this one
 * answers for input conventions the platform imposes either way, such as
 * Ctrl+click being a secondary click.
 */
export function isMacOSPlatform() {
  if (typeof window === "undefined") return false;
  const desktopPlatform = (window as LeafWindow).leaf?.desktop?.platform;
  if (desktopPlatform) return desktopPlatform === "darwin";
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    "";
  return /mac/i.test(platform);
}

export function usesMacOSInsetTitleBar() {
  if (typeof window === "undefined") return false;
  const desktop = (window as LeafWindow).leaf?.desktop;
  return desktop?.isElectron === true && desktop.platform === "darwin";
}

function subscribeToFullScreenChanges(onStoreChange: () => void) {
  const desktop = typeof window === "undefined" ? undefined : (window as LeafWindow).leaf?.desktop;
  if (!desktop?.onFullScreenChange) return () => {};
  return desktop.onFullScreenChange(() => onStoreChange());
}

function getInsetTitleBarSnapshot() {
  if (!usesMacOSInsetTitleBar()) return false;
  // macOS hides the traffic lights in native fullscreen, so the renderer must
  // drop its title-bar reserve and drag strip along with them.
  return (window as LeafWindow).leaf?.desktop?.isFullScreen?.() !== true;
}

export function useMacOSInsetTitleBar() {
  return useSyncExternalStore(subscribeToFullScreenChanges, getInsetTitleBarSnapshot);
}

export function isNativeDocumentWindow() {
  if (typeof window === "undefined") return false;
  return (window as LeafWindow).leaf?.desktop?.isNativeDocumentWindow === true;
}
