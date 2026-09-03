import { runInAction } from "mobx";
import type { LeafBranchDto, LeafFileDto } from "../shared/collaboration";
import type {
  CollaborationApplicationRuntime,
  CollaborationApplicationSession,
  NormalizedEditorSession,
} from "./collaboration-app-runtime";
import type {
  CollaborationPresencePeer,
  CollaborationPresenceStatus,
} from "./collaboration-presence";
import type { CollaborationTransportStatus } from "./collaboration-transport";
import { markStartup } from "../lib/startup-marks";

// Panel sizes are deliberately absent: they persist app-wide through
// panel-layout-storage, not per tab, so a fresh session already reads the
// user's sizes and a snapshot restore must not resurrect older ones.
export type ViewportSnapshot = {
  zoom: number;
  panX: number;
  panY: number;
  sidebarCollapsed: boolean;
};

export function readViewportSnapshot(session: NormalizedEditorSession): ViewportSnapshot {
  return {
    zoom: session.store.zoom,
    panX: session.store.panX,
    panY: session.store.panY,
    sidebarCollapsed: session.store.sidebarCollapsed,
  };
}

export function applyViewportSnapshot(
  session: NormalizedEditorSession,
  viewport: ViewportSnapshot,
) {
  runInAction(() => {
    session.store.zoom = viewport.zoom;
    session.store.panX = viewport.panX;
    session.store.panY = viewport.panY;
    session.store.sidebarCollapsed = viewport.sidebarCollapsed;
    session.store.shouldCenterInitialViewport = false;
  });
}

export type WorkspaceTabTransportStatus = CollaborationTransportStatus | "local";

export type WorkspaceTabSnapshot = {
  readonly tabId: string;
  readonly fileId: string;
  readonly branchId: string;
  /** Directory metadata clones for the tab; null until the directory resolves them. */
  readonly file: LeafFileDto | null;
  readonly branch: LeafBranchDto | null;
  readonly editor: NormalizedEditorSession | null;
  readonly session: CollaborationApplicationSession | null;
  readonly generation: number;
  readonly error: string | null;
  readonly isOpening: boolean;
  readonly presencePeers: CollaborationPresencePeer[];
  readonly presenceStatus: CollaborationPresenceStatus;
  readonly transportStatus: WorkspaceTabTransportStatus;
};

export type WorkspaceTabsSnapshot = {
  readonly activeTabId: string | null;
  readonly tabs: readonly WorkspaceTabSnapshot[];
};

type TabRecord = {
  tabId: string;
  fileId: string;
  branchId: string;
  file: LeafFileDto | null;
  branch: LeafBranchDto | null;
  editor: NormalizedEditorSession | null;
  session: CollaborationApplicationSession | null;
  generation: number;
  error: string | null;
  isOpening: boolean;
  openGeneration: number;
  presencePeers: CollaborationPresencePeer[];
  presenceStatus: CollaborationPresenceStatus;
  transportStatus: WorkspaceTabTransportStatus;
};

export type WorkspaceTabsControllerOptions = {
  runtime: CollaborationApplicationRuntime;
  /**
   * Desktop home windows retain multiple live tabs. Browser and native
   * document shells reuse one tab so their platform window/tab model remains
   * the only multi-document surface.
   */
  supportsMultipleTabs?: boolean;
  /**
   * Session retirement hook. The App wires this to its pending-disposal
   * tracker so native save/close drains still observe tab teardown failures.
   */
  disposeSession: (session: CollaborationApplicationSession) => Promise<void> | void;
  /** Called once a tab's editor session is ready (used for idle font preload). */
  onEditorReady?: (tabId: string, editor: NormalizedEditorSession) => void;
  /** Called when a session reports a branch write fence; App refreshes the directory. */
  onWriteFence?: () => void;
};

/**
 * Owns the open-tab list and one live collaboration session per tab.
 *
 * Background tabs keep their sessions connected so MCP agents can keep
 * mutating those documents; only the active tab is mounted by the editor UI.
 * Navigation stays URL-hash driven: the App maps hash selection changes onto
 * openSelection/showDashboard and mirrors the active tab back into the hash.
 */
export class WorkspaceTabsController {
  private readonly listeners = new Set<() => void>();
  private readonly tabs: TabRecord[] = [];
  /** Restored background tabs whose session open is still scheduled. */
  private readonly deferredRestoreOpens = new Map<string, () => void>();
  private activeTabId: string | null = null;
  private directory: LeafFileDto[] = [];
  private snapshot: WorkspaceTabsSnapshot = { activeTabId: null, tabs: [] };
  private snapshotStale = false;

