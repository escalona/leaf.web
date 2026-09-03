import { computed, makeAutoObservable, observable, runInAction } from "mobx";
import { createContext, useContext } from "react";
import type {
  DesignNode,
  DragInsertionPreview,
  EditorPage,
  GeneratedImageJob,
  ToolMode,
  Point,
  Rect,
  SnapGuide,
} from "../types";
import { DomIndex } from "./DomIndex";
import { EditorRuntime } from "../editor/runtime";
import type { LeafCommentAnchor, LeafCommentRecord } from "../shared/collaboration";
import { loadCommentReads, persistCommentReads } from "./comment-read-receipts";
import type { DocumentHistoryEntry, DocumentPersistenceAdapter } from "./document-adapter";
import {
  DEFAULT_PAGE_ID,
  DEFAULT_PAGE_NAME,
  getDocumentPages,
  persistedNodeToDesignNode,
  type PersistedDesignNode,
  type PersistedEditorDocument,
} from "./document";
import { createStarterDocument } from "./starter-document";
import {
  clampLayersPanelWidth,
  clampPagesPanelHeight,
  clampPropertiesPanelWidth,
} from "../editor/editor-layout";
import { loadPanelLayout, persistPanelLayout } from "./panel-layout-storage";
import type { CanvasPoint, ScreenPoint } from "../editor/interaction/coordinate-spaces";
import {
  areViewportBoundsEqual,
  clampZoom,
  getCssTransform,
  getCssTransform3d,
  getInitialCameraForPage,
  getInitialViewportTargetBounds,
  screenToCanvas as convertScreenToCanvas,
  setZoomAtPoint as calculateZoomAtPoint,
} from "./editor-camera-state";
import {
  collectForcedRenderSubtreeIds,
  collectRenderPinnedAncestorIds,
  registerNodeTreeEntries,
  shouldCullDescendants as shouldCullRenderDescendants,
  shouldKeepOffscreenFrameShells as shouldKeepRenderFrameShells,
  unregisterNodeTreeEntries,
} from "./editor-render-tree";
import {
  areSelectedIdsEqual,
  normalizeSelectedIds as normalizeEditorSelectedIds,
} from "./editor-selection";
import {
  getArtboard as findEditorArtboard,
  getCanvasPosition as getEditorCanvasPosition,
  getCanvasTransform as getEditorCanvasTransform,
  getPageIdForNode as getEditorPageIdForNode,
  getParent as getEditorParent,
  getRootSiblingsForNode as getEditorRootSiblingsForNode,
  getWorldRotation as getEditorWorldRotation,
  isDescendant as isEditorDescendant,
  isFlexChild as isEditorFlexChild,
  isFlowChild as isEditorFlowChild,
  type CanvasTransform,
} from "./editor-tree-queries";
import {
  activateInteractiveSurface as activateEditorInteractiveSurface,
  activateInteraction as activateEditorInteraction,
  activateScriptInteraction as activateEditorScriptInteraction,
  getInteractionDeactivationReason,
  getInteractionTargetId as getEditorInteractionTargetId,
  getScriptInteractionRootId as getEditorScriptInteractionRootId,
  getSelectedInteractionTargetId,
  registerScriptInteractionRoot as registerEditorScriptInteractionRoot,
  unregisterScriptInteractionRoot as unregisterEditorScriptInteractionRoot,
} from "./editor-interaction-state";
import {
  beginTextEditing as beginEditorTextEditing,
  finishTextEditing as finishEditorTextEditing,
  type TextEditingSelection,
  type TextEditingSession,
} from "./editor-text-editing";
import { AgentActivityState } from "./agent-activity";

export { createNode, generateId, resetIdCounter } from "../nodes/specs";
export type { TextEditingSelection, TextEditingSession } from "./editor-text-editing";

export type ViewportCanvasBounds = {
  bottom: number;
  left: number;
  right: number;
  top: number;
};

export type RenderTreeInsertMutation = {
  kind: "insert";
  version: number;
  insertions: Array<{ nodeId: string; parentId?: string }>;
};

type UnregisterNodeTreeOptions = {
  preserveScriptSessionStateIds?: ReadonlySet<string>;
  preserveTextEditingSessionIds?: ReadonlySet<string>;
};

/** A comment-tool placement in progress: nothing durable exists yet. */
export type PendingCommentDraft = {
  anchor: LeafCommentAnchor;
  /** Canvas point where the pin and composer render while drafting. */
  canvasPoint: { x: number; y: number };
  /** Page the draft was placed on; posting must not follow a page switch. */
  pageId: string;
};

export type CommentFilters = {
  showResolved: boolean;
  /** Only threads this author participates in; null shows everyone's. */
  authorId: string | null;
  /** Only threads on this page; null shows every page. */
  pageId: string | null;
};

export class EditorStore {
  // Camera state
  zoom = 1;
  panX = 0;
  panY = 0;
  private pendingInitialPageCameraId: string | null = null;
  shouldCenterInitialViewport = true;
  isZooming = false;
  isPanning = false;

  // Cached viewport pixel size, kept current by a ResizeObserver in Viewport.
  // Lets the camera/culling render path avoid a forced getBoundingClientRect()
  // layout read on every pan/zoom frame.
  viewportWidth = 0;
  viewportHeight = 0;
  // Conservative, overscanned canvas bounds used by both root and descendant
  // virtualization. During camera motion these bounds only expand; they shrink
  // after the gesture settles so visible subtrees never disappear mid-gesture.
  viewportCanvasBounds: ViewportCanvasBounds | null = null;
  // Region rendered at full descendant detail. Camera motion may expand the
  // membership bounds above while this region stays latched, yielding cheap frame
  // shells instead of mounting whole newly-visible subtrees mid-gesture.
  viewportDetailBounds: ViewportCanvasBounds | null = null;
  renderTreeVersion = 0;
  renderTreeMutation: RenderTreeInsertMutation | null = null;

