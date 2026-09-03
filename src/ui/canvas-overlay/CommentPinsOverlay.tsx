/**
 * Comment pins: the canvas-facing half of the comment lane.
 *
 * Follows the ArtboardLabels pattern — a pointer-transparent container, an
 * inner camera div whose transform is written imperatively so pan/zoom never
 * re-renders the pin list, and zero-sized counter-scaled anchors whose children
 * lay out in screen pixels. Interactive elements carry `data-overlay-ui` so the
 * viewport's pointer pipeline leaves them alone, and `data-comment-ui` so the
 * click-outside handler can tell comment surfaces from canvas.
 *
 * Three marker mechanisms cover the ways pins pile up:
 * - Nearby pins fold into a count badge at low zoom (greedy screen-distance
 *   fold with hysteresis); clicking the badge zooms just far enough to split.
 * - COINCIDENT pins — the same quantized canvas point, which no zoom can
 *   separate — render as a stack whose click opens a cascading card list.
 * - Hovering any closed marker opens a live preview panel after a short
 *   delay; one shared hovered-marker id keeps previews mutually exclusive.
 *
 * Pins are draggable to re-anchor: past a 4px threshold the pin translates by
 * the cursor delta (grab offset preserved), and release re-anchors — a node
 * under the cursor wins, a region translates, anywhere else becomes a point.
 */
import { observer } from "mobx-react-lite";
import { reaction, untracked } from "mobx";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { CheckIcon } from "../icons";
import type { LeafCommentThreadRecord } from "../../core/shared/collaboration";
import { useEditorStore, type EditorStore } from "../../core/state/EditorStore";
import {
  pageThreads,
  threadComments,
  threadHasUnread,
  threadMatchesFilters,
  moveThreadAnchor,
} from "../../core/editor/comment-actions";
import type { RegionAnchorRect } from "../../core/editor/comment-anchor-math";
import { mentionRoster, type MentionMember } from "../../core/editor/comment-mentions";
import {
  commentAnchorForCanvasPoint,
  commentAnchorTargetAtPoint,
  resolveCommentAnchorCanvasPoint,
  type CanvasXY,
} from "./comment-pin-geometry";
import {
  CommentBodyText,
  CommentDraftComposer,
  CommentThreadPopover,
  commentAuthorLabel,
  formatCommentTime,
  useEdgeClampedPlacement,
} from "./CommentThreadPopover";
import { FONT_STACK } from "../floating-styles";

const PIN_SIZE = 28;
const PIN_SCALE_VARIABLE = "--leaf-comment-pin-scale";
/** Screen px between two rendered pins below which they fold into a badge. */
const CLUSTER_FOLD_PX = PIN_SIZE;
/** Unfold threshold; the gap above FOLD is the hysteresis dead zone. */
const CLUSTER_UNFOLD_PX = PIN_SIZE * 1.3;
/** Landing zoom overshoots the unfold threshold so the split is decisive. */
const CLUSTER_SPLIT_OVERSHOOT = 1.05;
const CAMERA_ANIMATION_MS = 300;
/**
 * Coincident-pin quantum in canvas units — only absorbs float noise. Keyed on
 * the canvas point, not screen position, so camera moves never recompute it.
 */
const PIN_STACK_QUANTUM = 0.1;
const PREVIEW_OPEN_DELAY_MS = 180;
const PREVIEW_CLOSE_DELAY_MS = 220;
const PREVIEW_MAX_THREADS = 5;
const DRAG_THRESHOLD_PX = 4;

type PositionedThread = { thread: LeafCommentThreadRecord; point: CanvasXY };

type PinCluster = { members: PositionedThread[]; centroid: CanvasXY };

export function pinStackKey(point: CanvasXY): string {
  return `${Math.round(point.x / PIN_STACK_QUANTUM)}:${Math.round(point.y / PIN_STACK_QUANTUM)}`;
}

/**
 * Greedy fold over canvas-space positions priced in screen pixels. Threads are
 * visited oldest-first so cluster identity is stable as new comments land.
 */
function clusterThreads(
  entries: readonly PositionedThread[],
  zoom: number,
  foldPx: number,
): PinCluster[] {
  const clusters: PinCluster[] = [];
  for (const entry of entries) {
    let nearest: PinCluster | null = null;
    let nearestDistance = Infinity;
    for (const cluster of clusters) {
      const dx = (cluster.centroid.x - entry.point.x) * zoom;
      const dy = (cluster.centroid.y - entry.point.y) * zoom;
      const distance = Math.hypot(dx, dy);
      if (distance < nearestDistance) {
        nearest = cluster;
        nearestDistance = distance;
      }
    }
    if (nearest && nearestDistance <= foldPx) {
      nearest.members.push(entry);
      const count = nearest.members.length;
      nearest.centroid = {
        x: nearest.centroid.x + (entry.point.x - nearest.centroid.x) / count,
        y: nearest.centroid.y + (entry.point.y - nearest.centroid.y) / count,
      };
    } else {
      clusters.push({ members: [entry], centroid: { ...entry.point } });
    }
  }
  return clusters;
}

/** Zoom at which a cluster's closest pair sits `CLUSTER_UNFOLD_PX` apart. */
function clusterSplitZoom(cluster: PinCluster): number | null {
  let minCanvasDistance = Infinity;
  for (let i = 0; i < cluster.members.length; i += 1) {
    for (let j = i + 1; j < cluster.members.length; j += 1) {
      const a = cluster.members[i]!.point;
      const b = cluster.members[j]!.point;
      minCanvasDistance = Math.min(minCanvasDistance, Math.hypot(a.x - b.x, a.y - b.y));
    }
  }
  if (!Number.isFinite(minCanvasDistance) || minCanvasDistance <= 0) return null;
  return (CLUSTER_UNFOLD_PX / minCanvasDistance) * CLUSTER_SPLIT_OVERSHOOT;
}

