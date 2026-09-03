/**
 * Renderer startup signposts as `performance` marks. They cost nothing when
 * nobody reads them; a launch harness reads them over the DevTools protocol
 * to place first paint, session restore, directory load, and the dashboard's
 * first frame on one timeline with the main process's own marks.
 */
export function markStartup(name: string) {
  if (typeof performance === "undefined" || typeof performance.mark !== "function") return;
  try {
    performance.mark(`leaf:${name}`);
  } catch {
    // A duplicate or unsupported mark must never affect startup itself.
  }
}
