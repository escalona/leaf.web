import { runInAction } from "mobx";
import { measureMountedRootCanvasAabbs } from "../../core/editor/root-placement";
import type { EditorStore } from "../../core/state/EditorStore";
import type { DesignNode, EditorPage, Rect } from "../../core/types";
import { GENERIC_NODE_NAME_PATTERN } from "./generic-names";
import { rootHasModelDerivableCanvasAabb } from "./model-dimensions";
import { withMcpPageRenderStore } from "../../ui/render/render-replica";
import { waitForAnimationFrames } from "../../ui/render/render-settle";

export type CanvasLayoutStoredPlacement = {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
};

export type CanvasLayoutRoot = {
  id: string;
  name: string;
  type: DesignNode["type"];
  isArtboard: boolean;
  visible: boolean;
  locked: boolean;
  canvasX: number;
  canvasY: number;
  renderedWidth: number;
  renderedHeight: number;
  liveCanvasAabb: Rect | null;
  storedPlacement: CanvasLayoutStoredPlacement;
  boundsSource: "live" | "stored";
};

export type CanvasLayoutOverlap = {
  firstNodeId: string;
  secondNodeId: string;
  intersection: Rect;
  area: number;
};

export type CanvasLayoutHorizontalGap = {
  leftNodeId: string;
  rightNodeId: string;
  gap: number;
  verticalOverlap: number;
};

export type CanvasLayoutVerticalGap = {
  topNodeId: string;
  bottomNodeId: string;
  gap: number;
  horizontalOverlap: number;
};

export type CanvasLayoutGenericNameLint = {
  nodeId: string;
  rootId: string;
  name: string;
  type: DesignNode["type"];
  reason: "empty" | "default";
};

export type CanvasLayoutGenericNameSummary = {
  count: number;
  examples: CanvasLayoutGenericNameLint[];
  hint: string | null;
};

export type CanvasLayoutUnlockedSourceImageLint = {
  nodeId: string;
  rootId: string;
  name: string;
  assetId: string;
  sourceName: string | null;
};

export type CanvasLayoutDiagnostics = {
  pageId: string;
  pageName: string;
  active: boolean;
  roots: CanvasLayoutRoot[];
  overlaps: CanvasLayoutOverlap[];
  gaps: {
    horizontal: CanvasLayoutHorizontalGap[];
    vertical: CanvasLayoutVerticalGap[];
  };
  lint: {
    genericNames: CanvasLayoutGenericNameSummary;
    unlockedSourceImages: CanvasLayoutUnlockedSourceImageLint[];
  };
};

export type CanvasLayoutAnalysisOptions = {
  /** Include every generic-name finding instead of the capped example list. */
  verboseLint?: boolean;
};

export type CanvasLayoutLiveBounds = Readonly<Record<string, Rect | null | undefined>>;

type RootWithAnalysisBounds = CanvasLayoutRoot & {
  analysisBounds: Rect;
};

const GENERIC_NAME_LINT_EXAMPLE_LIMIT = 5;

