/**
 * How many shader surfaces may hold a WebGL context at once.
 *
 * Browsers cap live WebGL contexts per process — around sixteen in Chrome — and
 * silently drop the oldest past the cap, which paints a crashed-canvas icon
 * over the node instead of a shader. A board of thirty shaders reproduces this
 * immediately, so Leaf decides which ones are live rather than letting the
 * browser evict them arbitrarily. The rest keep their palette placeholder,
 * which is a far better failure than a broken canvas.
 *
 * The budget sits below the browser cap to leave contexts for screenshot
 * capture and document-script canvases.
 */
export const MAX_LIVE_SHADER_SURFACES = 8;

const holders = new Set<string>();
const waiters = new Set<() => void>();

/** Take a slot for `id`, or report that the budget is spent. */
export function requestSurfaceSlot(id: string): boolean {
  if (holders.has(id)) return true;
  if (holders.size >= MAX_LIVE_SHADER_SURFACES) return false;
  holders.add(id);
  return true;
}

/** Give a slot back and let whoever is waiting take it. */
export function releaseSurfaceSlot(id: string): void {
  if (!holders.delete(id)) return;
  // Snapshot first: a woken waiter may unsubscribe as it takes the slot.
  const woken = Array.from(waiters);
  for (const notify of woken) notify();
}

export function subscribeToSurfaceSlots(notify: () => void): () => void {
  waiters.add(notify);
  return () => {
    waiters.delete(notify);
  };
}

export function liveSurfaceCount(): number {
  return holders.size;
}

/** Test-only reset; nothing in the app drops every surface at once. */
export function resetSurfaceBudget(): void {
  holders.clear();
  waiters.clear();
}
