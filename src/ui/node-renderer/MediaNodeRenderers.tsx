import { computed } from "mobx";
import { observer } from "mobx-react-lite";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
} from "react";
import { DOCUMENT_SCRIPT_INTERACTION_BOUNDARY_EVENTS } from "../../core/nodes/interactive-surface";
import { useEditorStore } from "../../core/state/EditorStore";
import { useImageAssetUrl } from "../../core/state/use-image-asset-url";
import {
  collectSvgElementNodes,
  composeSvgMarkup,
  normalizeSvgRootForDisplay,
} from "../../core/editor/svg-decomposition";
import {
  applyTypedAppearanceStyles,
  buildBaseStyle,
  getMaterializedNodeProps,
} from "./node-renderer-style";
import {
  EmptyPlaceholder,
  GeneratedBackgroundPlaceholder,
  GeneratedImagePlaceholder,
  getGeneratedImagePlaceholderState,
  type RendererProps,
  useNodeRef,
} from "./renderer-helpers";
import { useResolvedNodeBackgroundImage } from "./node-background-image";

/**
 * Composes an SVG node and its decomposed sub-elements into one inline SVG so
 * decomposition does not change painting or create competing DOM subtrees.
 */
export const SvgNodeRenderer = observer(
  ({ node, isFlowChild = false, isInteractionSuppressed = false }: RendererProps) => {
    const store = useEditorStore();
    const nodeRef = useNodeRef(node);
    const elementRef = useRef<HTMLDivElement | null>(null);
    const contentRef = useRef<HTMLDivElement | null>(null);
    const lastContentRef = useRef<string | null>(null);
    const ref = useCallback(
      (element: HTMLDivElement | null) => {
        elementRef.current = element;
        nodeRef(element);
      },
      [nodeRef],
    );

    const style = buildBaseStyle(store, node, isFlowChild, isInteractionSuppressed);
    applyTypedAppearanceStyles(node, style);
    useResolvedNodeBackgroundImage(node, style);
    if (!node.styles.overflow) style.overflow = "hidden";

    // A MobX computed keeps the expensive subtree composition cached without
    // dropping subscriptions when unrelated geometry causes a re-render.
    const markupBox = useMemo(
      () => computed(() => normalizeSvgRootForDisplay(composeSvgMarkup(node))),
      [node],
    );
    const markup = markupBox.get();

    useLayoutEffect(() => {
      const element = contentRef.current;
      if (!element || lastContentRef.current === markup) return;
      element.innerHTML = markup;
      lastContentRef.current = markup;
    }, [markup]);

    useLayoutEffect(() => {
      const element = elementRef.current;
      const elementNodes = collectSvgElementNodes(node);
      if (!element || elementNodes.length === 0) return;

      const mounted = new Map<string, Element>();
      for (const candidate of Array.from(element.querySelectorAll("[data-node-id]"))) {
        const id = candidate.getAttribute("data-node-id");
        if (id && !mounted.has(id)) mounted.set(id, candidate);
      }

      const disposers: (() => void)[] = [];
      for (const elementNode of elementNodes) {
        const target = mounted.get(elementNode.id);
        if (target) disposers.push(store.domIndex.register(elementNode, target as HTMLElement));
      }
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, [markup, node, store.domIndex]);

    return (
      <div ref={ref} data-node-id={node.id} {...getMaterializedNodeProps(store, node.id, style)}>
        {/* A flex container lays the root svg out as a block whatever it authored.
            Inline, a replaced element sits on the wrapper's text baseline, so
            artwork shorter than the font's ascent (small icons, em-sized roots
            the normalizer passes through) drops below the node box and clips. */}
        <div
          ref={contentRef}
          data-svg-content
          style={{ display: "flex", width: "100%", height: "100%" }}
        />
        <GeneratedBackgroundPlaceholder node={node} />
      </div>
    );
  },
);

export const InteractiveSurfaceNodeRenderer = observer(
  ({ node, isFlowChild = false, isInteractionSuppressed = false }: RendererProps) => {
    const store = useEditorStore();
    const ref = useNodeRef(node);
    const style = buildBaseStyle(store, node, isFlowChild, isInteractionSuppressed);
    applyTypedAppearanceStyles(node, style);
    useResolvedNodeBackgroundImage(node, style);

    style.overflow = "hidden";
    style.userSelect = "none";
    style.WebkitUserSelect = "none";

    const isActive = store.isInteractionActiveForNode(node.id);
    const isDirectlyActive = store.activeInteractiveSurfaceId === node.id;
    if (isDirectlyActive) {
      style.outline = "2px solid #3b82f6";
      style.outlineOffset = "-2px";
    }

    return (
      <div ref={ref} data-node-id={node.id} {...getMaterializedNodeProps(store, node.id, style)}>
        <InteractiveSurfaceHost isActive={isActive} nodeId={node.id} />
        <GeneratedBackgroundPlaceholder node={node} />
        {!isActive ? (
          <div
            data-leaf-interactive-surface-hint
            style={{
              background: "rgba(9, 9, 11, 0.56)",
              border: "1px solid rgba(255, 255, 255, 0.18)",
              borderRadius: 999,
              color: "#fff",
              fontFamily: "Inter, system-ui, sans-serif",
              fontSize: 11,
              fontWeight: 650,
              padding: "7px 10px",
              pointerEvents: "none",
              position: "absolute",
              right: 12,
              top: 12,
            }}
          >
            {store.selectedIds.has(node.id)
              ? "Click again to interact"
              : "Interactive · click to select"}
          </div>
        ) : null}
      </div>
    );
  },
);

function InteractiveSurfaceHost({ isActive, nodeId }: { isActive: boolean; nodeId: string }) {
  const store = useEditorStore();
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element || !isActive) return;
    element.focus({ preventScroll: true });
    const exitInteractionOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      store.deactivateInteractiveSurface();
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const stopPropagation = (event: Event) => {
      if (event.type === "pointerdown") element.focus({ preventScroll: true });
      event.stopPropagation();
    };
    element.addEventListener("keydown", exitInteractionOnEscape, true);
    for (const eventName of DOCUMENT_SCRIPT_INTERACTION_BOUNDARY_EVENTS) {
      element.addEventListener(eventName, stopPropagation);
    }
    return () => {
      element.removeEventListener("keydown", exitInteractionOnEscape, true);
      for (const eventName of DOCUMENT_SCRIPT_INTERACTION_BOUNDARY_EVENTS) {
        element.removeEventListener(eventName, stopPropagation);
      }
    };
  }, [isActive, store]);

  return (
    <div
      ref={ref}
      data-leaf-interactive-surface-host={nodeId}
      data-active={isActive ? "true" : "false"}
      style={{
        inset: 0,
        isolation: "isolate",
        overflow: "hidden",
        pointerEvents: isActive ? "auto" : "none",
        position: "absolute",
        touchAction: isActive ? "auto" : undefined,
      }}
      tabIndex={isActive ? 0 : -1}
    />
  );
}

