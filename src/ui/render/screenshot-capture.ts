import { runInAction } from "mobx";
import { measureWithVisibleLayout } from "../../core/editor/forced-layout";
import { resolveOverflowAxes } from "../../core/editor/node-overflow";
import type { EditorStore } from "../../core/state/EditorStore";
import { isSharedAssetUrl, resolveImageAssetUrl } from "../../core/state/image-assets";
import type { DesignNode } from "../../core/types";
import { withMcpPageRenderStore } from "./render-replica";
import {
  waitForAnimationFrames,
  waitForPaintedFrameIfVisible,
  withRenderSettleTimeout,
} from "./render-settle";
import { assertScreenshotCaptureWithinLimits } from "./screenshot-limits";

let snapdomLoad: Promise<typeof import("@zumer/snapdom").snapdom> | null = null;

function stripRootCanvasPlacement(root: HTMLElement) {
  const rootLeft = root.style.left.trim();
  const rootTop = root.style.top.trim();
  const isAutoPlacedAbsoluteNode =
    root.style.position === "absolute" &&
    (rootLeft === "" || rootLeft === "0px") &&
    (rootTop === "" || rootTop === "0px");
  if (!isAutoPlacedAbsoluteNode) return;

  root.style.position = "relative";
  root.style.left = "0px";
  root.style.top = "0px";

  const transform = root.style.transform.trim();
  // Renderer placement may be rounded, so remove the clone's actual leading translate.
  const placement = /^translate\(\s*-?\d+(?:\.\d+)?px\s*,\s*-?\d+(?:\.\d+)?px\s*\)/.exec(transform);
  if (!placement) return;

  const remainingTransform = transform.slice(placement[0].length).trim();
  if (remainingTransform) {
    root.style.transform = remainingTransform;
  } else {
    root.style.removeProperty("transform");
  }
}

function getNodeClipAxes(node: DesignNode) {
  // Resolve each axis independently so one clipped axis does not hide
  // warnings on a visible one. `auto`/`scroll` count as non-clipping here on
  // purpose: scrollable overflow is reachable, so it should not warn.
  const { x, y } = resolveOverflowAxes(node);
  const clips = (value: string | undefined) => value === "hidden" || value === "clip";

  return {
    horizontal: clips(x),
    vertical: clips(y),
  };
}

function formatBoundsCoordinate(value: number) {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/\.?0+$/, "");
}

const BOUNDS_WARNING_TOLERANCE_PX = 1;

function getLiveNodeDimension(store: EditorStore, node: DesignNode, key: "width" | "height") {
  const element = store.domIndex.getElement(node);
  const live = key === "width" ? element?.offsetWidth : element?.offsetHeight;
  if (typeof live === "number" && Number.isFinite(live) && live >= 0) return live;
  return node[key];
}

function getLiveNodeCanvasBounds(store: EditorStore, node: DesignNode) {
  const element = store.domIndex.getElement(node);
  const viewportElement = element?.closest("[data-viewport]");
  if (!element || !(viewportElement instanceof HTMLElement)) return null;

  const nodeRect = element.getBoundingClientRect();
  const viewportRect = viewportElement.getBoundingClientRect();
  if (
    !Number.isFinite(nodeRect.left) ||
    !Number.isFinite(nodeRect.top) ||
    !Number.isFinite(viewportRect.left) ||
    !Number.isFinite(viewportRect.top) ||
    !Number.isFinite(store.zoom) ||
    store.zoom === 0
  ) {
    return null;
  }

  return {
    x: (nodeRect.left - viewportRect.left - store.panX) / store.zoom,
    y: (nodeRect.top - viewportRect.top - store.panY) / store.zoom,
    width: nodeRect.width / store.zoom,
    height: nodeRect.height / store.zoom,
  };
}

function getNodeCanvasBounds(store: EditorStore, node: DesignNode) {
  const liveBounds = getLiveNodeCanvasBounds(store, node);
  if (liveBounds) return liveBounds;

  const position = store.getCanvasPosition(node.id) ?? { x: node.x, y: node.y };
  return {
    x: position.x,
    y: position.y,
    width: getLiveNodeDimension(store, node, "width"),
    height: getLiveNodeDimension(store, node, "height"),
  };
}

