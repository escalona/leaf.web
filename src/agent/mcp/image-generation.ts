import { runInAction } from "mobx";
import { resolveImageReference } from "../../ui/toolbar/image-reference";
import { measureImageSource } from "../../core/editor/clipboard/image-paste";
import {
  isImageGenerationAvailable,
  requestImageGeneration,
} from "../../core/editor/image-generation-client";
import {
  getImageGenerationOption,
  type ImageGenerationAspectRatio,
  type ImageGenerationBackground,
  clearImageGenerationOwnership,
  markImageGenerationsOwned,
} from "../../core/editor/image-generation";
import { generateId } from "../../core/nodes/specs";
import { readDisplayError } from "../../core/shared/errors";
import type { EditorStore } from "../../core/state/EditorStore";
import { buildLocalAssetSrc, uploadImageAssetFromDataUrl } from "../../core/state/image-assets";
import type { DesignNode, ImageGenerationMetadata, NodeType } from "../../core/types";
import type { StylePatch } from "../../core/editor/style-mutation";

const LEAF_GENERATION_PROTOCOL = "leaf-gen:";
const MAX_GENERATIONS_PER_CALL = 10;
const MAX_REFERENCE_IMAGES = 8;

const SUPPORTED_MODELS = new Set(["openai-gpt-image-2", "openai-gpt-image-edit-2"]);
const IMAGE_EDIT_MODEL = "openai-gpt-image-edit-2";
const BACKGROUND_GENERATION_NODE_TYPES = new Set<NodeType>([
  "frame",
  "rectangle",
  "text",
  "svg",
  "interactive-surface",
]);
const SUPPORTED_ASPECT_RATIOS = new Set<ImageGenerationAspectRatio>([
  "1:1",
  "3:2",
  "4:3",
  "16:9",
  "2:1",
  "3:1",
  "2:3",
  "3:4",
  "9:16",
  "1:2",
  "1:3",
]);
const SUPPORTED_BACKGROUNDS = new Set<ImageGenerationBackground>(["auto", "opaque", "transparent"]);

export type McpImageGenerationTarget = "image" | "background";

export interface McpImageGenerationRequest {
  generationId?: string;
  nodeId: string;
  target: McpImageGenerationTarget;
  url: string;
}

type ParsedGenerationUrl = {
  aspectRatio: ImageGenerationAspectRatio;
  background: ImageGenerationBackground;
  modelId: string;
  prompt: string;
  referenceNodeIds: string[];
};

export interface PreparedWriteHtmlGeneration {
  html: string;
  requests: McpImageGenerationRequest[];
}

export interface PreparedStyleGeneration {
  requests: McpImageGenerationRequest[];
  updates: Array<{ nodeIds: string[]; styles: StylePatch }>;
}

export interface ImageGenerationDependencies {
  request: typeof requestImageGeneration;
  upload: typeof uploadImageAssetFromDataUrl;
  measure: typeof measureImageSource;
  resolveReference: typeof resolveImageReference;
}

function getDefaultDependencies(): ImageGenerationDependencies {
  return {
    request: requestImageGeneration,
    upload: uploadImageAssetFromDataUrl,
    measure: measureImageSource,
    resolveReference: resolveImageReference,
  };
}

function extractGeneratedBackgroundUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /url\(\s*(["']?)(leaf-gen:\/\/[^"')\s]+)\1\s*\)/i.exec(value);
  return match?.[2] ?? null;
}

function assertSupportedGenerationProtocol(value: unknown) {
  if (typeof value !== "string") return;
  const protocol = /\b([a-z][a-z0-9+.-]*-gen):\/\//i.exec(value)?.[1]?.toLowerCase();
  if (protocol && `${protocol}:` !== LEAF_GENERATION_PROTOCOL) {
    throw new Error(
      "Unsupported image-generation URL. Use leaf-gen:// for Leaf image generation. No changes were made.",
    );
  }
}

function ensureGenerationNodeId(element: Element) {
  const existing = element.getAttribute("data-leaf-node-id")?.trim();
  if (existing) return existing;
  const nodeId = generateId();
  element.setAttribute("data-leaf-node-id", nodeId);
  return nodeId;
}

function assertGenerationCount(count: number) {
  if (count <= MAX_GENERATIONS_PER_CALL) return;
  throw new Error(
    `A single tool call can generate at most ${MAX_GENERATIONS_PER_CALL} images. No changes were made.`,
  );
}

function assertHtmlBackgroundTargetSupported(element: Element) {
  const ownerSvg = element.closest("svg");
  if (element.tagName === "IMG" || (ownerSvg && ownerSvg !== element)) {
    throw new Error(
      `Generated backgrounds are not supported on <${element.tagName.toLowerCase()}> elements. Use a frame, rectangle, text, svg, or interactive-surface target. No changes were made.`,
    );
  }
}

/**
 * Replace generated URLs with inert placeholders before HTML reaches the importer.
 * The generated node IDs let the asynchronous completion path update the exact
 * imported node without relying on import order or a follow-up tree walk.
 */
export function prepareWriteHtmlImageGenerations(html: string): PreparedWriteHtmlGeneration {
  const parser = new DOMParser();
  const document = parser.parseFromString(`<div>${html}</div>`, "text/html");
  const wrapper = document.body.firstElementChild as HTMLElement | null;
  if (!wrapper) return { html, requests: [] };

  const requests: McpImageGenerationRequest[] = [];
  for (const element of Array.from(wrapper.querySelectorAll("*"))) {
    assertSupportedGenerationProtocol(element.getAttribute("src"));
    assertSupportedGenerationProtocol(element.getAttribute("style"));
  }
  for (const element of Array.from(wrapper.querySelectorAll("*"))) {
    let nodeId: string | null = null;
    if (element.tagName === "IMG") {
      const src = element.getAttribute("src")?.trim() ?? "";
      if (src.startsWith(`${LEAF_GENERATION_PROTOCOL}//`)) {
        nodeId = ensureGenerationNodeId(element);
        requests.push({ nodeId, target: "image", url: src });
        element.setAttribute("src", "");
      }
    }

    const htmlElement = element as HTMLElement;
    const backgroundUrl = extractGeneratedBackgroundUrl(htmlElement.style.backgroundImage);
    if (backgroundUrl) {
      assertHtmlBackgroundTargetSupported(element);
      nodeId ??= ensureGenerationNodeId(element);
      requests.push({ nodeId, target: "background", url: backgroundUrl });
      htmlElement.style.removeProperty("background-image");
    }
  }

  assertGenerationCount(requests.length);

  return { html: requests.length > 0 ? wrapper.innerHTML : html, requests };
}

export function prepareStyleImageGenerations(
  updates: Array<{ nodeIds: string[]; styles: StylePatch }>,
): PreparedStyleGeneration {
  const requestsByNodeId = new Map<string, McpImageGenerationRequest>();
  const preparedUpdates = updates.map(({ nodeIds, styles }) => {
    assertSupportedGenerationProtocol(styles.backgroundImage);
    const url = extractGeneratedBackgroundUrl(styles.backgroundImage);
    if (!url) return { nodeIds, styles };
    for (const nodeId of nodeIds) {
      requestsByNodeId.set(nodeId, { nodeId, target: "background", url });
    }
    const { backgroundImage: _generatedBackground, ...remainingStyles } = styles;
    return { nodeIds, styles: remainingStyles };
  });
  assertGenerationCount(requestsByNodeId.size);
  return { updates: preparedUpdates, requests: [...requestsByNodeId.values()] };
}

export function prepareArtboardImageGeneration(styles: Record<string, string | number>) {
  assertSupportedGenerationProtocol(styles.backgroundImage);
  const url = extractGeneratedBackgroundUrl(styles.backgroundImage);
  if (!url) return { styles, url: null };
  const { backgroundImage: _generatedBackground, ...remainingStyles } = styles;
  return { styles: remainingStyles, url };
}

export function parseLeafGenerationUrl(value: string): ParsedGenerationUrl {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error("The leaf-gen URL is invalid.", { cause: error });
  }
  if (url.protocol !== LEAF_GENERATION_PROTOCOL) {
    throw new Error("Image generation URLs must use leaf-gen://.");
  }
  const modelId = url.hostname;
  if (!SUPPORTED_MODELS.has(modelId)) {
    throw new Error(
      `Leaf supports leaf-gen://openai-gpt-image-2 and leaf-gen://openai-gpt-image-edit-2; received ${modelId || "no model"}.`,
    );
  }
  const prompt = url.searchParams.get("prompt")?.trim() ?? "";
  if (!prompt) throw new Error("The leaf-gen URL requires a prompt query parameter.");

  const rawAspectRatio = url.searchParams.get("aspect_ratio")?.trim() || "1:1";
  const aspectRatio = SUPPORTED_ASPECT_RATIOS.has(rawAspectRatio as ImageGenerationAspectRatio)
    ? (rawAspectRatio as ImageGenerationAspectRatio)
    : "1:1";
  const rawBackground = url.searchParams.get("background")?.trim() || "auto";
  if (!SUPPORTED_BACKGROUNDS.has(rawBackground as ImageGenerationBackground)) {
    throw new Error('leaf-gen background accepts "auto", "opaque", or "transparent".');
  }
  const background = rawBackground as ImageGenerationBackground;
  const referenceNodeIds = (url.searchParams.get("reference_nodes") ?? "")
    .split(",")
    .map((nodeId) => nodeId.trim())
    .filter(Boolean);
  if (referenceNodeIds.length > MAX_REFERENCE_IMAGES) {
    throw new Error(
      `leaf-gen reference_nodes accepts at most ${MAX_REFERENCE_IMAGES} node IDs; received ${referenceNodeIds.length}.`,
    );
  }

  return { aspectRatio, background, modelId, prompt, referenceNodeIds };
}

/**
 * Fails a request that asks for generated imagery when there is no Worker to
 * generate it, before any node is created or changed.
 */
export function assertImageGenerationAvailable(requests: readonly unknown[]) {
  if (requests.length === 0 || isImageGenerationAvailable()) return;
  throw new Error(
    "Image generation is not available here: this build has no Worker to generate images. Use an image URL or a data: URI instead. No changes were made.",
  );
}

export function assertMcpImageGenerationTargets(
  store: EditorStore,
  requests: McpImageGenerationRequest[],
) {
  assertGenerationCount(requests.length);
  for (const request of requests) {
    const node = store.getNode(request.nodeId);
    if (!node) throw new Error(`Node not found: ${request.nodeId}. No changes were made.`);
    const supported =
      request.target === "image"
        ? node.type === "image"
        : BACKGROUND_GENERATION_NODE_TYPES.has(node.type);
    if (!supported) {
      throw new Error(
        request.target === "image"
          ? `Generated image content requires an image node; ${request.nodeId} is ${node.type}. No changes were made.`
          : `Generated backgrounds are not supported on ${node.type} nodes (${request.nodeId}). Use a frame, rectangle, text, svg, or interactive-surface target. No changes were made.`,
      );
    }
  }
}

function collectReferenceNodes(store: EditorStore, rootIds: string[]) {
  const seen = new Set<string>();
  const nodes: DesignNode[] = [];
  const missing: string[] = [];
  const visit = (node: DesignNode) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    nodes.push(node);
    for (const child of node.children) visit(child);
  };
  for (const nodeId of rootIds) {
    const node = store.getNode(nodeId);
    if (node) visit(node);
    else missing.push(nodeId);
  }
  return { missing, nodes };
}

