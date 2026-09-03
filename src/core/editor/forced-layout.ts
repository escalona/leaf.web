/**
 * Measurement helper for nodes inside `content-visibility: auto` subtrees.
 *
 * Frames whose CSS already clips descendant paint (artboards by default, plus
 * frames with authored clipping overflow) render with `content-visibility:
 * auto` so far-offscreen content skips layout; non-clipping frames stay
 * containment-free so the canvas paints the overflow the model says is
 * visible. Skipped subtrees report collapsed geometry (0-height
 * boxes, or border-only heights) from offsetWidth/offsetHeight and
 * getBoundingClientRect, which corrupts MCP reads and document-script
 * getNodeBounds.
 *
 * The fix is batched, not per-element: a measuring attribute on the viewport
 * root activates a global.css rule that forces `content-visibility: visible`
 * for every node while the synchronous callback runs. Per-element inline
 * toggling is deliberately avoided — restoring one element's `auto` invalidates
 * the skip state of its neighbors, and `checkVisibility()` answers stale
 * values until the next rendering step, which made interleaved reads racy.
 */

export const LEAF_MEASURING_ATTRIBUTE = "data-leaf-measuring";

/**
 * Run `measure` with layout forced current for the whole viewport containing
 * `scope` (or the document when no viewport root exists). Reads inside the
 * callback (offsetWidth, getBoundingClientRect, …) see fully laid out
 * geometry. Re-entrant calls reuse the active measuring window.
 */
export function measureWithVisibleLayout<T>(scope: HTMLElement | Document, measure: () => T): T {
  const doc = scope instanceof Document ? scope : scope.ownerDocument;
  const root =
    (scope instanceof Document ? null : scope.closest<HTMLElement>("[data-viewport]")) ??
    doc.querySelector<HTMLElement>("[data-viewport]") ??
    doc.documentElement;

  if (root.hasAttribute(LEAF_MEASURING_ATTRIBUTE)) return measure();

  root.setAttribute(LEAF_MEASURING_ATTRIBUTE, "");
  try {
    return measure();
  } finally {
    root.removeAttribute(LEAF_MEASURING_ATTRIBUTE);
  }
}
