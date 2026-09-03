import type { MouseEvent, ReactNode } from "react";
import type { FileNavigationEntry } from "../../core/state/file-navigation";
import { cx } from "../primitives/cx";
import { FilePreview } from "./FilePreview";
import { type FilesViewMode, relativeTimeLabel } from "./files-dashboard-model";

export function FilesDashboardFileList({
  filteredFiles,
  isMobile,
  onOpenFile,
  useNativeLinks,
  viewMode,
}: {
  filteredFiles: FileNavigationEntry[];
  isMobile: boolean;
  onOpenFile: (fileUrl: string) => void;
  useNativeLinks: boolean;
  viewMode: FilesViewMode;
}) {
  return (
    <div
      className={cx(
        "grid",
        viewMode === "grid"
          ? isMobile
            ? "grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3.5"
            : "grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-5"
          : "grid-cols-1 gap-0.5",
      )}
    >
      {filteredFiles.length === 0 ? (
        <div className="col-span-full p-10 text-center text-md text-ink-muted">
          No files match your search.
        </div>
      ) : viewMode === "grid" ? (
        filteredFiles.map((file) => (
          <FileNavigationControl
            // Keyed by view mode so toggling grid/list remounts instead of
            // re-classing the same element — transition-colors must animate
            // hovers, never the border/background jump between the two looks.
            key={`grid:${file.url}`}
            file={file}
            onOpenFile={onOpenFile}
            useNativeLink={useNativeLinks}
            className="grid gap-2.5 rounded-[12px] border border-solid border-edge bg-surface px-2 pt-3 pb-2 text-left transition-colors hover:border-edge-strong"
          >
            {/* Name above the thumbnail so titles scan in one straight line. */}
            <div className="grid px-1.5">
              {/* 14px, not the 12px text-sm token: names must outweigh the
                  timestamp metadata beside them. */}
              <div className="truncate text-sm text-ink">{file.name}</div>
              <div className="text-sm text-ink-muted">{relativeTimeLabel(file.updatedAt)}</div>
            </div>
            <FilePreview file={file} />
          </FileNavigationControl>
        ))
      ) : (
        filteredFiles.map((file) => (
          <FileNavigationControl
            key={`list:${file.url}`}
            file={file}
            onOpenFile={onOpenFile}
            useNativeLink={useNativeLinks}
            // Full border declaration (not border-none) so no UA button
            // border ever participates in rendering or transitions.
            className="flex w-full items-center gap-3.5 rounded-md border border-solid border-transparent bg-transparent px-3 py-2.5 text-left transition-colors hover:bg-surface-sunken"
          >
            <div className="h-[30px] w-10 shrink-0 overflow-hidden rounded-[4px] bg-surface-sunken">
              {file.thumbnailUrl ? (
                <img
                  src={file.thumbnailUrl}
                  alt=""
                  loading="lazy"
                  draggable={false}
                  className="block h-full w-full object-contain"
                />
              ) : null}
            </div>
            <div className="flex-1 truncate text-[14px] font-medium text-ink">{file.name}</div>
            <div className="text-sm text-ink-muted">{relativeTimeLabel(file.updatedAt)}</div>
          </FileNavigationControl>
        ))
      )}
    </div>
  );
}

function FileNavigationControl({
  children,
  className,
  file,
  onOpenFile,
  useNativeLink,
}: {
  children: ReactNode;
  className: string;
  file: FileNavigationEntry;
  onOpenFile: (fileUrl: string) => void;
  useNativeLink: boolean;
}) {
  if (!useNativeLink) {
    return (
      <button type="button" onClick={() => onOpenFile(file.url)} className={className}>
        {children}
      </button>
    );
  }

  const openInCurrentTab = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    onOpenFile(file.url);
  };

  return (
    <a
      href={`#${file.url}`}
      onClick={openInCurrentTab}
      className={cx(className, "cursor-default text-inherit no-underline")}
    >
      {children}
    </a>
  );
}