async function resolveGenerationInput(
  store: EditorStore,
  parsed: ParsedGenerationUrl,
  dependencies: ImageGenerationDependencies,
) {
  const references = collectReferenceNodes(store, parsed.referenceNodeIds);
  const text = references.nodes
    .filter((node) => node.type === "text" && node.content.trim())
    .map((node) => node.content.trim());
  const prompt = [...text, parsed.prompt].join("\n");

  if (parsed.modelId !== IMAGE_EDIT_MODEL) {
    return { prompt, referenceImages: [] };
  }
  const imageNodes = references.nodes.filter((node) => node.type === "image");
  const referenceImages = (
    await Promise.all(imageNodes.map((node) => dependencies.resolveReference(node)))
  )
    .filter((reference): reference is NonNullable<typeof reference> => reference !== null)
    .slice(0, MAX_REFERENCE_IMAGES);
  if (referenceImages.length === 0) {
    const missingSuffix = references.missing.length
      ? ` Missing nodes: ${references.missing.join(", ")}.`
      : "";
    throw new Error(`openai-gpt-image-edit-2 requires a usable reference image.${missingSuffix}`);
  }
  return { prompt, referenceImages };
}

function assetBackgroundImage(assetSrc: string) {
  return `url(${JSON.stringify(assetSrc)})`;
}

function generationMetadata(
  parsed: ParsedGenerationUrl,
  target: McpImageGenerationTarget,
): ImageGenerationMetadata {
  return {
    prompt: parsed.prompt,
    modelId: parsed.modelId,
    aspectRatio: parsed.aspectRatio,
    ...(parsed.background !== "auto" ? { background: parsed.background } : {}),
    target,
    referenceNodeIds: [...parsed.referenceNodeIds],
    status: "generating",
    startedAt: Date.now(),
  };
}

