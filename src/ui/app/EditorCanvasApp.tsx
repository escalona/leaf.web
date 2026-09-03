import { Fragment, Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react";
import { observer } from "mobx-react-lite";
import { Toolbar } from "../Toolbar";
import { PasteIndicator } from "../PasteIndicator";
import { Viewport } from "../Viewport";
import { LayersPanel } from "../LayersPanel";
import { FileMenu } from "../layers/FileMenu";
import { PropertiesPanel } from "../properties/PropertiesPanel";
import { HistoryPreviewBanner } from "../history/HistoryPreviewBanner";
import { AppTitleBar } from "./AppTitleBar";
import { EditorStoreContext, useEditorStore, type EditorStore } from "../../core/state/EditorStore";
import type { CollaborationPresencePeer } from "../../core/state/collaboration-presence";
import type { LeafCollaborationWindowContext } from "../../core/state/collaboration-app-runtime";
import { useInteractionRootGuard } from "./useInteractionRootGuard";

const EMPTY_PRESENCE_PEERS: readonly CollaborationPresencePeer[] = [];

export function EditorCanvasApp({
  collaborationContext,
  session,
  fileName,
  feedbackScopeId,
  onReturnToDashboard,
  onRenameFile,
  profilerOnRender,
  presencePeers = EMPTY_PRESENCE_PEERS,
  documentDirty = false,
  renderDocumentScriptHost,
}: {
  collaborationContext?: LeafCollaborationWindowContext;
  session: { store: EditorStore };
  fileName: string;
  feedbackScopeId?: string;
  onReturnToDashboard: () => void;
  onRenameFile: (name: string) => void;
  profilerOnRender?: ProfilerOnRenderCallback;
  presencePeers?: readonly CollaborationPresencePeer[];
  documentDirty?: boolean;
  /** Desktop-only: mounts the native document script runtime inside the canvas. */
  renderDocumentScriptHost?: (store: EditorStore) => ReactNode;
}) {
  // The MCP bridge is installed once per window by the App shell and routes
  // tool calls across every open tab, so mounting an editor no longer owns a
  // bridge installation. The unused prop is kept for the window-context pass
  // to native document scripts.
  void collaborationContext;
  useInteractionRootGuard(session.store);
  return (
    <EditorStoreContext.Provider value={session.store}>
      <EditorCanvasLayout
        fileName={fileName}
        feedbackScopeId={feedbackScopeId}
        onReturnToDashboard={onReturnToDashboard}
        onRenameFile={onRenameFile}
        profilerOnRender={profilerOnRender}
        presencePeers={presencePeers}
        documentDirty={documentDirty}
        renderDocumentScriptHost={renderDocumentScriptHost}
      />
    </EditorStoreContext.Provider>
  );
}

const EditorCanvasLayout = observer(function EditorCanvasLayout({
  fileName,
  feedbackScopeId,
  onReturnToDashboard,
  onRenameFile,
  profilerOnRender,
  presencePeers,
  documentDirty,
  renderDocumentScriptHost,
}: {
  fileName: string;
  feedbackScopeId?: string;
  onReturnToDashboard: () => void;
  onRenameFile: (name: string) => void;
  profilerOnRender?: ProfilerOnRenderCallback;
  presencePeers: readonly CollaborationPresencePeer[];
  documentDirty: boolean;
  renderDocumentScriptHost?: (store: EditorStore) => ReactNode;
}) {
  const store = useEditorStore();
  const sidebarCollapsed = store.sidebarCollapsed;

  return (
    <div
      style={{
        display: "flex",
        height: "100%",
        width: "100%",
        overflow: "hidden",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <AppTitleBar>{documentDirty ? "Edited" : null}</AppTitleBar>
      {!sidebarCollapsed && (
        <ProfileBoundary id="layers" onRender={profilerOnRender}>
          <LayersPanel
            fileName={fileName}
            onReturnToDashboard={onReturnToDashboard}
            onRenameFile={onRenameFile}
          />
        </ProfileBoundary>
      )}
      <div
        style={{
          flex: 1,
          position: "relative",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <ProfileBoundary id="viewport" onRender={profilerOnRender}>
          <Viewport presencePeers={presencePeers} />
        </ProfileBoundary>
        {store.isHistoryPreviewing ? <HistoryPreviewBanner /> : <Toolbar />}
        <PasteIndicator feedbackScopeId={feedbackScopeId} />
        {sidebarCollapsed && (
          <FileMenu
            fileName={fileName}
            onReturnToDashboard={onReturnToDashboard}
            onRenameFile={onRenameFile}
            onToggleSidebar={() => store.toggleSidebar()}
            floating
          />
        )}
        {sidebarCollapsed && <PropertiesPanel floating />}
        {renderDocumentScriptHost?.(store) ?? null}
      </div>
      {!sidebarCollapsed && (
        <ProfileBoundary id="properties" onRender={profilerOnRender}>
          <PropertiesPanel />
        </ProfileBoundary>
      )}
    </div>
  );
});

function ProfileBoundary({
  id,
  onRender,
  children,
}: {
  id: string;
  onRender?: ProfilerOnRenderCallback;
  children: ReactNode;
}) {
  if (!onRender) return <Fragment>{children}</Fragment>;
  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  );
}