  // Document tree. Pages each own their root nodes; `nodes` is the active
  // page's roots, so every existing caller keeps working unchanged.
  pages: EditorPage[] = [{ id: DEFAULT_PAGE_ID, name: DEFAULT_PAGE_NAME, nodes: [] }];
  activePageId: string = DEFAULT_PAGE_ID;
  nodeMap = new Map<string, DesignNode>();

  // Parent tracking (childId → parentId)
  parentMap = new Map<string, string>();

  // Selection
  selectedIds = new Set<string>();
  hoveredId: string | null = null;
  hoveredCanvasRect: Rect | null = null;
  enteredContainerId: string | null = null;
  snapGuides: SnapGuide[] = [];

  // Tool
  activeTool: ToolMode = "select";

  // Panel layout. Sizes are a locally durable workspace preference shared by
  // every document (initialized from storage, written back in the setters);
  // collapse state stays session-local.
  sidebarCollapsed = false;
  sidebarWidth = loadPanelLayout().sidebarWidth;
  pagesPanelHeight = loadPanelLayout().pagesPanelHeight;
  propertiesPanelWidth = loadPanelLayout().propertiesPanelWidth;

  // True while a marquee selection drag is actively updating the selection.
  // Floating UI surfaces hide during this window to avoid popping in mid-drag.
  marqueeSelecting = false;

  // Number of image paste/drop operations still measuring and uploading files.
  // The paste indicator derives its visibility from this count.
  imagePastesInProgress = 0;

  // Working indicator (nodes being worked on by AI or local AI-assisted actions)
  workingOnIds = new Set<string>();
  agentActivity = new AgentActivityState();

  // Materializing nodes (recently created by agent, animating from wireframe to rendered)
  materializingIds = new Map<string, number>(); // nodeId → stagger delay (ms)

  // Image generation jobs are renderer-local state keyed by image placeholder node.
  generatedImageJobs = new Map<string, GeneratedImageJob>();

  // Count of live editor canvases currently mounted for this store, maintained
  // by ViewportCanvas. Zero means no window is rendering this document (a
  // background workspace tab, or a window showing the files dashboard), so
  // DOM-dependent MCP reads must use an isolated render replica instead of
  // waiting on live elements that can never mount.
  canvasMountCount = 0;

  // Subtree roots temporarily pinned into the viewport tree even if they are
  // outside the visible canvas bounds. Used by tools like MCP screenshots.
  forcedRenderCounts = new Map<string, number>();
  deferredDetailRootIds = new Set<string>();

  // Script-owned interaction roots. These are session-local: the durable node
  // remains in the document while a document script attaches behavior at runtime.
  scriptInteractionRootIds = new Set<string>();

  // Active directly-interactive surface node. Script behavior roots share the
  // same interaction mode through scriptInteractionRootIds.
  activeInteractiveSurfaceId: string | null = null;

  // Active inline text editor.
  editingTextSession: TextEditingSession | null = null;

  // Canvas-space offset from node properties, captured at drag start.
  // Overlay uses: canvasRect = nodeProps + offset, avoiding stale DOM measurement.
  dragCanvasOffset = new Map<string, { x: number; y: number; width: number; height: number }>();

  // Session-local canvas-space offsets for remote peers' in-flight drags.
  // The renderer composes these as a transient transform so a peer's drag moves
  // the real element live; the durable model is untouched until the peer commits.
  remoteDragPreviews = new Map<string, { x: number; y: number }>();

  // Nodes temporarily rendered at the canvas root while a drag crosses frame boundaries.
  // The committed hierarchy is not updated until the drag is released.
  dragDetachedIds = new Set<string>();
  dragPendingParentIds = new Map<string, string | null>();
  dragInsertionPreview: DragInsertionPreview | null = null;
  // True from a viewport pointer-down boundary through commit or cancel. Page
  // switches consult this even before a drag has moved far enough to populate
  // offsets, so they cannot retarget a gesture that captured another page.
  pointerGestureActive = false;

  // Session-local hover state for flex spacing bands (gaps and padding
  // strips): the band whose full pink section and value badge are shown.
  // `bandKey` is the band's position in its container's rendered band list
  // for that kind; `gapAxis`/`side` carry the band's semantic identity so the
  // overlay can recover when a mid-drag reflow reorders the rendered list.
  // Written by idle pointer moves and by the spacing gestures themselves so
  // the highlight survives pointer capture; cleared on gesture end/cancel,
  // gesture resets, deselection, and when the pointer leaves the viewport.
  spacingBandHighlight:
    | { nodeId: string; kind: "gap"; bandKey: number; gapAxis: "row" | "column" }
    | {
        nodeId: string;
        kind: "padding";
        bandKey: number;
        side: "top" | "right" | "bottom" | "left";
      }
    | null = null;

  // Comment lane projection. Comment threads live alongside the canvas — they
  // travel with the document and sync through the same room, but they are not
  // design nodes. This map mirrors the canonical lane for the pin overlay and
  // comments panel; `collaboration-comments` owns the conversion.
  commentRecords = new Map<string, LeafCommentRecord>();

  // Comment authorship for this session: the sync actor id plus a display
  // name denormalized onto records at write time. Session-local.
  commentAuthor: { id: string; name: string | null } | null = null;

