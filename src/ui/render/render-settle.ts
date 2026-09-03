/**
 * Bounded render-settle waits shared by MCP measurement, mutation, screenshot,
 * and render-replica paths.
 *
 * Settling never truly requires a painted frame: React commits flush through
 * MessageChannel scheduler messages (which browsers never throttle, hidden or
 * visible) and forced-layout reads compute synchronously. Waiting on real
 * animation frames instead couples every settle to vsync (~16.7ms per frame in
 * a visible window) and hangs entirely in hidden/occluded windows, where
 * browsers pause `requestAnimationFrame` and throttle timers to
 * seconds-or-minutes granularity.
 *
 * So every window settles the same way: MessageChannel round-trip yields that
 * interleave with — and therefore wait out — the scheduler's pending commit
 * work before measurement proceeds, costing microseconds when the queue is
 * idle. rAF (bounded by a short timer) and a zero timeout remain only as
 * fallbacks for environments without MessageChannel. Every MCP call returns in
 * bounded time, degrading to explicit unmounted-node reporting instead of
 * hanging until the tab is foregrounded.
 */

/** Upper bound for one settle frame when rAF is paused in a visible window. */
const FRAME_FALLBACK_TIMEOUT_MS = 100;

/**
 * Scheduler yields substituted for one frame. Each round-trip lets at least
 * one pending scheduler chunk run and costs microseconds when the queue is
 * idle.
 */
const FRAME_SCHEDULER_YIELDS = 25;

/**
 * One channel serves a whole settle (constructing a fresh MessageChannel per
 * round-trip showed up as measurable native time in foreground profiles), but
 * each settle still opens its own: message ordering across distinct ports is
 * not spec-guaranteed, so a single long-lived port could let an environment
 * drain our yield burst without servicing the scheduler ports the settle
 * exists to wait out.
 */
async function waitForSchedulerSettle() {
  const channel = new MessageChannel();
  let deliver: (() => void) | null = null;
  channel.port1.onmessage = () => deliver?.();
  try {
    for (let round = 0; round < FRAME_SCHEDULER_YIELDS; round += 1) {
      await new Promise<void>((resolve) => {
        deliver = resolve;
        channel.port2.postMessage(null);
      });
    }
  } finally {
    channel.port1.close();
  }
}

function waitForVisibleAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const frameId = requestAnimationFrame(() => {
      if (settled) return;
      settled = true;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      resolve();
    });
    timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frameId);
      resolve();
    }, FRAME_FALLBACK_TIMEOUT_MS);
  });
}

function waitForAnimationFrame(): Promise<void> {
  if (typeof MessageChannel === "function") {
    return waitForSchedulerSettle();
  }
  if (typeof requestAnimationFrame !== "function") {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  return waitForVisibleAnimationFrame();
}

export async function waitForAnimationFrames(count: number) {
  for (let index = 0; index < count; index += 1) {
    await waitForAnimationFrame();
  }
}

/**
 * Wait for one real painted frame when the window is visible, bounded by the
 * frame fallback timeout. Scheduler yields settle React commits but never
 * span a vsync, so requestAnimationFrame-STAGED work — a document script
 * drawing to a canvas on its next rAF tick — has not run when a settle
 * resolves. Canvas pixel capture calls this first so it reads post-draw
 * pixels; hidden windows (rAF paused) skip it and keep bounded-time capture
 * with the existing retained-pixel warnings.
 */
export async function waitForPaintedFrameIfVisible() {
  if (typeof document === "undefined" || document.visibilityState !== "visible") return;
  if (typeof requestAnimationFrame !== "function") return;
  await waitForVisibleAnimationFrame();
}

/** Bound browser readiness work that may otherwise wait forever on a resource event. */
export async function withRenderSettleTimeout<T>(
  readiness: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      readiness,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