export function collectBoundsWarnings(store: EditorStore, root: DesignNode, limit = 5) {
  const warnings: string[] = [];
  const roundBound = (value: number) => Math.round(value * 100) / 100;

  function visit(parent: DesignNode) {
    if (warnings.length >= limit) return;
    const parentClipAxes = getNodeClipAxes(parent);
    const parentBounds = getNodeCanvasBounds(store, parent);

    for (const child of parent.children) {
      if (warnings.length >= limit) return;
      const childPosition = child.styles.position;
      if (childPosition === "fixed" || childPosition === "sticky") {
        continue;
      }

      const childBounds = getNodeCanvasBounds(store, child);
      // Round before comparing: live bounds divide every rect edge by the zoom,
      // so the float noise otherwise flips exactly-at-tolerance cases (a 1px
      // parent border) into warnings.
      const renderedX = roundBound(childBounds.x - parentBounds.x);
      const renderedY = roundBound(childBounds.y - parentBounds.y);

      const overflowsHorizontally =
        renderedX < -BOUNDS_WARNING_TOLERANCE_PX ||
        renderedX + childBounds.width > parentBounds.width + BOUNDS_WARNING_TOLERANCE_PX;
      const overflowsVertically =
        renderedY < -BOUNDS_WARNING_TOLERANCE_PX ||
        renderedY + childBounds.height > parentBounds.height + BOUNDS_WARNING_TOLERANCE_PX;

      if (overflowsHorizontally || overflowsVertically) {
        const fullyOutsideHorizontally =
          renderedX + childBounds.width <= BOUNDS_WARNING_TOLERANCE_PX ||
          renderedX >= parentBounds.width - BOUNDS_WARNING_TOLERANCE_PX;
        const fullyOutsideVertically =
          renderedY + childBounds.height <= BOUNDS_WARNING_TOLERANCE_PX ||
          renderedY >= parentBounds.height - BOUNDS_WARNING_TOLERANCE_PX;
        const fullyClipped =
          (parentClipAxes.horizontal && fullyOutsideHorizontally) ||
          (parentClipAxes.vertical && fullyOutsideVertically);
        const hasClippedOverflow =
          (parentClipAxes.horizontal && overflowsHorizontally) ||
          (parentClipAxes.vertical && overflowsVertically);
        const isCaptureBoundary = parent === root;
        if (!hasClippedOverflow && !isCaptureBoundary) {
          visit(child);
          continue;
        }
        const allOverflowIsClipped =
          (!overflowsHorizontally || parentClipAxes.horizontal) &&
          (!overflowsVertically || parentClipAxes.vertical);
        // An image or svg partially overflowing an overflow-clipped frame is
        // the standard way crops are authored — not worth a warning. A fully
        // hidden child, or overflowing frame/text content, still is.
        const isIntentionalCropIdiom =
          allOverflowIsClipped && !fullyClipped && (child.type === "image" || child.type === "svg");

        if (fullyClipped) {
          warnings.push(
            `"${child.name}" (${child.id}) at x/y (${formatBoundsCoordinate(renderedX)}, ${formatBoundsCoordinate(renderedY)}) relative to "${parent.name}", with size ${formatBoundsCoordinate(childBounds.width)}×${formatBoundsCoordinate(childBounds.height)}, is entirely outside and hidden by its overflow clipping.`,
          );
        } else if (!isIntentionalCropIdiom) {
          warnings.push(
            `"${child.name}" (${child.id}) extends outside "${parent.name}" at x/y (${formatBoundsCoordinate(renderedX)}, ${formatBoundsCoordinate(renderedY)}) relative to that parent, with size ${formatBoundsCoordinate(childBounds.width)}×${formatBoundsCoordinate(childBounds.height)}${hasClippedOverflow ? " and is cropped by its overflow clipping" : " and may be cropped by the screenshot boundary"}.`,
          );
        }
      }

      visit(child);
    }
  }

  visit(root);
  return warnings;
}

function applyScreenshotImageStyles(img: HTMLImageElement, node: DesignNode) {
  img.draggable = false;
  img.style.width = "100%";
  img.style.height = "100%";
  img.style.display = "block";
  img.style.objectFit =
    typeof node.styles.objectFit === "string" ? node.styles.objectFit : "contain";
  img.style.objectPosition =
    typeof node.styles.objectPosition === "string" ? node.styles.objectPosition : "top left";
  img.style.pointerEvents = "none";
}

function retainScreenshotRenderTrees(store: EditorStore, nodes: readonly DesignNode[]) {
  const nodeIds = [...new Set(nodes.map((node) => node.id))];
  runInAction(() => {
    for (const nodeId of nodeIds) store.retainForcedRender(nodeId);
  });

  let released = false;
  return () => {
    if (released) return;
    released = true;
    runInAction(() => {
      for (const nodeId of nodeIds) store.releaseForcedRender(nodeId);
    });
  };
}

/**
 * Wall-clock budget for a forced screenshot target to mount. Settle yields are
 * near-instant, so a frame-count budget would give a still-committing (or
 * timer-gated) mount almost no real time; the deadline keeps the wait bounded
 * while giving large pages and background-tab replicas time to commit.
 */
const SCREENSHOT_MOUNT_WAIT_DEADLINE_MS = 1000;
/** Fast scheduler-yield polls before the wait backs off to timer cadence. */
const SCREENSHOT_MOUNT_FAST_POLLS = 10;
const SCREENSHOT_MOUNT_POLL_INTERVAL_MS = 16;