  // Session-local comment UI state: the one open thread popover, an in-flight
  // placement draft (comment tool click, before anything durable exists), and
  // pin visibility.
  openCommentThreadId: string | null = null;
  pendingCommentDraft: PendingCommentDraft | null = null;
  commentsHidden = false;
  commentFilters: CommentFilters = { showResolved: false, authorId: null, pageId: null };
  // One hovered marker at a time keeps hover previews mutually exclusive.
  hoveredCommentMarkerId: string | null = null;
  // An open stack of coincident pins, keyed by the stack's quantized point so
  // the state survives the stack pin remounting.
  openCommentStackKey: string | null = null;
  // Locally durable per-account read receipts, loaded when the author is set.
  commentReadIds = new Set<string>();

  // DOM bridge
  domIndex = new DomIndex();

  // Shared mutation surface used by UI and MCP.
  runtime: EditorRuntime;
  documentAdapter: DocumentPersistenceAdapter | null = null;
  canUndo = false;
  canRedo = false;
  canPreviewHistory = true;
  historyEntries: DocumentHistoryEntry[] = [];
  historyPreview: DocumentHistoryEntry | null = null;

  constructor(options?: { initialDocument?: PersistedEditorDocument }) {
    makeAutoObservable<EditorStore, "pendingInitialPageCameraId">(this, {
      domIndex: false,
      nodeMap: false,
      parentMap: false,
      runtime: false,
      documentAdapter: false,
      agentActivity: false,
      pendingInitialPageCameraId: false,
      // Comment records are canonical protocol data passed to structuredClone
      // and the sync layer; deep observability would wrap them in proxies that
      // structuredClone rejects. The map itself (and the draft reference) is
      // what changes, so shallow/ref tracking is also strictly cheaper.
      commentRecords: observable.shallow,
      pendingCommentDraft: observable.ref,
      renderPinnedAncestorIds: computed.struct,
      forcedRenderSubtreeIds: computed.struct,
      // keepAlive: read from pointer handlers (no observer), so the cache
      // must survive outside reactions to avoid an O(selection x depth)
      // rebuild on every pointermove.
      shallowTargetOpenContainerIds: computed({ keepAlive: true }),
    });
    this.runtime = new EditorRuntime(this);

    const initialDocument = options?.initialDocument || createStarterDocument();
    this.initializePersistedDocument(initialDocument);
  }

  private initializePersistedDocument(document: PersistedEditorDocument) {
    const nextNodeMap = new Map<string, DesignNode>();
    const nextParentMap = new Map<string, string>();
    const hydrate = (persistedNode: PersistedDesignNode) =>
      persistedNodeToDesignNode(persistedNode, (node, parentId) => {
        nextNodeMap.set(node.id, node);
        if (parentId) nextParentMap.set(node.id, parentId);
      });

    this.pages = getDocumentPages(document).map((page) => ({
      id: page.id,
      name: page.name,
      nodes: page.nodes.map(hydrate),
      camera: page.camera,
      ...(page.background ? { background: page.background } : {}),
    }));
    this.activePageId = this.pages[0]!.id;
    this.nodeMap = nextNodeMap;
    this.parentMap = nextParentMap;
    this.forcedRenderMembershipByNodeId.clear();
    this.deferredDetailMembershipByNodeId.clear();
    this.renderTreeVersion += 1;
    this.renderTreeMutation = null;
  }

  // --- Pages ---

  get activePage(): EditorPage {
    return this.pages.find((page) => page.id === this.activePageId) ?? this.pages[0]!;
  }

  /** Root nodes of the active page. */
  get nodes(): DesignNode[] {
    return this.activePage.nodes;
  }

  set nodes(next: DesignNode[]) {
    this.activePage.nodes = next;
  }

  /**
   * The page a node lives on, walking up to its root ancestor.
   *
   * The page scan is a linear walk rather than an index: bulk record creation
   * asks this once per created node, but the answer is almost always the page
   * the caller just looked at, so checking the active page first turns the
   * common case into one comparison. A maintained root->page index would be
   * faster in the worst case and is not worth the invalidation surface — the
   * page list is short and roots per page are bounded by what a human arranges.
   */
  getPageIdForNode(nodeId: string): string | null {
    return getEditorPageIdForNode(this, nodeId);
  }

  /**
   * Root nodes of the page that owns `nodeId`.
   *
   * Sibling ordering and rank allocation must resolve against the node's own
   * page, not `nodes` (the active page). Otherwise a root node on a background
   * page gets its rank computed against strangers, which reorders it for every
   * other client on the next sync.
   */
  getRootSiblingsForNode(nodeId: string): DesignNode[] {
    return getEditorRootSiblingsForNode(this, nodeId);
  }

