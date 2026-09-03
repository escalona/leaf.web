/**
 * The export panel's format and scale, shared with every other export entry
 * point. The Cmd/Ctrl+Shift+E shortcut and the context menu run without the
 * panel's React state in reach, so the panel publishes its choices here and
 * they read the same values back — one preference, three ways in.
 *
 * Module-level rather than per-document: like the panel's own state, the
 * choice is a user preference that follows them between selections.
 */
import type { ExportOptions } from "./export-options";

const DEFAULT_PREFERENCES: ExportOptions = { format: "png", scale: 2 };

let preferences: ExportOptions = DEFAULT_PREFERENCES;
const listeners = new Set<() => void>();

export function getExportPreferences(): ExportOptions {
  return preferences;
}

export function setExportPreferences(next: Partial<ExportOptions>): void {
  const merged: ExportOptions = { ...preferences, ...next };
  if (merged.format === preferences.format && merged.scale === preferences.scale) return;
  preferences = merged;
  for (const listener of listeners) listener();
}

export function subscribeToExportPreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetExportPreferencesForTests(): void {
  preferences = DEFAULT_PREFERENCES;
  listeners.clear();
}