async function waitForScreenshotElements(
  store: EditorStore,
  nodes: readonly DesignNode[],
): Promise<HTMLElement[] | null> {
  const deadline = performance.now() + SCREENSHOT_MOUNT_WAIT_DEADLINE_MS;
  for (let poll = 0; ; poll += 1) {
    const elements = nodes.map((node) => store.domIndex.getElement(node));
    if (elements.every((element): element is HTMLElement => element !== undefined)) {
      return elements;
    }
    if (performance.now() >= deadline) return null;
    // Scheduler yields resolve in microseconds, so the wall-clock deadline
    // alone would busy-spin the main thread for its full budget when a
    // target never mounts. The first polls stay yield-fast to catch a mount
    // that is one commit away; after that, a short timer paces the loop.
    await waitForAnimationFrames(1);
    if (poll >= SCREENSHOT_MOUNT_FAST_POLLS) {
      await new Promise((resolve) => setTimeout(resolve, SCREENSHOT_MOUNT_POLL_INTERVAL_MS));
    }
  }
}

async function getElementsForScreenshot(store: EditorStore, nodes: readonly DesignNode[]) {
  const release = retainScreenshotRenderTrees(store, nodes);

  try {
    const elements = await waitForScreenshotElements(store, nodes);
    if (!elements) {
      const missingNode = nodes.find((node) => !store.domIndex.getElement(node)) ?? nodes[0]!;
      throw new Error(
        `DOM element not found for node: ${missingNode.id}. The node exists in the document state but did not mount in the capture canvas within the settle window. ` +
          `This is usually transient (a very large page still committing its render) — retry the call, or continue with document reads and writes.`,
      );
    }
    return { elements, release };
  } catch (error) {
    release();
    throw error;
  }
}

async function getElementForScreenshot(store: EditorStore, node: DesignNode) {
  const { elements, release } = await getElementsForScreenshot(store, [node]);
  return { element: elements[0]!, release };
}

function normalizeScreenshotClone(root: HTMLElement) {
  root.dataset.leafScreenshotRoot = "true";

  for (const element of [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]) {
    foldAbsoluteTranslateIntoPosition(element);
    element.classList.remove("node-materializing");
    element.style.removeProperty("--mat-delay");
    element.style.setProperty("animation", "none", "important");
    element.style.setProperty("transition", "none", "important");
    element.style.setProperty("content-visibility", "visible", "important");
    element.style.removeProperty("contain-intrinsic-size");
  }
}

function foldAbsoluteTranslateIntoPosition(element: HTMLElement) {
  if (element.style.position !== "absolute") return;

  const transform = element.style.transform.trim();
  const match = /^translate\(\s*(-?\d+(?:\.\d+)?)px\s*,\s*(-?\d+(?:\.\d+)?)px\s*\)/.exec(transform);
  if (!match) return;

  const translateX = Number.parseFloat(match[1]!);
  const translateY = Number.parseFloat(match[2]!);
  const currentLeft = getFoldablePixelOffset(element.style.left);
  const currentTop = getFoldablePixelOffset(element.style.top);
  if (currentLeft === null || currentTop === null) return;

  element.style.left = `${currentLeft + translateX}px`;
  element.style.top = `${currentTop + translateY}px`;

  const remainingTransform = transform.slice(match[0].length).trim();
  if (remainingTransform) {
    element.style.transform = remainingTransform;
  } else {
    element.style.removeProperty("transform");
  }
}

function getFoldablePixelOffset(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return 0;

  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(trimmed);
  return match ? Number.parseFloat(match[1]!) : null;
}

async function hydrateScreenshotAssetImages(store: EditorStore, screenshotRoot: HTMLElement) {
  const candidateElements = [
    ...(screenshotRoot.matches("[data-node-id]") ? [screenshotRoot] : []),
    ...Array.from(screenshotRoot.querySelectorAll<HTMLElement>("[data-node-id]")),
  ];

  await Promise.all(
    candidateElements.map(async (element) => {
      const nodeId = element.dataset.nodeId;
      if (!nodeId) return;

      const node = store.getNode(nodeId);
      if (!node || node.type !== "image" || !node.imageAsset) return;

      const src = await resolveImageAssetUrl(node.imageAsset, { shouldResolveToOriginal: true });
      let img = element.querySelector("img");

      if (!src) {
        img?.removeAttribute("src");
        return;
      }

      if (!(img instanceof HTMLImageElement)) {
        img = element.ownerDocument.createElement("img");
        element.replaceChildren(img);
      }

      applyScreenshotImageStyles(img, node);
      img.alt = node.name;
      img.dataset.leafScreenshotAssetId = node.imageAsset.assetId;
      img.setAttribute("src", src);
    }),
  );
}

function getCanvasElements(root: HTMLElement) {
  return [
    ...(root instanceof HTMLCanvasElement ? [root] : []),
    ...Array.from(root.querySelectorAll<HTMLCanvasElement>("canvas")),
  ];
}

function copyCanvasReplacementAttributes(source: HTMLCanvasElement, replacement: HTMLImageElement) {
  for (const attribute of Array.from(source.attributes)) {
    replacement.setAttribute(attribute.name, attribute.value);
  }
  replacement.width = source.width;
  replacement.height = source.height;
  replacement.draggable = false;
  replacement.decoding = "sync";
}

