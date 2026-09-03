import { runInAction } from "mobx";
import type { EditorStore } from "../../core/state/EditorStore";
import type { DesignNode, EditorPage } from "../../core/types";
import { serializeNode, serializeNodeFull } from "../../core/editor/serialization";
import { measureWithVisibleLayout } from "../../core/editor/forced-layout";
import { ROOT_PLACEMENT_GAP } from "../../core/editor/root-placement";
import { measureCanvasLayout, type CanvasLayoutDiagnostics } from "./canvas-layout";
import {
  getAuthoredDimension,
  getModelDimension,
  isModelSizedDimension,
  type DimensionKey,
} from "./model-dimensions";
import { withMcpPageRenderStore } from "../../ui/render/render-replica";
import { waitForAnimationFrames } from "../../ui/render/render-settle";

// ─── Camera-independent measurement ──────────────────────────────
// The dimension-source helpers live in ./model-dimensions so canvas-layout can
// share them without importing this module back (it already imports us).

/**
 * The dimension an agent should see, in pixels, or null when it genuinely
 * cannot be measured.
 *
 * The source is chosen from the node alone and never from where the camera
 * happens to be: a model-sized dimension always reports the model number, and
 * everything else always reports the rendered box. Falling back to the model
 * for an unmounted layout-sized node is what made the same node answer `85`
 * with the camera on it and `41` with the camera elsewhere.
 */
export function getReportedDimension(
  store: EditorStore,
  node: DesignNode,
  key: DimensionKey,
): number | null {
  if (isModelSizedDimension(store, node, key)) return getModelDimension(node, key);

  const element = store.domIndex.getElement(node);
  if (!element) return null;
  const measured = key === "width" ? element.offsetWidth : element.offsetHeight;
  return typeof measured === "number" && Number.isFinite(measured) && measured >= 0
    ? measured
    : null;
}

type ReportedSize = {
  width: number | null;
  height: number | null;
  authoredWidth?: string;
  authoredHeight?: string;
  measurementUnavailable?: string;
};

export function getReportedSize(store: EditorStore, node: DesignNode): ReportedSize {
  const width = getReportedDimension(store, node, "width");
  const height = getReportedDimension(store, node, "height");
  const authoredWidth = getAuthoredDimension(node, "width");
  const authoredHeight = getAuthoredDimension(node, "height");

  return {
    width,
    height,
    ...(authoredWidth !== null ? { authoredWidth } : {}),
    ...(authoredHeight !== null ? { authoredHeight } : {}),
    ...(width === null || height === null
      ? { measurementUnavailable: describeUnmeasurableNode(store, node) }
      : {}),
  };
}

function describeUnmeasurableNode(store: EditorStore, node: DesignNode) {
  if (node.visible === false) {
    return "Node is hidden, so it never renders and its layout size cannot be measured.";
  }
  // Decomposed SVG sub-elements register the real `<path>`/`<g>` they render as,
  // and SVG elements expose no offset box. Saying "not mounted" there would send
  // an agent hunting for a mounting problem that does not exist.
  if (store.domIndex.getElement(node)) {
    return "Node renders as an SVG element, which has no layout box to measure; use its stored geometry instead.";
  }
  return "Node is not mounted in this window, so its layout size cannot be measured.";
}

/** `width×height` for tree summaries, keeping authored intent next to the measured box. */
export function formatReportedDimension(size: ReportedSize, key: DimensionKey) {
  const value = size[key];
  const authored = key === "width" ? size.authoredWidth : size.authoredHeight;
  const measured = value === null ? "?" : String(value);
  return authored ? `${authored}→${measured}` : measured;
}

type TextLayoutMetrics = {
  boxHeight: number;
  boxWidth: number;
  contentHeight: number;
  contentWidth: number;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  overflowX: boolean;
  overflowY: boolean;
};

export function getMcpNodeType(store: EditorStore, node: DesignNode) {
  return node.isArtboard && !store.parentMap.has(node.id) ? "artboard" : node.type;
}

function getMcpNodePlacement(store: EditorStore, node: DesignNode) {
  const parentId = store.parentMap.get(node.id) ?? null;
  const canvas = store.getCanvasPosition(node.id) ?? { x: node.x, y: node.y };
  return {
    canvas,
    coordinateSpace: parentId ? ("parent" as const) : ("canvas" as const),
    nodeType: node.type,
    parentId,
  };
}

