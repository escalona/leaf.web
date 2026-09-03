import { runInAction } from "mobx";
import type { PinchGestureMode } from "../../core/editor/interaction/pinchGesture";
import type { EditorStore } from "../../core/state/EditorStore";
import type { FlowRestoreState, MoveNodeToParentOptions } from "../../core/state/document-adapter";
import type { CompassDirection, InkPoint, Point, Rect } from "../../core/types";
import type { FrameDropTargetLookup, MarqueeSelectionTarget } from "./interaction-helpers";
import { timeLeafPerfTrace } from "../../core/lib/perf-trace";

export type DragState =
  | { type: "idle" }
  | { type: "panning"; startMouse: Point; startPan: Point }
  | {
      type: "marquee";
      initialSelectedIds: Set<string>;
      baseSelectedIds: Set<string>;
      selectionTargets: MarqueeSelectionTarget[] | null;
      startCanvas: Point;
      startMouse: Point;
      started: boolean;
    }
  | {
      type: "moving";
      flowRestoreStates: Map<string, FlowRestoreState>;
      startMouse: Point;
      startPositions: Map<string, Point>;
      flexReparented: boolean;
      started: boolean;
      activateOnClickId?: string;
      /**
       * Set when the drag began on empty canvas inside the multi-selection
       * bounds: a real drag moves the group, but a plain click falls back to
       * the empty-canvas behavior and clears the selection.
       */
      deselectOnClick?: boolean;
    }
  | {
      type: "resizing";
      nodeId: string;
      direction: CompassDirection;
      startMouse: Point;
      startRect: { x: number; y: number; width: number; height: number };
      /** The node's own turn, which its parent-local `startRect` is written in. */
      rotation: number;
      /**
       * Everything the ancestors turn it by. Added to `rotation` it is the angle
       * the canvas-space pointer delta arrives at; on its own it is what
       * separates the node's parent frame from canvas space.
       */
      ancestorRotation: number;
      flexReparented: boolean;
      /** True only for the synthetic resize that creates a draw-tool node. */
      isCreating: boolean;
    }
  | {
      type: "resizing-selection";
      direction: CompassDirection;
      startMouse: Point;
      startUnion: Rect;
      startRects: Map<string, Rect>;
      startModels: Map<string, Point>;
      /** Per member, the turn its ancestors apply — canvas space to its parent's. */
      startAncestorRotations: Map<string, number>;
      /** Non-uniform scale is ill-defined for a rotated child, so force proportions. */
      lockProportions: boolean;
      baked: boolean;
    }
  | {
      type: "resizing-gap";
      nodeId: string;
      /** Which CSS gap longhand the drag writes (`rowGap` or `columnGap`). */
      gapAxis: "row" | "column";
      /** Client axis the pointer delta is read from. */
      pointerAxis: "x" | "y";
      /** Pointer-to-gap ratio so the grabbed band's far edge tracks the cursor. */
      divisor: number;
      /** −1 for reversed flex directions, where packing grows toward −main. */
      sign: 1 | -1;
      startMouse: Point;
      startGap: number;
      /** Write a single linked `gap` instead of the two longhands. */
      linked: boolean;
      /** Preserved other-axis value for unlinked writes. */
      otherGap: string | number | null;
    }
  | {
      type: "resizing-padding";
      nodeId: string;
      side: "top" | "right" | "bottom" | "left";
      /** Client axis the pointer delta is read from. */
      pointerAxis: "x" | "y";
      /** +1 when growing padding drags toward +axis (top/left), −1 otherwise. */
      sign: 1 | -1;
      startMouse: Point;
      /** Rendered numeric padding on the dragged side at drag start. */
      startPadding: number;
      /** Authored values for the other three sides, preserved during write-back. */
      startSides: {
        top: string | number;
        right: string | number;
        bottom: string | number;
        left: string | number;
      };
    }
  | {
      type: "rotating";
      center: Point;
      startPointerAngle: number;
      /**
       * Angle the gizmo box is drawn at: a single node's total turn — its own
       * plus every ancestor's — or 0 for the axis-aligned box around a group.
       * Snapping quantizes this visible angle, and each member's own rotation
       * takes the resulting delta, so a snap lands the box on a round angle
       * whatever its ancestors contribute.
       */
      startBoundsRotation: number;
      startRotations: Map<string, number>;
      startCenters: Map<string, Point>;
      startModels: Map<string, Point>;
      /** Per member, canvas-space center deltas must be inverted through this angle. */
      startAncestorRotations: Map<string, number>;
      rect: Rect;
    }
  | { type: "inking"; pointerId: number; useRealPressure: boolean };