function finiteRect(rect: Rect | null | undefined): Rect | null {
  if (
    !rect ||
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width < 0 ||
    rect.height < 0
  ) {
    return null;
  }
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/**
 * Convert stored root placement into a canvas-axis-aligned box.
 *
 * Stored placement is kept separately in the result because rotation makes the
 * AABB origin and dimensions different from the model's x/y/width/height.
 * Authored CSS transforms cannot be reconstructed from model fields, so live
 * DOM measurement remains authoritative whenever it is available.
 */
export function getStoredCanvasAabb(placement: CanvasLayoutStoredPlacement): Rect {
  const { x, y, width, height } = placement;
  const rotation = ((placement.rotation % 360) + 360) % 360;
  if (rotation === 0 || width === 0 || height === 0) {
    return { x, y, width, height };
  }

  const radians = (rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const centerX = x + width / 2;
  const centerY = y + height / 2;
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const aabbHalfWidth = Math.abs(halfWidth * cos) + Math.abs(halfHeight * sin);
  const aabbHalfHeight = Math.abs(halfWidth * sin) + Math.abs(halfHeight * cos);

  return {
    x: centerX - aabbHalfWidth,
    y: centerY - aabbHalfHeight,
    width: aabbHalfWidth * 2,
    height: aabbHalfHeight * 2,
  };
}

function intersectRects(first: Rect, second: Rect): Rect | null {
  const left = Math.max(first.x, second.x);
  const top = Math.max(first.y, second.y);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const bottom = Math.min(first.y + first.height, second.y + second.height);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function intervalOverlap(
  firstStart: number,
  firstSize: number,
  secondStart: number,
  secondSize: number,
) {
  return (
    Math.min(firstStart + firstSize, secondStart + secondSize) - Math.max(firstStart, secondStart)
  );
}

/**
 * A gap pair is reported only when the pair is adjacent: no third root sits
 * inside the open span between them while also crossing the band the two
 * roots share on the other axis. Distant same-row pairs separated by other
 * roots are derivable from the adjacent gaps and only inflate the payload.
 * Callers pass visible roots only: a hidden root is invisible in every
 * screenshot, so it must neither appear in a gap entry nor suppress the
 * adjacency of the visible pair around it.
 */
function isGapBlocked(
  roots: readonly RootWithAnalysisBounds[],
  first: RootWithAnalysisBounds,
  second: RootWithAnalysisBounds,
  axis: "horizontal" | "vertical",
): boolean {
  const [gapStart, gapEnd] =
    axis === "horizontal"
      ? [
          Math.min(
            first.analysisBounds.x + first.analysisBounds.width,
            second.analysisBounds.x + second.analysisBounds.width,
          ),
          Math.max(first.analysisBounds.x, second.analysisBounds.x),
        ]
      : [
          Math.min(
            first.analysisBounds.y + first.analysisBounds.height,
            second.analysisBounds.y + second.analysisBounds.height,
          ),
          Math.max(first.analysisBounds.y, second.analysisBounds.y),
        ];
  const gapSize = gapEnd - gapStart;
  if (gapSize <= 0) return false;

  const bandStart =
    axis === "horizontal"
      ? Math.max(first.analysisBounds.y, second.analysisBounds.y)
      : Math.max(first.analysisBounds.x, second.analysisBounds.x);
  const bandEnd =
    axis === "horizontal"
      ? Math.min(
          first.analysisBounds.y + first.analysisBounds.height,
          second.analysisBounds.y + second.analysisBounds.height,
        )
      : Math.min(
          first.analysisBounds.x + first.analysisBounds.width,
          second.analysisBounds.x + second.analysisBounds.width,
        );

  for (const middle of roots) {
    if (middle === first || middle === second) continue;
    const alongGap =
      axis === "horizontal"
        ? intervalOverlap(middle.analysisBounds.x, middle.analysisBounds.width, gapStart, gapSize)
        : intervalOverlap(middle.analysisBounds.y, middle.analysisBounds.height, gapStart, gapSize);
    if (alongGap <= 0) continue;
    const acrossBand =
      axis === "horizontal"
        ? intervalOverlap(
            middle.analysisBounds.y,
            middle.analysisBounds.height,
            bandStart,
            bandEnd - bandStart,
          )
        : intervalOverlap(
            middle.analysisBounds.x,
            middle.analysisBounds.width,
            bandStart,
            bandEnd - bandStart,
          );
    if (acrossBand > 0) return true;
  }
  return false;
}

function collectGenericNameLints(roots: readonly DesignNode[]) {
  const findings: CanvasLayoutGenericNameLint[] = [];

  const visit = (node: DesignNode, rootId: string) => {
    const name = node.name.trim();
    if (!name) {
      findings.push({ nodeId: node.id, rootId, name: node.name, type: node.type, reason: "empty" });
    } else if (GENERIC_NODE_NAME_PATTERN.test(name)) {
      findings.push({
        nodeId: node.id,
        rootId,
        name: node.name,
        type: node.type,
        reason: "default",
      });
    }
    for (const child of node.children) visit(child, rootId);
  };

  for (const root of roots) visit(root, root.id);
  return findings;
}

function summarizeGenericNameLints(
  findings: CanvasLayoutGenericNameLint[],
  verbose: boolean,
): CanvasLayoutGenericNameSummary {
  const truncated = !verbose && findings.length > GENERIC_NAME_LINT_EXAMPLE_LIMIT;
  return {
    count: findings.length,
    examples: truncated ? findings.slice(0, GENERIC_NAME_LINT_EXAMPLE_LIMIT) : findings,
    hint:
      findings.length === 0
        ? null
        : `${truncated ? `Showing ${GENERIC_NAME_LINT_EXAMPLE_LIMIT} of ${findings.length} findings (pass verboseLint:true for all). ` : ""}Name layers inline with layer-name="…" attributes during write_html, or rename_nodes afterward.`,
  };
}

function collectUnlockedSourceImageLints(roots: readonly DesignNode[]) {
  const findings: CanvasLayoutUnlockedSourceImageLint[] = [];
  const visit = (node: DesignNode, rootId: string) => {
    if (node.type === "image" && node.imageAsset && node.locked !== true) {
      findings.push({
        nodeId: node.id,
        rootId,
        name: node.name,
        assetId: node.imageAsset.assetId,
        sourceName: node.imageAsset.sourceName ?? null,
      });
    }
    for (const child of node.children) visit(child, rootId);
  };

  for (const root of roots) visit(root, root.id);
  return findings;
}

/**
 * Pure page-layout analysis. Callers without a DOM can omit `liveCanvasBounds`;
 * every relationship then falls back to the rotation-aware stored root AABB.
 */
export function analyzeCanvasLayout(
  page: Pick<EditorPage, "id" | "name" | "nodes">,
  activePageId: string,
  liveCanvasBounds: CanvasLayoutLiveBounds = {},
  options: CanvasLayoutAnalysisOptions = {},
): CanvasLayoutDiagnostics {
  const analyzedRoots: RootWithAnalysisBounds[] = page.nodes.map((node) => {
    const storedPlacement: CanvasLayoutStoredPlacement = {
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      rotation: node.rotation ?? 0,
    };
    const storedBounds = getStoredCanvasAabb(storedPlacement);
    const liveCanvasAabb = finiteRect(liveCanvasBounds[node.id]);
    const analysisBounds = liveCanvasAabb ?? storedBounds;

    return {
      id: node.id,
      name: node.name,
      type: node.type,
      isArtboard: node.isArtboard,
      visible: node.visible !== false,
      locked: node.locked === true,
      canvasX: analysisBounds.x,
      canvasY: analysisBounds.y,
      renderedWidth: analysisBounds.width,
      renderedHeight: analysisBounds.height,
      liveCanvasAabb,
      storedPlacement,
      boundsSource: liveCanvasAabb ? "live" : "stored",
      analysisBounds,
    };
  });

  const overlaps: CanvasLayoutOverlap[] = [];
  for (let firstIndex = 0; firstIndex < analyzedRoots.length; firstIndex += 1) {
    const first = analyzedRoots[firstIndex]!;
    for (let secondIndex = firstIndex + 1; secondIndex < analyzedRoots.length; secondIndex += 1) {
      const second = analyzedRoots[secondIndex]!;
      const intersection = intersectRects(first.analysisBounds, second.analysisBounds);
      if (intersection) {
        overlaps.push({
          firstNodeId: first.id,
          secondNodeId: second.id,
          intersection,
          area: intersection.width * intersection.height,
        });
      }
    }
  }

  // Overlaps above include hidden roots on purpose (latent collisions).
  // Gap adjacency is a visual-spacing report, so it runs over visible roots
  // only — see isGapBlocked.
  const visibleRoots = analyzedRoots.filter((root) => root.visible);
  const horizontalGaps: CanvasLayoutHorizontalGap[] = [];
  const verticalGaps: CanvasLayoutVerticalGap[] = [];
  for (let firstIndex = 0; firstIndex < visibleRoots.length; firstIndex += 1) {
    const first = visibleRoots[firstIndex]!;
    for (let secondIndex = firstIndex + 1; secondIndex < visibleRoots.length; secondIndex += 1) {
      const second = visibleRoots[secondIndex]!;
      if (intersectRects(first.analysisBounds, second.analysisBounds)) continue;

      const verticalOverlap = intervalOverlap(
        first.analysisBounds.y,
        first.analysisBounds.height,
        second.analysisBounds.y,
        second.analysisBounds.height,
      );
      if (verticalOverlap > 0 && !isGapBlocked(visibleRoots, first, second, "horizontal")) {
        const [left, right] =
          first.analysisBounds.x <= second.analysisBounds.x ? [first, second] : [second, first];
        horizontalGaps.push({
          leftNodeId: left.id,
          rightNodeId: right.id,
          gap: Math.max(
            0,
            right.analysisBounds.x - (left.analysisBounds.x + left.analysisBounds.width),
          ),
          verticalOverlap,
        });
      }

      const horizontalOverlap = intervalOverlap(
        first.analysisBounds.x,
        first.analysisBounds.width,
        second.analysisBounds.x,
        second.analysisBounds.width,
      );
      if (horizontalOverlap > 0 && !isGapBlocked(visibleRoots, first, second, "vertical")) {
        const [top, bottom] =
          first.analysisBounds.y <= second.analysisBounds.y ? [first, second] : [second, first];
        verticalGaps.push({
          topNodeId: top.id,
          bottomNodeId: bottom.id,
          gap: Math.max(
            0,
            bottom.analysisBounds.y - (top.analysisBounds.y + top.analysisBounds.height),
          ),
          horizontalOverlap,
        });
      }
    }
  }

  return {
    pageId: page.id,
    pageName: page.name,
    active: page.id === activePageId,
    roots: analyzedRoots.map(({ analysisBounds: _analysisBounds, ...root }) => root),
    overlaps,
    gaps: {
      horizontal: horizontalGaps,
      vertical: verticalGaps,
    },
    lint: {
      genericNames: summarizeGenericNameLints(
        collectGenericNameLints(page.nodes),
        options.verboseLint === true,
      ),
      unlockedSourceImages: collectUnlockedSourceImageLints(page.nodes),
    },
  };
}

/**
 * Culling-safe renderer measurement for every root on a page.
 *
 * The page's roots are retained together so auto-sized roots include their
 * complete subtrees. DOM reads then run in one visible-layout window, avoiding
 * the content-visibility skip-state races caused by toggling individual
 * elements. Inactive or unmounted pages use an isolated render replica and
 * never change the user's active page.
 */
export async function measureCanvasLayout(
  store: EditorStore,
  pageId = store.activePageId,
  options: CanvasLayoutAnalysisOptions = {},
): Promise<CanvasLayoutDiagnostics> {
  const page = store.pages.find((candidate) => candidate.id === pageId);
  if (!page) throw new Error(`Page not found: ${pageId}`);
  if (typeof document === "undefined") {
    return analyzeCanvasLayout(page, store.activePageId, {}, options);
  }

  // Live rendered AABBs only differ from rotation-aware stored AABBs for
  // auto-sized or CSS-transformed roots. When every visible root is
  // model-derivable — the common all-explicit-artboards page — skip the DOM
  // (and, for background documents, the render replica build) entirely.
  const everyVisibleRootIsModelDerivable = page.nodes.every(
    (node) => node.visible === false || rootHasModelDerivableCanvasAabb(store, node),
  );
  if (everyVisibleRootIsModelDerivable) {
    return analyzeCanvasLayout(page, store.activePageId, {}, options);
  }

  const sourceActivePageId = store.activePageId;
  return await withMcpPageRenderStore(store, pageId, async (renderStore) => {
    const renderPage = renderStore.pages.find((candidate) => candidate.id === pageId);
    if (!renderPage) throw new Error(`Page not found: ${pageId}`);
    const retainedIds = renderPage.nodes.map((node) => node.id);
    runInAction(() => {
      for (const nodeId of retainedIds) renderStore.retainForcedRender(nodeId);
    });

    try {
      if (retainedIds.length > 0) await waitForAnimationFrames(2);
      await document.fonts?.ready;
      if (retainedIds.length > 0) await waitForAnimationFrames(1);

      const liveBounds = Object.fromEntries(
        measureMountedRootCanvasAabbs(renderStore, renderPage.nodes),
      );
      return analyzeCanvasLayout(renderPage, sourceActivePageId, liveBounds, options);
    } finally {
      runInAction(() => {
        for (const nodeId of retainedIds) renderStore.releaseForcedRender(nodeId);
      });
    }
  });
}