/**
 * Fraction of one line-height treated as measurement noise rather than real
 * vertical overflow. Line-box rounding and font metrics (glyph ascent/descent
 * extending past the specified line box) report single-line display text a few
 * percent taller than its box even though nothing is visually clipped, and
 * that excess scales with line-height — so flagging it as overflow sends
 * agents into line-height repair loops that can never converge. Real overflow
 * (a lost wrapped line, or a box resized into the text) exceeds this slack by
 * a wide margin. `contentHeight` itself stays the exact measured value.
 */
const TEXT_OVERFLOW_LINE_HEIGHT_TOLERANCE = 0.1;

/** Resolve a reported CSS line-height to pixels for overflow-slack purposes. */
function resolveLineHeightPx(lineHeight: string, fontSizePx: number): number {
  const trimmed = lineHeight.trim();
  const parsed = Number.parseFloat(trimmed);
  if (Number.isFinite(parsed) && parsed > 0) {
    if (trimmed.endsWith("px")) return parsed;
    if (/^[\d.]+$/.test(trimmed)) return parsed * fontSizePx;
  }
  // "normal" and unresolved values sit near the browser default multiplier.
  return 1.2 * fontSizePx;
}

export function getTextLayoutMetrics(
  store: EditorStore,
  node: DesignNode,
): TextLayoutMetrics | null {
  if (node.type !== "text") return null;
  const element = store.domIndex.getElement(node);
  const content = element?.querySelector<HTMLElement>("[data-text-content]");
  if (!element || !content) return null;

  // offsetWidth/offsetHeight are the border-box dimensions promised by the
  // MCP contract. client* excludes borders and must only be a fallback for
  // synthetic DOMs that do not expose usable offset metrics.
  const boxWidth = element.offsetWidth || element.clientWidth;
  const boxHeight = element.offsetHeight || element.clientHeight;
  const contentClientWidth = content.clientWidth || boxWidth;
  const contentClientHeight = content.clientHeight || boxHeight;
  const contentWidth = Math.max(contentClientWidth, content.scrollWidth);
  const contentHeight = Math.max(contentClientHeight, content.scrollHeight);
  const computed = content.ownerDocument.defaultView?.getComputedStyle(content);
  const fontSize = computed?.fontSize ?? `${node.fontSize}px`;
  const lineHeight = computed?.lineHeight ?? String(node.styles.lineHeight ?? "normal");
  const parsedFontSize = Number.parseFloat(fontSize);
  const fontSizePx =
    Number.isFinite(parsedFontSize) && parsedFontSize > 0 ? parsedFontSize : node.fontSize;
  const overflowSlackY = Math.max(
    0.5,
    resolveLineHeightPx(lineHeight, fontSizePx) * TEXT_OVERFLOW_LINE_HEIGHT_TOLERANCE,
  );

  return {
    boxHeight,
    boxWidth,
    contentHeight,
    contentWidth,
    fontFamily: computed?.fontFamily ?? node.fontFamily,
    fontSize,
    fontWeight: computed?.fontWeight ?? node.fontWeight,
    lineHeight,
    overflowX: contentWidth > boxWidth + 0.5,
    overflowY: contentHeight > boxHeight + overflowSlackY,
  };
}

function formatMcpCoordinate(value: number) {
  const rounded = Math.round(value * 100) / 100;
  return String(rounded);
}

/**
 * Placement for a summary line, or null when it carries no information: roots
 * report their canvas position, positioned children report their model offset
 * in parent space (the space move_nodes' coordinateSpace:"parent" uses), and
 * unpositioned normal-flow children — the overwhelming majority — report
 * nothing. Full explicit placement stays on get_node_info and find_nodes.
 */