  setActivePage(pageId: string, options: { allowDuringPointerGesture?: boolean } = {}) {
    if (pageId === this.activePageId) return;
    if (!this.pages.some((page) => page.id === pageId)) return;
    if (this.pointerGestureActive && !options.allowDuringPointerGesture) return;
    // Leaving the page commits an inline text session the way a tool switch
    // does; otherwise it would outlive its node's page and settle blind.
    // `allowDuringPointerGesture` marks the system-driven switches (rollback
    // restore, deleted-page fallback), which keep the session exactly as the
    // render-tree replay path expects.
    if (!options.allowDuringPointerGesture) this.finishTextEditing();
    // A comment placement draft belongs to the page where it was composed.
    // Switching pages abandons it rather than rendering it over unrelated
    // content and later posting back to the captured page.
    this.pendingCommentDraft = null;
    // Park the camera on the page being left so switching back restores the
    // view the user had, the way most design tools behave.
    const leaving = this.activePage;
    if (this.pendingInitialPageCameraId !== leaving.id) {
      leaving.camera = { zoom: this.zoom, panX: this.panX, panY: this.panY };
    }
    this.pendingInitialPageCameraId = null;

    this.activePageId = pageId;
    this.deselectAll();
    this.hoveredId = null;
    this.enteredContainerId = null;

    // A page's parked camera is restored when there is one. The first visit
    // is intentionally independent of the page being left: an empty page
    // centers the world origin at 1x, while a populated page fits its visible
    // content with the usual 50px padding and 1x zoom cap.
    //
    // `shouldCenterInitialViewport` is deliberately never re-armed here. It
    // means "the one-time camera centering at document open is still pending",
    // and the viewport records that centering per store in a WeakSet: setting
    // the flag back to true after the first render centers nothing, it only
    // re-subscribes the `initialViewportTargetBounds` computed — a full
    // node-tree traversal on a page with no artboard — for every drag frame in
    // the rest of the session.
    const parkedCamera = this.activePage.camera;
    const initialCamera = parkedCamera ? null : this.getInitialCameraForPage(this.activePage);
    const camera = parkedCamera ??
      initialCamera ?? {
        zoom: 1,
        panX: 0,
        panY: 0,
      };
    if (initialCamera) {
      this.activePage.camera = initialCamera;
    } else if (!parkedCamera) {
      this.pendingInitialPageCameraId = this.activePage.id;
    }
    this.zoom = camera.zoom;
    this.panX = camera.panX;
    this.panY = camera.panY;
    // An explicit page switch is a deliberate camera action; a still-pending
    // open-time centering must not stomp it afterwards.
    this.shouldCenterInitialViewport = false;

    this.renderTreeVersion += 1;
    this.renderTreeMutation = null;
    this.markRenderTreeChanged();
  }

  // --- Camera ---

  get cssTransform(): string {
    return getCssTransform(this);
  }

  get cssTransform3d(): string {
    return getCssTransform3d(this);
  }

  screenToCanvas(screen: ScreenPoint): CanvasPoint {
    return convertScreenToCanvas(this, screen);
  }

  zoomAtPoint(delta: number, screenPoint: Point) {
    const oldZoom = this.zoom;
    const factor = Math.pow(2, -delta * 0.01);
    const newZoom = clampZoom(oldZoom * factor);
    this.setZoomAtPoint(newZoom, screenPoint);
  }

  setZoomAtPoint(nextZoom: number, screenPoint: Point) {
    const camera = calculateZoomAtPoint(this, nextZoom, screenPoint);
    if (camera.zoom === this.zoom) return;
    this.panX = camera.panX;
    this.panY = camera.panY;
    this.zoom = camera.zoom;
  }

  zoomWithWheel(delta: number, screenPoint: Point) {
    const nextZoom = this.zoom + delta * this.zoom;
    this.setZoomAtPoint(nextZoom, screenPoint);
  }

  pan(dx: number, dy: number) {
    this.panX += dx;
    this.panY += dy;
  }

  setViewportSize(width: number, height: number) {
    if (this.viewportWidth === width && this.viewportHeight === height) return;
    this.viewportWidth = width;
    this.viewportHeight = height;

    // A page switch can race the first ResizeObserver measurement in desktop
    // startup. Keep an unvisited page unparked until a real viewport exists,
    // then initialize the same camera it would have received synchronously.
    if (
      this.pendingInitialPageCameraId === this.activePageId &&
      !this.activePage.camera &&
      width > 0 &&
      height > 0
    ) {
      const camera = this.getInitialCameraForPage(this.activePage);
      if (!camera) return;
      this.activePage.camera = camera;
      this.zoom = camera.zoom;
      this.panX = camera.panX;
      this.panY = camera.panY;
      this.pendingInitialPageCameraId = null;
    }
  }

  setViewport(next: { zoom?: number; panX?: number; panY?: number }) {
    if (next.zoom !== undefined || next.panX !== undefined || next.panY !== undefined) {
      this.pendingInitialPageCameraId = null;
    }
    if (next.zoom !== undefined) {
      this.zoom = clampZoom(next.zoom);
    }
    if (next.panX !== undefined) this.panX = next.panX;
    if (next.panY !== undefined) this.panY = next.panY;
  }

  setViewportCanvasBounds(bounds: ViewportCanvasBounds | null) {
    if (areViewportBoundsEqual(this.viewportCanvasBounds, bounds)) return;
    this.viewportCanvasBounds = bounds;
  }

  setViewportDetailBounds(bounds: ViewportCanvasBounds | null) {
    if (areViewportBoundsEqual(this.viewportDetailBounds, bounds)) return;
    this.viewportDetailBounds = bounds;
  }

  /**
   * Containers the shallow hit resolver drills through: ancestors of the
   * selection plus the entered container and its ancestors (opening the
   * entered chain makes hover predict the post-retarget click target).
   * Recomputed only when selection, scope, or the tree changes.
   */
  get shallowTargetOpenContainerIds(): ReadonlySet<string> {
    void this.renderTreeVersion;
    const openIds = new Set<string>();
    for (const selectedId of this.selectedIds) {
      let ancestorId = this.parentMap.get(selectedId);
      while (ancestorId) {
        openIds.add(ancestorId);
        ancestorId = this.parentMap.get(ancestorId);
      }
    }
    let scopeAncestorId = this.enteredContainerId ?? undefined;
    while (scopeAncestorId) {
      openIds.add(scopeAncestorId);
      scopeAncestorId = this.parentMap.get(scopeAncestorId);
    }
    return openIds;
  }