  constructor(private readonly options: WorkspaceTabsControllerOptions) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): WorkspaceTabsSnapshot => {
    if (this.snapshotStale) {
      this.snapshot = {
        activeTabId: this.activeTabId,
        tabs: this.tabs.map((tab) => ({
          tabId: tab.tabId,
          fileId: tab.fileId,
          branchId: tab.branchId,
          file: tab.file,
          branch: tab.branch,
          editor: tab.editor,
          session: tab.session,
          generation: tab.generation,
          error: tab.error,
          isOpening: tab.isOpening,
          presencePeers: tab.presencePeers,
          presenceStatus: tab.presenceStatus,
          transportStatus: tab.transportStatus,
        })),
      };
      this.snapshotStale = false;
    }
    return this.snapshot;
  };

  getActiveTab(): WorkspaceTabSnapshot | null {
    const snapshot = this.getSnapshot();
    return snapshot.tabs.find((tab) => tab.tabId === snapshot.activeTabId) ?? null;
  }

  /** Refresh directory metadata and reconcile branch write-lifecycle transitions. */
  setDirectory(files: LeafFileDto[]) {
    // refreshFiles hands the same array to setDirectory directly and again
    // via the [files] effect; the second pass has nothing new to reconcile.
    if (files === this.directory) return;
    this.directory = files;
    const filesById = new Map(files.map((file) => [file.fileId, file]));
    for (const tab of this.tabs) {
      const file = filesById.get(tab.fileId);
      const branch = file?.branches.find((candidate) => candidate.branchId === tab.branchId);
      if (!file || !branch) {
        // A transient directory miss (racing refreshes) must not sever a live
        // session — MCP agents keep addressing it — so only tabs without one
        // report the miss.
        if (!tab.session) {
          tab.error = "The selected file or branch is no longer available.";
        }
        continue;
      }
      const previousBranch = tab.branch;
      const restoredFromReadOnly =
        previousBranch !== null &&
        (previousBranch.writeMode !== "writable" || previousBranch.status !== "active") &&
        branch.writeMode === "writable" &&
        branch.status === "active";
      tab.file = structuredClone(file);
      tab.branch = structuredClone(branch);
      if (restoredFromReadOnly && (tab.session || tab.isOpening)) {
        // Permanent write fences are intentionally one-way. A restored branch
        // therefore needs a fresh session, and the fenced editor must be
        // detached before an exact-tab activation can expose it as writable.
        this.beginOpen(tab, tab.fileId, tab.branchId, { retireCurrentSession: true });
        continue;
      }
      // A transient directory miss (racing refreshes) may have errored a live
      // tab; recover it once the file and branch are listed again.
      if (tab.session) {
        tab.error = null;
      } else if (tab.error !== null && !tab.isOpening) {
        // A failed open retries once the directory lists its branch (e.g. a
        // deep link to a branch another client had just created), matching
        // the pre-tab shell's retry on every directory refresh.
        this.beginOpen(tab, tab.fileId, tab.branchId);
      }
      if (tab.session && (branch.writeMode !== "writable" || branch.status !== "active")) {
        const kind =
          branch.writeMode === "archived" || branch.status === "archived"
            ? ("archived" as const)
            : ("read-only" as const);
        void tab.session.fenceWrites(kind);
      }
    }
    this.emit();
  }

  private createTabRecord(fileId: string, branchId: string): TabRecord {
    return {
      tabId: crypto.randomUUID(),
      fileId,
      branchId,
      file: null,
      branch: null,
      editor: null,
      session: null,
      generation: 0,
      error: null,
      isOpening: true,
      openGeneration: 0,
      presencePeers: [],
      presenceStatus: "idle",
      transportStatus: this.options.runtime.mode === "local" ? "local" : "idle",
    };
  }

  /**
   * Open the given file/branch: activates the exact tab when one exists,
   * switches the active tab's branch in place (carrying its viewport), or
   * opens a new tab. In a multi-tab shell, a background tab on a sibling
   * branch is never retargeted — an MCP agent may be addressing it as
   * fileId:branchId and its session must stay live. Single-tab shells reuse
   * their sole slot instead.
   */
  openSelection(fileId: string, branchId: string) {
    const existing =
      this.tabs.find((tab) => tab.fileId === fileId && tab.branchId === branchId) ??
      this.tabs.find((tab) => tab.fileId === fileId && tab.tabId === this.activeTabId) ??
      (this.options.supportsMultipleTabs === false ? this.tabs[0] : undefined);
    if (existing) {
      this.activeTabId = existing.tabId;
      // A restored tab the user reaches before its deferred open runs opens now.
      this.deferredRestoreOpens.get(existing.tabId)?.();
      if (existing.branchId !== branchId || (!existing.session && !existing.isOpening)) {
        this.beginOpen(existing, fileId, branchId);
      }
      this.emit();
      return existing.tabId;
    }
    const tab = this.createTabRecord(fileId, branchId);
    this.tabs.push(tab);
    this.activeTabId = tab.tabId;
    this.beginOpen(tab, fileId, branchId);
    this.emit();
    return tab.tabId;
  }

  /**
   * Open a new document tab without changing the active tab or dashboard.
   * MCP file creation uses this so a new addressable workspace file does not
   * silently move the user's view or the home window's unaddressed target.
   */
  openBackgroundSelection(fileId: string, branchId: string) {
    const existing = this.tabs.find((tab) => tab.fileId === fileId && tab.branchId === branchId);
    if (existing) return existing.tabId;
    const tab = this.createTabRecord(fileId, branchId);
    this.tabs.push(tab);
    this.beginOpen(tab, fileId, branchId);
    this.emit();
    return tab.tabId;
  }

  activateTab(tabId: string) {
    const tab = this.tabs.find((candidate) => candidate.tabId === tabId);
    if (!tab || this.activeTabId === tabId) return;
    this.activeTabId = tabId;
    this.emit();
  }

  /**
   * Reopen a persisted tab set after an app relaunch: appends background tabs
   * for selections still present in the directory, skipping ones already open
   * (e.g. a deep link that raced restoration) and ones the directory no
   * longer lists. Never changes the active tab; single-tab shells don't
   * restore.
   *
   * With `deferBackground`, only `activeSelection` opens its session now; the
   * other tabs appear in the strip at once but open through the scheduler, so
   * the surface the launch lands on paints before the rest of the workspace
   * starts its session work and network burst. A deferred tab the user
   * activates first opens immediately.
   */
  restoreTabs(
    selections: ReadonlyArray<{ branchId: string; fileId: string }>,
    options: {
      activeSelection?: { branchId: string; fileId: string } | null;
      deferBackground?: (open: () => void) => void;
    } = {},
  ) {
    if (this.options.supportsMultipleTabs === false) return;
    for (const selection of selections) {
      const alreadyOpen = this.tabs.some(
        (tab) => tab.fileId === selection.fileId && tab.branchId === selection.branchId,
      );
      if (alreadyOpen) continue;
      const file = this.directory.find((candidate) => candidate.fileId === selection.fileId);
      const branch = file?.branches.find((candidate) => candidate.branchId === selection.branchId);
      if (!file || !branch) continue;
      const tab = this.createTabRecord(selection.fileId, selection.branchId);
      // A deferred tab shows its real title in the strip before it opens.
      tab.file = structuredClone(file);
      tab.branch = structuredClone(branch);
      this.tabs.push(tab);
      const isActive =
        options.activeSelection?.fileId === selection.fileId &&
        options.activeSelection.branchId === selection.branchId;
      if (!options.deferBackground || isActive) {
        this.beginOpen(tab, selection.fileId, selection.branchId);
        continue;
      }
      const open = () => {
        if (!this.deferredRestoreOpens.delete(tab.tabId)) return;
        if (!this.tabs.includes(tab) || tab.session) return;
        this.beginOpen(tab, selection.fileId, selection.branchId);
      };
      this.deferredRestoreOpens.set(tab.tabId, open);
      options.deferBackground(open);
    }
    this.emit();
  }

  /** Move an open tab to the given insertion slot without disturbing its live session. */
  moveTab(tabId: string, insertionIndex: number) {
    const currentIndex = this.tabs.findIndex((candidate) => candidate.tabId === tabId);
    if (currentIndex === -1) return;

    const boundedInsertionIndex = Math.max(0, Math.min(insertionIndex, this.tabs.length));
    const nextIndex =
      boundedInsertionIndex > currentIndex ? boundedInsertionIndex - 1 : boundedInsertionIndex;
    if (nextIndex === currentIndex) return;

    const [tab] = this.tabs.splice(currentIndex, 1);
    this.tabs.splice(nextIndex, 0, tab!);
    this.emit();
  }

  showDashboard() {
    if (this.activeTabId === null) return;
    this.activeTabId = null;
    this.emit();
  }

  closeTab(tabId: string) {
    const index = this.tabs.findIndex((candidate) => candidate.tabId === tabId);
    if (index === -1) return;
    this.deferredRestoreOpens.delete(tabId);
    const [tab] = this.tabs.splice(index, 1);
    tab!.openGeneration += 1;
    if (tab!.session) void this.options.disposeSession(tab!.session);
    if (this.activeTabId === tabId) {
      const neighbor = this.tabs[index] ?? this.tabs[index - 1] ?? null;
      this.activeTabId = neighbor?.tabId ?? null;
    }
    this.emit();
  }

  setOnline(online: boolean) {
    for (const tab of this.tabs) tab.session?.setOnline(online);
  }

  /** Detach all tabs without disposing sessions (used after runtime-level logout disposal). */
  reset() {
    for (const tab of this.tabs) tab.openGeneration += 1;
    this.tabs.length = 0;
    this.activeTabId = null;
    this.emit();
  }

  /**
   * Close every tab and dispose its session. The controller stays usable —
   * React StrictMode runs the App's unmount cleanup between double-invoked
   * effect passes against the same controller instance, so a one-way
   * "disposed" latch would silently drop every session opened afterwards.
   */
  dispose() {
    for (const tab of this.tabs) {
      tab.openGeneration += 1;
      if (tab.session) void this.options.disposeSession(tab.session);
    }
    this.tabs.length = 0;
    this.activeTabId = null;
    this.emit();
  }

  private beginOpen(
    tab: TabRecord,
    fileId: string,
    branchId: string,
    options: { retireCurrentSession?: boolean } = {},
  ) {
    const file = this.directory.find((candidate) => candidate.fileId === fileId);
    const branch = file?.branches.find((candidate) => candidate.branchId === branchId);
    if (!file || !branch) {
      tab.fileId = fileId;
      tab.branchId = branchId;
      tab.error = "The selected file or branch is no longer available.";
      tab.isOpening = false;
      this.emit();
      return;
    }

    const sameFile = tab.fileId === fileId;
    if (!options.retireCurrentSession && tab.session && tab.branchId === branchId && sameFile) {
      // Metadata-only refresh: setDirectory already reconciled clones/fences.
      tab.file = structuredClone(file);
      tab.branch = structuredClone(branch);
      tab.error = null;
      this.emit();
      return;
    }

    const generation = ++tab.openGeneration;
    const previousSession = tab.session;
    const previousEditor = tab.editor;
    const viewport = previousEditor && sameFile ? readViewportSnapshot(previousEditor) : null;
    if (options.retireCurrentSession) {
      tab.session = null;
      tab.editor = null;
      tab.generation = 0;
      tab.presencePeers = [];
      tab.presenceStatus = "idle";
      tab.transportStatus = this.options.runtime.mode === "local" ? "local" : "idle";
      if (previousSession) void this.options.disposeSession(previousSession);
    }
    tab.fileId = fileId;
    tab.branchId = branchId;
    tab.file = structuredClone(file);
    tab.branch = structuredClone(branch);
    tab.error = null;
    tab.isOpening = true;
    this.emit();

    const isCurrent = () =>
      generation === tab.openGeneration &&
      this.tabs.some((candidate) => candidate.tabId === tab.tabId);

    void this.options.runtime
      .openSession(file, branch, {
        onPresenceChange: (peers, status) => {
          if (!isCurrent()) return;
          tab.presencePeers = peers;
          tab.presenceStatus = status;
          // Remote cursors update at high frequency; background tabs record
          // presence silently and the next activation emit surfaces it.
          if (this.activeTabId === tab.tabId) this.emit();
        },
        onSessionReplaced: (replacement, sessionGeneration) => {
          if (!isCurrent()) return;
          if (tab.editor) applyViewportSnapshot(replacement, readViewportSnapshot(tab.editor));
          tab.editor = replacement;
          tab.generation = sessionGeneration;
          this.emit();
        },
        onStatusChange: (status) => {
          if (!isCurrent()) return;
          tab.transportStatus = status;
          this.emit();
        },
        onWriteFence: () => {
          if (!isCurrent()) return;
          this.options.onWriteFence?.();
        },
      })
      .then((session) => {
        if (!isCurrent()) {
          void this.options.disposeSession(session);
          return;
        }
        const editor = session.getCurrentSession();
        markStartup("tab-session-ready");
        if (viewport) applyViewportSnapshot(editor, viewport);
        tab.session = session;
        tab.editor = editor;
        tab.generation = session.generation;
        tab.transportStatus = session.status;
        tab.presencePeers = session.presencePeers;
        tab.presenceStatus = session.presenceStatus;
        tab.error = null;
        tab.isOpening = false;
        // Retire the replaced session independently: a disposal failure is
        // tracked by disposeSession without tearing down the replacement.
        if (!options.retireCurrentSession && previousSession && previousSession !== session) {
          void this.options.disposeSession(previousSession);
        }
        this.emit();
        this.options.onEditorReady?.(tab.tabId, editor);
      })
      .catch((error: unknown) => {
        if (!isCurrent()) return;
        if (!options.retireCurrentSession && previousSession) {
          void this.options.disposeSession(previousSession);
        }
        tab.session = null;
        tab.editor = null;
        tab.error = error instanceof Error ? error.message : "Unable to open the selected branch.";
        tab.isOpening = false;
        this.emit();
      });
  }

  private emit() {
    this.snapshotStale = true;
    for (const listener of this.listeners) listener();
  }
}
