/**
 * Frame stepping for remote collaborator cursors.
 *
 * Presence packets arrive at the network cadence (~30fps on the fast lane,
 * slower under budget pressure), so applying them raw makes peer cursors hop
 * between samples. Positions instead ease toward the latest network target
 * each animation frame with an exponential approach, and the caller writes the
 * resulting transform straight to the DOM so cursor motion never re-renders
 * React trees.
 */

export interface RemoteCursorSample {
  x: number;
  y: number;
}

interface RemoteCursorSpring {
  x: number;
  y: number;
  targetX: number;
  targetY: number;
}

/** Time for a cursor to close ~63% of its remaining distance to the target. */
const SMOOTHING_TIME_CONSTANT_MS = 80;
/** On-screen jumps larger than this are teleports (tab focus, page hops) and snap. */
const SNAP_DISTANCE_SCREEN_PX = 500;
/** Below this on-screen distance the cursor lands exactly on the target. */
const SETTLE_DISTANCE_SCREEN_PX = 0.25;

export class RemoteCursorInterpolator {
  private cursors = new Map<string, RemoteCursorSpring>();

  /**
   * Points the session's cursor at a new network sample. Coordinates are
   * canvas-space. Returns whether the sample changed anything, so callers can
   * skip repaint work when a re-render delivers an unchanged target.
   */
  setTarget(sessionId: string, target: RemoteCursorSample, zoom: number): boolean {
    const cursor = this.cursors.get(sessionId);
    if (!cursor) {
      this.cursors.set(sessionId, {
        x: target.x,
        y: target.y,
        targetX: target.x,
        targetY: target.y,
      });
      return true;
    }
    if (cursor.targetX === target.x && cursor.targetY === target.y) return false;
    // Teleport detection compares consecutive network samples, not the eased
    // position: lag grows with pointer speed and screen distance grows with
    // zoom, so a lag-based check could snap mid-glide on a local zoom-in even
    // though the remote pointer never jumped.
    const jump = Math.hypot(target.x - cursor.targetX, target.y - cursor.targetY) * zoom;
    cursor.targetX = target.x;
    cursor.targetY = target.y;
    if (jump > SNAP_DISTANCE_SCREEN_PX) {
      cursor.x = target.x;
      cursor.y = target.y;
    }
    return true;
  }

  /** Drops sessions that are no longer live so departed peers stop animating. */
  prune(liveSessionIds: ReadonlySet<string>) {
    for (const sessionId of this.cursors.keys()) {
      if (!liveSessionIds.has(sessionId)) this.cursors.delete(sessionId);
    }
  }

  positionOf(sessionId: string): RemoteCursorSample | null {
    const cursor = this.cursors.get(sessionId);
    return cursor ? { x: cursor.x, y: cursor.y } : null;
  }

  /** Advances every cursor one frame. Returns true while any cursor is still gliding. */
  step(dtMs: number, zoom: number): boolean {
    const alpha = 1 - Math.exp(-Math.max(0, dtMs) / SMOOTHING_TIME_CONSTANT_MS);
    let moving = false;
    for (const cursor of this.cursors.values()) {
      const dx = cursor.targetX - cursor.x;
      const dy = cursor.targetY - cursor.y;
      if (Math.hypot(dx, dy) * zoom <= SETTLE_DISTANCE_SCREEN_PX) {
        cursor.x = cursor.targetX;
        cursor.y = cursor.targetY;
        continue;
      }
      cursor.x += dx * alpha;
      cursor.y += dy * alpha;
      moving = true;
    }
    return moving;
  }
}