  get renderPinnedAncestorIds() {
    void this.renderTreeVersion;
    return collectRenderPinnedAncestorIds({
      dragDetachedIds: this.dragDetachedIds,
      dragCanvasOffsetIds: this.dragCanvasOffset.keys(),
      remoteDragPreviewIds: this.remoteDragPreviews.keys(),
      forcedRenderIds: this.forcedRenderCounts.keys(),
      editingTextNodeId: this.editingTextNodeId,
      enteredContainerId: this.enteredContainerId,
      activeInteractionId: this.activeInteractiveSurfaceId,
      parentMap: this.parentMap,
    });
  }

  /**
   * Every node below a forced-render root. This is a MobX computed value, so the
   * iterative tree walk is shared by all RenderNode observers until either the
   * forced roots or document tree changes.
   */
  get forcedRenderSubtreeIds() {
    void this.renderTreeVersion;
    return collectForcedRenderSubtreeIds(this.forcedRenderCounts.keys(), this.nodeMap);
  }

  /**
   * Per-node membership computeds over forcedRenderSubtreeIds. Renderers must
   * subscribe through these, never through the set itself: the set's identity
   * changes on every retain/release (an MCP capture or measurement does both),
   * and a direct `.has` subscription re-renders every mounted node on the page
   * each time. The per-node computed re-checks membership cheaply and only
   * propagates to a node's renderer when its own membership actually flips.
   */
  private readonly forcedRenderMembershipByNodeId = new Map<
    string,
    ReturnType<typeof computed<boolean>>
  >();

  /**
   * Shared cache logic for the per-node membership computeds below: cache
   * only for live nodes (a deleted node's query answers false without
   * creating an entry) and evict eagerly on subtree unregister.
   */
  private cachedNodeMembership(
    cache: Map<string, ReturnType<typeof computed<boolean>>>,
    nodeId: string,
    isMember: () => boolean,
  ): boolean {
    let membership = cache.get(nodeId);
    if (!membership) {
      if (!this.nodeMap.has(nodeId)) {
        cache.delete(nodeId);
        return false;
      }
      membership = computed(isMember);
      cache.set(nodeId, membership);
    }
    return membership.get();
  }

  isNodeInForcedRenderSubtree(nodeId: string): boolean {
    return this.cachedNodeMembership(this.forcedRenderMembershipByNodeId, nodeId, () =>
      this.forcedRenderSubtreeIds.has(nodeId),
    );
  }

  /**
   * Per-node membership computeds over deferredDetailRootIds, for the same
   * reason as the forced-render membership above: the deferred-detail release
   * pump deletes one root per frame, and a direct `.has` subscription on the
   * observable set re-rendered every mounted node once per frame while the
   * queue drained.
   */
  private readonly deferredDetailMembershipByNodeId = new Map<
    string,
    ReturnType<typeof computed<boolean>>
  >();

  isDeferredDetailRoot(nodeId: string): boolean {
    return this.cachedNodeMembership(this.deferredDetailMembershipByNodeId, nodeId, () =>
      this.deferredDetailRootIds.has(nodeId),
    );
  }

  /**
   * Drop a removed node's cached membership computeds. Once cached, a live
   * node's entry short-circuits the lazy nodeMap check above, so subtree
   * unregistration must evict eagerly or repeated write_html replacement
   * retains one computed per deleted node for the store lifetime.
   */
  evictRenderMembershipComputeds(nodeId: string) {
    this.forcedRenderMembershipByNodeId.delete(nodeId);
    this.deferredDetailMembershipByNodeId.delete(nodeId);
  }

  /**
   * Keep mounted renderers subscribed to the culling mode, not the exact document
   * size/version. MobX only publishes this computed value when an insertion crosses
   * the threshold, so a normal paste does not revisit every mounted NodeChildren.
   */
  get shouldCullDescendants() {
    void this.renderTreeVersion;
    return shouldCullRenderDescendants(this.nodeMap.size);
  }

  /**
   * Small/medium frame-heavy documents keep cheap empty frame shells mounted so
   * compositor zoom never reveals a blank canvas. Above this cap, normal spatial
   * membership wins so pathological all-frame documents do not retain thousands
   * of offscreen DOM elements.
   */
  get shouldKeepOffscreenFrameShells() {
    void this.renderTreeVersion;
    return shouldKeepRenderFrameShells(this.nodeMap);
  }

  get canLatchCullBoundsDuringZoom() {
    return (
      this.shouldKeepOffscreenFrameShells &&
      this.nodes.length === 1 &&
      this.nodes[0]?.type === "frame" &&
      this.nodes[0].children.every((child) => child.type === "frame")
    );
  }

  // --- Node tree registration ---

  /** Recursively register a node and all its descendants in nodeMap + parentMap */
  registerNodeTree(node: DesignNode, parentId?: string) {
    this.registerNodeTreeInternal(node, parentId);
    this.renderTreeVersion += 1;
    this.renderTreeMutation = {
      kind: "insert",
      version: this.renderTreeVersion,
      insertions: [{ nodeId: node.id, parentId }],
    };
  }

  /** Register several appended roots as one observable tree mutation. */
  registerNodeTrees(insertions: Array<{ node: DesignNode; parentId?: string }>) {
    if (insertions.length === 0) return;
    for (const { node, parentId } of insertions) {
      this.registerNodeTreeInternal(node, parentId);
    }
    this.renderTreeVersion += 1;
    this.renderTreeMutation = {
      kind: "insert",
      version: this.renderTreeVersion,
      insertions: insertions.map(({ node, parentId }) => ({ nodeId: node.id, parentId })),
    };
  }

