import { LEAF_WORKER_ROUTES, buildLeafWorkerRoutePath } from "../shared/collaboration";
import { formatImageGenerationSize } from "./image-generation";
import { buildWorkerUrl, getConfiguredWorkerBaseUrl } from "../state/worker-endpoints";
import type { ImageGenerationApiSize, ImageGenerationBackground } from "./image-generation";

/**
 * Image generation runs on the Worker's AI routes. A local-only build, or a
 * session that declined the Worker, has no origin to call, so the feature is
 * absent rather than broken: no toolbar entry, no shortcut, and the agent
 * tools neither advertise nor accept leaf-gen:// URLs.
 */
export function isImageGenerationAvailable() {
  return getConfiguredWorkerBaseUrl() !== null;
}

export interface ImageGenerationRequest {
  prompt: string;
  size: ImageGenerationApiSize;
  background?: ImageGenerationBackground;
  count?: number;
  referenceImages?: ImageGenerationReference[];
}

export interface ImageGenerationReference {
  id?: string;
  name?: string;
  dataUrl: string;
}

export interface GeneratedImage {
  dataUrl: string;
  revisedPrompt?: string;
}

export interface ImageGenerationResult {
  images: GeneratedImage[];
}

type ImageGenerationResponse =
  | {
      images: Array<{
        imageBase64: string;
        mimeType?: string;
        revisedPrompt?: string;
      }>;
    }
  | {
      error: string;
    };

function getImageGenerationRoute(hasReferenceImages: boolean) {
  const routeId = hasReferenceImages ? "editImage" : "createImage";
  return {
    method: LEAF_WORKER_ROUTES[routeId].method,
    url: buildWorkerUrl(buildLeafWorkerRoutePath(routeId, {})),
  };
}

function getImageGenerationHeaders() {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = import.meta.env.VITE_IMAGE_GENERATION_KEY?.trim();
  if (key) headers["X-Leaf-Image-Generation-Key"] = key;
  return headers;
}

export async function requestImageGeneration({
  prompt,
  size,
  background = "auto",
  count = 1,
  referenceImages = [],
}: ImageGenerationRequest): Promise<ImageGenerationResult> {
  const route = getImageGenerationRoute(referenceImages.length > 0);
  const response = await fetch(route.url, {
    method: route.method,
    headers: getImageGenerationHeaders(),
    body: JSON.stringify({
      prompt,
      size: formatImageGenerationSize(size),
      background,
      count,
      referenceImages: referenceImages.map((image) => ({
        id: image.id,
        name: image.name,
        dataUrl: image.dataUrl,
      })),
    }),
  });

  const payload = (await response.json().catch(() => ({
    error: "Image generation returned an invalid response.",
  }))) as ImageGenerationResponse;

  if (!response.ok || "error" in payload) {
    throw new Error("error" in payload ? payload.error : "Image generation failed.");
  }
  if (!Array.isArray(payload.images) || payload.images.length === 0) {
    throw new Error("Image generation did not return any images.");
  }

  return {
    images: payload.images.map((image) => ({
      dataUrl: `data:${image.mimeType ?? "image/png"};base64,${image.imageBase64}`,
      revisedPrompt: image.revisedPrompt,
    })),
  };
}