export function formatCompactMcpNodePlacement(store: EditorStore, node: DesignNode) {
  const placement = getMcpNodePlacement(store, node);
  if (!placement.parentId) {
    return `canvas (${formatMcpCoordinate(placement.canvas.x)}, ${formatMcpCoordinate(placement.canvas.y)})`;
  }
  // A relative/sticky child offset purely through authored left/top/inset has
  // model x/y of 0 but does not sit at its flow position. The model cannot
  // express the rendered offset, so flag it instead of staying silent and
  // letting an agent read the node as unmoved; get_node_info reports the true
  // canvas coordinates.
  const { styles } = node;
  const hasOffsetKeys =
    styles.left !== undefined ||
    styles.top !== undefined ||
    styles.right !== undefined ||
    styles.bottom !== undefined ||
    Object.keys(styles).some((key) => key.startsWith("inset"));
  const hasAuthoredOffset =
    hasOffsetKeys && (styles.position === "relative" || styles.position === "sticky");
  if (node.x !== 0 || node.y !== 0 || styles.position === "absolute" || hasAuthoredOffset) {
    const offsetSuffix = hasAuthoredOffset ? " +css-offset" : "";
    return `parent (${formatMcpCoordinate(node.x)}, ${formatMcpCoordinate(node.y)})${offsetSuffix}`;
  }
  return null;
}

/** A node whose geometry a read tool is about to report. */
type MeasurementTarget = {
  node: DesignNode;
  /** Text metrics always come from the DOM, so they always need the node mounted. */
  withTextLayout?: boolean;
};

/** Whether every node in this subtree currently has a mounted element. */
function isSubtreeMounted(store: EditorStore, node: DesignNode): boolean {
  // A hidden node never renders, so retaining it cannot mount anything.
  if (node.visible === false) return true;
  if (!store.domIndex.getElement(node)) return false;
  return node.children.every((child) => isSubtreeMounted(store, child));
}

function needsMountToReport(store: EditorStore, { node, withTextLayout }: MeasurementTarget) {
  const readsDom =
    (withTextLayout === true && node.type === "text") ||
    store.isFlowChild(node.id) || // canvas placement is measured, not accumulated
    !isModelSizedDimension(store, node, "width") ||
    !isModelSizedDimension(store, node, "height");
  if (!readsDom) return false;
  // An auto-sized box is sized by its descendants, so a mounted node with a
  // culled child still measures short.
  return !isSubtreeMounted(store, node);
}

/**
 * Mount whatever the caller is about to measure, then run `fn` inside a
 * measuring window.
 *
 * Two culling layers hide off-screen geometry from measurement: nodes can be
 * absent from the DOM entirely (shell or hidden render modes), and mounted
 * nodes can have their layout skipped by `content-visibility: auto`. Forced
 * render retention mounts the subtree, the settle frames let React commit it,
 * and the measuring window suspends content-visibility culling so every
 * synchronous read inside `fn` sees real layout.
 *
 * Retention is scoped to the targets that actually read the DOM and are not
 * already mounted, and a retained ancestor covers its descendants, so reporting
 * a document of explicitly sized artboards costs no forced render at all.
 */
export async function withMeasuredNodes<T>(
  store: EditorStore,
  targets: readonly MeasurementTarget[],
  fn: () => T,
): Promise<T> {
  const retainedIds = collectForcedRenderRoots(store, targets);
  if (retainedIds.length > 0) {
    runInAction(() => {
      for (const nodeId of retainedIds) store.retainForcedRender(nodeId);
    });
  }
  try {
    if (retainedIds.length > 0) await waitForAnimationFrames(2);
    const scope = targets
      .map((target) => store.domIndex.getElement(target.node))
      .find((element): element is HTMLElement => element !== undefined);
    return measureWithVisibleLayout(scope ?? document, fn);
  } finally {
    if (retainedIds.length > 0) {
      runInAction(() => {
        for (const nodeId of retainedIds) store.releaseForcedRender(nodeId);
      });
    }
  }
}