type CanvasPresentation = Array<[property: string, value: string, priority: string]>;

/**
 * Snapshot the live canvas's computed presentation. A shader library may size
 * and position its drawing surface with selectors that only match `canvas`,
 * so the values must be materialized before the screenshot clone swaps that
 * tag for an image. MUST be read inside a visible-layout measuring window:
 * outside it, a `content-visibility` ancestor of a far-offscreen root may
 * already have collapsed again, and the frozen values would be unresolved.
 */
function captureCanvasPresentation(source: HTMLCanvasElement): CanvasPresentation {
  const computed = source.ownerDocument.defaultView?.getComputedStyle(source);
  if (!computed) return [];
  const declarations: CanvasPresentation = [];
  for (let index = 0; index < computed.length; index += 1) {
    const property = computed.item(index);
    if (!property) continue;
    declarations.push([
      property,
      computed.getPropertyValue(property),
      computed.getPropertyPriority(property),
    ]);
  }
  return declarations;
}

/** Apply a captured presentation, keeping the backing dimensions as the image's intrinsic size. */
function applyCanvasReplacementPresentation(
  declarations: CanvasPresentation,
  replacement: HTMLImageElement,
) {
  for (const [property, value, priority] of declarations) {
    replacement.style.setProperty(property, value, priority);
  }
}

