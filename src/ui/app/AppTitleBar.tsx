import { createContext, useContext, type CSSProperties, type ReactNode } from "react";
import { TITLE_BAR_HEIGHT, useMacOSInsetTitleBar } from "../../core/platform";

const AppTitleBarVisibilityContext = createContext(true);

// Matches the integrated workspace tab strip's metrics and colors so the
// launch handoff between the two chrome surfaces is seamless.
const titleBarStyle: CSSProperties = {
  position: "fixed",
  inset: "0 0 auto",
  height: TITLE_BAR_HEIGHT,
  zIndex: 30,
  display: "grid",
  placeItems: "center",
  borderBottom: "1px solid #dedee1",
  backgroundColor: "#f1f1f2",
  color: "#71717a",
  fontSize: 12,
  fontWeight: 500,
};

/**
 * Lets the workspace shell replace the standalone title strip with integrated
 * tab chrome without threading a visibility prop through every loading,
 * dashboard, and editor surface.
 */
export function AppTitleBarVisibility({
  children,
  visible,
}: {
  children: ReactNode;
  visible: boolean;
}) {
  return (
    <AppTitleBarVisibilityContext.Provider value={visible}>
      {children}
    </AppTitleBarVisibilityContext.Provider>
  );
}

/**
 * Standalone renderer-drawn window chrome for macOS `hiddenInset` windows.
 * Full-window surfaces without integrated workspace chrome render one so the
 * window always has an opaque strip behind the traffic lights and a drag
 * region to move it by. Renders nothing outside macOS Electron windows and
 * while the window is in fullscreen.
 */
export function AppTitleBar({ children }: { children?: ReactNode }) {
  const visible = useContext(AppTitleBarVisibilityContext);
  const hasInsetTitleBar = useMacOSInsetTitleBar();
  if (!visible || !hasInsetTitleBar) return null;

  return (
    <div className="app-titlebar" style={titleBarStyle}>
      {children}
    </div>
  );
}
