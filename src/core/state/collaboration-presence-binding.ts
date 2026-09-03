import {
  LEAF_PRESENCE_MAX_SELECTION_IDS,
  LEAF_PRESENCE_MAX_TRANSFORM_DELTAS,
  type LeafBranchDto,
  type LeafBranchSessionDto,
  type LeafFileDto,
} from "../shared/collaboration";
import { screenPoint } from "../editor/interaction/coordinate-spaces";
import { autorun, type IReactionDisposer } from "mobx";
import { createCollaborationEditorSession } from "./collaboration-session";
import {
  CollaborationPresenceClient,
  type CollaborationPresencePeer,
  type CollaborationPresenceStatus,
} from "./collaboration-presence";
import type { CollaborationPermanentWriteFenceKind } from "./collaboration-persistence";

type NormalizedEditorSession = ReturnType<typeof createCollaborationEditorSession>;

export interface CollaborationPresenceBinding {
  replaceDescriptor?(descriptor: LeafBranchSessionDto): void | Promise<void>;
  replaceSession?(session: NormalizedEditorSession): void;
  fence?(kind: CollaborationPermanentWriteFenceKind): void;
  dispose(): void | Promise<void>;
}

export interface CollaborationPresenceBindingFactory {
  create(context: {
    branch: LeafBranchDto;
    descriptor: LeafBranchSessionDto | null;
    file: LeafFileDto;
    getCurrentSession: () => NormalizedEditorSession | null;
    onPeersChange: (peers: CollaborationPresencePeer[]) => void;
    onStatusChange: (status: CollaborationPresenceStatus) => void;
  }): CollaborationPresenceBinding | null | Promise<CollaborationPresenceBinding | null>;
}

export const defaultPresenceBindingFactory: CollaborationPresenceBindingFactory = {
  create(context) {
    if (!context.descriptor) return null;
    return new DefaultCollaborationPresenceBinding(context);
  },
};

class DefaultCollaborationPresenceBinding implements CollaborationPresenceBinding {
  private client: CollaborationPresenceClient | null = null;
  private descriptor: LeafBranchSessionDto;
  private reaction: IReactionDisposer | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private disposed = false;
  private fenced = false;
  private cursor: { x: number; y: number } | null = null;
  private dragInteractionId: string | null = null;
  private dragNodeIds: string[] = [];
  private dragBaseline = new Map<string, { x: number; y: number; width: number; height: number }>();

  constructor(
    private readonly context: Parameters<CollaborationPresenceBindingFactory["create"]>[0],
  ) {
    this.descriptor = context.descriptor!;
    this.createClient();
    this.bindSession();
    if (typeof window !== "undefined") {
      window.addEventListener("pointermove", this.handlePointerMove, { passive: true });
      window.addEventListener("blur", this.handlePointerExit);
    }
  }

  replaceDescriptor(descriptor: LeafBranchSessionDto) {
    if (
      this.disposed ||
      this.fenced ||
      descriptor.presenceServerUrl === this.descriptor.presenceServerUrl
    ) {
      this.descriptor = descriptor;
      return;
    }
    this.descriptor = descriptor;
    this.clearReconnectTimer();
    this.client?.close();
    this.client = null;
    this.reconnectAttempt = 0;
    this.createClient();
    this.bindSession();
  }

  replaceSession() {
    if (this.disposed) return;
    this.bindSession();
  }

  fence() {
    if (this.disposed || this.fenced) return;
    this.fenced = true;
    this.clearReconnectTimer();
    this.client?.close();
    this.client = null;
    this.context.onPeersChange([]);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clearReconnectTimer();
    this.reaction?.();
    this.reaction = null;
    if (typeof window !== "undefined") {
      window.removeEventListener("pointermove", this.handlePointerMove);
      window.removeEventListener("blur", this.handlePointerExit);
    }
    this.client?.close();
    this.client = null;
  }

  private createClient() {
    if (this.disposed || this.fenced) return;
    const client = new CollaborationPresenceClient({
      presenceServerUrl: this.descriptor.presenceServerUrl,
      onPeersChange: (peers) => this.context.onPeersChange(peers),
      onStatusChange: (status) => {
        this.context.onStatusChange(status);
        if (status === "live") {
          this.reconnectAttempt = 0;
          this.clearReconnectTimer();
        } else if (status === "idle" || status === "error") {
          this.scheduleReconnect(client);
        }
      },
    });
    this.client = client;
    client.connect();
  }