function createCanvasCaptureWarningDataUrl(width: number, height: number) {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const fontSize = Math.max(12, Math.min(32, Math.round(Math.min(safeWidth, safeHeight) / 8)));
  const stripeSize = Math.max(12, Math.min(28, fontSize));
  const labelY = safeHeight / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${safeWidth}" height="${safeHeight}" viewBox="0 0 ${safeWidth} ${safeHeight}">
  <defs>
    <pattern id="stripes" width="${stripeSize}" height="${stripeSize}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="${stripeSize / 2}" height="${stripeSize}" fill="#7f1d1d"/>
      <rect x="${stripeSize / 2}" width="${stripeSize / 2}" height="${stripeSize}" fill="#450a0a"/>
    </pattern>
  </defs>
  <rect width="100%" height="100%" fill="url(#stripes)"/>
  <rect x="2" y="2" width="${Math.max(0, safeWidth - 4)}" height="${Math.max(0, safeHeight - 4)}" fill="none" stroke="#fca5a5" stroke-width="4"/>
  <text x="50%" y="${labelY}" fill="#fff7ed" font-family="system-ui, sans-serif" font-size="${fontSize}" font-weight="700" text-anchor="middle" dominant-baseline="middle">CANVAS SNAPSHOT FAILED</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function describeCanvasSnapshotError(error: unknown) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function hydrateScreenshotCanvases(liveRoot: HTMLElement, screenshotRoot: HTMLElement) {
  const liveCanvases = getCanvasElements(liveRoot);
  const clonedCanvases = getCanvasElements(screenshotRoot);
  const captureWarnings: string[] = [];
  const livePresentations =
    liveCanvases.length > 0
      ? measureWithVisibleLayout(liveRoot, () => liveCanvases.map(captureCanvasPresentation))
      : [];

  for (const [index, liveCanvas] of liveCanvases.entries()) {
    const clonedCanvas = clonedCanvases[index];
    if (!clonedCanvas) {
      captureWarnings.push(
        `Canvas ${index + 1} could not be matched to the screenshot clone, so its retained pixels are missing from the capture.`,
      );
      continue;
    }

    const replacement = screenshotRoot.ownerDocument.createElement("img");
    copyCanvasReplacementAttributes(clonedCanvas, replacement);
    applyCanvasReplacementPresentation(livePresentations[index] ?? [], replacement);

    try {
      const dataUrl = liveCanvas.toDataURL("image/png");
      if (!/^data:image\/png(?:;[^,]*)?,.+/s.test(dataUrl)) {
        throw new Error("the browser returned an empty canvas snapshot");
      }
      replacement.src = dataUrl;
      replacement.alt = "Captured canvas content";
      replacement.dataset.leafCanvasSnapshot = "true";
    } catch (error) {
      replacement.src = createCanvasCaptureWarningDataUrl(liveCanvas.width, liveCanvas.height);
      replacement.alt = "Canvas snapshot failed";
      replacement.dataset.leafCanvasCaptureWarning = "true";
      captureWarnings.push(
        `Canvas ${index + 1} could not be snapshotted (${describeCanvasSnapshotError(error)}). ` +
          "The screenshot contains a visible failure marker; Leaf did not rerun its render callback or bypass browser origin protections.",
      );
    }

    clonedCanvas.replaceWith(replacement);
  }

  return captureWarnings;
}

function replaceScreenshotIframes(screenshotRoot: HTMLElement) {
  const iframes = Array.from(screenshotRoot.querySelectorAll<HTMLIFrameElement>("iframe"));

  for (const iframe of iframes) {
    const placeholder = screenshotRoot.ownerDocument.createElement("div");
    for (const attribute of Array.from(iframe.attributes)) {
      if (attribute.name === "src" || attribute.name === "srcdoc") continue;
      placeholder.setAttribute(attribute.name, attribute.value);
    }
    placeholder.dataset.leafIframeCaptureWarning = "true";
    placeholder.setAttribute("role", "img");
    placeholder.setAttribute("aria-label", "Embedded content omitted from screenshot");
    placeholder.style.display = "flex";
    placeholder.style.alignItems = "center";
    placeholder.style.justifyContent = "center";
    placeholder.style.boxSizing = "border-box";
    placeholder.style.background = "#f4f4f5";
    placeholder.style.border = "1px dashed #a1a1aa";
    placeholder.style.color = "#52525b";
    placeholder.style.font = "12px system-ui, sans-serif";
    placeholder.style.textAlign = "center";
    placeholder.textContent = "Embedded content is not available in Leaf screenshots";
    iframe.replaceWith(placeholder);
  }

  return iframes.length === 0
    ? []
    : [
        `${iframes.length} embedded iframe${iframes.length === 1 ? " was" : "s were"} replaced with an inert placeholder because iframe pixels are opaque to DOM screenshot capture.`,
      ];
}

function markUnavailableReplicaInteractiveSurfaces(
  liveRoot: HTMLElement,
  screenshotRoot: HTMLElement,
) {
  if (!liveRoot.closest("[data-mcp-render-replica]")) return [];

  const liveHosts = Array.from(
    liveRoot.querySelectorAll<HTMLElement>("[data-leaf-interactive-surface-host]"),
  );
  const screenshotHosts = Array.from(
    screenshotRoot.querySelectorAll<HTMLElement>("[data-leaf-interactive-surface-host]"),
  );
  let markedCount = 0;

  for (const [index, liveHost] of liveHosts.entries()) {
    // Document scripts intentionally do not execute in the read-only replica.
    // If a future renderer can safely project retained output here, preserve it.
    if (liveHost.childNodes.length > 0) continue;

    const screenshotHost = screenshotHosts[index];
    if (!screenshotHost) continue;

    const marker = screenshotRoot.ownerDocument.createElement("div");
    marker.dataset.leafReplicaSurfaceCaptureWarning = "true";
    marker.setAttribute("role", "img");
    marker.setAttribute(
      "aria-label",
      "Interactive surface unavailable in isolated inactive-page capture",
    );
    Object.assign(marker.style, {
      alignItems: "center",
      background:
        "repeating-linear-gradient(135deg, #450a0a 0, #450a0a 14px, #7f1d1d 14px, #7f1d1d 28px)",
      border: "3px solid #fca5a5",
      boxSizing: "border-box",
      color: "#fff7ed",
      display: "flex",
      font: "700 13px/1.3 system-ui, sans-serif",
      inset: "0",
      justifyContent: "center",
      padding: "16px",
      position: "absolute",
      textAlign: "center",
    });
    marker.textContent = "INTERACTIVE SURFACE UNAVAILABLE IN ISOLATED CAPTURE";
    screenshotHost.replaceChildren(marker);
    markedCount += 1;
  }

  return markedCount === 0
    ? []
    : [
        `${markedCount} interactive surface${markedCount === 1 ? " was" : "s were"} unavailable in the isolated inactive-page render. ` +
          "The screenshot contains a visible failure marker; Leaf did not rerun the document script or disturb the foreground session.",
      ];
}

type PreparedScreenshotClone = {
  screenshotRoot: HTMLElement;
  width: number;
  height: number;
};

/**
 * Text that renders as one line on the canvas must stay one line in the
 * capture. SnapDOM serializes each element's computed width, so an auto-sized
 * text box becomes a fixed-width box; the raster pass then measures glyphs a
 * hair differently and wraps at the first break opportunity — a leading or
 * trailing space drops the whole word onto a second line even though the canvas
 * shows one line. `white-space: pre` removes soft wrapping for exactly the
 * elements whose live layout has none; explicit newlines already render as
 * separate line boxes and are left alone.
 */
function pinSingleLineTextClones(liveRoot: HTMLElement, screenshotRoot: HTMLElement) {
  const doc = liveRoot.ownerDocument;
  for (const content of liveRoot.querySelectorAll<HTMLElement>("[data-text-content]")) {
    const host = content.parentElement;
    const nodeId = host?.dataset.nodeId;
    if (!host || !nodeId || host.querySelector("[data-inline-text-editor]")) continue;
    if (!rendersAsSingleLine(doc, content)) continue;
    const selector = `[data-node-id="${nodeId.replace(/["\\]/g, "\\$&")}"]`;
    const cloneHost =
      screenshotRoot.dataset.nodeId === nodeId
        ? screenshotRoot
        : screenshotRoot.querySelector<HTMLElement>(selector);
    cloneHost?.style.setProperty("white-space", "pre");
  }
}

/**
 * Count rendered line boxes by grouping every text fragment rect into
 * vertically overlapping bands. Fragments on one line (a preserved leading
 * space and the word after it, or letter-spaced runs) share a band; stacked
 * lines never overlap. Element boxes are ignored so wrapper spans do not count.
 */
function countRenderedTextLines(doc: Document, content: HTMLElement): number {
  if (typeof doc.createRange !== "function" || typeof doc.createTreeWalker !== "function") {
    return 0;
  }
  const bands: Array<{ top: number; bottom: number }> = [];
  const walker = doc.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const range = doc.createRange();
    range.selectNodeContents(text);
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width <= 0 && rect.height <= 0) continue;
      const band = bands.find((entry) => rect.top < entry.bottom && rect.bottom > entry.top);
      if (band) {
        band.top = Math.min(band.top, rect.top);
        band.bottom = Math.max(band.bottom, rect.bottom);
      } else {
        bands.push({ top: rect.top, bottom: rect.bottom });
      }
    }
  }
  return bands.length;
}

