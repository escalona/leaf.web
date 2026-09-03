import { FolderOpenIcon, GridIcon, ListIcon, MenuIcon, PlusIcon, SearchIcon } from "../icons";
import type { RefObject } from "react";
import { isMacOSPlatform } from "../../core/platform";
import { cx } from "../primitives/cx";
import type { FilesViewMode } from "./files-dashboard-model";

export function FilesDashboardHeader({
  isCompact,
  isCreatingFile,
  isMobile,
  onCreateFile,
  onOpenNativeFile,
  onOpenSidebar,
  onSearchQueryChange,
  onViewModeChange,
  searchInputRef,
  searchQuery,
  title,
  viewMode,
}: {
  isCompact: boolean;
  isCreatingFile: boolean;
  isMobile: boolean;
  onCreateFile: () => void | Promise<void>;
  onOpenNativeFile?: () => void | Promise<void>;
  onOpenSidebar: () => void;
  onSearchQueryChange: (query: string) => void;
  onViewModeChange: (viewMode: FilesViewMode) => void;
  searchInputRef?: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  title: string;
  viewMode: FilesViewMode;
}) {
  return (
    <div
      className={cx(
        "flex shrink-0 justify-between bg-surface-raised",
        isCompact ? "flex-col items-stretch gap-3.5" : "flex-row items-center gap-4",
        isMobile ? "pt-4 pb-4" : isCompact ? "pt-5 pb-4" : "pt-6 pb-5",
      )}
    >
      <div className="flex items-center gap-3">
        {isMobile && (
          <button
            type="button"
            aria-label="Open navigation"
            onClick={onOpenSidebar}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-edge bg-surface text-ink transition-colors hover:bg-surface-sunken"
          >
            <MenuIcon size={16} />
          </button>
        )}
        {/* flex-1 pushes the compact-mode action buttons to the right edge. */}
        <h1
          className={cx(
            "flex-1 font-normal tracking-[-0.5px]",
            isMobile ? "text-2xl" : "text-[32px]",
          )}
        >
          {title}
        </h1>
        {isCompact && (
          <>
            {onOpenNativeFile ? (
              <button
                type="button"
                onClick={onOpenNativeFile}
                title="Open .leaf file"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-edge bg-surface text-ink transition-colors hover:bg-surface-sunken"
              >
                <FolderOpenIcon size={16} />
              </button>
            ) : null}
            <button
              type="button"
              onClick={onCreateFile}
              disabled={isCreatingFile}
              className={cx(
                "inline-flex shrink-0 items-center gap-2 rounded-md border border-edge bg-ink py-2 text-sm font-semibold whitespace-nowrap text-white transition-colors hover:bg-ink/85",
                isMobile ? "px-3.5" : "px-4",
                isCreatingFile && "cursor-progress",
              )}
            >
              <PlusIcon size={16} />
              {isCreatingFile ? "Creating..." : "New file"}
            </button>
          </>
        )}
      </div>

      <div className={cx("flex flex-wrap items-center", isMobile ? "gap-2" : "gap-3")}>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label="Grid view"
            aria-pressed={viewMode === "grid"}
            onClick={() => onViewModeChange("grid")}
            className={cx(
              "grid h-8 w-8 place-items-center rounded-[6px] border-none transition-colors",
              viewMode === "grid"
                ? "bg-surface-sunken text-ink"
                : "bg-transparent text-ink-faint hover:bg-surface-sunken/60 hover:text-ink-muted",
            )}
          >
            <GridIcon size={16} />
          </button>
          <button
            type="button"
            aria-label="List view"
            aria-pressed={viewMode === "list"}
            onClick={() => onViewModeChange("list")}
            className={cx(
              "grid h-8 w-8 place-items-center rounded-[6px] border-none transition-colors",
              viewMode === "list"
                ? "bg-surface-sunken text-ink"
                : "bg-transparent text-ink-faint hover:bg-surface-sunken/60 hover:text-ink-muted",
            )}
          >
            <ListIcon size={16} />
          </button>
        </div>

        <div
          className={cx(
            "flex items-center gap-2 rounded-md border border-edge bg-surface px-3 py-[7px] transition-colors hover:border-edge-strong",
            "focus-within:border-edge-active focus-within:ring-[3px] focus-within:ring-ink/10",
            isCompact && "flex-1",
            !isMobile && "min-w-[180px]",
          )}
        >
          <SearchIcon size={16} className="shrink-0 text-ink-muted" />
          <input
            ref={searchInputRef}
            type="text"
            aria-label="Search files"
            placeholder="Search files"
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onSearchQueryChange("");
                event.currentTarget.blur();
              }
            }}
            className="w-full border-none bg-transparent text-sm text-ink outline-none"
          />
          {!isCompact ? (
            <span className="shrink-0 rounded-[5px] border border-edge bg-surface-raised px-[5px] py-px text-xs font-medium text-ink-faint">
              {isMacOSPlatform() ? "⌘F" : "Ctrl+F"}
            </span>
          ) : null}
        </div>

        {!isCompact && (
          <>
            {onOpenNativeFile ? (
              <button
                type="button"
                onClick={onOpenNativeFile}
                className="inline-flex items-center gap-2 rounded-md border border-edge bg-surface px-3.5 py-2 text-sm font-semibold whitespace-nowrap text-ink transition-colors hover:bg-surface-sunken"
              >
                <FolderOpenIcon size={16} />
                Open
              </button>
            ) : null}
            <button
              type="button"
              onClick={onCreateFile}
              disabled={isCreatingFile}
              className={cx(
                "inline-flex items-center gap-2 rounded-md border border-edge bg-ink px-4 py-2 text-sm font-semibold whitespace-nowrap text-white transition-colors hover:bg-ink/85",
                isCreatingFile && "cursor-progress",
              )}
            >
              <PlusIcon size={16} />
              {isCreatingFile ? "Creating..." : "New file"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