  private scheduleReconnect(client: CollaborationPresenceClient) {
    if (
      this.disposed ||
      this.fenced ||
      this.client !== client ||
      this.reconnectTimer !== null ||
      typeof window === "undefined"
    ) {
      return;
    }
    const delay = Math.min(10_000, 250 * 2 ** Math.min(6, this.reconnectAttempt++));
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.client === client && !this.disposed && !this.fenced) client.connect();
    }, delay);
  }

  private bindSession() {
    this.reaction?.();
    this.reaction = null;
    if (this.disposed || this.fenced || !this.client) return;
    this.dragInteractionId = null;
    this.dragNodeIds = [];
    this.dragBaseline.clear();
    this.reaction = autorun(() => {
      const session = this.context.getCurrentSession();
      if (!session) return;
      const store = session.store;
      const selectedNodeIds = [...store.selectedIds].slice(0, LEAF_PRESENCE_MAX_SELECTION_IDS);
      const bounds = store.viewportCanvasBounds;
      const viewport = bounds
        ? {
            x: bounds.left,
            y: bounds.top,
            width: Math.max(0, bounds.right - bounds.left),
            height: Math.max(0, bounds.bottom - bounds.top),
            zoom: store.zoom,
          }
        : store.viewportWidth > 0 && store.viewportHeight > 0
          ? {
              x: -store.panX / store.zoom,
              y: -store.panY / store.zoom,
              width: store.viewportWidth / store.zoom,
              height: store.viewportHeight / store.zoom,
              zoom: store.zoom,
            }
          : null;
      const transform = this.readTransformPreview(store);
      this.client?.update({
        cursor: this.cursor,
        pageId: store.activePageId,
        selectedNodeIds,
        tool: store.activeTool,
        viewport,
        transform,
      });
    });
  }

  private readTransformPreview(store: NormalizedEditorSession["store"]) {
    const nodeIds = [...store.dragCanvasOffset.keys()]
      .filter((nodeId) => store.nodeMap.has(nodeId))
      .slice(0, LEAF_PRESENCE_MAX_TRANSFORM_DELTAS);
    if (nodeIds.length === 0) {
      if (this.dragInteractionId) this.client?.completeInteraction(this.dragInteractionId);
      this.dragInteractionId = null;
      this.dragNodeIds = [];
      this.dragBaseline.clear();
      return null;
    }
    if (!sameStringArray(nodeIds, this.dragNodeIds)) {
      if (this.dragInteractionId) this.client?.completeInteraction(this.dragInteractionId);
      this.dragInteractionId = crypto.randomUUID();
      this.dragNodeIds = nodeIds;
      this.dragBaseline.clear();
      for (const nodeId of nodeIds) {
        this.dragBaseline.set(nodeId, canvasDragPreviewRect(store, nodeId));
      }
    }
    // Baseline and per-frame samples both use node + dragCanvasOffset — the
    // canvas-space preview rect the drag maintains as an invariant — so deltas
    // stay canvas-consistent even when a detach or flex normalization rewrites
    // node.x/y into another coordinate space mid-gesture.
    const deltas = nodeIds.map((nodeId) => {
      const current = canvasDragPreviewRect(store, nodeId);
      const baseline = this.dragBaseline.get(nodeId)!;
      return {
        nodeId,
        x: current.x - baseline.x,
        y: current.y - baseline.y,
        width: current.width - baseline.width,
        height: current.height - baseline.height,
      };
    });
    return {
      interactionId: this.dragInteractionId!,
      kind: deltas.some((delta) => delta.width !== 0 || delta.height !== 0)
        ? ("resize" as const)
        : ("drag" as const),
      deltas,
    };
  }

  private readonly handlePointerMove = (event: PointerEvent) => {
    if (this.disposed || this.fenced) return;
    const session = this.context.getCurrentSession();
    if (!session) return;
    const store = session.store;
    const viewport = document.querySelector<HTMLElement>("[data-viewport]");
    const bounds = viewport?.getBoundingClientRect();
    this.cursor = store.screenToCanvas(
      screenPoint(event.clientX - (bounds?.left ?? 0), event.clientY - (bounds?.top ?? 0)),
    );
    this.client?.update({ cursor: this.cursor });
  };

  private readonly handlePointerExit = () => {
    this.cursor = null;
    this.client?.update({ cursor: null });
  };

  private clearReconnectTimer() {
    if (this.reconnectTimer === null || typeof window === "undefined") return;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

function sameStringArray(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * The canvas-space rect a dragged node currently previews at. `dragCanvasOffset`
 * is maintained by the drag gesture so that node properties plus offset always
 * equal the canvas rect, across flex detach and reparent transitions.
 */
export function canvasDragPreviewRect(
  store: {
    getNode(id: string): { x: number; y: number; width: number; height: number } | undefined;
    dragCanvasOffset: ReadonlyMap<string, { x: number; y: number; width: number; height: number }>;
  },
  nodeId: string,
): { x: number; y: number; width: number; height: number } {
  const node = store.getNode(nodeId)!;
  const offset = store.dragCanvasOffset.get(nodeId);
  return {
    x: node.x + (offset?.x ?? 0),
    y: node.y + (offset?.y ?? 0),
    width: node.width + (offset?.width ?? 0),
    height: node.height + (offset?.height ?? 0),
  };
}