function metadataWithStatus(
  metadata: ImageGenerationMetadata,
  status: NonNullable<ImageGenerationMetadata["status"]>,
  error?: string,
): ImageGenerationMetadata {
  const { error: _previousError, ...provenance } = metadata;
  return {
    ...provenance,
    status,
    ...(error ? { error } : {}),
  };
}

function attemptedGenerationMetadata(
  generation: McpImageGenerationRequest,
  error: string,
): ImageGenerationMetadata {
  let prompt = generation.url;
  let modelId = "invalid";
  let aspectRatio: ImageGenerationAspectRatio = "1:1";
  let background: ImageGenerationBackground = "auto";
  let referenceNodeIds: string[] = [];
  try {
    const url = new URL(generation.url);
    prompt = url.searchParams.get("prompt")?.trim() || generation.url;
    modelId = url.hostname || "invalid";
    const requestedRatio = url.searchParams.get("aspect_ratio")?.trim();
    if (
      requestedRatio &&
      SUPPORTED_ASPECT_RATIOS.has(requestedRatio as ImageGenerationAspectRatio)
    ) {
      aspectRatio = requestedRatio as ImageGenerationAspectRatio;
    }
    const requestedBackground = url.searchParams.get("background")?.trim();
    if (
      requestedBackground &&
      SUPPORTED_BACKGROUNDS.has(requestedBackground as ImageGenerationBackground)
    ) {
      background = requestedBackground as ImageGenerationBackground;
    }
    referenceNodeIds = (url.searchParams.get("reference_nodes") ?? "")
      .split(",")
      .map((nodeId) => nodeId.trim())
      .filter(Boolean)
      .slice(0, MAX_REFERENCE_IMAGES);
  } catch {
    // Preserve a normalized, durable record even when the attempted URL cannot be parsed.
  }
  return {
    prompt,
    modelId,
    aspectRatio,
    ...(background !== "auto" ? { background } : {}),
    target: generation.target,
    referenceNodeIds,
    status: "failed",
    error,
  };
}

function generationMetadataMatches(
  current: ImageGenerationMetadata | null | undefined,
  expected: ImageGenerationMetadata,
) {
  return JSON.stringify(current) === JSON.stringify(expected);
}

function assetIdentity(node: DesignNode) {
  return node.imageAsset?.assetId ?? null;
}

function captureGenerationTarget(node: DesignNode, target: McpImageGenerationTarget) {
  return target === "image"
    ? { assetId: assetIdentity(node), value: node.content }
    : { assetId: assetIdentity(node), value: node.styles.backgroundImage ?? null };
}

function generationTargetMatches(
  node: DesignNode,
  target: McpImageGenerationTarget,
  expected: ReturnType<typeof captureGenerationTarget>,
) {
  const current = captureGenerationTarget(node, target);
  return current.assetId === expected.assetId && current.value === expected.value;
}

function isCurrentGenerationJob(store: EditorStore, generation: McpImageGenerationRequest) {
  return (
    !generation.generationId ||
    store.generatedImageJobs.get(generation.nodeId)?.generationId === generation.generationId
  );
}

function persistGenerationMetadata(
  store: EditorStore,
  nodeId: string,
  metadata: ImageGenerationMetadata,
) {
  const node = store.getNode(nodeId);
  if (!node || JSON.stringify(node.imageGeneration) === JSON.stringify(metadata)) return;
  store.runtime.updateNode(nodeId, { imageGeneration: metadata });
}