function rendersAsSingleLine(doc: Document, content: HTMLElement) {
  if (!content.textContent) return false;
  return countRenderedTextLines(doc, content) === 1;
}

function cloneMeasuredScreenshotRoot(
  element: HTMLElement,
  node: DesignNode,
): PreparedScreenshotClone {
  return measureWithVisibleLayout(element, () => {
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const screenshotRoot = element.cloneNode(true) as HTMLElement;
    pinSingleLineTextClones(element, screenshotRoot);

    // `content-visibility:auto` can collapse an off-screen intrinsic-size root
    // again after the clone leaves the live measuring window. Pin only authored
    // auto dimensions to the exact laid-out pixels observed above; explicitly
    // sized roots keep their authored CSS untouched.
    if (node.styles.width === "auto") screenshotRoot.style.width = `${width}px`;
    if (node.styles.height === "auto") screenshotRoot.style.height = `${height}px`;

    return { screenshotRoot, width, height };
  });
}

async function hydratePreparedScreenshotClone(
  store: EditorStore,
  element: HTMLElement,
  prepared: PreparedScreenshotClone,
  stripCanvasPlacement: boolean,
) {
  const { screenshotRoot } = prepared;
  const captureWarnings = [
    ...hydrateScreenshotCanvases(element, screenshotRoot),
    ...replaceScreenshotIframes(screenshotRoot),
    ...markUnavailableReplicaInteractiveSurfaces(element, screenshotRoot),
  ];
  if (stripCanvasPlacement) stripRootCanvasPlacement(screenshotRoot);
  normalizeScreenshotClone(screenshotRoot);
  await hydrateScreenshotAssetImages(store, screenshotRoot);
  return { captureWarnings, ...prepared };
}

async function prepareScreenshotRoot(store: EditorStore, node: DesignNode) {
  const { element, release } = await getElementForScreenshot(store, node);

  try {
    await document.fonts.ready;
    // Canvas pixels may be drawn by rAF-staged work (a document script's next
    // frame); scheduler-yield settles never span a vsync, so give visible
    // windows one painted frame before toDataURL reads the surface.
    if (element.querySelector("canvas")) await waitForPaintedFrameIfVisible();
    const prepared = cloneMeasuredScreenshotRoot(element, node);
    const hydrated = await hydratePreparedScreenshotClone(store, element, prepared, true);
    return { ...hydrated, element, release };
  } catch (error) {
    release();
    throw error;
  }
}

const SCREENSHOT_IMAGE_DECODE_TIMEOUT_MS = 8_000;
const SCREENSHOT_IMAGE_DECODE_ATTEMPTS = 2;

async function decodeScreenshotImage(img: HTMLImageElement) {
  await withRenderSettleTimeout(
    img.decode(),
    SCREENSHOT_IMAGE_DECODE_TIMEOUT_MS,
    "Timed out while decoding the image.",
  );
}

function retryScreenshotImageSource(img: HTMLImageElement, attempt: number) {
  const src = img.getAttribute("src");
  if (!src || !isSharedAssetUrl(src)) return;
  const retryUrl = new URL(src, document.baseURI);
  retryUrl.searchParams.set("leafScreenshotRetry", String(attempt));
  img.setAttribute("src", retryUrl.toString());
}

async function waitForScreenshotImages(root: HTMLElement) {
  const images = [
    ...(root instanceof HTMLImageElement ? [root] : []),
    ...Array.from(root.querySelectorAll<HTMLImageElement>("img")),
  ];

  await Promise.all(
    images.map(async (img) => {
      if (!img.getAttribute("src")) return;

      if (typeof img.decode !== "function") {
        if (!img.complete) await waitForAnimationFrames(1);
        return;
      }

      let lastError: unknown;
      for (let attempt = 1; attempt <= SCREENSHOT_IMAGE_DECODE_ATTEMPTS; attempt += 1) {
        try {
          await decodeScreenshotImage(img);
          return;
        } catch (error) {
          if (img.complete && img.naturalWidth > 0) return;
          lastError = error;
          if (attempt < SCREENSHOT_IMAGE_DECODE_ATTEMPTS) {
            retryScreenshotImageSource(img, attempt);
            await waitForAnimationFrames(1);
          }
        }
      }

      const assetId = img.dataset.leafScreenshotAssetId;
      const detail = lastError instanceof Error ? ` ${lastError.message}` : "";
      throw new Error(
        `Image${assetId ? ` asset ${assetId}` : ""} was not ready for screenshot capture after ${SCREENSHOT_IMAGE_DECODE_ATTEMPTS} attempts.${detail}`,
        { cause: lastError },
      );
    }),
  );
}

