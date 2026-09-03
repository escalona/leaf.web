import { useEffect, useRef, useState } from "react";
import { CloseIcon } from "../icons";
import { AppTitleBar } from "../app/AppTitleBar";
import { isEventTargetEditable, matchesKeyboardShortcut } from "../../core/lib/keyboard-shortcuts";
import { isElectronRuntime, isMacOSPlatform } from "../../core/platform";
import type { FileNavigationEntry } from "../../core/state/file-navigation";
import type { FileOpenHistory } from "../../core/state/file-open-history";
import { cx } from "../primitives/cx";
import { EmptyFilesState } from "./EmptyFilesState";
import { FilesDashboardFileList } from "./FilesDashboardFileList";
import { FilesDashboardHeader } from "./FilesDashboardHeader";
import {
  FilesDashboardSidebar,
  MobileFilesDashboardSidebar,
  type FilesDashboardAuthUser,
} from "./FilesDashboardSidebar";
import {
  FILES_DASHBOARD_VIEW_TITLES,
  type FilesDashboardView,
  type FilesViewMode,
  getFilteredFiles,
  getViewSortedFiles,
  useMediaQuery,
} from "./files-dashboard-model";

/**
 * A failed dashboard action (a New file or Open that did not go through). It
 * is reported inline, above the file list, so the files the user already has
 * stay reachable rather than being replaced by a full-screen error.
 */
export type FilesDashboardNotice = {
  title: string;
  detail: string;
};

export function FilesDashboard({
  files,
  authUser,
  notice = null,
  onCreateFile,
  onDismissNotice,
  onOpenNativeFile,
  onOpenFile,
  onSignIn,
  onSignOut,
  isCreatingFile,
  openHistory = {},
}: {
  files: FileNavigationEntry[];
  authUser?: FilesDashboardAuthUser | null;
  notice?: FilesDashboardNotice | null;
  onCreateFile: () => void | Promise<void>;
  onDismissNotice?: () => void;
  onOpenNativeFile?: () => void | Promise<void>;
  onOpenFile: (fileUrl: string) => void;
  onSignIn?: () => void;
  onSignOut?: () => void;
  isCreatingFile: boolean;
  /** Device-local last-opened times keyed by fileId; drives Recents ordering. */
  openHistory?: FileOpenHistory;
}) {
  const [view, setView] = useState<FilesDashboardView>("recents");
  const [viewMode, setViewMode] = useState<FilesViewMode>("grid");
  const [searchQuery, setSearchQuery] = useState("");
  const [, setTimeTick] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isFileListScrolled, setIsFileListScrolled] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const isMobile = useMediaQuery("(max-width: 640px)");
  const isTablet = useMediaQuery("(min-width: 641px) and (max-width: 1024px)");
  const isCompact = isMobile || isTablet;
  const horizontalPadding = isMobile ? "px-4" : isTablet ? "px-6" : "px-10";
  const bottomPadding = isMobile ? "pb-8" : isTablet ? "pb-10" : "pb-12";

  useEffect(() => {
    const id = setInterval(() => setTimeTick((tick) => tick + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // ⌘F (Ctrl+F elsewhere) focuses the dashboard search instead of browser
  // find. Exactly the platform accel, so macOS Ctrl+F (caret navigation) and
  // Ctrl+⌘F (fullscreen) pass through untouched.
  useEffect(() => {
    const combo = isMacOSPlatform() ? { key: "f", meta: true } : { key: "f", ctrl: true };
    const focusSearch = (event: KeyboardEvent) => {
      if (!matchesKeyboardShortcut(event, combo)) return;
      if (isEventTargetEditable(event.target) && event.target !== searchInputRef.current) return;
      event.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  const filteredFiles = getFilteredFiles(getViewSortedFiles(files, view, openHistory), searchQuery);

  return (
    <div
      className={cx(
        "grid h-full w-full overflow-hidden bg-surface-raised text-ink",
        isMobile
          ? "grid-cols-1"
          : isTablet
            ? "grid-cols-[200px_minmax(0,1fr)]"
            : "grid-cols-[220px_minmax(0,1fr)]",
      )}
    >
      <AppTitleBar />
      {isMobile && sidebarOpen ? (
        <MobileFilesDashboardSidebar
          activeView={view}
          authUser={authUser}
          onClose={() => setSidebarOpen(false)}
          onSignIn={onSignIn}
          onSignOut={onSignOut}
          onViewChange={setView}
        />
      ) : null}
      {!isMobile ? (
        <FilesDashboardSidebar
          activeView={view}
          authUser={authUser}
          onSignIn={onSignIn}
          onSignOut={onSignOut}
          onViewChange={setView}
        />
      ) : null}

      <main className="flex min-h-0 flex-col overflow-hidden">
        <div
          className={cx(
            "shrink-0 border-b",
            horizontalPadding,
            isFileListScrolled ? "border-edge" : "border-transparent",
          )}
        >
          <FilesDashboardHeader
            isCompact={isCompact}
            isCreatingFile={isCreatingFile}
            isMobile={isMobile}
            onCreateFile={onCreateFile}
            onOpenNativeFile={onOpenNativeFile}
            onOpenSidebar={() => setSidebarOpen(true)}
            onSearchQueryChange={setSearchQuery}
            onViewModeChange={setViewMode}
            searchInputRef={searchInputRef}
            searchQuery={searchQuery}
            title={FILES_DASHBOARD_VIEW_TITLES[view]}
            viewMode={viewMode}
          />
        </div>
        <div
          role="region"
          aria-label={`${FILES_DASHBOARD_VIEW_TITLES[view]} files`}
          className={cx("min-h-0 flex-1 overflow-y-auto", horizontalPadding, bottomPadding)}
          onScroll={(event) => {
            const nextScrolled = event.currentTarget.scrollTop > 0;
            setIsFileListScrolled((current) => (current === nextScrolled ? current : nextScrolled));
          }}
        >
          {notice ? (
            <div
              role="alert"
              data-dashboard-notice=""
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 12,
                margin: "12px 0 16px",
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid #fecaca",
                backgroundColor: "#fef2f2",
                color: "#7f1d1d",
                fontSize: 13,
                lineHeight: 1.5,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{notice.title}</div>
                <div style={{ color: "#991b1b" }}>{notice.detail}</div>
              </div>
              {onDismissNotice ? (
                <button
                  type="button"
                  onClick={onDismissNotice}
                  aria-label="Dismiss"
                  title="Dismiss"
                  style={{
                    width: 24,
                    height: 24,
                    display: "grid",
                    placeItems: "center",
                    borderRadius: 6,
                    border: "none",
                    backgroundColor: "transparent",
                    color: "inherit",
                    flexShrink: 0,
                  }}
                >
                  <CloseIcon size={16} />
                </button>
              ) : null}
            </div>
          ) : null}
          {files.length === 0 ? (
            <EmptyFilesState
              onCreateFile={onCreateFile}
              onOpenNativeFile={onOpenNativeFile}
              isCreatingFile={isCreatingFile}
            />
          ) : (
            <FilesDashboardFileList
              filteredFiles={filteredFiles}
              isMobile={isMobile}
              onOpenFile={onOpenFile}
              useNativeLinks={!isElectronRuntime()}
              viewMode={viewMode}
            />
          )}
        </div>
      </main>
    </div>
  );
}