export async function generateMcpImageForNode(
  store: EditorStore,
  generation: McpImageGenerationRequest,
  dependencies: ImageGenerationDependencies = getDefaultDependencies(),
) {
  let metadata: ImageGenerationMetadata | null = null;
  let initialTarget: ReturnType<typeof captureGenerationTarget> | null = null;
  try {
    const parsed = parseLeafGenerationUrl(generation.url);
    metadata = generationMetadata(parsed, generation.target);
    persistGenerationMetadata(store, generation.nodeId, metadata);
    const startingNode = store.getNode(generation.nodeId);
    if (!startingNode) return;
    initialTarget = captureGenerationTarget(startingNode, generation.target);
    const input = await resolveGenerationInput(store, parsed, dependencies);
    const result = await dependencies.request({
      prompt: input.prompt,
      size:
        input.referenceImages.length > 0
          ? "auto"
          : getImageGenerationOption(parsed.aspectRatio).apiSize,
      ...(parsed.background !== "auto" ? { background: parsed.background } : {}),
      count: 1,
      referenceImages: input.referenceImages,
    });
    const image = result.images[0];
    if (!image) throw new Error("Image generation did not return an image.");
    const naturalSize = await dependencies.measure(image.dataUrl);
    const currentNode = store.getNode(generation.nodeId);
    const sourceName = currentNode?.name || "Generated Image";
    const asset = await dependencies.upload(image.dataUrl, naturalSize, sourceName);

    runInAction(() => {
      const node = store.getNode(generation.nodeId);
      if (!node) {
        // The target is gone for good (deleted, or its create was rejected);
        // drop the renderer-local job so it cannot leak.
        store.generatedImageJobs.delete(generation.nodeId);
        return;
      }
      if (!isCurrentGenerationJob(store, generation)) {
        return;
      }
      if (
        !generationMetadataMatches(node.imageGeneration, metadata!) ||
        !initialTarget ||
        !generationTargetMatches(node, generation.target, initialTarget)
      ) {
        if (generationMetadataMatches(node.imageGeneration, metadata!)) {
          store.runtime.updateNode(node.id, { imageGeneration: null });
        }
        store.generatedImageJobs.delete(node.id);
        return;
      }
      const completedMetadata = metadataWithStatus(metadata!, "ready");
      if (generation.target === "image") {
        store.runtime.updateNode(node.id, {
          content: "",
          imageAsset: asset,
          imageGeneration: completedMetadata,
        });
      } else {
        store.runtime.updateNode(node.id, {
          imageAsset: asset,
          imageGeneration: completedMetadata,
          styles: {
            ...node.styles,
            backgroundImage: assetBackgroundImage(asset.src ?? buildLocalAssetSrc(asset.assetId)),
          },
        });
      }
      store.generatedImageJobs.delete(node.id);
    });
  } catch (error) {
    const message = readDisplayError(error, "Image generation failed.");
    runInAction(() => {
      if (!store.getNode(generation.nodeId)) {
        store.generatedImageJobs.delete(generation.nodeId);
        return;
      }
      if (!isCurrentGenerationJob(store, generation)) return;
      const node = store.getNode(generation.nodeId);
      if (
        metadata &&
        initialTarget &&
        node &&
        (!generationMetadataMatches(node.imageGeneration, metadata) ||
          !generationTargetMatches(node, generation.target, initialTarget))
      ) {
        if (generationMetadataMatches(node.imageGeneration, metadata)) {
          store.runtime.updateNode(generation.nodeId, { imageGeneration: null });
        }
        store.generatedImageJobs.delete(generation.nodeId);
        return;
      }
      const failedMetadata = metadata
        ? metadataWithStatus(metadata, "failed", message)
        : attemptedGenerationMetadata(generation, message);
      if (node) {
        store.runtime.updateNode(generation.nodeId, {
          imageGeneration: failedMetadata,
        });
      }
      store.generatedImageJobs.delete(generation.nodeId);
    });
  } finally {
    clearImageGenerationOwnership([generation.nodeId]);
  }
}

export function startMcpImageGenerations(
  store: EditorStore,
  requests: McpImageGenerationRequest[],
) {
  if (requests.length === 0) return {};
  assertMcpImageGenerationTargets(store, requests);

  for (const request of requests) {
    const generationId = generateId();
    let prompt = request.url;
    try {
      prompt = parseLeafGenerationUrl(request.url).prompt;
    } catch {
      // The asynchronous path records the actionable parse error on the node.
    }
    store.generatedImageJobs.set(request.nodeId, {
      generationId,
      prompt,
      status: "generating",
      output: "raster",
      target: request.target,
    });
    // Same reload recovery as the toolbar path: this tab owns the request.
    markImageGenerationsOwned([request.nodeId]);
    void generateMcpImageForNode(store, { ...request, generationId });
  }
  return {
    note: `${requests.length} image(s) are generating; a generation typically lands in 45-60 seconds. Call wait_for_image_generation with generatingNodeIds to block until they settle, or poll get_node_info (imageGeneration.status).`,
    generatingNodeIds: requests.map((request) => request.nodeId),
  };
}