async function captureScreenshotRoot(root: HTMLElement, scale: number, transparent: boolean) {
  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.left = "-100000px";
  host.style.top = "0";
  host.style.pointerEvents = "none";
  host.style.transform = "none";
  host.style.zIndex = "-1";

  host.appendChild(root);
  document.body.appendChild(host);

  try {
    await waitForAnimationFrames(1);
    await waitForScreenshotImages(root);
    return await captureElementWithSnapdom(root, scale, transparent);
  } finally {
    host.remove();
  }
}

async function captureElementWithSnapdom(
  element: HTMLElement,
  scale: number,
  transparent: boolean,
) {
  if (!snapdomLoad) {
    snapdomLoad = import("@zumer/snapdom")
      .then((module) => module.snapdom)
      .catch((error) => {
        snapdomLoad = null;
        throw error;
      });
  }

  return (await snapdomLoad).toCanvas(element, {
    scale,
    dpr: 1,
    backgroundColor: transparent ? undefined : "#ffffff",
    cache: "soft",
    embedFonts: true,
    fast: true,
    outerTransforms: true,
    outerShadows: false,
  });
}

async function captureMountedNodeScreenshot(
  store: EditorStore,
  node: DesignNode,
  scale: number,
  transparent: boolean,
) {
  const { captureWarnings, element, height, release, screenshotRoot, width } =
    await prepareScreenshotRoot(store, node);

  try {
    assertScreenshotCaptureWithinLimits(width, height, scale);
    const canvas = await captureScreenshotRoot(screenshotRoot, scale, transparent);
    const mimeType = transparent ? "image/png" : "image/jpeg";
    const dataUrl = transparent ? canvas.toDataURL(mimeType) : canvas.toDataURL(mimeType, 0.85);

    return {
      data: dataUrl.replace(/^data:image\/\w+;base64,/, ""),
      mimeType,
      name: node.name,
      type: node.isArtboard && !store.parentMap.has(node.id) ? "artboard" : node.type,
      width,
      height,
      childCount: node.children.length,
      backend: "snapdom",
      warnings: measureWithVisibleLayout(element, () => collectBoundsWarnings(store, node)),
      captureWarnings,
    };
  } finally {
    release();
  }
}

export async function captureNodeScreenshot(
  store: EditorStore,
  node: DesignNode,
  scale: number,
  transparent: boolean,
) {
  const pageId = store.getPageIdForNode(node.id);
  if (!pageId) return await captureMountedNodeScreenshot(store, node, scale, transparent);
  return await withMcpPageRenderStore(store, pageId, async (renderStore) => {
    const renderNode = renderStore.getNode(node.id);
    if (!renderNode) throw new Error(`Node not found: ${node.id}`);
    return await captureMountedNodeScreenshot(renderStore, renderNode, scale, transparent);
  });
}

/**
 * Capture several nodes with one render session per page.
 *
 * Preparing and rastering a node is inherently per-node, but the replica
 * mount and settle window is not: nodes on the same (inactive) page share a
 * single withMcpPageRenderStore session instead of paying the mount, font
 * wait, and animation-frame settles once per node. Results are returned in
 * the caller's node order.
 */
export async function captureNodeScreenshotBatch(
  store: EditorStore,
  nodes: readonly DesignNode[],
  scale: number,
  transparent: boolean,
) {
  const captures = new Array<Awaited<ReturnType<typeof captureMountedNodeScreenshot>>>(
    nodes.length,
  );
  const indexesByPage = new Map<string | null, number[]>();
  nodes.forEach((node, index) => {
    const pageId = store.getPageIdForNode(node.id) ?? null;
    const indexes = indexesByPage.get(pageId);
    if (indexes) indexes.push(index);
    else indexesByPage.set(pageId, [index]);
  });

  for (const [pageId, indexes] of indexesByPage) {
    if (pageId === null) {
      for (const index of indexes) {
        captures[index] = await captureMountedNodeScreenshot(
          store,
          nodes[index]!,
          scale,
          transparent,
        );
      }
      continue;
    }
    await withMcpPageRenderStore(store, pageId, async (renderStore) => {
      for (const index of indexes) {
        const node = nodes[index]!;
        const renderNode = renderStore.getNode(node.id);
        if (!renderNode) throw new Error(`Node not found: ${node.id}`);
        captures[index] = await captureMountedNodeScreenshot(
          renderStore,
          renderNode,
          scale,
          transparent,
        );
      }
    });
  }
  return captures;
}

