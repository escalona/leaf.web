import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { AppDiagnostics } from "../ui/app/AppDiagnostics";
import { AppTitleBarVisibility } from "../ui/app/AppTitleBar";
import { ConnectionStatusIndicator } from "../ui/app/ConnectionStatusIndicator";
import { createDeferredModule, useDeferredModule } from "../ui/app/deferred-module";
// The editor is not on the launch path: the dashboard paints from a bundle
// that does not evaluate the canvas, overlays, and property panels, and the
// editor chunk is preloaded in idle time right after the first frame so that
// opening a file stays instant.
const editorCanvasApp = createDeferredModule(
  () => import("../ui/app/EditorCanvasApp").then((module) => module.EditorCanvasApp),
  () => markStartup("editor-chunk-loaded"),
);

/**
 * The editor chunk as plain state (see `createDeferredModule` for why not a
 * Suspense boundary). Requested only once a tab is about to show an editor.
 * The idle preload after the dashboard's first frame and the mount-time
 * preload for a persisted active tab usually have it loaded by then; a launch
 * that lands on the dashboard must not evaluate the editor behind its first
 * frame. A fetch that failed is left alone here: the shell shows the failure
 * and offers another attempt rather than hammering the server.
 */
function useEditorCanvasApp(needed: boolean) {
  const { value: component, error } = useDeferredModule(editorCanvasApp);
  useEffect(() => {
    if (needed && !component && error === null) void editorCanvasApp.load();
  }, [component, error, needed]);
  return { component, error };
}
import { LoadingScreen } from "../ui/app/LoadingScreen";
import { SessionTransitionOverlay } from "../ui/app/SessionTransitionOverlay";
import { toFileNavigationEntry } from "../ui/app/collaboration-navigation";
import { startFileThumbnailCaptureLoop } from "../ui/app/file-thumbnail-capture";
import { cancelIdleWork, scheduleIdleWork } from "../ui/app/idle-work";
import { usePendingSessionDisposals } from "../ui/app/usePendingSessionDisposals";
import { useWorkspaceTabShortcuts } from "../ui/app/useWorkspaceTabShortcuts";
import { WorkspaceTabBar } from "../ui/app/WorkspaceTabBar";
import { FilesDashboard } from "../ui/files/FilesDashboard";
import {
  getAccountDisplayName,
  type FilesDashboardAuthUser,
} from "../ui/files/FilesDashboardSidebar";
import { preloadFontsForNodeTree } from "../core/fonts/loader";
import type { McpBridgeDocumentProvider, McpDocumentBinding } from "../agent/mcp/bridge";
import { isElectronRuntime, TITLE_BAR_HEIGHT, useMacOSInsetTitleBar } from "../core/platform";
import { useHostDocumentDirty, type AppHost } from "./app-host";
import type { LeafFileDto } from "../core/shared/collaboration";
import { readDisplayError } from "../core/shared/errors";
import {
  collaborationAccountScope,
  collaborationSelectionKey,
  getMainCollaborationBranch,
  parseCollaborationSelection,
  type CollaborationApplicationRuntime,
  type LeafCollaborationWindowContext,
} from "../core/state/collaboration-app-runtime";
import {
  getFileOpenHistorySnapshot,
  recordFileOpened,
  subscribeToFileOpenHistory,
} from "../core/state/file-open-history";
import {
  persistWorkspaceTabs,
  readPersistedWorkspaceTabs,
  workspaceTabsStorageKey,
} from "../core/state/workspace-tab-persistence";
import { WorkspaceTabsController } from "../core/state/workspace-tabs";
import { getConnectionStatus, getSyncHealth } from "../core/state/sync-health";
import { markStartup } from "../core/lib/startup-marks";

type DashboardActionError = {
  detail: string;
  title: string;
  /**
   * A failed action the dashboard reports inline (New file, Open): the user's
   * files stay on screen. Absent for a failed directory load, where there is
   * no file list to keep and the full-screen error is the accurate diagnosis.
   */
  inline?: boolean;
};

/**
 * Desktop menu bridge: the main process's File > Close Tab (Cmd/Ctrl+W)
 * handler invokes this global to close the active workspace tab, and closes
 * the window itself only when the renderer reports no active tab.
 */
type WorkspaceTabsWindow = Window & {
  leafWorkspaceTabs?: { closeActiveTab: () => boolean };
};

const ENABLE_MCP_BRIDGE = import.meta.env.DEV || import.meta.env.VITE_ENABLE_MCP_BRIDGE === "true";
// How many of the most recently updated files get their cache warmed after the
// directory loads, and how long the dashboard gets to settle first.
const RECENT_FILE_CACHE_WARM_LIMIT = 8;
const RECENT_FILE_CACHE_WARM_DELAY_MS = 2_000;
// The editor chunk loads right behind the dashboard's first frame.
const EDITOR_PRELOAD_DELAY_MS = 250;
// Restored background tabs open their sessions after the launch surface has
// painted; this cap runs them anyway if that frame never comes.
const RESTORED_TAB_OPEN_FALLBACK_MS = 1_500;

const selectionListeners = new Set<() => void>();
let selectionRevision = 0;

function emitSelectionChange() {
  for (const listener of selectionListeners) listener();
}

/**
 * Marks the editor's first frame once the editor has mounted, and lets
 * the shell schedule work that must stay behind that frame.
 */
function EditorFrameMark({ onFrame }: { onFrame?: () => void }) {
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      markStartup("editor-frame");
      onFrame?.();
    });
    return () => cancelAnimationFrame(frame);
    // Runs once per editor mount; the callback identity is not a reason to re-run.
  }, []);
  return null;
}

function subscribeToSelection(listener: () => void) {
  selectionListeners.add(listener);
  if (selectionListeners.size === 1) {
    window.addEventListener("hashchange", emitSelectionChange);
    window.addEventListener("popstate", emitSelectionChange);
  }

  return () => {
    selectionListeners.delete(listener);
    if (selectionListeners.size === 0) {
      window.removeEventListener("hashchange", emitSelectionChange);
      window.removeEventListener("popstate", emitSelectionChange);
    }
  };
}

function readSelectionSnapshot() {
  const selectionKey = typeof window === "undefined" ? "" : window.location.hash.slice(1);
  return `${selectionRevision}:${selectionKey}`;
}

