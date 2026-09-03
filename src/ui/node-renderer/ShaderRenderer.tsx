import { observer } from "mobx-react-lite";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useEditorStore } from "../../core/state/EditorStore";
import { useImageAssetUrl } from "../../core/state/use-image-asset-url";
import type { DesignNode } from "../../core/types";
import { shaderPreviewColors, shaderPreviewGradient } from "../../core/editor/shaders/preview";
import {
  parseShaderContent,
  shaderComponentProps,
  type ShaderNodeValue,
} from "../../core/editor/shaders/serialization";
import type { ShaderDefinition } from "../../core/editor/shaders/registry";
import {
  releaseSurfaceSlot,
  requestSurfaceSlot,
  subscribeToSurfaceSlots,
} from "../../core/editor/shaders/surface-budget";
import { useIsNearViewport } from "./use-near-viewport";
import {
  applyTypedAppearanceStyles,
  buildBaseStyle,
  getMaterializedNodeProps,
} from "./node-renderer-style";

interface ShaderRendererProps {
  node: DesignNode;
  isFlowChild?: boolean;
  isInteractionSuppressed?: boolean;
  renderChildren?: boolean;
  forceDetail?: boolean;
}

/**
 * Cap the render surface at roughly 2x the node's CSS pixels.
 *
 * The library defaults to a 2x minimum pixel ratio against an 8.3M pixel
 * ceiling, which lets a full-bleed shader render far more pixels than the
 * canvas ever shows.
 */
const PIXEL_RATIO_CAP = 2;

/**
 * Keep the drawing buffer readable after compositing.
 *
 * WebGL clears it by default, so anything that reads the canvas outside the
 * frame that drew it — screenshot capture, export — gets a transparent
 * rectangle where the shader should be.
 */
const WEBGL_CONTEXT_ATTRIBUTES: WebGLContextAttributes = { preserveDrawingBuffer: true };

/**
 * WebGL2 is required by every shader in the package, and its absence is not an
 * error worth surfacing — jsdom, older browsers and blocked GPUs all land here,
 * and all of them still need the node to look like itself.
 */
function supportsWebGl2(): boolean {
  return typeof WebGL2RenderingContext !== "undefined";
}

/**
 * Hold one of the document's WebGL context slots while `wanted`.
 *
 * Waits rather than fails: a shader that could not get a slot picks one up as
 * soon as another node scrolls away or is deleted.
 */
function useShaderSurfaceSlot(nodeId: string, wanted: boolean): boolean {
  const [granted, setGranted] = useState(false);

  useEffect(() => {
    if (!wanted) {
      releaseSurfaceSlot(nodeId);
      setGranted(false);
      return;
    }
    const acquire = () => setGranted(requestSurfaceSlot(nodeId));
    acquire();
    const unsubscribe = subscribeToSurfaceSlots(acquire);
    return () => {
      unsubscribe();
      releaseSurfaceSlot(nodeId);
    };
  }, [nodeId, wanted]);

  return granted;
}

/**
 * Stop re-rendering a surface whose GPU context died.
 *
 * A lost context leaves the canvas painting a crashed-canvas icon over the
 * node. Dropping the surface uncovers the palette placeholder instead, and
 * staying dropped avoids remounting straight into another loss. Editing the
 * node clears the flag, so it is recoverable without a reload.
 */
function useSurfaceContextLoss(element: HTMLElement | null, content: string) {
  const [lost, setLost] = useState(false);

  useEffect(() => {
    setLost(false);
  }, [content]);

  useEffect(() => {
    if (!element) return;
    const onLost = () => setLost(true);
    // Listen on the wrapper in the capture phase: the canvas is created inside
    // the library's own async setup, so it does not exist when this effect
    // runs, and `webglcontextlost` does not bubble.
    element.addEventListener("webglcontextlost", onLost, true);
    return () => element.removeEventListener("webglcontextlost", onLost, true);
  }, [element]);

  return lost;
}

function PlaceholderLayer({ background, message }: { background: string; message?: string }) {
  return (
    <div
      data-shader-placeholder={message ? "error" : "preview"}
      style={{
        position: "absolute",
        inset: 0,
        background,
        borderRadius: "inherit",
        display: message ? "flex" : "block",
        alignItems: "center",
        justifyContent: "center",
        padding: message ? 12 : 0,
        boxSizing: "border-box",
        color: "#71717a",
        fontSize: 12,
        fontFamily: "Inter, system-ui, sans-serif",
        textAlign: "center",
      }}
    >
      {message}
    </div>
  );
}