export type PinchState = {
  mode: PinchGestureMode;
  initialDistance: number;
  initialZoom: number;
  initialPan: Point;
  initialMidpoint: Point;
  previousMidpoint: Point;
  source: "touch" | "gesture";
};

export type DeferredTouchStart = {
  pointerId: number;
  clientX: number;
  clientY: number;
  button: number;
  pressure: number;
  accelKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
};

export type InkSession = {
  pathData: string;
  points: InkPoint[];
  pointerId: number;
  useRealPressure: boolean;
};

export type MovingDragCommit =
  | {
      type: "moveNodeToParent";
      nodeId: string;
      canvasPosition: Point;
      newParentId?: string;
      options?: MoveNodeToParentOptions;
    }
  | {
      type: "updateNodePosition";
      nodeId: string;
      position: Point;
    };

/**
 * Imperative state for one mounted viewport.
 *
 * React owns the visible preview values, while this coordinator owns pointer
 * continuity, gesture history compaction, camera-settle timers, and deferred
 * structural commits. Keeping those together makes their lifecycle explicit
 * without changing the order in which Viewport dispatches model mutations.
 */
export class ViewportInteractionCoordinator {
  dragState: DragState = { type: "idle" };
  activePointerId: number | null = null;
  readonly activeTouchPoints = new Map<number, Point>();
  pinchState: PinchState | null = null;
  pendingTouchStart: DeferredTouchStart | null = null;
  spacePressed = false;
  lastClickTime = 0;
  lastClickNodeId: string | null = null;
  frameDropTargets: FrameDropTargetLookup | null = null;
  snapTargetRects: Rect[] | null = null;
  pendingMovingDragCommit: (() => void) | null = null;
  pendingMovingDragCommitTimeout: number | null = null;
  inkSession: InkSession | null = null;

  private historyTransactionOpen = false;
  private zoomSettleTimeout: number | null = null;
  private panSettleTimeout: number | null = null;

  beginHistoryTransaction(store: EditorStore) {
    if (this.historyTransactionOpen) return;
    this.historyTransactionOpen = true;
    store.beginHistoryTransaction();
  }

  endHistoryTransaction(store: EditorStore) {
    if (!this.historyTransactionOpen) return;
    this.historyTransactionOpen = false;
    timeLeafPerfTrace("history.end", () => {
      store.endHistoryTransaction();
    });
  }

  cancelHistoryTransaction(store: EditorStore) {
    if (!this.historyTransactionOpen) return;
    this.historyTransactionOpen = false;
    store.cancelHistoryTransaction();
  }

  closeHistoryTransactionOnUnmount(store: EditorStore) {
    if (!this.historyTransactionOpen) return;
    this.historyTransactionOpen = false;
    store.endHistoryTransaction();
  }

  markZooming(store: EditorStore) {
    store.isZooming = true;
    if (this.zoomSettleTimeout !== null) window.clearTimeout(this.zoomSettleTimeout);
    this.zoomSettleTimeout = window.setTimeout(() => {
      this.zoomSettleTimeout = null;
      runInAction(() => {
        store.isZooming = false;
      });
    }, 150);
  }

  markPanning(store: EditorStore) {
    store.isPanning = true;
    if (this.panSettleTimeout !== null) window.clearTimeout(this.panSettleTimeout);
    this.panSettleTimeout = window.setTimeout(() => {
      this.panSettleTimeout = null;
      runInAction(() => {
        store.isPanning = false;
      });
    }, 150);
  }

  clearCameraMotion(store: EditorStore) {
    if (this.zoomSettleTimeout !== null) {
      window.clearTimeout(this.zoomSettleTimeout);
      this.zoomSettleTimeout = null;
    }
    if (this.panSettleTimeout !== null) {
      window.clearTimeout(this.panSettleTimeout);
      this.panSettleTimeout = null;
    }
    runInAction(() => {
      store.isZooming = false;
      store.isPanning = false;
    });
  }

  flushPendingMovingDragCommit() {
    if (this.pendingMovingDragCommitTimeout !== null) {
      window.clearTimeout(this.pendingMovingDragCommitTimeout);
      this.pendingMovingDragCommitTimeout = null;
    }

    const pendingCommit = this.pendingMovingDragCommit;
    if (!pendingCommit) return;
    this.pendingMovingDragCommit = null;
    pendingCommit();
  }

  deferMovingDragCommit(commit: () => void) {
    this.pendingMovingDragCommit = commit;
    this.pendingMovingDragCommitTimeout = window.setTimeout(() => {
      this.pendingMovingDragCommitTimeout = null;
      const pendingCommit = this.pendingMovingDragCommit;
      this.pendingMovingDragCommit = null;
      pendingCommit?.();
    }, 0);
  }

  clearTargetCaches() {
    this.frameDropTargets = null;
    this.snapTargetRects = null;
  }
}
