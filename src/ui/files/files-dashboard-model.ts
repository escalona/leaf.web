import { useCallback, useSyncExternalStore } from "react";
import type { FileNavigationEntry } from "../../core/state/file-navigation";
import type { FileOpenHistory } from "../../core/state/file-open-history";

export type FilesViewMode = "grid" | "list";

/**
 * Recents is my activity (last opened on this device, falling back to edited
 * time); Files is the team library, browsed by name. Same file set, different
 * ordering — the split keeps a teammate's edits from reshuffling Recents.
 */
export type FilesDashboardView = "recents" | "files";

export const FILES_DASHBOARD_VIEW_TITLES: Record<FilesDashboardView, string> = {
  recents: "Recents",
  files: "Files",
};

export function getViewSortedFiles(
  files: FileNavigationEntry[],
  view: FilesDashboardView,
  openHistory: FileOpenHistory,
) {
  if (view === "files") {
    return files.slice().sort((left, right) => left.name.localeCompare(right.name));
  }
  const activityTime = (file: FileNavigationEntry) => {
    const openedAt = openHistory[file.fileId];
    return Date.parse(openedAt ?? file.updatedAt) || 0;
  };
  return files.slice().sort((left, right) => activityTime(right) - activityTime(left));
}

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (callback: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", callback);
      return () => mql.removeEventListener("change", callback);
    },
    [query],
  );
  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

export function getFilteredFiles(files: FileNavigationEntry[], searchQuery: string) {
  if (!searchQuery) return files;
  const normalizedSearchQuery = searchQuery.toLowerCase();
  return files.filter((file) => file.name.toLowerCase().includes(normalizedSearchQuery));
}

export function relativeTimeLabel(timestamp: string) {
  const elapsedMs = Date.now() - new Date(timestamp).getTime();
  const elapsedMinutes = Math.max(0, Math.floor(elapsedMs / 60000));

  if (elapsedMinutes < 1) return "Edited just now";
  if (elapsedMinutes < 60)
    return `Edited ${elapsedMinutes} minute${elapsedMinutes === 1 ? "" : "s"} ago`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `Edited ${elapsedHours} hour${elapsedHours === 1 ? "" : "s"} ago`;

  const elapsedDays = Math.floor(elapsedHours / 24);
  return `Edited ${elapsedDays} day${elapsedDays === 1 ? "" : "s"} ago`;
}