  private registerNodeTreeInternal(node: DesignNode, parentId?: string) {
    registerNodeTreeEntries(node, this.nodeMap, this.parentMap, parentId);
  }

  /** Recursively unregister a node and all descendants */
  unregisterNodeTree(node: DesignNode, options: UnregisterNodeTreeOptions = {}) {
    unregisterNodeTreeEntries(this, node, options);
    this.markRenderTreeChanged();
  }

  markRenderTreeChanged() {
    this.renderTreeVersion += 1;
    this.renderTreeMutation = null;
    // Safety net for the paths that break the "selection sits inside the active
    // interaction root" invariant without going through commitSelectedIds:
    // unregisterNodeTreeInternal's direct delete, applySelectedIdsFromHistory,
    // and reparents that move an unchanged selection out of the root. In the
    // steady state the invariant already holds, so this does not fire on
    // unrelated mutations.
    if (this.activeInteractiveSurfaceId) {
      if (
        getInteractionDeactivationReason(this, (nodeId, ancestorId) =>
          this.isDescendant(nodeId, ancestorId),
        )
      ) {
        this.deactivateInteractiveSurface();
      }
    }
  }

  getParent(nodeId: string): DesignNode | undefined {
    return getEditorParent(this, nodeId);
  }

  isDescendant(nodeId: string, ancestorId: string) {
    void this.renderTreeVersion;
    return isEditorDescendant(this, nodeId, ancestorId);
  }

  isNodeWithinSelectionScope(nodeId: string) {
    if (!this.enteredContainerId) return true;
    return this.isDescendant(nodeId, this.enteredContainerId);
  }

  /** Check if a node is a child of a flex container and doesn't have its own absolute positioning */
  isFlexChild(nodeId: string): boolean {
    return isEditorFlexChild(this, nodeId);
  }

  /** Check if browser CSS layout, such as flex or grid, determines a child node's position. */
  isFlowChild(nodeId: string): boolean {
    return isEditorFlowChild(this, nodeId);
  }

  /** Find the nearest artboard ancestor of a node */
  getArtboard(nodeId: string): DesignNode | undefined {
    return findEditorArtboard(this, nodeId);
  }

  getCanvasPosition(nodeId: string): Point | undefined {
    return getEditorCanvasPosition(this, nodeId);
  }

  /**
   * The node's own unrotated box in canvas space plus the rotation the renderer
   * turns it by — every ancestor's rotation composed, the way the DOM does it.
   */
  getCanvasTransform(nodeId: string): CanvasTransform | undefined {
    return getEditorCanvasTransform(this, nodeId);
  }

  /** Total rotation applied to the node: its own plus every ancestor's. */
  getWorldRotation(nodeId: string): number {
    return getEditorWorldRotation(this, nodeId);
  }

  getNode(id: string): DesignNode | undefined {
    return this.nodeMap.get(id);
  }

  // --- Artboards ---

  get artboards(): DesignNode[] {
    return this.nodes.filter((n) => n.isArtboard);
  }

  get initialViewportTargetBounds(): Rect | null {
    return getInitialViewportTargetBounds(this.nodes);
  }

  private getInitialCameraForPage(page: EditorPage): {
    zoom: number;
    panX: number;
    panY: number;
  } | null {
    return getInitialCameraForPage(page, this.viewportWidth, this.viewportHeight);
  }

  activateInteractiveSurface(nodeId: string) {
    activateEditorInteractiveSurface(this, nodeId);
  }

  registerScriptInteractionRoot(nodeId: string) {
    registerEditorScriptInteractionRoot(this, nodeId);
  }

  unregisterScriptInteractionRoot(nodeId: string) {
    unregisterEditorScriptInteractionRoot(this, nodeId);
  }

  getScriptInteractionRootId(nodeId: string) {
    void this.renderTreeVersion;
    return getEditorScriptInteractionRootId(this, nodeId);
  }

  getInteractionTargetId(nodeId: string) {
    void this.renderTreeVersion;
    return getEditorInteractionTargetId(this, nodeId);
  }

  get selectedInteractionTargetId() {
    void this.renderTreeVersion;
    return getSelectedInteractionTargetId(this);
  }

  isInteractionActiveForNode(nodeId: string) {
    return (
      !!this.activeInteractiveSurfaceId &&
      this.isDescendant(nodeId, this.activeInteractiveSurfaceId)
    );
  }

  activateInteraction(nodeId: string) {
    activateEditorInteraction(this, nodeId);
  }

  activateScriptInteraction(nodeId: string) {
    activateEditorScriptInteraction(this, nodeId);
  }

  deactivateInteractiveSurface() {
    this.activeInteractiveSurfaceId = null;
  }

  // --- Inline text editing ---

  get editingTextNodeId(): string | null {
    return this.editingTextSession?.nodeId ?? null;
  }

  beginTextEditing(
    nodeId: string,
    options: { isCreating?: boolean; selection?: TextEditingSelection } = {},
  ) {
    beginEditorTextEditing(this, nodeId, options);
  }

  finishTextEditing(options: { deleteEmptyText?: boolean } = {}) {
    finishEditorTextEditing(this, options);
  }

  // --- Working indicator ---

  get workingIndicatorNodeIds() {
    return new Set([...this.workingOnIds, ...this.agentActivity.activeNodeIds]);
  }

  finishWorkingOnNodes(nodeIds: string[]) {
    for (const id of nodeIds) {
      this.workingOnIds.delete(id);
    }
  }