/** Eased camera move that centers `point` at `zoom`. */
export function flyCameraTo(store: EditorStore, point: CanvasXY, zoom: number): void {
  const target = {
    zoom,
    panX: store.viewportWidth / 2 - point.x * zoom,
    panY: store.viewportHeight / 2 - point.y * zoom,
  };
  const from = { zoom: store.zoom, panX: store.panX, panY: store.panY };
  const startedAt = performance.now();
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    store.setViewport(target);
  };
  const step = (now: number) => {
    if (settled) return;
    const t = Math.min(1, (now - startedAt) / CAMERA_ANIMATION_MS);
    if (t >= 1) {
      finish();
      return;
    }
    const ease = 1 - (1 - t) ** 3;
    store.setViewport({
      zoom: from.zoom + (target.zoom - from.zoom) * ease,
      panX: from.panX + (target.panX - from.panX) * ease,
      panY: from.panY + (target.panY - from.panY) * ease,
    });
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  // rAF stalls in hidden or throttled documents; the camera must still land.
  setTimeout(finish, CAMERA_ANIMATION_MS + 80);
}

/** Fly to a thread's pin, zooming just far enough to pop it out of a fold. */
export function revealCommentThread(store: EditorStore, threadId: string): void {
  const record = store.commentRecords.get(threadId);
  const thread = record?.kind === "thread" ? record : null;
  if (!thread) return;
  if (thread.pageId !== store.activePageId) store.setActivePage(thread.pageId);
  const point = resolveCommentAnchorCanvasPoint(store, thread.anchor, null);
  if (!point) {
    store.setOpenCommentThread(threadId);
    return;
  }
  const entries = positionThreads(store, pageThreads(store, thread.pageId), null);
  const cluster = clusterThreads(entries, store.zoom, CLUSTER_FOLD_PX).find((candidate) =>
    candidate.members.some((member) => member.thread.id === threadId),
  );
  const splitZoom = cluster && cluster.members.length > 1 ? clusterSplitZoom(cluster) : null;
  flyCameraTo(store, point, Math.max(store.zoom, splitZoom ?? store.zoom));
  store.setOpenCommentThread(threadId);
}

function positionThreads(
  store: EditorStore,
  threads: readonly LeafCommentThreadRecord[],
  viewportEl: Element | null,
): PositionedThread[] {
  const positioned: PositionedThread[] = [];
  for (const thread of threads) {
    const point = resolveCommentAnchorCanvasPoint(store, thread.anchor, viewportEl);
    if (point) positioned.push({ thread, point });
  }
  // Oldest-first keeps greedy cluster identity stable as threads come and go.
  return positioned.sort(
    (a, b) => a.thread.createdAt - b.thread.createdAt || a.thread.id.localeCompare(b.thread.id),
  );
}

/**
 * Shared hover-preview timing: one open timer, one close timer, and the
 * store's single hovered-marker id so previews are mutually exclusive. The
 * close delay is long enough for the pointer to cross into the panel, whose
 * own enter handler re-asserts the marker.
 */
function useMarkerPreview(store: EditorStore, markerId: string) {
  const timers = useRef<{ open: number | null; close: number | null }>({
    open: null,
    close: null,
  });
  useEffect(
    () => () => {
      if (timers.current.open !== null) window.clearTimeout(timers.current.open);
      if (timers.current.close !== null) window.clearTimeout(timers.current.close);
    },
    [],
  );
  const onPointerEnter = () => {
    if (timers.current.close !== null) window.clearTimeout(timers.current.close);
    if (store.hoveredCommentMarkerId === markerId) return;
    timers.current.open = window.setTimeout(
      () => store.setHoveredCommentMarker(markerId),
      PREVIEW_OPEN_DELAY_MS,
    );
  };
  const onPointerLeave = () => {
    if (timers.current.open !== null) window.clearTimeout(timers.current.open);
    timers.current.close = window.setTimeout(() => {
      if (store.hoveredCommentMarkerId === markerId) store.setHoveredCommentMarker(null);
    }, PREVIEW_CLOSE_DELAY_MS);
  };
  /** Immediate teardown for gestures a preview must not interrupt. */
  const cancel = () => {
    if (timers.current.open !== null) window.clearTimeout(timers.current.open);
    if (timers.current.close !== null) window.clearTimeout(timers.current.close);
    if (store.hoveredCommentMarkerId === markerId) store.setHoveredCommentMarker(null);
  };
  return { onPointerEnter, onPointerLeave, cancel };
}

/** One thread's card inside a preview or stack list. */
const ThreadPreviewCard = observer(
  ({ thread, onSelect }: { thread: LeafCommentThreadRecord; onSelect?: () => void }) => {
    const store = useEditorStore();
    const comments = threadComments(store, thread.id);
    const first = comments[0];
    return (
      <div
        role={onSelect ? "button" : undefined}
        tabIndex={onSelect ? 0 : undefined}
        onClick={onSelect}
        onKeyDown={onSelect ? (event) => event.key === "Enter" && onSelect() : undefined}
        style={{ ...PREVIEW_CARD_STYLE }}
      >
        <div style={PREVIEW_CARD_HEAD_STYLE}>
          <span style={{ fontWeight: 600 }}>
            {commentAuthorLabel(store, thread.createdBy, thread.createdByName)}
          </span>
          <span style={{ color: "var(--leaf-text-muted)" }}>
            {first ? formatCommentTime(first.createdAt) : ""}
            {comments.length > 1
              ? ` · ${comments.length - 1} ${comments.length === 2 ? "reply" : "replies"}`
              : ""}
          </span>
        </div>
        {first && (
          <div style={PREVIEW_CARD_BODY_STYLE}>
            <CommentBodyText body={first.body} interactive={false} />
          </div>
        )}
      </div>
    );
  },
);