function collectForcedRenderRoots(store: EditorStore, targets: readonly MeasurementTarget[]) {
  const pendingIds = new Set<string>();
  const hasPendingAncestor = (nodeId: string) => {
    // Guarded the same way as `isAncestorOf`: a corrupt parent map must not
    // spin this walk forever on the renderer's own thread.
    const seen = new Set<string>([nodeId]);
    let ancestorId = store.parentMap.get(nodeId);
    while (ancestorId && !seen.has(ancestorId)) {
      if (pendingIds.has(ancestorId)) return true;
      seen.add(ancestorId);
      ancestorId = store.parentMap.get(ancestorId);
    }
    return false;
  };

  for (const target of targets) {
    // Retention covers the whole subtree, so a pending ancestor already mounts
    // this node and its subtree-mount walk can be skipped outright.
    if (hasPendingAncestor(target.node.id)) continue;
    if (needsMountToReport(store, target)) pendingIds.add(target.node.id);
  }

  // Targets arrive parent-first for tree reads, but not for every caller.
  return [...pendingIds].filter((nodeId) => !hasPendingAncestor(nodeId));
}

/** Every node a read tool will describe, down to `maxDepth` levels of children. */
export function collectSubtreeTargets(
  node: DesignNode,
  maxDepth: number,
  withTextLayout: boolean,
  targets: MeasurementTarget[] = [],
  depth = 0,
) {
  targets.push({ node, withTextLayout });
  if (depth < maxDepth) {
    for (const child of node.children) {
      collectSubtreeTargets(child, maxDepth, withTextLayout, targets, depth + 1);
    }
  }
  return targets;
}