  // --- Canvas mount tracking ---

  get hasMountedCanvas() {
    return this.canvasMountCount > 0;
  }

  registerCanvasMount() {
    this.canvasMountCount += 1;
  }

  releaseCanvasMount() {
    if (this.canvasMountCount > 0) this.canvasMountCount -= 1;
  }

  retainForcedRender(nodeId: string) {
    if (!this.nodeMap.has(nodeId)) return;
    const count = this.forcedRenderCounts.get(nodeId) ?? 0;
    this.forcedRenderCounts.set(nodeId, count + 1);
  }

  releaseForcedRender(nodeId: string) {
    const count = this.forcedRenderCounts.get(nodeId);
    if (!count) return;
    if (count <= 1) {
      this.forcedRenderCounts.delete(nodeId);
      return;
    }
    this.forcedRenderCounts.set(nodeId, count - 1);
  }

  deferRenderDetails(nodeIds: readonly string[]) {
    if (nodeIds.length === 0) return;
    for (const nodeId of nodeIds) this.deferredDetailRootIds.add(nodeId);
    let index = 0;
    const releaseNext = () => {
      runInAction(() => {
        this.deferredDetailRootIds.delete(nodeIds[index]);
        index += 1;
      });
      if (index < nodeIds.length) requestAnimationFrame(releaseNext);
    };
    requestAnimationFrame(releaseNext);
  }

  isForcedRender(nodeId: string) {
    return (this.forcedRenderCounts.get(nodeId) ?? 0) > 0;
  }

  // --- Selection ---

  private commitSelectedIds(nextIds: Iterable<string>) {
    const beforeIds = Array.from(this.selectedIds);
    const afterIds = normalizeEditorSelectedIds(nextIds, this.nodeMap, this.parentMap);
    if (areSelectedIdsEqual(beforeIds, afterIds)) return false;
    this.selectedIds = new Set(afterIds);
    if (
      this.activeInteractiveSurfaceId &&
      getInteractionDeactivationReason(this, (nodeId, ancestorId) =>
        this.isDescendant(nodeId, ancestorId),
      )
    ) {
      this.deactivateInteractiveSurface();
    }
    this.documentAdapter?.recordSelectionChange(beforeIds, afterIds);
    return true;
  }

  selectNode(id: string, additive = false) {
    const nextIds = additive ? new Set(this.selectedIds) : new Set<string>();
    if (nextIds.has(id) && additive) {
      nextIds.delete(id);
    } else {
      nextIds.add(id);
    }
    this.commitSelectedIds(nextIds);
  }

  setSelectedIds(ids: Iterable<string>) {
    this.commitSelectedIds(ids);
  }

  deselectAll() {
    this.commitSelectedIds([]);
    this.clearHoveredNode();
    // Spacing band chrome is gated on the selection; a stale highlight would
    // resurrect it un-hovered the next time the same node is selected.
    this.spacingBandHighlight = null;
  }

  applySelectedIdsFromHistory(ids: Iterable<string>) {
    this.selectedIds = new Set(normalizeEditorSelectedIds(ids, this.nodeMap, this.parentMap));
  }

  get selectedNodes(): DesignNode[] {
    return Array.from(this.selectedIds)
      .map((id) => this.nodeMap.get(id))
      .filter(Boolean) as DesignNode[];
  }

  get selectedNode(): DesignNode | null {
    if (this.selectedIds.size !== 1) return null;
    const id = Array.from(this.selectedIds)[0];
    return this.nodeMap.get(id) ?? null;
  }

  setHoveredNode(nodeId: string | null, canvasRect: Rect | null = null) {
    this.hoveredId = nodeId;
    this.hoveredCanvasRect = nodeId ? canvasRect : null;
  }

  clearHoveredNode() {
    this.hoveredId = null;
    this.hoveredCanvasRect = null;
  }

  enterContainer(nodeId: string) {
    const node = this.nodeMap.get(nodeId);
    if (!node || node.type !== "frame" || node.children.length === 0) return;
    this.enteredContainerId = nodeId;
  }

  exitContainer() {
    const enteredId = this.enteredContainerId;
    if (!enteredId) return;
    const parent = this.getParent(enteredId);
    this.enteredContainerId = parent?.type === "frame" ? parent.id : null;
    this.commitSelectedIds([enteredId]);
  }

  /**
   * Pop the entered-container scope until it contains the hit node, or
   * clear it entirely for a miss. Clicking outside the entered container
   * retargets the scope instead of requiring Escape first.
   */
  retargetContainerScope(hitNodeId: string | null) {
    while (
      this.enteredContainerId &&
      (!hitNodeId || !this.isDescendant(hitNodeId, this.enteredContainerId))
    ) {
      // Pop to the nearest frame ancestor: a non-frame parent in the chain
      // must not eject the scope past frames that do contain the hit.
      let ancestor = this.getParent(this.enteredContainerId);
      while (ancestor && ancestor.type !== "frame") ancestor = this.getParent(ancestor.id);
      this.enteredContainerId = ancestor?.id ?? null;
    }
  }

  // --- Paste indicator ---

  beginImagePaste() {
    this.imagePastesInProgress += 1;
  }

  endImagePaste() {
    this.imagePastesInProgress = Math.max(0, this.imagePastesInProgress - 1);
  }

  // --- Tool ---