/** The live preview panel next to a hovered marker. */
const MarkerPreviewPanel = observer(
  ({
    threads,
    onEnter,
    onLeave,
    onSelect,
  }: {
    threads: LeafCommentThreadRecord[];
    onEnter: () => void;
    onLeave: () => void;
    onSelect: (threadId: string) => void;
  }) => {
    const rootRef = useEdgeClampedPlacement<HTMLDivElement>([threads.length]);
    const shown = threads.slice(0, PREVIEW_MAX_THREADS);
    return (
      <div
        ref={rootRef}
        data-overlay-ui=""
        data-comment-ui=""
        data-comment-preview=""
        onPointerEnter={onEnter}
        onPointerLeave={onLeave}
        style={PREVIEW_PANEL_STYLE}
      >
        {shown.map((thread) => (
          <ThreadPreviewCard key={thread.id} thread={thread} onSelect={() => onSelect(thread.id)} />
        ))}
        {threads.length > shown.length && (
          <div style={PREVIEW_MORE_STYLE}>+{threads.length - shown.length} more</div>
        )}
      </div>
    );
  },
);

/** Dashed region rectangle, drawn in canvas units with a zoom-constant stroke. */
function CommentRegionBox({ region }: { region: RegionAnchorRect }) {
  return (
    <div
      data-comment-region=""
      style={{
        position: "absolute",
        left: region.x,
        top: region.y,
        width: region.w,
        height: region.h,
        border: `calc(var(${PIN_SCALE_VARIABLE}, 1) * 1.5px) dashed var(--leaf-accent)`,
        borderRadius: `calc(var(${PIN_SCALE_VARIABLE}, 1) * 4px)`,
        background: "color-mix(in srgb, var(--leaf-accent) 6%, transparent)",
        pointerEvents: "none",
      }}
    />
  );
}

/**
 * Three corner resize handles for an open region thread — every corner except
 * the pin's own, which is the move handle (the pin itself). Each handle spans
 * from its FIXED opposite corner to the cursor, normalized so dragging past
 * it flips.
 */
const RegionResizeHandles = observer(({ thread }: { thread: LeafCommentThreadRecord }) => {
  const store = useEditorStore();
  const [preview, setPreview] = useState<RegionAnchorRect | null>(null);
  const activeResizeCleanupRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      activeResizeCleanupRef.current?.();
      activeResizeCleanupRef.current = null;
    },
    [],
  );
  if (thread.anchor.type !== "region") return null;
  const anchor = thread.anchor;
  const region = preview ?? anchor;
  const corners = (
    [
      { cx: 0, cy: 0 },
      { cx: 1, cy: 0 },
      { cx: 0, cy: 1 },
      { cx: 1, cy: 1 },
    ] as const
  ).filter((corner) => corner.cx !== anchor.pinX || corner.cy !== anchor.pinY);

  const startResize = (corner: { cx: number; cy: number }) => (event: ReactPointerEvent) => {
    event.stopPropagation();
    event.preventDefault();
    activeResizeCleanupRef.current?.();
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // Window-level listeners below carry the gesture regardless.
    }
    // The box at pointer-down is captured so the live preview reflowing the
    // rendered rect cannot move the fixed edges mid-drag.
    const base = { x: anchor.x, y: anchor.y, w: anchor.w, h: anchor.h };
    const fixed = {
      x: base.x + (1 - corner.cx) * base.w,
      y: base.y + (1 - corner.cy) * base.h,
    };
    let last: RegionAnchorRect = base;
    const toCanvas = (client: { clientX: number; clientY: number }): CanvasXY => {
      const viewport = document.querySelector("[data-viewport]");
      const rect = viewport?.getBoundingClientRect();
      const left = rect?.left ?? 0;
      const top = rect?.top ?? 0;
      return {
        x: (client.clientX - left - store.panX) / store.zoom,
        y: (client.clientY - top - store.panY) / store.zoom,
      };
    };
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      const cursor = toCanvas(move);
      last = {
        x: Math.min(fixed.x, cursor.x),
        y: Math.min(fixed.y, cursor.y),
        w: Math.abs(cursor.x - fixed.x),
        h: Math.abs(cursor.y - fixed.y),
      };
      setPreview(last);
    };
    const removeListeners = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      window.removeEventListener("keydown", onEscape, true);
      if (activeResizeCleanupRef.current === removeListeners) {
        activeResizeCleanupRef.current = null;
      }
    };
    const onUp = (up: PointerEvent) => {
      if (up.pointerId !== pointerId) return;
      removeListeners();
      setPreview(null);
      moveThreadAnchor(store, thread.id, { ...anchor, ...last });
    };
    const onCancel = (cancel: PointerEvent) => {
      if (cancel.pointerId !== pointerId) return;
      removeListeners();
      setPreview(null);
    };
    const onEscape = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== "Escape") return;
      keyEvent.preventDefault();
      keyEvent.stopImmediatePropagation();
      removeListeners();
      setPreview(null);
      try {
        target.releasePointerCapture(pointerId);
      } catch {
        // Unsupported or already-ended capture; removing the listeners cancels the resize.
      }
    };
    activeResizeCleanupRef.current = removeListeners;
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    window.addEventListener("keydown", onEscape, true);
  };

  return (
    <>
      {preview && <CommentRegionBox region={preview} />}
      {corners.map((corner) => (
        <div
          key={`${corner.cx}-${corner.cy}`}
          style={{
            ...ANCHOR_STYLE,
            left: region.x + corner.cx * region.w,
            top: region.y + corner.cy * region.h,
          }}
        >
          <div
            data-overlay-ui=""
            data-comment-ui=""
            data-comment-region-handle=""
            onPointerDown={startResize(corner)}
            style={REGION_HANDLE_STYLE}
          />
        </div>
      ))}
    </>
  );
});