export const ImageNodeRenderer = observer(
  ({ node, isFlowChild = false, isInteractionSuppressed = false }: RendererProps) => {
    const store = useEditorStore();
    const ref = useNodeRef(node);
    const {
      url: assetUrl,
      handleImageLoadError,
      handleImageLoad,
    } = useImageAssetUrl(node.imageAsset);
    const source = assetUrl ?? node.content;
    const generationJob = store.generatedImageJobs.get(node.id);
    const generationPlaceholder = getGeneratedImagePlaceholderState(node, generationJob);

    const style = buildBaseStyle(store, node, isFlowChild, isInteractionSuppressed);
    applyTypedAppearanceStyles(node, style);
    style.overflow = "hidden";
    style.userSelect = "none";
    style.WebkitUserSelect = "none";
    const imageObjectFit =
      typeof node.styles.objectFit === "string"
        ? (node.styles.objectFit as CSSProperties["objectFit"])
        : "contain";
    const imageObjectPosition =
      typeof node.styles.objectPosition === "string" ? node.styles.objectPosition : "top left";
    delete (style as Record<string, unknown>).objectFit;
    delete (style as Record<string, unknown>).objectPosition;

    return (
      <div ref={ref} data-node-id={node.id} {...getMaterializedNodeProps(store, node.id, style)}>
        {!source && generationPlaceholder ? (
          <GeneratedImagePlaceholder
            status={generationPlaceholder.status}
            error={generationPlaceholder.error}
          />
        ) : source ? (
          <img
            src={source}
            alt={node.name}
            draggable={false}
            onError={assetUrl ? handleImageLoadError : undefined}
            onLoad={assetUrl ? handleImageLoad : undefined}
            style={{
              width: "100%",
              height: "100%",
              display: "block",
              objectFit: imageObjectFit,
              objectPosition: imageObjectPosition,
              pointerEvents: "none",
            }}
          />
        ) : (
          <EmptyPlaceholder message={node.imageAsset ? "Loading image" : "No image set"} />
        )}
        {source && generationPlaceholder && generationPlaceholder.status !== "ready" ? (
          <GeneratedImagePlaceholder
            status={generationPlaceholder.status}
            error={generationPlaceholder.error}
            overlay
          />
        ) : null}
      </div>
    );
  },
);