async function measureMountedTextNodes(store: EditorStore, nodeIds: string[]) {
  const uniqueIds = [...new Set(nodeIds)];
  const nodes = uniqueIds.map((nodeId) => {
    const node = store.getNode(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    if (node.type !== "text") throw new Error(`Node ${nodeId} is not a text node`);
    return node;
  });

  for (const node of nodes) store.retainForcedRender(node.id);
  try {
    await waitForAnimationFrames(2);
    await document.fonts?.ready;
    await waitForAnimationFrames(2);
    const scope = nodes
      .map((node) => store.domIndex.getElement(node))
      .find((element): element is HTMLElement => element !== undefined);
    return measureWithVisibleLayout(scope ?? document, () =>
      Object.fromEntries(
        nodes.map((node) => {
          const metrics = getTextLayoutMetrics(store, node);
          if (!metrics) {
            throw new Error(
              `Text node ${node.id} exists but its rendered content is not mounted in this window`,
            );
          }
          return [node.id, { ...metrics, text: node.content }];
        }),
      ),
    );
  } finally {
    for (const node of nodes) store.releaseForcedRender(node.id);
  }
}

export async function measureTextNodes(store: EditorStore, nodeIds: string[]) {
  const pageGroups = new Map<string, string[]>();
  for (const nodeId of new Set(nodeIds)) {
    const node = store.getNode(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    if (node.type !== "text") throw new Error(`Node ${nodeId} is not a text node`);
    const pageId = store.getPageIdForNode(nodeId);
    if (!pageId) throw new Error(`Cannot resolve page for text node: ${nodeId}`);
    const group = pageGroups.get(pageId) ?? [];
    group.push(nodeId);
    pageGroups.set(pageId, group);
  }

  const measured: Record<string, TextLayoutMetrics & { text: string }> = {};
  for (const [pageId, groupNodeIds] of pageGroups) {
    const pageMetrics = await withMcpPageRenderStore(store, pageId, (renderStore) =>
      measureMountedTextNodes(renderStore, groupNodeIds),
    );
    Object.assign(measured, pageMetrics);
  }
  return measured;
}

export function requirePage(store: EditorStore, pageId: string): EditorPage {
  const page = store.pages.find((candidate) => candidate.id === pageId);
  if (!page) throw new Error(`Page not found: ${pageId}`);
  return page;
}

export function countNodes(roots: readonly DesignNode[]): number {
  let count = 0;
  const pending = [...roots];
  while (pending.length > 0) {
    const node = pending.pop()!;
    count += 1;
    pending.push(...node.children);
  }
  return count;
}

export function resolvePageScope(
  store: EditorStore,
  params: Record<string, unknown>,
): { allPages: boolean; pages: EditorPage[] } {
  const pageId = params.pageId as string | undefined;
  const allPages = params.allPages === true;
  if (pageId && allPages) {
    throw new Error("pageId and allPages cannot be combined.");
  }
  return {
    allPages,
    pages: allPages ? [...store.pages] : [pageId ? requirePage(store, pageId) : store.activePage],
  };
}

/**
 * The shared per-node envelope for find_nodes, creation, and move results.
 * Placement stays explicit (x/y are model coordinates in coordinateSpace;
 * canvasX/canvasY are the canvas-space position), but default-valued fields
 * are omitted rather than echoed on every node: visible only when hidden,
 * locked only when locked, nodeType only when it differs from the reported
 * type, and canvasX/canvasY only when they differ from x/y (they coincide for
 * canvas-space roots).
 */
export function serializeNodeForMcp(store: EditorStore, node: DesignNode) {
  const placement = getMcpNodePlacement(store, node);
  const { visible, ...base } = serializeNode(node);
  const type = getMcpNodeType(store, node);
  return {
    ...base,
    type,
    ...(placement.nodeType !== type ? { nodeType: placement.nodeType } : {}),
    parentId: placement.parentId,
    coordinateSpace: placement.coordinateSpace,
    ...(placement.canvas.x !== node.x || placement.canvas.y !== node.y
      ? { canvasX: placement.canvas.x, canvasY: placement.canvas.y }
      : {}),
    ...(visible ? {} : { visible }),
    ...(node.locked === true ? { locked: true } : {}),
    pageId: store.getPageIdForNode(node.id),
    ...getReportedSize(store, node),
  };
}

export type McpImageGenerationStatus = {
  status: "processing" | "ready" | "failed";
  error?: string;
  target?: "image" | "background";
  startedAt?: number;
  elapsedMs?: number;
};

/**
 * Compact generation lifecycle for one node: the durable metadata wins, the
 * renderer-local job fills in for a peer-less in-flight request, and `null`
 * means the node never carried generated imagery. Cheap enough to poll.
 */
export function getMcpImageGenerationStatus(
  store: EditorStore,
  node: DesignNode,
  now = Date.now(),
): McpImageGenerationStatus | null {
  const metadata = node.imageGeneration;
  const job = store.generatedImageJobs.get(node.id);
  if (!metadata && !job) return null;
  const durable = metadata
    ? (metadata.status ?? (node.imageAsset ? "ready" : "generating"))
    : job!.status;
  const status = durable === "generating" ? ("processing" as const) : durable;
  const error = metadata?.error ?? job?.error;
  const target = metadata?.target ?? job?.target;
  const startedAt = metadata?.startedAt;
  return {
    status,
    ...(error ? { error } : {}),
    ...(target ? { target } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(startedAt && status === "processing" ? { elapsedMs: Math.max(0, now - startedAt) } : {}),
  };
}

export function serializeNodeFullForMcp(store: EditorStore, node: DesignNode) {
  const placement = getMcpNodePlacement(store, node);
  const textLayout = getTextLayoutMetrics(store, node);
  const generationJob = store.generatedImageJobs.get(node.id);
  const generationMetadata = node.imageGeneration;
  const durableStatus = generationMetadata?.status ?? (node.imageAsset ? "ready" : "generating");
  const imageGeneration = generationMetadata
    ? {
        ...generationMetadata,
        status: durableStatus === "generating" ? ("processing" as const) : durableStatus,
        output: "raster" as const,
      }
    : generationJob
      ? {
          status:
            generationJob.status === "generating" ? ("processing" as const) : generationJob.status,
          output: generationJob.output ?? ("raster" as const),
          prompt: generationJob.prompt,
          ...(generationJob.target ? { target: generationJob.target } : {}),
          ...(generationJob.error ? { error: generationJob.error } : {}),
        }
      : null;
  return {
    ...serializeNodeFull(node),
    type: getMcpNodeType(store, node),
    nodeType: placement.nodeType,
    parentId: placement.parentId,
    coordinateSpace: placement.coordinateSpace,
    canvasX: placement.canvas.x,
    canvasY: placement.canvas.y,
    locked: node.locked === true,
    pageId: store.getPageIdForNode(node.id),
    ...getReportedSize(store, node),
    ...(textLayout ? { textLayout } : {}),
    ...(imageGeneration ? { imageGeneration } : {}),
  };
}

type PlacementWarning = {
  kind: "overlap" | "insufficient-gap";
  pageId: string;
  nodeId: string;
  otherNodeId: string;
  area?: number;
  intersection?: { x: number; y: number; width: number; height: number };
  axis?: "horizontal" | "vertical";
  gap?: number;
  message: string;
};

// Browser layout commonly reports an authored 80px gap as 79.9999px after
// camera transforms. Treat subpixel noise as equal while preserving warnings
// for materially underspaced roots.
const PLACEMENT_WARNING_TOLERANCE = 0.5;

function getPlacementWarnings(layout: CanvasLayoutDiagnostics, nodeIds: ReadonlySet<string>) {
  const overlaps: PlacementWarning[] = layout.overlaps.flatMap((overlap) => {
    const firstTracked = nodeIds.has(overlap.firstNodeId);
    const secondTracked = nodeIds.has(overlap.secondNodeId);
    if (!firstTracked && !secondTracked) return [];
    const nodeId = firstTracked ? overlap.firstNodeId : overlap.secondNodeId;
    const otherNodeId = firstTracked ? overlap.secondNodeId : overlap.firstNodeId;
    return [
      {
        kind: "overlap",
        pageId: layout.pageId,
        nodeId,
        otherNodeId,
        area: overlap.area,
        intersection: overlap.intersection,
        message: `Node ${nodeId} overlaps ${otherNodeId} by ${overlap.intersection.width}×${overlap.intersection.height} canvas pixels.`,
      },
    ];
  });
  const horizontalGaps: PlacementWarning[] = layout.gaps.horizontal.flatMap((entry) => {
    if (entry.gap + PLACEMENT_WARNING_TOLERANCE >= ROOT_PLACEMENT_GAP) return [];
    const leftTracked = nodeIds.has(entry.leftNodeId);
    const rightTracked = nodeIds.has(entry.rightNodeId);
    if (!leftTracked && !rightTracked) return [];
    const nodeId = leftTracked ? entry.leftNodeId : entry.rightNodeId;
    const otherNodeId = leftTracked ? entry.rightNodeId : entry.leftNodeId;
    return [
      {
        kind: "insufficient-gap",
        pageId: layout.pageId,
        nodeId,
        otherNodeId,
        axis: "horizontal",
        gap: entry.gap,
        message: `Node ${nodeId} has only ${entry.gap}px horizontal space from ${otherNodeId}; the root spacing rule is ${ROOT_PLACEMENT_GAP}px.`,
      },
    ];
  });
  const verticalGaps: PlacementWarning[] = layout.gaps.vertical.flatMap((entry) => {
    if (entry.gap + PLACEMENT_WARNING_TOLERANCE >= ROOT_PLACEMENT_GAP) return [];
    const topTracked = nodeIds.has(entry.topNodeId);
    const bottomTracked = nodeIds.has(entry.bottomNodeId);
    if (!topTracked && !bottomTracked) return [];
    const nodeId = topTracked ? entry.topNodeId : entry.bottomNodeId;
    const otherNodeId = topTracked ? entry.bottomNodeId : entry.topNodeId;
    return [
      {
        kind: "insufficient-gap",
        pageId: layout.pageId,
        nodeId,
        otherNodeId,
        axis: "vertical",
        gap: entry.gap,
        message: `Node ${nodeId} has only ${entry.gap}px vertical space from ${otherNodeId}; the root spacing rule is ${ROOT_PLACEMENT_GAP}px.`,
      },
    ];
  });
  return [...overlaps, ...horizontalGaps, ...verticalGaps];
}

export async function collectPlacementWarnings(
  store: EditorStore,
  nodes: readonly DesignNode[],
): Promise<PlacementWarning[]> {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const pageIds = [
    ...new Set(
      nodes
        .map((node) => store.getPageIdForNode(node.id))
        .filter((pageId): pageId is string => pageId !== null),
    ),
  ];
  const layouts = await Promise.all(pageIds.map((pageId) => measureCanvasLayout(store, pageId)));
  return layouts.flatMap((layout) => getPlacementWarnings(layout, nodeIds));
}

export function isAncestorOf(store: EditorStore, ancestorId: string, nodeId: string): boolean {
  let current: DesignNode | undefined = store.getNode(nodeId);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    if (current.id === ancestorId) return true;
    seen.add(current.id);
    current = store.getParent(current.id);
  }
  return false;
}