type PinDragState = {
  pointerId: number;
  target: HTMLButtonElement;
  startClient: { x: number; y: number };
  dragging: boolean;
  /** Screen-pixel delta from the grab point; converted to canvas on commit. */
  deltaPx: { x: number; y: number };
};

/**
 * One pin and (when open) its thread popover, anchored at its own live
 * position. Each pin tracks its anchor independently so a node drag
 * re-renders exactly this pin — the same per-frame pipeline the dragged
 * element renders through — instead of re-clustering the whole overlay.
 * During the pin's own drag the translate is written imperatively in screen
 * pixels, so the pin rides the cursor at any zoom.
 */
const CommentPinAnchor = observer(
  ({
    thread: threadProp,
    fallbackPoint,
    open,
    mentionRoster: roster = [],
  }: {
    thread: LeafCommentThreadRecord;
    fallbackPoint: CanvasXY;
    open: boolean;
    mentionRoster?: MentionMember[];
  }) => {
    const store = useEditorStore();
    const anchorRef = useRef<HTMLDivElement | null>(null);
    // Re-read the live record: the overlay body deliberately does not track
    // anchors or geometry, so this component must.
    const record = store.commentRecords.get(threadProp.id);
    const thread = record?.kind === "thread" ? record : threadProp;
    const point =
      resolveCommentAnchorCanvasPoint(
        store,
        thread.anchor,
        document.querySelector("[data-viewport]"),
      ) ?? fallbackPoint;
    // The gesture lives in a ref so a pointerup in the same frame as its
    // pointerdown still sees it.
    const dragRef = useRef<PinDragState | null>(null);
    const preview = useMarkerPreview(store, `pin:${thread.id}`);
    const resolved = thread.resolvedAt !== null;
    const unread = threadHasUnread(store, thread.id);
    const label = commentAuthorLabel(store, thread.createdBy, thread.createdByName);
    const count = threadComments(store, thread.id).length;

    const applyDragTransform = useCallback(() => {
      const drag = dragRef.current;
      const element = anchorRef.current;
      if (!element) return;
      element.style.transform =
        drag?.dragging === true
          ? `scale(var(${PIN_SCALE_VARIABLE}, 1)) translate(${drag.deltaPx.x}px, ${drag.deltaPx.y}px)`
          : `scale(var(${PIN_SCALE_VARIABLE}, 1))`;
    }, []);
    // A re-render mid-drag re-writes the style prop; put the drag translate back.
    useLayoutEffect(applyDragTransform);
    useEffect(() => {
      const onEscape = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        const drag = dragRef.current;
        if (!drag) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        dragRef.current = null;
        try {
          drag.target.releasePointerCapture(drag.pointerId);
        } catch {
          // Unsupported or already-ended capture; clearing the drag is enough.
        }
        applyDragTransform();
      };
      window.addEventListener("keydown", onEscape, true);
      return () => window.removeEventListener("keydown", onEscape, true);
    }, [applyDragTransform]);

    // Node-anchored pins on DOM-measured geometry (flow children of imported
    // HTML, flex layouts) have no observable position to track: MobX cannot
    // see getBoundingClientRect. While any drag is in flight, follow the DOM
    // per frame — the element the user is watching is the ground truth — and
    // write the position imperatively, RemoteCursors-style. Store-backed
    // geometry gets the same values it would from the reactive render, so one
    // code path covers every anchor.
    useLayoutEffect(() => {
      let frameHandle: number | null = null;
      const stop = () => {
        if (frameHandle !== null) cancelAnimationFrame(frameHandle);
        frameHandle = null;
      };
      let measureQueued = false;
      let active = false;
      const measure = () => {
        // The pin's own drag owns its transform; do not fight it.
        if (dragRef.current?.dragging) return;
        const element = anchorRef.current;
        if (!element) return;
        const livePoint = untracked(() => {
          const current = store.commentRecords.get(thread.id);
          const anchor = current?.kind === "thread" ? current.anchor : thread.anchor;
          if (anchor.type !== "node") return null;
          return resolveCommentAnchorCanvasPoint(
            store,
            anchor,
            document.querySelector("[data-viewport]"),
          );
        });
        if (!livePoint) return;
        element.style.left = `${livePoint.x}px`;
        element.style.top = `${livePoint.y}px`;
      };
      // Each drag pointermove schedules one post-commit measurement (a
      // MessageChannel tick lands after the move's synchronous store commit
      // and layout, and unlike rAF is never throttled); the rAF loop covers
      // motion with no local pointer, like a peer's remote drag.
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        measureQueued = false;
        if (active) measure();
      };
      const onDragPointerMove = () => {
        if (measureQueued) return;
        measureQueued = true;
        channel.port2.postMessage(0);
      };
      const frame = () => {
        // A cancelled-but-already-queued frame must not measure or respawn.
        if (!active) return;
        frameHandle = requestAnimationFrame(frame);
        measure();
      };
      const dispose = reaction(
        () => store.dragCanvasOffset.size > 0 || store.remoteDragPreviews.size > 0,
        (dragActive) => {
          stop();
          window.removeEventListener("pointermove", onDragPointerMove, true);
          active = dragActive;
          if (!dragActive) return;
          window.addEventListener("pointermove", onDragPointerMove, true);
          frameHandle = requestAnimationFrame(frame);
        },
        { fireImmediately: true },
      );
      return () => {
        active = false;
        dispose();
        stop();
        window.removeEventListener("pointermove", onDragPointerMove, true);
        channel.port1.close();
      };
    }, [store, thread.id, thread.anchor]);

    const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      if (event.button !== 0) return;
      // Pressing a pin is never a hover; a preview opening mid-drag would
      // fight the gesture.
      preview.cancel();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // A stale or synthetic pointer id cannot be captured; the drag still
        // works through the button's own move/up handlers while hovered.
      }
      dragRef.current = {
        pointerId: event.pointerId,
        target: event.currentTarget,
        startClient: { x: event.clientX, y: event.clientY },
        dragging: false,
        deltaPx: { x: 0, y: 0 },
      };
    };
    const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const dxPx = event.clientX - drag.startClient.x;
      const dyPx = event.clientY - drag.startClient.y;
      if (!drag.dragging && Math.hypot(dxPx, dyPx) < DRAG_THRESHOLD_PX) return;
      drag.dragging = true;
      drag.deltaPx = { x: dxPx, y: dyPx };
      applyDragTransform();
    };
    const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const wasDragging = drag.dragging;
      const deltaPx = drag.deltaPx;
      dragRef.current = null;
      applyDragTransform();
      if (!wasDragging) {
        store.setOpenCommentThread(open ? null : thread.id);
        return;
      }
      const delta = { x: deltaPx.x / store.zoom, y: deltaPx.y / store.zoom };
      if (thread.anchor.type === "region") {
        moveThreadAnchor(store, thread.id, {
          ...thread.anchor,
          x: thread.anchor.x + delta.x,
          y: thread.anchor.y + delta.y,
        });
        return;
      }
      const released = { x: point.x + delta.x, y: point.y + delta.y };
      // The drop target is whatever sits under the CURSOR (resolved by the
      // same rule tool placement uses), but the anchor is the translated pin
      // point — the grab offset is preserved.
      const target = commentAnchorTargetAtPoint(store, event.clientX, event.clientY);
      moveThreadAnchor(
        store,
        thread.id,
        commentAnchorForCanvasPoint(
          store,
          target,
          released,
          document.querySelector("[data-viewport]"),
        ),
      );
    };
    const onPointerCancel = () => {
      // Abort outright: no commit, no toggle; the pin snaps back.
      dragRef.current = null;
      applyDragTransform();
    };

    return (
      <div
        ref={anchorRef}
        style={{
          ...ANCHOR_STYLE,
          left: point.x,
          top: point.y,
          zIndex: open ? 1 : undefined,
        }}
      >
        <button
          type="button"
          data-overlay-ui=""
          data-comment-ui=""
          data-comment-pin={thread.id}
          aria-label={`${resolved ? "Resolved comment" : "Comment"} by ${label}${count > 1 ? `, ${count} messages` : ""}`}
          title={`${label}${count > 1 ? ` · ${count}` : ""}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onPointerEnter={open ? undefined : preview.onPointerEnter}
          onPointerLeave={open ? undefined : preview.onPointerLeave}
          onClick={(event) => event.stopPropagation()}
          style={{
            ...PIN_STYLE,
            background: resolved ? "var(--leaf-surface-sunken)" : "var(--leaf-surface)",
            borderColor: open
              ? "var(--leaf-accent)"
              : resolved
                ? "var(--leaf-border-strong)"
                : "var(--leaf-accent)",
            opacity: resolved && !open ? 0.75 : 1,
          }}
        >
          {resolved && <CheckIcon size={12} style={{ color: "var(--leaf-text-muted)" }} />}
          {unread && !resolved && <span style={UNREAD_DOT_STYLE} />}
        </button>
        {open && (
          <div style={POPOVER_ANCHOR_STYLE}>
            <CommentThreadPopover thread={thread} mentionRoster={roster} />
          </div>
        )}
      </div>
    );
  },
);

/** A stack of coincident pins: count badge → cascading card list. */
const CommentStack = observer(
  ({
    stackKey,
    members,
    mentionRoster: roster = [],
  }: {
    stackKey: string;
    members: PositionedThread[];
    mentionRoster?: MentionMember[];
  }) => {
    const store = useEditorStore();
    const open = store.openCommentStackKey === stackKey;
    const preview = useMarkerPreview(store, `stack:${stackKey}`);
    const unread = members.some((member) => threadHasUnread(store, member.thread.id));
    const listRef = useEdgeClampedPlacement<HTMLDivElement>([open, members.length]);
    return (
      <>
        <button
          type="button"
          data-overlay-ui=""
          data-comment-ui=""
          data-comment-stack={stackKey}
          aria-label={`${members.length} comments here`}
          title={`${members.length} comments`}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerEnter={open ? undefined : preview.onPointerEnter}
          onPointerLeave={open ? undefined : preview.onPointerLeave}
          onClick={(event) => {
            event.stopPropagation();
            store.setOpenCommentStack(open ? null : stackKey);
          }}
          style={{ ...PIN_STYLE, ...BADGE_STYLE, borderColor: "var(--leaf-accent)" }}
        >
          {members.length}
          {unread && <span style={UNREAD_DOT_STYLE} />}
        </button>
        {open && (
          <div ref={listRef} style={POPOVER_ANCHOR_STYLE} data-comment-ui="" data-overlay-ui="">
            <div style={STACK_LIST_STYLE}>
              {members.map(({ thread }) =>
                store.openCommentThreadId === thread.id ? (
                  <CommentThreadPopover key={thread.id} thread={thread} mentionRoster={roster} />
                ) : (
                  <ThreadPreviewCard
                    key={thread.id}
                    thread={thread}
                    onSelect={() => store.setOpenCommentThread(thread.id)}
                  />
                ),
              )}
            </div>
          </div>
        )}
      </>
    );
  },
);

export const CommentPinsOverlay = observer(
  ({
    presencePeers = [],
  }: {
    presencePeers?: ReadonlyArray<{ actorId: string; displayName: string | null }>;
  }) => {
    const store = useEditorStore();
    const cameraRef = useRef<HTMLDivElement | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);
    // Zoom snapshot that only advances once the camera crosses a fold/unfold
    // boundary for the current pin set — the hysteresis that stops flicker.
    const [clusterZoom, setClusterZoom] = useState(() => store.zoom);

    const writeCameraTransform = (element: HTMLDivElement) => {
      const { panX, panY, zoom } = store;
      element.style.transform = `matrix(${zoom}, 0, 0, ${zoom}, ${panX}, ${panY})`;
      element.style.setProperty(PIN_SCALE_VARIABLE, String(zoom === 0 ? 1 : 1 / zoom));
    };
    useLayoutEffect(
      () =>
        reaction(
          () => ({ panX: store.panX, panY: store.panY, zoom: store.zoom }),
          () => {
            const element = cameraRef.current;
            if (element) writeCameraTransform(element);
          },
        ),
      [store],
    );

    // Re-cluster only when zoom moves enough to matter: fold pricing scales
    // linearly with zoom, so a boundary crossing requires the zoom ratio to
    // leave the [FOLD/UNFOLD] hysteresis band.
    useEffect(
      () =>
        reaction(
          () => store.zoom,
          (zoom) => {
            setClusterZoom((current) => {
              const ratio = zoom / current;
              return ratio > CLUSTER_UNFOLD_PX / CLUSTER_FOLD_PX ||
                ratio < CLUSTER_FOLD_PX / CLUSTER_UNFOLD_PX
                ? zoom
                : current;
            });
          },
        ),
      [store],
    );

    const openThreadId = store.openCommentThreadId;
    const openStackKey = store.openCommentStackKey;

    // Placing a comment reveals pins. The eye toggle can hide them while the
    // comment tool stays active; a press then creates a draft that this
    // overlay — unmounted below — would never show, leaving no pin and no
    // composer for the click the user just made.
    useEffect(
      () =>
        reaction(
          () => store.pendingCommentDraft,
          (draft) => {
            if (draft && store.commentsHidden) store.toggleCommentsHidden();
          },
        ),
      [store],
    );

    // Deep link: `?comment=<threadId>` reveals the thread once its record
    // exists. A latch rather than a call — a link into a document whose
    // records are still syncing simply waits for them.
    const [revealRequest, setRevealRequest] = useState<string | null>(() => {
      try {
        return new URLSearchParams(window.location.search).get("comment");
      } catch {
        return null;
      }
    });
    const revealTarget = revealRequest ? store.commentRecords.get(revealRequest) : undefined;
    useEffect(() => {
      if (!revealRequest || !revealTarget) return;
      setRevealRequest(null);
      // Strip the parameter so refresh and back do not re-fly the camera.
      const url = new URL(window.location.href);
      url.searchParams.delete("comment");
      window.history.replaceState(null, "", url.toString());
      const threadId = revealTarget.kind === "comment" ? revealTarget.threadId : revealTarget.id;
      revealCommentThread(store, threadId);
    }, [revealRequest, revealTarget, store]);

    // Close open comment surfaces when the pointer goes down anywhere that is
    // not a comment surface. Capture phase because popovers stop propagation.
    useEffect(() => {
      if (!openThreadId && !openStackKey) return;
      const onPointerDown = (event: PointerEvent) => {
        const target = event.target;
        if (target instanceof Element && target.closest("[data-comment-ui]")) return;
        store.setOpenCommentThread(null);
        store.setOpenCommentStack(null);
      };
      document.addEventListener("pointerdown", onPointerDown, true);
      return () => document.removeEventListener("pointerdown", onPointerDown, true);
    }, [store, openThreadId, openStackKey]);

    if (store.commentsHidden) return null;

    // Layout changes move node-anchored pins even when the model is untouched.
    store.domIndex.resizeTick.get();

    const threads = pageThreads(store, store.activePageId).filter(
      (thread) => thread.id === openThreadId || threadMatchesFilters(store, thread),
    );
    // Grouping (stacks, clusters) reads positions UNTRACKED: pins position
    // themselves and follow drags on their own, and re-grouping the whole
    // overlay per drag frame is what made pins visibly lag their element.
    // Reading the drag maps' sizes re-groups once at each gesture boundary.
    store.dragCanvasOffset.size;
    store.remoteDragPreviews.size;
    const positioned = untracked(() => positionThreads(store, threads, containerRef.current));

    // Coincident pins first: no zoom can separate them, so they bypass the
    // distance-based fold entirely.
    const byStack = new Map<string, PositionedThread[]>();
    for (const entry of positioned) {
      const key = pinStackKey(entry.point);
      byStack.set(key, [...(byStack.get(key) ?? []), entry]);
    }
    const stacks = [...byStack.entries()].filter(([, members]) => members.length > 1);
    const stackKeys = new Set(stacks.map(([key]) => key));
    const singles = positioned.filter((entry) => !stackKeys.has(pinStackKey(entry.point)));

    // The open thread renders as its own pin; folding it into a badge would
    // put the popover under a count. Members of an open stack render inside
    // the stack's own list.
    const clustered = clusterThreads(
      singles.filter((entry) => entry.thread.id !== openThreadId),
      clusterZoom,
      clusterZoom === store.zoom ? CLUSTER_FOLD_PX : CLUSTER_UNFOLD_PX,
    );
    const openEntry =
      openThreadId && !openStackKey
        ? positioned.find((entry) => entry.thread.id === openThreadId)
        : undefined;
    const draft = store.pendingCommentDraft;
    // A node-anchored draft rides its node while composing (tracked, so a
    // move re-renders it), exactly where the posted pin will land; the press
    // point is only the fallback for anchors with no live position.
    const draftPoint = draft
      ? (resolveCommentAnchorCanvasPoint(
          store,
          draft.anchor,
          document.querySelector("[data-viewport]"),
        ) ?? draft.canvasPoint)
      : null;
    const roster: MentionMember[] = mentionRoster(store, presencePeers);
    const hoveredMarkerId =
      openThreadId || openStackKey || draft ? null : store.hoveredCommentMarkerId;

    const previewFor = (markerId: string): LeafCommentThreadRecord[] => {
      if (hoveredMarkerId !== markerId) return [];
      if (markerId.startsWith("pin:")) {
        const thread = store.commentRecords.get(markerId.slice(4));
        return thread?.kind === "thread" ? [thread] : [];
      }
      if (markerId.startsWith("stack:")) {
        return (byStack.get(markerId.slice(6)) ?? []).map((entry) => entry.thread);
      }
      if (markerId.startsWith("cluster:")) {
        const cluster = clustered.find(
          (candidate) =>
            candidate.members.length > 1 && candidate.members[0]!.thread.id === markerId.slice(8),
        );
        return cluster?.members.map((member) => member.thread) ?? [];
      }
      return [];
    };
    const previewMarker = hoveredMarkerId;
    const previewThreads = previewMarker ? previewFor(previewMarker) : [];
    const previewPoint = ((): CanvasXY | null => {
      if (!previewMarker || previewThreads.length === 0) return null;
      if (previewMarker.startsWith("pin:")) {
        const entry = positioned.find(
          (candidate) => candidate.thread.id === previewMarker.slice(4),
        );
        return entry?.point ?? null;
      }
      if (previewMarker.startsWith("stack:")) {
        return byStack.get(previewMarker.slice(6))?.[0]?.point ?? null;
      }
      const cluster = clustered.find(
        (candidate) =>
          candidate.members.length > 1 &&
          candidate.members[0]!.thread.id === previewMarker.slice(8),
      );
      return cluster?.centroid ?? null;
    })();
    const previewHandlers = previewMarker ? clusterPreviewHandlers(store, previewMarker) : null;

    // The hovered marker's region box is revealed even before opening.
    const hoveredRegionThread = ((): LeafCommentThreadRecord | null => {
      if (!previewMarker?.startsWith("pin:")) return null;
      const thread = store.commentRecords.get(previewMarker.slice(4));
      return thread?.kind === "thread" && thread.anchor.type === "region" ? thread : null;
    })();

    return (
      <div ref={containerRef} data-comment-pins="" style={CONTAINER_STYLE}>
        {/* The camera div unmounts whenever pins are hidden, so the transform
            is (re)written on attach — a reaction alone leaves a remounted
            layer at identity until the next pan or zoom. */}
        <div
          ref={(element) => {
            cameraRef.current = element;
            if (element) writeCameraTransform(element);
          }}
          style={CAMERA_STYLE}
        >
          {openEntry?.thread.anchor.type === "region" && (
            <>
              <CommentRegionBox region={openEntry.thread.anchor} />
              <RegionResizeHandles thread={openEntry.thread} />
            </>
          )}
          {hoveredRegionThread?.anchor.type === "region" && (
            <CommentRegionBox region={hoveredRegionThread.anchor} />
          )}
          {draft?.anchor.type === "region" && <CommentRegionBox region={draft.anchor} />}
          {clustered.map((cluster) => {
            if (cluster.members.length === 1) {
              const { thread, point } = cluster.members[0]!;
              return (
                <CommentPinAnchor
                  key={thread.id}
                  thread={thread}
                  fallbackPoint={point}
                  open={false}
                />
              );
            }
            const key = cluster.members[0]!.thread.id;
            const markerPreview = clusterPreviewHandlers(store, `cluster:${key}`);
            return (
              <div
                key={`cluster-${key}`}
                style={{ ...ANCHOR_STYLE, left: cluster.centroid.x, top: cluster.centroid.y }}
              >
                <button
                  type="button"
                  data-overlay-ui=""
                  data-comment-ui=""
                  data-comment-cluster={key}
                  aria-label={`${cluster.members.length} comments`}
                  title={`${cluster.members.length} comments`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onPointerEnter={markerPreview.onPointerEnter}
                  onPointerLeave={markerPreview.onPointerLeave}
                  onClick={(event) => {
                    event.stopPropagation();
                    const splitZoom = clusterSplitZoom(cluster);
                    if (splitZoom) flyCameraTo(store, cluster.centroid, splitZoom);
                  }}
                  style={{ ...PIN_STYLE, ...BADGE_STYLE }}
                >
                  {cluster.members.length}
                </button>
              </div>
            );
          })}
          {stacks.map(([key, members]) => (
            <div
              key={`stack-${key}`}
              style={{ ...ANCHOR_STYLE, left: members[0]!.point.x, top: members[0]!.point.y }}
            >
              <CommentStack stackKey={key} members={members} mentionRoster={roster} />
            </div>
          ))}
          {openEntry && (
            <CommentPinAnchor
              thread={openEntry.thread}
              fallbackPoint={openEntry.point}
              open
              mentionRoster={roster}
            />
          )}
          {previewPoint && previewThreads.length > 0 && previewHandlers && (
            <div style={{ ...ANCHOR_STYLE, left: previewPoint.x, top: previewPoint.y, zIndex: 1 }}>
              <div style={POPOVER_ANCHOR_STYLE}>
                <MarkerPreviewPanel
                  threads={previewThreads}
                  onEnter={previewHandlers.onPointerEnter}
                  onLeave={previewHandlers.onPointerLeave}
                  onSelect={(threadId) => {
                    store.setHoveredCommentMarker(null);
                    revealCommentThread(store, threadId);
                  }}
                />
              </div>
            </div>
          )}
          {draft && draftPoint && (
            <div
              data-comment-draft-anchor=""
              style={{
                ...ANCHOR_STYLE,
                left: draftPoint.x,
                top: draftPoint.y,
                zIndex: 2,
              }}
            >
              {/* Solid accent, continuing the teardrop cursor it dropped from. */}
              <div style={{ ...PIN_STYLE, background: "var(--leaf-accent)" }} />
              <div style={POPOVER_ANCHOR_STYLE}>
                <CommentDraftComposer mentionRoster={roster} />
              </div>
            </div>
          )}
        </div>
      </div>
    );
  },
);

/**
 * Non-hook preview handlers for markers rendered inside `.map()` where hooks
 * cannot run. Timers live in a per-store map keyed by marker id.
 */
const PREVIEW_TIMERS = new WeakMap<EditorStore, Map<string, { open: number; close: number }>>();

function clusterPreviewHandlers(store: EditorStore, markerId: string) {
  let timers = PREVIEW_TIMERS.get(store);
  if (!timers) {
    timers = new Map();
    PREVIEW_TIMERS.set(store, timers);
  }
  const entry = timers.get(markerId) ?? { open: 0, close: 0 };
  timers.set(markerId, entry);
  return {
    onPointerEnter: () => {
      window.clearTimeout(entry.close);
      if (store.hoveredCommentMarkerId === markerId) return;
      entry.open = window.setTimeout(
        () => store.setHoveredCommentMarker(markerId),
        PREVIEW_OPEN_DELAY_MS,
      );
    },
    onPointerLeave: () => {
      window.clearTimeout(entry.open);
      entry.close = window.setTimeout(() => {
        if (store.hoveredCommentMarkerId === markerId) store.setHoveredCommentMarker(null);
      }, PREVIEW_CLOSE_DELAY_MS);
    },
  };
}

const CONTAINER_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 3,
  pointerEvents: "none",
};

const CAMERA_STYLE: CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  width: 0,
  height: 0,
  transformOrigin: "0 0",
};

/** Zero-sized, counter-scaled: children lay out in screen pixels. */
const ANCHOR_STYLE: CSSProperties = {
  position: "absolute",
  width: 0,
  height: 0,
  transform: `scale(var(${PIN_SCALE_VARIABLE}, 1))`,
  transformOrigin: "0 0",
};

/**
 * The marker: a rounded square with one sharp corner pointing at the exact
 * anchor point, offset so that corner sits on the anchor.
 */
const PIN_STYLE: CSSProperties = {
  position: "absolute",
  left: 0,
  bottom: 0,
  width: PIN_SIZE,
  height: PIN_SIZE,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: "50% 50% 50% 0",
  border: "1.5px solid var(--leaf-accent)",
  background: "var(--leaf-surface)",
  boxShadow: "var(--leaf-shadow-float)",
  pointerEvents: "auto",
  padding: 0,
  fontFamily: FONT_STACK,
};

const BADGE_STYLE: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: "var(--leaf-accent)",
};

const UNREAD_DOT_STYLE: CSSProperties = {
  position: "absolute",
  top: -3,
  right: -3,
  width: 9,
  height: 9,
  borderRadius: "50%",
  background: "var(--leaf-accent)",
  border: "1.5px solid var(--leaf-surface)",
};

const REGION_HANDLE_STYLE: CSSProperties = {
  position: "absolute",
  left: -5,
  top: -5,
  width: 10,
  height: 10,
  borderRadius: 3,
  border: "1.5px solid var(--leaf-accent)",
  background: "var(--leaf-surface)",
  cursor: "nwse-resize",
  pointerEvents: "auto",
};

/** Popover opens to the right of the pin, first message near pin height. */
const POPOVER_ANCHOR_STYLE: CSSProperties = {
  position: "absolute",
  left: PIN_SIZE + 8,
  bottom: -6,
  pointerEvents: "auto",
};

const STACK_LIST_STYLE: CSSProperties = {
  width: 300,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const PREVIEW_PANEL_STYLE: CSSProperties = {
  width: 280,
  display: "flex",
  flexDirection: "column",
  background: "var(--leaf-surface)",
  border: "1px solid var(--leaf-border)",
  borderRadius: 12,
  boxShadow: "var(--leaf-shadow-overlay)",
  fontFamily: FONT_STACK,
  fontSize: 12,
  color: "var(--leaf-text)",
  overflow: "hidden",
};

const PREVIEW_CARD_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 3,
  padding: "8px 12px",
  borderBottom: "1px solid var(--leaf-border)",
  background: "var(--leaf-surface)",
  borderRadius: 10,
};

const PREVIEW_CARD_HEAD_STYLE: CSSProperties = {
  display: "flex",
  gap: 6,
  alignItems: "baseline",
  fontSize: 11,
};

const PREVIEW_CARD_BODY_STYLE: CSSProperties = {
  lineHeight: 1.4,
  overflow: "hidden",
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
};

const PREVIEW_MORE_STYLE: CSSProperties = {
  padding: "6px 12px",
  fontSize: 11,
  color: "var(--leaf-text-faint)",
};