function ShaderSurface({
  definition,
  value,
  paused,
  imageUrl,
  width,
  height,
}: {
  definition: ShaderDefinition;
  value: ShaderNodeValue;
  paused: boolean;
  imageUrl: string | null;
  width: number;
  height: number;
}) {
  const Component = definition.component;
  const props = shaderComponentProps(definition, value);

  return (
    <Component
      {...props}
      {...(definition.acceptsImage && imageUrl ? { image: imageUrl } : {})}
      // Zero stops the render loop outright rather than animating at zero cost.
      {...(paused ? { speed: 0 } : {})}
      minPixelRatio={1}
      maxPixelCount={Math.max(1, Math.ceil(width * height * PIXEL_RATIO_CAP * PIXEL_RATIO_CAP))}
      webGlContextAttributes={WEBGL_CONTEXT_ATTRIBUTES}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        borderRadius: "inherit",
        pointerEvents: "none",
      }}
    />
  );
}

/**
 * Shader renderer — a WebGL surface from the shader library sized to the node.
 *
 * The palette gradient underneath is not decoration: it is what the node looks
 * like whenever the real surface is absent, which happens on every offscreen
 * node, on machines without WebGL2, and in the gap before the context finishes
 * initializing. Drawing it always means those transitions never flash empty.
 */
export const ShaderRenderer = observer(
  ({ node, isFlowChild = false, isInteractionSuppressed = false }: ShaderRendererProps) => {
    const store = useEditorStore();
    const {
      url: imageUrl,
      handleImageLoad,
      handleImageLoadError,
    } = useImageAssetUrl(node.imageAsset);
    const [loadedImageUrl, setLoadedImageUrl] = useState<string | null>(null);
    const [element, setElement] = useState<HTMLDivElement | null>(null);
    const disposeRegistration = useRef<(() => void) | null>(null);

    const ref = useCallback(
      (nextElement: HTMLDivElement | null) => {
        disposeRegistration.current?.();
        disposeRegistration.current = nextElement
          ? store.domIndex.register(node, nextElement)
          : null;
        setElement(nextElement);
      },
      [node, store.domIndex],
    );

    // Each mounted shader holds its own WebGL2 context and browsers drop the
    // oldest once roughly a dozen are live, so a shader that scrolled away has
    // to give its context back rather than merely stop animating.
    const isNearViewport = useIsNearViewport(element);
    const parsed = parseShaderContent(node.content);

    const style: CSSProperties = buildBaseStyle(store, node, isFlowChild, isInteractionSuppressed);
    applyTypedAppearanceStyles(node, style);
    // The canvas inherits the wrapper's radius, but a rotated or scaled surface
    // still needs the box to clip it.
    if (!node.styles.overflow) style.overflow = "hidden";
    // Absolute children need a positioned box; a flow child may not have one.
    if (!style.position) style.position = "relative";

    // Ask about the lost context before the slot, so a surface that gave up on
    // its context also gives up the slot: a node rendering a placeholder must
    // not sit on one of the eight, or a handful of losses starves the shaders
    // that could still paint.
    const contextLost = useSurfaceContextLoss(
      element,
      `${node.content}\u0000${node.imageAsset?.assetId ?? ""}`,
    );
    const wantsSurface =
      parsed.status === "ok" && isNearViewport && supportsWebGl2() && !contextLost;
    const hasSlot = useShaderSurfaceSlot(node.id, wantsSurface);

    const background =
      parsed.status === "ok"
        ? shaderPreviewGradient(shaderPreviewColors(parsed.definition, parsed.value))
        : "#f5f5f5";
    const readyImageUrl = loadedImageUrl === imageUrl ? loadedImageUrl : null;

    return (
      <div ref={ref} data-node-id={node.id} {...getMaterializedNodeProps(store, node.id, style)}>
        {imageUrl ? (
          <img
            data-shader-image-preloader
            src={imageUrl}
            alt=""
            aria-hidden="true"
            onLoad={() => {
              handleImageLoad();
              setLoadedImageUrl(imageUrl);
            }}
            onError={() => {
              setLoadedImageUrl(null);
              handleImageLoadError();
            }}
            style={{ display: "none" }}
          />
        ) : null}
        <PlaceholderLayer
          background={background}
          message={parsed.status === "invalid" ? parsed.message : undefined}
        />
        {parsed.status === "ok" && hasSlot ? (
          <ShaderSurface
            definition={parsed.definition}
            value={parsed.value}
            paused={parsed.value.paused === true}
            imageUrl={readyImageUrl}
            width={node.width}
            height={node.height}
          />
        ) : null}
      </div>
    );
  },
);