function getPageCaptureBounds(store: EditorStore, nodes: readonly DesignNode[], padding: number) {
  const bounds = nodes.map((node) => getNodeCanvasBounds(store, node));
  const left = Math.floor(Math.min(...bounds.map((rect) => rect.x)) - padding);
  const top = Math.floor(Math.min(...bounds.map((rect) => rect.y)) - padding);
  const right = Math.ceil(Math.max(...bounds.map((rect) => rect.x + rect.width)) + padding);
  const bottom = Math.ceil(Math.max(...bounds.map((rect) => rect.y + rect.height)) + padding);
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * Capture the visible roots on a page as one canvas composition.
 *
 * Root clones keep their renderer-owned canvas placement (normalized from
 * translate into left/top where possible) on a shared inner plane. Unlike
 * one-node screenshots, sibling overlap therefore remains visible in the
 * raster. Inactive and unmounted targets use an isolated render replica, so
 * active page, selection, interaction state, and per-page cameras remain
 * unchanged throughout capture.
 */
async function captureMountedPageScreenshot(
  store: EditorStore,
  pageId = store.activePageId,
  scale = 1,
  transparent = false,
  padding = 80,
) {
  const page = store.pages.find((candidate) => candidate.id === pageId);
  if (!page) throw new Error(`Page not found: ${pageId}`);
  if (!Number.isFinite(padding) || padding < 0) {
    throw new Error("Page screenshot padding must be a finite non-negative number.");
  }

  const nodes = page.nodes.filter((node) => node.visible !== false);
  if (nodes.length === 0) {
    throw new Error(
      `Cannot capture page "${page.name}" (${page.id}) because it has no visible roots.`,
    );
  }

  if (page.id !== store.activePageId) {
    throw new Error(`Page ${page.id} is not mounted in the isolated render session.`);
  }

  const { elements, release } = await getElementsForScreenshot(store, nodes);
  try {
    await document.fonts.ready;
    if (elements.some((element) => element.querySelector("canvas"))) {
      await waitForPaintedFrameIfVisible();
    }
    const measurementScope = elements[0]!;
    const measured = measureWithVisibleLayout(measurementScope, () => {
      const prepared = elements.map((element, index) =>
        cloneMeasuredScreenshotRoot(element, nodes[index]!),
      );
      return {
        prepared,
        composition: getPageCaptureBounds(store, nodes, padding),
      };
    });

    assertScreenshotCaptureWithinLimits(
      measured.composition.width,
      measured.composition.height,
      scale,
    );

    const hydrated = await Promise.all(
      measured.prepared.map((prepared, index) =>
        hydratePreparedScreenshotClone(store, elements[index]!, prepared, false),
      ),
    );

    const screenshotRoot = document.createElement("div");
    screenshotRoot.dataset.leafPageScreenshotRoot = page.id;
    screenshotRoot.style.position = "relative";
    screenshotRoot.style.width = `${measured.composition.width}px`;
    screenshotRoot.style.height = `${measured.composition.height}px`;
    screenshotRoot.style.overflow = "hidden";

    const canvasPlane = document.createElement("div");
    canvasPlane.style.position = "absolute";
    canvasPlane.style.left = `${-measured.composition.left}px`;
    canvasPlane.style.top = `${-measured.composition.top}px`;
    canvasPlane.style.width = "0";
    canvasPlane.style.height = "0";
    for (const entry of hydrated) canvasPlane.appendChild(entry.screenshotRoot);
    screenshotRoot.appendChild(canvasPlane);

    const canvas = await captureScreenshotRoot(screenshotRoot, scale, transparent);
    const mimeType = transparent ? "image/png" : "image/jpeg";
    const dataUrl = transparent ? canvas.toDataURL(mimeType) : canvas.toDataURL(mimeType, 0.85);
    const warnings = measureWithVisibleLayout(measurementScope, () =>
      nodes.flatMap((node) =>
        collectBoundsWarnings(store, node).map((warning) => `"${node.name}": ${warning}`),
      ),
    );

    return {
      data: dataUrl.replace(/^data:image\/\w+;base64,/, ""),
      mimeType,
      pageId: page.id,
      pageName: page.name,
      width: measured.composition.width,
      height: measured.composition.height,
      origin: { x: measured.composition.left, y: measured.composition.top },
      padding,
      rootCount: nodes.length,
      backend: "snapdom",
      warnings,
      captureWarnings: hydrated.flatMap((entry, index) =>
        entry.captureWarnings.map((warning) => `"${nodes[index]!.name}": ${warning}`),
      ),
    };
  } finally {
    release();
  }
}

export async function capturePageScreenshot(
  store: EditorStore,
  pageId = store.activePageId,
  scale = 1,
  transparent = false,
  padding = 80,
) {
  return await withMcpPageRenderStore(store, pageId, (renderStore) =>
    captureMountedPageScreenshot(renderStore, pageId, scale, transparent, padding),
  );
}