async function waitForWorkspaceTabReady(
  controller: WorkspaceTabsController,
  tabId: string,
  documentId: string,
  timeoutMs = 15_000,
) {
  await new Promise<void>((resolve, reject) => {
    let unsubscribe: () => void = () => undefined;
    const timeout = window.setTimeout(() => {
      unsubscribe();
      reject(
        new Error(
          `Leaf created collaboration document ${documentId}, but its editor session did not become ready before the timeout.`,
        ),
      );
    }, timeoutMs);
    const finish = (callback: () => void) => {
      window.clearTimeout(timeout);
      unsubscribe();
      callback();
    };
    const inspect = () => {
      const tab = controller.getSnapshot().tabs.find((candidate) => candidate.tabId === tabId);
      if (!tab) {
        finish(() => reject(new Error(`The new collaboration document ${documentId} was closed.`)));
        return;
      }
      // A racing refreshFiles can put a transient directory-miss error on a
      // still-opening tab; beginOpen's completion clears it (or leaves the
      // final error with isOpening false), so only a settled error is terminal.
      if (tab.error && !tab.isOpening) {
        finish(() => reject(new Error(`Unable to open ${documentId}: ${tab.error}`)));
        return;
      }
      if (!tab.isOpening && tab.editor && tab.file && tab.branch) finish(resolve);
    };
    unsubscribe = controller.subscribe(inspect);
    inspect();
  });
}