  setTool(tool: ToolMode) {
    if (tool !== this.activeTool) {
      this.finishTextEditing();
      this.deactivateInteractiveSurface();
    }
    this.activeTool = tool;
    if (tool === "ink" || tool === "pan") {
      this.clearHoveredNode();
    }
    // Leaving the comment tool abandons an unposted placement draft.
    if (tool !== "comment") this.pendingCommentDraft = null;
    // Entering it reveals pins: the tool exists to see and place comments, and
    // the sidebar pane it opens lists threads whose pins must be pointable-at.
    if (tool === "comment") this.commentsHidden = false;
  }

  setPointerGestureActive(active: boolean) {
    this.pointerGestureActive = active;
  }

  toggleSidebar() {
    const willCollapse = !this.sidebarCollapsed;
    this.panX += willCollapse ? this.sidebarWidth : -this.sidebarWidth;
    this.sidebarCollapsed = willCollapse;
  }

  setSidebarWidth(width: number) {
    const nextWidth = clampLayersPanelWidth(width);
    if (nextWidth === this.sidebarWidth) return;
    if (!this.sidebarCollapsed) {
      this.panX -= nextWidth - this.sidebarWidth;
    }
    this.sidebarWidth = nextWidth;
    this.persistPanelLayout();
  }

  setPagesPanelHeight(height: number) {
    this.pagesPanelHeight = clampPagesPanelHeight(height);
    this.persistPanelLayout();
  }

  // The right panel's left edge slides; the canvas origin (its own left edge)
  // stays put, so unlike the layers sidebar no panX compensation is needed.
  setPropertiesPanelWidth(width: number) {
    this.propertiesPanelWidth = clampPropertiesPanelWidth(width);
    this.persistPanelLayout();
  }

  private persistPanelLayout() {
    persistPanelLayout({
      sidebarWidth: this.sidebarWidth,
      pagesPanelHeight: this.pagesPanelHeight,
      propertiesPanelWidth: this.propertiesPanelWidth,
    });
  }

  setCommentAuthor(author: { id: string; name: string | null } | null) {
    this.commentAuthor = author;
    this.commentReadIds = loadCommentReads(author?.id ?? "local");
  }

  setOpenCommentThread(threadId: string | null) {
    this.openCommentThreadId = threadId;
    // Opening a thread always reveals pins; a hidden overlay with an open
    // popover would leave the conversation pointing at nothing.
    if (threadId) this.commentsHidden = false;
  }

  setOpenCommentStack(stackKey: string | null) {
    this.openCommentStackKey = stackKey;
    if (stackKey) {
      this.commentsHidden = false;
      this.pendingCommentDraft = null;
    } else {
      this.openCommentThreadId = null;
    }
  }

  setPendingCommentDraft(draft: PendingCommentDraft | null) {
    this.pendingCommentDraft = draft;
    if (draft) this.openCommentThreadId = null;
  }

  setHoveredCommentMarker(markerId: string | null) {
    this.hoveredCommentMarkerId = markerId;
  }

  markCommentsRead(commentIds: readonly string[]) {
    let changed = false;
    for (const id of commentIds) {
      if (!this.commentReadIds.has(id)) {
        this.commentReadIds.add(id);
        changed = true;
      }
    }
    if (changed) persistCommentReads(this.commentAuthor?.id ?? "local", this.commentReadIds);
  }

  toggleCommentsHidden() {
    this.commentsHidden = !this.commentsHidden;
    if (this.commentsHidden) {
      this.openCommentThreadId = null;
      this.openCommentStackKey = null;
      this.pendingCommentDraft = null;
    }
  }

  setCommentFilters(filters: CommentFilters) {
    this.commentFilters = { ...filters };
  }

  attachDocumentAdapter(adapter: DocumentPersistenceAdapter) {
    this.documentAdapter = adapter;
    this.setHistoryState(adapter.canUndo, adapter.canRedo);
  }

  setHistoryState(canUndo: boolean, canRedo: boolean, canPreviewHistory = true) {
    this.canUndo = canUndo;
    this.canRedo = canRedo;
    this.canPreviewHistory = canPreviewHistory;
  }

  setDocumentHistoryState(
    entries: readonly DocumentHistoryEntry[],
    preview: DocumentHistoryEntry | null,
  ) {
    this.historyEntries = entries.map((entry) => ({ ...entry }));
    this.historyPreview = preview ? { ...preview } : null;
  }

  get isHistoryPreviewing() {
    return this.historyPreview !== null;
  }

  previewHistoryVersion(entryId: string) {
    this.documentAdapter?.previewHistoryVersion?.(entryId);
    this.domIndex.scheduleGeometryRefresh();
  }

  restoreHistoryVersion(entryId?: string) {
    this.documentAdapter?.restoreHistoryVersion?.(entryId);
    this.domIndex.scheduleGeometryRefresh();
  }

  exitHistoryPreview() {
    this.documentAdapter?.exitHistoryPreview?.();
    this.domIndex.scheduleGeometryRefresh();
  }

  beginHistoryTransaction() {
    this.documentAdapter?.beginHistoryTransaction();
  }

  endHistoryTransaction() {
    this.documentAdapter?.endHistoryTransaction();
  }

  cancelHistoryTransaction() {
    this.documentAdapter?.cancelHistoryTransaction();
  }

  undo() {
    this.documentAdapter?.undo();
    // A history jump can move flow children without resizing them, which
    // ResizeObserver never reports; remeasure live overlay chrome next frame.
    this.domIndex.scheduleGeometryRefresh();
  }

  redo() {
    this.documentAdapter?.redo();
    this.domIndex.scheduleGeometryRefresh();
  }
}

export const EditorStoreContext = createContext<EditorStore>(null!);

export function useEditorStore(): EditorStore {
  return useContext(EditorStoreContext);
}