export function App({
  runtime,
  host,
  authUser,
  autoOpenFirstFile = false,
  onSignIn,
  onSignOut,
}: {
  runtime: CollaborationApplicationRuntime;
  /** Shell integration supplied by the desktop entry; absent in the browser. */
  host?: AppHost;
  authUser?: FilesDashboardAuthUser | null;
  /**
   * Land a first visit in the editor: a browser-local workspace with nothing in
   * it opens onto a fresh canvas instead of an empty dashboard. The local-only
   * build sets this; hosted "Use Leaf locally" keeps the dashboard, which is
   * where sign-in is offered.
   */
  autoOpenFirstFile?: boolean;
  /** Present only while running locally: offers a way back to the account flow. */
  onSignIn?: () => void;
  onSignOut?: () => void | Promise<void>;
}) {
  const nativeDocument = host?.document ?? null;
  const documentDirty = useHostDocumentDirty(host);
  const isNativeShell = runtime.documentKind === "native";
  const supportsWorkspaceTabs = isElectronRuntime() && !isNativeShell;
  const hasInsetTitleBar = useMacOSInsetTitleBar();
  // The directory this device saw last paints at launch, before any network
  // round trip; the mount-time refresh below reconciles it. Only an account
  // with nothing cached shows the loading screen.
  const [cachedFilesAtMount] = useState(() => runtime.readCachedFiles?.() ?? null);
  const [files, setFiles] = useState<LeafFileDto[]>(() => cachedFilesAtMount ?? []);
  // Handlers that act on the current directory without re-rendering per change.
  const filesRef = useRef(files);
  filesRef.current = files;
  const [directoryLoading, setDirectoryLoading] = useState(cachedFilesAtMount === null);
  // True after the first successful directory load; tab restoration (and the
  // persistence writes that could overwrite a saved tab set) wait for it so a
  // failed offline start can't wipe the previous session. A cached directory
  // counts: it is the same list a retryable outage would have served.
  const [directoryReady, setDirectoryReady] = useState(cachedFilesAtMount !== null);
  const selectionSnapshot = useSyncExternalStore(
    subscribeToSelection,
    readSelectionSnapshot,
    readSelectionSnapshot,
  );
  const selected = useMemo(
    () => parseCollaborationSelection(selectionSnapshot.slice(selectionSnapshot.indexOf(":") + 1)),
    [selectionSnapshot],
  );
  const [isCreatingFile, setIsCreatingFile] = useState(false);
  const [dashboardActionError, setDashboardActionError] = useState<DashboardActionError | null>(
    null,
  );
  const [showSwitchingIndicator, setShowSwitchingIndicator] = useState(false);
  const [isOnline, setIsOnline] = useState(() => window.navigator.onLine);
  const tabsStorageKey = useMemo(
    () =>
      workspaceTabsStorageKey(
        runtime.mode,
        runtime.accountId === undefined
          ? undefined
          : collaborationAccountScope(runtime.accountId, runtime.organizationId),
      ),
    [runtime.accountId, runtime.mode, runtime.organizationId],
  );
  // A launch that will restore an active tab must not paint the dashboard
  // first: the restore runs in an effect, one render after the first frame,
  // and that frame used to flash the file cards before the editor replaced
  // them. The shell holds a quiet screen until the restore has run, or until
  // the directory load it waits on fails, when the failure is what to show.
  const [restorePending, setRestorePending] = useState(
    () =>
      supportsWorkspaceTabs &&
      (readPersistedWorkspaceTabs(window.localStorage, tabsStorageKey)?.activeIndex ?? null) !==
        null,
  );
  const nativeDocumentActionGenerationRef = useRef(0);
  const fontPreloadHandlesRef = useRef(new Map<string, number>());
  const thumbnailLoopCancelsRef = useRef(new Map<string, () => void>());

  const { disposeSession, waitForPendingSessionDisposals } = usePendingSessionDisposals();

  const refreshFilesRef = useRef<() => Promise<LeafFileDto[]>>(async () => []);

  const tabsControllerRef = useRef<WorkspaceTabsController | null>(null);
  if (!tabsControllerRef.current) {
    tabsControllerRef.current = new WorkspaceTabsController({
      runtime,
      disposeSession,
      supportsMultipleTabs: supportsWorkspaceTabs,
      onEditorReady: (tabId, editor) => {
        const previous = fontPreloadHandlesRef.current.get(tabId);
        if (previous !== undefined) cancelIdleWork(previous);
        const handle = scheduleIdleWork(() => {
          fontPreloadHandlesRef.current.delete(tabId);
          // The tab may have closed or switched branches during the idle
          // window; only preload for the editor that is still mounted.
          const tab = tabsControllerRef
            .current!.getSnapshot()
            .tabs.find((candidate) => candidate.tabId === tabId);
          if (tab?.editor !== editor) return;
          void preloadFontsForNodeTree(editor.store.nodes);
        }, 1000);
        fontPreloadHandlesRef.current.set(tabId, handle);

        thumbnailLoopCancelsRef.current.get(tabId)?.();
        thumbnailLoopCancelsRef.current.delete(tabId);
        const setFileThumbnail = runtime.setFileThumbnail?.bind(runtime);
        const readyTab = tabsControllerRef
          .current!.getSnapshot()
          .tabs.find((candidate) => candidate.tabId === tabId);
        // Dashboard cards represent the file's main branch, so only a mounted
        // main-branch editor feeds the thumbnail. Local/offline runtimes have
        // no setFileThumbnail and skip capture entirely.
        const isMainBranch =
          !!readyTab?.file &&
          getMainCollaborationBranch(readyTab.file)?.branchId === readyTab.branchId;
        if (setFileThumbnail && readyTab && isMainBranch) {
          const { fileId, branchId } = readyTab;
          // Resolve through the tab on every use: a transport-level session
          // replacement swaps tab.editor without another editor-ready event,
          // and holding the original editor here would both stop the loop and
          // pin the replaced session's node maps in memory.
          const resolveMountedEditor = () => {
            const current = tabsControllerRef
              .current!.getSnapshot()
              .tabs.find((candidate) => candidate.tabId === tabId);
            if (!current?.editor || current.isOpening || current.error !== null) return null;
            if (current.fileId !== fileId || current.branchId !== branchId) return null;
            return current.editor;
          };
          const cancel = startFileThumbnailCaptureLoop({
            fileId,
            initialThumbnailAssetId: readyTab.file?.thumbnailAssetId ?? null,
            getMountedStore: () => resolveMountedEditor()?.store ?? null,
            // Local transactions + tree structure + active page. Misses some
            // shapes (undo, remote style-only edits); the loop's periodic
            // forced refresh covers those.
            getContentVersion: () => {
              const mounted = resolveMountedEditor();
              if (!mounted) return "";
              return `${mounted.controller.transactionCount}:${mounted.store.renderTreeVersion}:${mounted.store.activePageId}`;
            },
            isTabActive: () => tabsControllerRef.current!.getSnapshot().activeTabId === tabId,
            setFileThumbnail,
          });
          thumbnailLoopCancelsRef.current.set(tabId, cancel);
        }
      },
      onWriteFence: () => {
        void refreshFilesRef.current().catch(() => undefined);
      },
    });
  }
  const tabsController = tabsControllerRef.current;

  const tabsSnapshot = useSyncExternalStore(tabsController.subscribe, tabsController.getSnapshot);
  const activeTab = tabsSnapshot.tabs.find((tab) => tab.tabId === tabsSnapshot.activeTabId) ?? null;
  const { component: EditorCanvasApp, error: editorChunkError } = useEditorCanvasApp(
    activeTab !== null,
  );

  const refreshFiles = useCallback(async () => {
    const nextFiles = await runtime.listFiles();
    markStartup("directory-loaded");
    tabsControllerRef.current!.setDirectory(nextFiles);
    startTransition(() => setFiles(nextFiles));
    // Any successful load readies the directory — not just the mount-time one —
    // so an offline start still restores and persists tabs once it recovers.
    setDirectoryReady(true);
    return nextFiles;
  }, [runtime]);

  // The dashboard's first frame after the directory is in: the startup
  // timeline's "interactive" signpost.

  useEffect(() => {
    refreshFilesRef.current = refreshFiles;
  }, [refreshFiles]);

  // Whether an empty directory opens a fresh file. Desktop keeps its own
  // launch path (workspace-tab restore, native documents). Read through a ref
  // by the mount-time load so the decision does not re-run that load.
  const opensFirstFile =
    autoOpenFirstFile && runtime.mode === "local" && !isElectronRuntime() && !nativeDocument;
  const opensFirstFileRef = useRef(opensFirstFile);
  opensFirstFileRef.current = opensFirstFile;
  // `handleCreateFile` is defined further down, after the tab controller it
  // drives; the load only needs it once the directory is in.
  const handleCreateFileRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    let cancelled = false;
    // Refreshing behind a cached directory keeps it on screen; only an
    // account with nothing cached waits on the loading screen.
    if (!cachedFilesAtMount) setDirectoryLoading(true);
    void (async () => {
      let directory: LeafFileDto[] | null = null;
      try {
        directory = await refreshFiles();
      } catch (error) {
        if (cancelled) return;
        // Tab restoration waits for a directory; with none coming, the
        // quiet restore screen would otherwise hide this error for good.
        setRestorePending(false);
        setDashboardActionError({
          detail: readDisplayError(error, "Unable to load files."),
          title: "Unable to load files",
        });
      }
      if (cancelled) return;
      setDirectoryLoading(false);
      // Decided on the directory this load returned rather than on `files`,
      // which commits inside a transition and can trail the ready flags by a
      // render. A URL that already selects a file is a deep link, not a first
      // visit.
      if (
        directory?.length === 0 &&
        opensFirstFileRef.current &&
        parseCollaborationSelection(window.location.hash.slice(1)) === null
      ) {
        void handleCreateFileRef.current();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshFiles]);

  // Keep the controller's directory clones aligned with optimistic updates
  // (renames) that bypass refreshFiles.
  useEffect(() => {
    tabsControllerRef.current!.setDirectory(files);
  }, [files]);

  // Once per launch, in idle time, pull the most recently touched files into
  // the local cache so their first open renders from disk the way a reopen
  // does. Best effort: a file that is not warmed simply opens over the
  // network as before.
  const warmedRecentFilesRef = useRef(false);
  useEffect(() => {
    const warmBranchCache = runtime.warmBranchCache?.bind(runtime);
    if (!directoryReady || warmedRecentFilesRef.current || !warmBranchCache) return;
    warmedRecentFilesRef.current = true;
    let cancelled = false;
    const handle = scheduleIdleWork(() => {
      void (async () => {
        const candidates = [...filesRef.current]
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .slice(0, RECENT_FILE_CACHE_WARM_LIMIT);
        if (cancelled || !window.navigator.onLine) return;
        // All at once: their branch-session requests coalesce into one
        // Worker request, and one warm that stalls cannot hold back the
        // rest. A warm that fails simply leaves that file on the network
        // path for its next open.
        await Promise.allSettled(
          candidates.map(async (file) => {
            const main = getMainCollaborationBranch(file);
            if (!main) return;
            const openInTab = tabsControllerRef
              .current!.getSnapshot()
              .tabs.some((tab) => tab.fileId === file.fileId);
            if (openInTab) return;
            await warmBranchCache(file, main);
          }),
        );
      })();
    }, RECENT_FILE_CACHE_WARM_DELAY_MS);
    return () => {
      cancelled = true;
      cancelIdleWork(handle);
    };
  }, [directoryReady, runtime]);

  // Navigating to a document dismisses any pending dashboard error. Adjusted
  // during render (not in an Effect) so no frame paints the stale error.
  const [errorClearedForSnapshot, setErrorClearedForSnapshot] = useState(selectionSnapshot);
  if (selectionSnapshot !== errorClearedForSnapshot) {
    setErrorClearedForSnapshot(selectionSnapshot);
    if (selected) setDashboardActionError(null);
  }

  useEffect(() => {
    if (!selected) return;
    nativeDocumentActionGenerationRef.current += 1;
    // Opening any branch of a file marks it recently used for this account's
    // device-local Recents ordering. An Effect (not a handler) so history
    // navigation and restored selections count as opens too.
    recordFileOpened(window.localStorage, runtime.accountId ?? "", selected.fileId);
  }, [selected, runtime.accountId]);

  const openHistory = useSyncExternalStore(subscribeToFileOpenHistory, () =>
    getFileOpenHistorySnapshot(runtime.accountId ?? ""),
  );

  // Comment authorship for the active editor session: the runtime account id
  // is the same identity the sync token's actor derives from, and the display
  // name is denormalized onto comment records at write time.
  const activeEditorStore = activeTab?.editor?.store ?? null;
  useEffect(() => {
    if (!activeEditorStore) return;
    activeEditorStore.setCommentAuthor({
      id: runtime.accountId || "local",
      name: authUser ? getAccountDisplayName(authUser) : null,
    });
  }, [activeEditorStore, authUser, runtime.accountId]);

  // Map the URL-hash selection onto the tab set: activate the exact tab,
  // switch the active tab's branch in place, or open a new tab.
  const hadSelectionRef = useRef(false);
  useEffect(() => {
    if (directoryLoading) return;
    const controller = tabsControllerRef.current!;
    const hadSelection = hadSelectionRef.current;
    hadSelectionRef.current = selected !== null;
    if (!selected) {
      controller.showDashboard();
      // Returning from a document refetches the directory so freshly captured
      // thumbnails (yours or a teammate's) appear without a reload. A cold
      // start on the dashboard skips this: the mount-time load just ran.
      if (hadSelection) void refreshFilesRef.current().catch(() => undefined);
      return;
    }
    controller.openSelection(selected.fileId, selected.branchId);
  }, [directoryLoading, selected]);

  useEffect(() => {
    const updateOnline = () => {
      const online = window.navigator.onLine;
      setIsOnline(online);
      tabsControllerRef.current!.setOnline(online);
    };
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    return () => {
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
    };
  }, []);

  useEffect(
    () => () => {
      for (const handle of fontPreloadHandlesRef.current.values()) cancelIdleWork(handle);
      fontPreloadHandlesRef.current.clear();
      for (const cancel of thumbnailLoopCancelsRef.current.values()) cancel();
      thumbnailLoopCancelsRef.current.clear();
      tabsControllerRef.current!.dispose();
    },
    [],
  );

  const switchBranch = useCallback((fileId: string, branchId: string) => {
    const key = collaborationSelectionKey(fileId, branchId);
    if (window.location.hash.slice(1) === key) {
      selectionRevision += 1;
    } else {
      window.location.hash = key;
    }
    emitSelectionChange();
  }, []);

  const openFile = useCallback(
    (selectionKey: string) => {
      const next = parseCollaborationSelection(selectionKey);
      if (next) {
        nativeDocumentActionGenerationRef.current += 1;
        setDashboardActionError(null);
        switchBranch(next.fileId, next.branchId);
      }
    },
    [switchBranch],
  );

  const returnToDashboard = useCallback(() => {
    const controller = tabsControllerRef.current!;
    if (!supportsWorkspaceTabs) {
      // Browser and native-document shells have no persistent app tab strip;
      // leaving the document retires their single session. Browser users can
      // keep independent documents open with native browser tabs instead.
      const active = controller.getSnapshot().activeTabId;
      if (active) {
        thumbnailLoopCancelsRef.current.get(active)?.();
        thumbnailLoopCancelsRef.current.delete(active);
        controller.closeTab(active);
      }
    } else {
      controller.showDashboard();
    }
    window.history.pushState(null, "", `${window.location.pathname}${window.location.search}`);
    emitSelectionChange();
  }, [supportsWorkspaceTabs]);

  const handleSelectTab = useCallback(
    (tabId: string) => {
      const tab = tabsControllerRef
        .current!.getSnapshot()
        .tabs.find((candidate) => candidate.tabId === tabId);
      if (tab) switchBranch(tab.fileId, tab.branchId);
    },
    [switchBranch],
  );

  const handleCloseTab = useCallback(
    (tabId: string) => {
      const controller = tabsControllerRef.current!;
      const wasActive = controller.getSnapshot().activeTabId === tabId;
      thumbnailLoopCancelsRef.current.get(tabId)?.();
      thumbnailLoopCancelsRef.current.delete(tabId);
      controller.closeTab(tabId);
      if (!wasActive) return;
      const next = controller.getActiveTab();
      if (next) {
        switchBranch(next.fileId, next.branchId);
      } else {
        window.history.pushState(null, "", `${window.location.pathname}${window.location.search}`);
        emitSelectionChange();
      }
    },
    [switchBranch],
  );

  const handleReorderTab = useCallback((tabId: string, insertionIndex: number) => {
    tabsControllerRef.current!.moveTab(tabId, insertionIndex);
  }, []);

  const tabsRestoredRef = useRef(false);
  const deferredRestoreOpensRef = useRef<Array<() => void>>([]);
  const deferredRestoreFallbackRef = useRef<number | null>(null);
  // All background restores open together: their branch-session requests
  // coalesce into one Worker request (see the registry client), so a burst
  // no longer queues the file list refresh behind seven database reads.
  const flushDeferredRestores = useCallback(() => {
    if (deferredRestoreFallbackRef.current !== null) {
      window.clearTimeout(deferredRestoreFallbackRef.current);
      deferredRestoreFallbackRef.current = null;
    }
    const opens = deferredRestoreOpensRef.current;
    deferredRestoreOpensRef.current = [];
    for (const open of opens) open();
  }, []);
  useEffect(
    () => () => {
      if (deferredRestoreFallbackRef.current !== null) {
        window.clearTimeout(deferredRestoreFallbackRef.current);
      }
    },
    [],
  );

  // A launch that will land on a restored editor tab needs the editor chunk
  // at once, not after the dashboard's idle window.
  useEffect(() => {
    if (!supportsWorkspaceTabs) return;
    const persisted = readPersistedWorkspaceTabs(window.localStorage, tabsStorageKey);
    if (persisted && persisted.activeIndex !== null) void editorCanvasApp.load();
  }, [supportsWorkspaceTabs, tabsStorageKey]);
  const lastPersistedTabsRef = useRef<string | null>(null);

  // The dashboard's first frame: marks the startup timeline and starts the
  // editor chunk's idle preload. A restored editor launch never shows it.
  const dashboardFrameMarkedRef = useRef(false);
  const dashboardVisible = !directoryLoading && !restorePending && activeTab === null;
  useEffect(() => {
    if (!dashboardVisible || dashboardFrameMarkedRef.current) return;
    dashboardFrameMarkedRef.current = true;
    const frame = requestAnimationFrame(() => markStartup("dashboard-frame"));
    const preload = scheduleIdleWork(() => void editorCanvasApp.load(), EDITOR_PRELOAD_DELAY_MS);
    return () => {
      cancelAnimationFrame(frame);
      cancelIdleWork(preload);
    };
  }, [dashboardVisible]);

  // Restore the previous session's tabs once after the directory first loads.
  // Restored tabs open in the background; the previously active tab is
  // refocused only when no deep link already chose a selection.
  useEffect(() => {
    if (!supportsWorkspaceTabs || !directoryReady || tabsRestoredRef.current) return;
    tabsRestoredRef.current = true;
    setRestorePending(false);
    const persisted = readPersistedWorkspaceTabs(window.localStorage, tabsStorageKey);
    if (!persisted || persisted.tabs.length === 0) return;
    const active = persisted.activeIndex === null ? null : persisted.tabs[persisted.activeIndex];
    // The tab the launch lands on opens now; the others open only after the
    // landing surface has painted (the editor's first frame, or the
    // dashboard's), so that frame never competes with their session work.
    tabsControllerRef.current!.restoreTabs(persisted.tabs, {
      activeSelection: active ?? null,
      deferBackground: (open) => {
        deferredRestoreOpensRef.current.push(open);
      },
    });
    const fallback = window.setTimeout(flushDeferredRestores, RESTORED_TAB_OPEN_FALLBACK_MS);
    deferredRestoreFallbackRef.current = fallback;
    if (!active) {
      // Landing on the dashboard: it has painted by the next frame.
      requestAnimationFrame(() => requestAnimationFrame(flushDeferredRestores));
    }
    if (persisted.activeIndex !== null && window.location.hash.slice(1) === "") {
      // Refocus only a selection restoreTabs actually opened: it validates
      // against the directory, so a deleted file/branch stays silently
      // dropped instead of resurfacing as a foregrounded errored tab.
      const restored =
        active &&
        tabsControllerRef
          .current!.getSnapshot()
          .tabs.some((tab) => tab.fileId === active.fileId && tab.branchId === active.branchId);
      if (restored) switchBranch(active.fileId, active.branchId);
    }
  }, [directoryReady, flushDeferredRestores, supportsWorkspaceTabs, switchBranch, tabsStorageKey]);

  // Mirror the open tab set into storage so relaunch can restore it. Writes
  // start only after restoration ran, so a snapshot from before restore can't
  // clobber the saved set.
  useEffect(() => {
    if (!supportsWorkspaceTabs || !tabsRestoredRef.current) return;
    // Read the controller directly: in the commit where restoration just ran,
    // the render-captured tabsSnapshot predates the restored tabs and would
    // briefly overwrite the saved set.
    const snapshot = tabsControllerRef.current!.getSnapshot();
    const activeIndex = snapshot.tabs.findIndex((tab) => tab.tabId === snapshot.activeTabId);
    const value = {
      activeIndex: activeIndex === -1 ? null : activeIndex,
      tabs: snapshot.tabs.map((tab) => ({ branchId: tab.branchId, fileId: tab.fileId })),
    };
    // Controller emits also fire for presence/transport churn that never
    // changes the persisted projection; skip those redundant writes.
    const serialized = JSON.stringify(value);
    if (serialized === lastPersistedTabsRef.current) return;
    lastPersistedTabsRef.current = serialized;
    persistWorkspaceTabs(window.localStorage, tabsStorageKey, value);
  }, [supportsWorkspaceTabs, tabsSnapshot, tabsStorageKey]);

  // Menu-driven Cmd/Ctrl+W: browser-style close of the active tab. The
  // dashboard cannot close as a tab, so it reports false and the main
  // process falls back to closing the window.
  useEffect(() => {
    if (!supportsWorkspaceTabs) return;
    const tabsWindow = window as WorkspaceTabsWindow;
    tabsWindow.leafWorkspaceTabs = {
      closeActiveTab: () => {
        const activeTabId = tabsControllerRef.current!.getSnapshot().activeTabId;
        if (activeTabId === null) return false;
        handleCloseTab(activeTabId);
        return true;
      },
    };
    return () => {
      delete tabsWindow.leafWorkspaceTabs;
    };
  }, [handleCloseTab, supportsWorkspaceTabs]);

  const workspaceTabShortcutOptions = useMemo(
    () => ({
      enabled: supportsWorkspaceTabs,
      tabIds: tabsSnapshot.tabs.map((tab) => tab.tabId),
      activeTabId: tabsSnapshot.activeTabId,
      onSelectTab: handleSelectTab,
      onSelectDashboard: returnToDashboard,
    }),
    [
      handleSelectTab,
      returnToDashboard,
      supportsWorkspaceTabs,
      tabsSnapshot.activeTabId,
      tabsSnapshot.tabs,
    ],
  );
  useWorkspaceTabShortcuts(workspaceTabShortcutOptions);

  useEffect(() => {
    if (!nativeDocument) return;
    return nativeDocument.onSaveRequested(async () => {
      await waitForPendingSessionDisposals();
      await tabsControllerRef.current!.getActiveTab()?.session?.flushPersistence();
    });
  }, [nativeDocument, waitForPendingSessionDisposals]);

  useEffect(() => {
    if (!nativeDocument) return;
    return nativeDocument.onCloseRequested(async () => {
      const active = tabsControllerRef.current!.getActiveTab();
      const releaseBarrier = active?.session
        ? await active.session.acquireWriteBarrier()
        : () => undefined;
      try {
        await waitForPendingSessionDisposals();
        return releaseBarrier;
      } catch (error) {
        releaseBarrier();
        throw error;
      }
    });
  }, [nativeDocument, waitForPendingSessionDisposals]);

  const handleOpenNativeFile = useCallback(async () => {
    if (!nativeDocument || runtime.mode !== "local") return;
    const actionGeneration = ++nativeDocumentActionGenerationRef.current;
    setDashboardActionError(null);
    try {
      await nativeDocument.openDocument();
    } catch (error) {
      if (actionGeneration !== nativeDocumentActionGenerationRef.current) return;
      setDashboardActionError({
        detail: readDisplayError(error, "Unable to open the selected document."),
        inline: true,
        title: "Unable to open document",
      });
    }
  }, [nativeDocument, runtime.mode]);

  const createCollaborationFile = useCallback(
    async (name: string, requireNetworkWorkspace: boolean, activate: boolean) => {
      if (requireNetworkWorkspace && runtime.mode !== "network") {
        throw new Error(
          "create_file requires Leaf's authenticated network workspace. No offline or native document was created.",
        );
      }
      const file = await runtime.createFile(name);
      const main = getMainCollaborationBranch(file);
      if (!main) throw new Error("The created file has no main branch.");

      // The runtime already lists the file, so the tabs controller gets the
      // same directory synchronously and the tab opens in this tick; React
      // catches up afterwards. No registry refetch stands between the click
      // and the editor.
      const nextFiles = [
        ...filesRef.current.filter((candidate) => candidate.fileId !== file.fileId),
        file,
      ];
      const controller = tabsControllerRef.current!;
      controller.setDirectory(nextFiles);
      setFiles(nextFiles);

      // MCP-created files stay in the background so the user's visible tab and
      // the home window's unaddressed target do not change underneath them.
      const tabId = activate
        ? controller.openSelection(file.fileId, main.branchId)
        : controller.openBackgroundSelection(file.fileId, main.branchId);
      if (activate) switchBranch(file.fileId, main.branchId);
      const documentId = `${file.fileId}:${main.branchId}`;
      const confirmation = runtime.awaitFileCreation?.(file.fileId) ?? Promise.resolve();
      // A confirmation that fails closes the tab it opened and drops the file
      // from the directory, leaving no editor (and no dashboard card) on a
      // file the registry never accepted.
      const withdraw = () => {
        const current = tabsControllerRef.current;
        if (!current) return false;
        const wasActive = current.getSnapshot().activeTabId === tabId;
        thumbnailLoopCancelsRef.current.get(tabId)?.();
        thumbnailLoopCancelsRef.current.delete(tabId);
        current.closeTab(tabId);
        setFiles((previous) => previous.filter((candidate) => candidate.fileId !== file.fileId));
        if (wasActive) {
          window.history.pushState(
            null,
            "",
            `${window.location.pathname}${window.location.search}`,
          );
          emitSelectionChange();
        }
        return true;
      };
      if (!activate) {
        // The MCP path promises a registry-backed document, so it waits for
        // the registry's confirmation and for the tab's session; the caller
        // hears about a rejection, and nothing of the file stays behind.
        try {
          await confirmation;
        } catch (error) {
          withdraw();
          throw error;
        }
        await waitForWorkspaceTabReady(controller, tabId, documentId);
        return documentId;
      }
      // The user-facing path returns now and reports a later failure on the
      // dashboard.
      void confirmation.catch((error: unknown) => {
        if (!withdraw()) return;
        setDashboardActionError({
          detail: readDisplayError(error, "Unable to create a new document."),
          inline: true,
          title: "Unable to create document",
        });
      });
      return documentId;
    },
    [runtime, switchBranch],
  );

  const handleCreateFile = useCallback(async () => {
    const isNativeDocumentAction = Boolean(nativeDocument && runtime.mode === "local");
    const actionGeneration = ++nativeDocumentActionGenerationRef.current;
    setDashboardActionError(null);
    setIsCreatingFile(true);
    try {
      if (isNativeDocumentAction) {
        await nativeDocument!.createDocument();
        return;
      }
      const name = files.length === 0 ? "Untitled file" : `Untitled file ${files.length + 1}`;
      await createCollaborationFile(name, false, true);
    } catch (error) {
      // A rejection that lands after the user moved on must not replace the
      // currently visible editor or a newer dashboard action with stale UI.
      if (actionGeneration !== nativeDocumentActionGenerationRef.current) return;
      setDashboardActionError({
        detail: readDisplayError(error, "Unable to create a new document."),
        inline: true,
        title: "Unable to create document",
      });
    } finally {
      setIsCreatingFile(false);
    }
  }, [createCollaborationFile, files.length, nativeDocument, runtime]);

  handleCreateFileRef.current = handleCreateFile;

  // MCP rename path: awaited (no optimistic UI) so the tool result reflects
  // the runtime outcome, then propagated through the files directory the tabs
  // controller syncs from.
  const renameCollaborationFile = useCallback(
    async (fileId: string, name: string) => {
      // The MCP binding omits renameFile for rename-less runtimes, so the
      // bridge handler owns the user-facing capability error; this guard is an
      // internal invariant check only.
      if (!runtime.renameFile) throw new Error("This runtime cannot rename files.");
      const renamed = await runtime.renameFile(fileId, name);
      setFiles((previous) =>
        previous.map((file) => (file.fileId === renamed.fileId ? renamed : file)),
      );
      return renamed;
    },
    [runtime],
  );

  const handleRenameFile = useCallback(
    (name: string) => {
      const active = tabsControllerRef.current!.getActiveTab();
      if (!active || !runtime.renameFile) return;
      setFiles((previous) =>
        previous.map((file) =>
          file.fileId === active.fileId
            ? { ...file, name, updatedAt: new Date().toISOString() }
            : file,
        ),
      );
      void runtime
        .renameFile(active.fileId, name)
        .then((renamed) => {
          setFiles((previous) =>
            previous.map((file) => (file.fileId === renamed.fileId ? renamed : file)),
          );
        })
        .catch(() => void refreshFiles());
    },
    [refreshFiles, runtime],
  );

  const handleSignOut = useCallback(async () => {
    // Stop thumbnail loops before the tabs they resolve through disappear —
    // a capture in flight must not PATCH a file after logout.
    for (const cancel of thumbnailLoopCancelsRef.current.values()) cancel();
    thumbnailLoopCancelsRef.current.clear();
    await runtime.disposeForLogout();
    tabsControllerRef.current!.reset();
    await onSignOut?.();
  }, [onSignOut, runtime]);

  const [windowContext] = useState<LeafCollaborationWindowContext>(() => {
    const controller = tabsController;
    return {
      mode: runtime.mode,
      clientInstanceId: runtime.clientInstanceId,
      get currentFile() {
        return structuredClone(controller.getActiveTab()?.file ?? null);
      },
      get currentBranch() {
        return structuredClone(controller.getActiveTab()?.branch ?? null);
      },
      get sessionGeneration() {
        return controller.getActiveTab()?.generation ?? 0;
      },
      get presencePeers() {
        return structuredClone(controller.getActiveTab()?.presencePeers ?? []);
      },
      get presenceStatus() {
        return controller.getActiveTab()?.presenceStatus ?? "idle";
      },
      getCurrentSession: () => controller.getActiveTab()?.editor ?? null,
    };
  });
  useEffect(() => {
    if (runtime.documentKind === "native") return;
    window.leafCollaboration = windowContext;
    return () => {
      if (window.leafCollaboration === windowContext) {
        delete window.leafCollaboration;
      }
    };
  }, [runtime.documentKind, windowContext]);

  // MCP bridge: one installation per window routing tool calls onto any open
  // tab. Unaddressed calls hit the active tab; documentId-addressed calls hit
  // matching background tabs so agents can work without foregrounding them.
  const createCollaborationFileRef = useRef(createCollaborationFile);
  const renameCollaborationFileRef = useRef(renameCollaborationFile);
  useEffect(() => {
    createCollaborationFileRef.current = createCollaborationFile;
    renameCollaborationFileRef.current = renameCollaborationFile;
  }, [createCollaborationFile, renameCollaborationFile]);

  const [mcpProvider] = useState<McpBridgeDocumentProvider>(() => {
    const controller = tabsController;
    const findTab = (tabId: string) =>
      controller.getSnapshot().tabs.find((candidate) => candidate.tabId === tabId) ?? null;
    const makeBinding = (tabId: string): McpDocumentBinding => ({
      getDocumentId: () => {
        const tab = findTab(tabId);
        return tab ? `${tab.fileId}:${tab.branchId}` : null;
      },
      // beginOpen rebinds the tab's identity ahead of its session during a
      // branch switch (and on a failed open), so withhold the store until the
      // open settles — otherwise addressed calls advertising the new
      // documentId would mutate the previous branch's live store.
      getStore: () => {
        const tab = findTab(tabId);
        if (!tab || tab.isOpening || tab.error) return null;
        return tab.editor?.store ?? null;
      },
      getError: () => findTab(tabId)?.error ?? null,
      getFile: () => findTab(tabId)?.file ?? null,
      getBranch: () => findTab(tabId)?.branch ?? null,
      // Absent when the runtime cannot rename, so the bridge handler's
      // capability check raises the single user-facing error.
      ...(runtime.renameFile
        ? {
            renameFile: async (name: string) => {
              const tab = findTab(tabId);
              if (!tab) {
                throw new Error(
                  "rename_file lost its document tab before running. No changes were made.",
                );
              }
              return renameCollaborationFileRef.current(tab.fileId, name);
            },
          }
        : {}),
    });
    return {
      createFile: (name) => createCollaborationFileRef.current(name, true, false),
      closeDocument: (documentId) => {
        const tab = controller
          .getSnapshot()
          .tabs.find((candidate) => `${candidate.fileId}:${candidate.branchId}` === documentId);
        if (!tab) {
          throw new Error(`close_file lost its document tab (${documentId}). No tab was closed.`);
        }
        // The active tab is what the user is looking at; agents clean up their
        // own background tabs and leave the user's view alone.
        if (controller.getActiveTab()?.tabId === tab.tabId) {
          throw new Error(
            "close_file refuses to close the window's active tab. Close a background tab, or ask the user to close this one. No tab was closed.",
          );
        }
        controller.closeTab(tab.tabId);
      },
      getFocusedDocument: () => {
        const active = controller.getActiveTab();
        return active ? makeBinding(active.tabId) : null;
      },
      findDocument: (documentId) => {
        const tab = controller
          .getSnapshot()
          .tabs.find((candidate) => `${candidate.fileId}:${candidate.branchId}` === documentId);
        return tab ? makeBinding(tab.tabId) : null;
      },
      listDocuments: () =>
        controller.getSnapshot().tabs.map((candidate) => makeBinding(candidate.tabId)),
    };
  });

  useEffect(() => {
    if (!ENABLE_MCP_BRIDGE && !isElectronRuntime()) return;
    let cancelled = false;
    let disposeMcpBridge: (() => void) | undefined;
    void import("../agent/mcp/bridge").then(({ installMcpBridge }) => {
      if (!cancelled) disposeMcpBridge = installMcpBridge(mcpProvider);
    });
    return () => {
      cancelled = true;
      disposeMcpBridge?.();
    };
  }, [mcpProvider]);

  const webMcpDocumentId =
    activeTab?.editor && !activeTab.isOpening && !activeTab.error
      ? `${activeTab.fileId}:${activeTab.branchId}`
      : null;

  // WebMCP is page-scoped, so expose tools only while a ready editor tab is
  // focused. Re-registering on tab or branch changes pins every invocation to
  // the document the user can see; both this adapter and the bridge fail
  // closed if focus changes while an invocation is in flight.
  useEffect(() => {
    if (!webMcpDocumentId) return;

    let cancelled = false;
    let disposeWebMcp: (() => void) | undefined;
    void Promise.all([import("../agent/mcp/bridge"), import("../agent/webmcp/leaf-webmcp")])
      .then(([{ createMcpBridgeHandler }, { registerLeafWebMcp }]) => {
        if (cancelled) return;

        const handler = createMcpBridgeHandler(mcpProvider);
        const registration = registerLeafWebMcp({
          executor: (method, params, expectedDocumentId, activityAgent) =>
            handler.handleToolCall(method, params, expectedDocumentId, activityAgent),
          getDocumentId: () => mcpProvider.getFocusedDocument()?.getDocumentId() ?? null,
          activityAgent: {
            id: "leaf-webmcp-browser-agent",
            kind: "unknown",
            label: "Browser agent",
          },
        });
        if (!registration) return;

        disposeWebMcp = () => registration.dispose();
        void registration.ready.catch((error: unknown) => {
          // A registration failure aborts the signal itself, so only an
          // explicit dispose() (teardown) makes this rejection expected.
          if (!registration.disposed) {
            console.warn("Leaf could not register its WebMCP tools.", error);
          }
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) console.warn("Leaf could not initialize WebMCP.", error);
      });

    return () => {
      cancelled = true;
      disposeWebMcp?.();
    };
  }, [mcpProvider, webMcpDocumentId]);

  const dashboardFiles = useMemo(
    () =>
      files
        .filter((file) => file.status === "active")
        .flatMap((file) => {
          const main = getMainCollaborationBranch(file);
          return main ? [toFileNavigationEntry(file, main)] : [];
        }),
    [files],
  );
  const displayedFile = activeTab?.file ?? null;
  const isSwitchingSession = Boolean(activeTab?.isOpening && activeTab.editor);
  // Opening a tab usually takes a few frames (a cached session and a loaded
  // editor chunk). The screen stays quiet for that long and only labels
  // itself once the wait is long enough to need explaining, the same 180 ms
  // the tab-switch indicator uses.
  const isOpeningQuietly =
    restorePending ||
    Boolean(activeTab && activeTab.isOpening && !activeTab.editor) ||
    Boolean(activeTab?.editor && displayedFile && !EditorCanvasApp);
  const [showOpeningLabel, setShowOpeningLabel] = useState(false);
  useEffect(() => {
    if (!isOpeningQuietly) {
      setShowOpeningLabel(false);
      return;
    }
    const timeoutId = window.setTimeout(() => setShowOpeningLabel(true), 180);
    return () => window.clearTimeout(timeoutId);
  }, [isOpeningQuietly]);

  useEffect(() => {
    if (!isSwitchingSession) {
      setShowSwitchingIndicator(false);
      return;
    }
    const timeoutId = window.setTimeout(() => setShowSwitchingIndicator(true), 180);
    return () => window.clearTimeout(timeoutId);
  }, [isSwitchingSession]);

  const transportStatus =
    activeTab?.transportStatus ?? (runtime.mode === "local" ? "local" : "idle");
  const presencePeers = activeTab?.presencePeers ?? [];
  const peerCount =
    transportStatus === "live" || transportStatus === "read-only" ? presencePeers.length + 1 : 0;
  const syncHealth = getSyncHealth({
    hasActiveDocument: activeTab !== null,
    isOnline,
    peerCount,
    syncServerEnabled: runtime.mode === "network",
  });
  const networkIssue =
    transportStatus === "error"
      ? "The collaboration session could not establish a contiguous stream."
      : transportStatus === "offline"
        ? "The collaboration session is using its committed offline cache."
        : transportStatus === "reconnecting"
          ? "The collaboration session is reconnecting."
          : null;
  // Production connection chrome: shown only while the active session is not
  // healthy (offline, reconnecting, read-only, error); nothing otherwise.
  const connectionStatus = getConnectionStatus({
    isOnline,
    runtimeMode: runtime.mode === "network" ? "network" : "local",
    transportStatus,
  });

  let content: ReactNode;
  if (directoryLoading) {
    content = <LoadingScreen title="Loading files" detail="Fetching your files." />;
  } else if (restorePending || (activeTab && activeTab.isOpening && !activeTab.editor)) {
    content = (
      <LoadingScreen
        title={showOpeningLabel ? "Opening file" : ""}
        detail={showOpeningLabel ? "Loading the document and getting the editor ready." : undefined}
      />
    );
  } else if (dashboardActionError && !dashboardActionError.inline && !activeTab?.editor) {
    // Rendered ahead of the tab error: a deep link during a failed directory
    // load produces both, and the load failure is the accurate diagnosis.
    // A mounted editor still wins — a failed background action (e.g. the tab
    // strip's New file) must not displace a live editing session.
    content = (
      <LoadingScreen
        title={dashboardActionError.title}
        detail={dashboardActionError.detail}
        action={
          <button
            type="button"
            onClick={() => {
              setDashboardActionError(null);
              if (activeTab) returnToDashboard();
            }}
            style={errorActionStyle}
          >
            Back to files
          </button>
        }
      />
    );
  } else if (activeTab?.error) {
    content = (
      <LoadingScreen
        title="Failed to open file"
        detail={activeTab.error}
        action={
          <button type="button" onClick={returnToDashboard} style={errorActionStyle}>
            Back to dashboard
          </button>
        }
      />
    );
  } else if (activeTab?.editor && displayedFile && !EditorCanvasApp && editorChunkError !== null) {
    // The chunk never arrived. Holding the opening screen would read as a
    // slow open that never finishes; say so and offer another fetch.
    content = (
      <LoadingScreen
        title="Unable to load the editor"
        detail={readDisplayError(editorChunkError, "The editor failed to load.")}
        action={
          <button
            type="button"
            onClick={() => void editorCanvasApp.load()}
            style={errorActionStyle}
          >
            Try again
          </button>
        }
      />
    );
  } else if (activeTab?.editor && displayedFile && !EditorCanvasApp) {
    content = (
      <LoadingScreen
        title={showOpeningLabel ? "Opening file" : ""}
        detail={showOpeningLabel ? "Loading the document and getting the editor ready." : undefined}
      />
    );
  } else if (activeTab?.editor && displayedFile && EditorCanvasApp) {
    content = (
      <>
        <EditorCanvasApp
          key={activeTab.tabId}
          collaborationContext={windowContext}
          session={activeTab.editor}
          presencePeers={presencePeers}
          fileName={displayedFile.name}
          feedbackScopeId={activeTab.tabId}
          onReturnToDashboard={returnToDashboard}
          onRenameFile={handleRenameFile}
          documentDirty={documentDirty}
          renderDocumentScriptHost={isNativeShell ? host?.renderDocumentScriptHost : undefined}
        />
        <EditorFrameMark onFrame={() => requestAnimationFrame(flushDeferredRestores)} />
        {isSwitchingSession ? (
          <SessionTransitionOverlay
            fileName={displayedFile?.name ?? "file"}
            showLabel={showSwitchingIndicator}
          />
        ) : null}
      </>
    );
  } else {
    content = (
      <FilesDashboard
        files={dashboardFiles}
        openHistory={openHistory}
        authUser={authUser}
        notice={dashboardActionError?.inline ? dashboardActionError : null}
        onDismissNotice={() => setDashboardActionError(null)}
        onCreateFile={handleCreateFile}
        onOpenNativeFile={
          nativeDocument && runtime.mode === "local" ? handleOpenNativeFile : undefined
        }
        onOpenFile={openFile}
        onSignIn={onSignIn}
        onSignOut={onSignOut ? () => void handleSignOut() : undefined}
        isCreatingFile={isCreatingFile}
      />
    );
  }

  return (
    <>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100vh",
          width: "100vw",
          overflow: "hidden",
          paddingTop: isNativeShell && hasInsetTitleBar ? TITLE_BAR_HEIGHT : undefined,
        }}
      >
        {supportsWorkspaceTabs ? (
          <WorkspaceTabBar
            tabs={tabsSnapshot.tabs.map((tab) => ({
              tabId: tab.tabId,
              label: tab.file?.name ?? "Untitled",
              isActive: tab.tabId === tabsSnapshot.activeTabId,
              // Transport failures count too: a background tab an agent is
              // writing into must surface a broken stream somewhere. Offline
              // is reported separately — cached editing is not a failure.
              hasError: tab.error !== null || tab.transportStatus === "error",
              isOffline: tab.transportStatus === "offline",
              statusDetail:
                tab.error ??
                (tab.transportStatus === "error"
                  ? "the connection broke and recent edits may not reach the server."
                  : tab.transportStatus === "offline"
                    ? "edits are saved on this device and sync when you're back online."
                    : undefined),
              agentActivity: tab.editor?.store.agentActivity,
            }))}
            dashboardActive={!activeTab}
            isCreatingFile={isCreatingFile}
            onSelectDashboard={returnToDashboard}
            onSelectTab={handleSelectTab}
            onCloseTab={handleCloseTab}
            onReorderTab={handleReorderTab}
            onCreateFile={() => void handleCreateFile()}
          />
        ) : null}
        <AppTitleBarVisibility visible={isNativeShell}>
          <div style={{ flex: 1, minHeight: 0, position: "relative" }}>{content}</div>
        </AppTitleBarVisibility>
      </div>
      <ConnectionStatusIndicator status={connectionStatus} />
      <AppDiagnostics syncHealth={syncHealth} peerCount={peerCount} networkIssue={networkIssue} />
    </>
  );
}

const errorActionStyle = {
  padding: "10px 20px",
  borderRadius: 8,
  border: "1px solid #18181b",
  backgroundColor: "#18181b",
  color: "#fff",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
} as const;
