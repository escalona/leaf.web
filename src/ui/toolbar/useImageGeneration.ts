import { reaction, runInAction } from "mobx";
import type { RefObject } from "react";
import { useEffect, useState } from "react";
import { measureImageSource } from "../../core/editor/clipboard/image-paste";
import {
  clearImageGenerationOwnership,
  DEFAULT_IMAGE_GENERATION_BACKGROUND,
  DEFAULT_IMAGE_GENERATION_RATIO,
  getGeneratedImageResultName,
  getImageGenerationCanvasSize,
  getImageGenerationOption,
  markImageGenerationsOwned,
  reconcileInterruptedImageGenerations,
  STALE_IMAGE_GENERATION_RECHECK_MS,
  type ImageGenerationAspectRatio,
  type ImageGenerationBackground,
} from "../../core/editor/image-generation";
import { requestImageGeneration } from "../../core/editor/image-generation-client";
import type { EditorStore } from "../../core/state/EditorStore";
import { readDisplayError } from "../../core/shared/errors";
import { uploadImageAssetFromDataUrl } from "../../core/state/image-assets";
import type { DesignNode, ImageAssetRef } from "../../core/types";
import { OPEN_IMAGE_GENERATION_DIALOG_EVENT } from "../toolbar-events";
import { isImageGenerationAvailable } from "../../core/editor/image-generation-client";
import {
  createGeneratedImagePlaceholders,
  isImageNodeWithSource,
  resolveImageReference,
} from "./image-reference";
import {
  DEFAULT_IMAGE_GENERATION_COUNT,
  type ImageGenerationReferencePreview,
} from "./toolbar-model";

export function applyGeneratedImageAssetsToStore({
  assets,
  placeholders,
  store,
  submittedCount,
  submittedPrompt,
}: {
  assets: Array<ImageAssetRef | undefined>;
  placeholders: Array<Pick<DesignNode, "id">>;
  store: EditorStore;
  submittedCount: number;
  submittedPrompt: string;
}) {
  const successfulIds: string[] = [];
  clearImageGenerationOwnership(placeholders.map(({ id }) => id));
  for (const [index, placeholder] of placeholders.entries()) {
    const asset = assets[index];
    if (!store.getNode(placeholder.id)) continue;

    if (!asset) {
      const node = store.getNode(placeholder.id);
      if (node?.imageGeneration) {
        store.runtime.updateNode(placeholder.id, {
          imageGeneration: {
            ...node.imageGeneration,
            status: "failed",
            error: "Image generation returned fewer images than requested.",
          },
        });
      }
      store.generatedImageJobs.set(placeholder.id, {
        prompt: submittedPrompt,
        status: "failed",
        error: "Image generation returned fewer images than requested.",
      });
      continue;
    }

    const node = store.getNode(placeholder.id);
    const imageGeneration = node?.imageGeneration
      ? (() => {
          const { error: _previousError, ...metadata } = node.imageGeneration;
          return { ...metadata, status: "ready" as const };
        })()
      : undefined;
    store.runtime.updateNode(placeholder.id, {
      imageAsset: asset,
      ...(imageGeneration ? { imageGeneration } : {}),
      content: "",
      name: getGeneratedImageResultName(submittedPrompt, submittedCount, index),
    });
    store.generatedImageJobs.delete(placeholder.id);
    successfulIds.push(placeholder.id);
  }
  if (successfulIds.length > 0) {
    store.setSelectedIds(successfulIds);
  }
}

export function markGeneratedImagePlaceholdersFailed({
  message,
  placeholders,
  store,
  submittedPrompt,
}: {
  message: string;
  placeholders: Array<Pick<DesignNode, "id">>;
  store: EditorStore;
  submittedPrompt: string;
}) {
  clearImageGenerationOwnership(placeholders.map(({ id }) => id));
  for (const placeholder of placeholders) {
    const node = store.getNode(placeholder.id);
    if (node) {
      if (node.imageGeneration) {
        store.runtime.updateNode(placeholder.id, {
          imageGeneration: {
            ...node.imageGeneration,
            status: "failed",
            error: message,
          },
        });
      }
      store.generatedImageJobs.set(placeholder.id, {
        prompt: submittedPrompt,
        status: "failed",
        error: message,
      });
    }
  }
}

export function useImageGeneration(
  store: EditorStore,
  toolbarRef: RefObject<HTMLDivElement | null>,
) {
  const [showDialog, setShowDialog] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState<ImageGenerationAspectRatio>(DEFAULT_IMAGE_GENERATION_RATIO);
  const [background, setBackground] = useState<ImageGenerationBackground>(
    DEFAULT_IMAGE_GENERATION_BACKGROUND,
  );
  const [count, setCount] = useState(DEFAULT_IMAGE_GENERATION_COUNT);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [references, setReferences] = useState<ImageGenerationReferencePreview[]>([]);
  const selectedImageNodes = store.selectedNodes.filter(isImageNodeWithSource);
  const selectedImageKey = selectedImageNodes
    .map((node) => `${node.id}:${node.imageAsset?.assetId ?? ""}:${node.content}`)
    .join("\n");

  useEffect(() => {
    if (!isImageGenerationAvailable()) return;
    const onOpenImageGenerationDialog = () => {
      setShowDialog(true);
      setError(null);
    };

    window.addEventListener(OPEN_IMAGE_GENERATION_DIALOG_EVENT, onOpenImageGenerationDialog);
    return () => {
      window.removeEventListener(OPEN_IMAGE_GENERATION_DIALOG_EVENT, onOpenImageGenerationDialog);
    };
  }, []);

  // Placeholders this tab started generating for, but whose request did not
  // survive (a reload mid-generation), would otherwise say "Generating image…"
  // forever. Re-check whenever the tree changes so a session whose document
  // arrives after mount still reconciles once the nodes are present.
  // Placeholders started by a session that is gone for good (a closed tab,
  // another client that crashed) carry a durable `startedAt`; once one is stale
  // any client may fail it, so re-check on a slow timer as well.
  useEffect(() => {
    const dispose = reaction(
      () => store.renderTreeVersion,
      () => {
        reconcileInterruptedImageGenerations(store);
      },
      { fireImmediately: true },
    );
    const timer = window.setInterval(() => {
      reconcileInterruptedImageGenerations(store);
    }, STALE_IMAGE_GENERATION_RECHECK_MS);
    return () => {
      dispose();
      window.clearInterval(timer);
    };
  }, [store]);

  useEffect(() => {
    if (!showDialog) {
      setReferences([]);
      return;
    }
    if (isSubmitting) return;

    let isCancelled = false;
    const currentSelectedImageNodes = store.selectedNodes.filter(isImageNodeWithSource);
    void Promise.all(
      currentSelectedImageNodes.map(async (node) => {
        try {
          return await resolveImageReference(node);
        } catch {
          return null;
        }
      }),
    ).then((nextReferences) => {
      if (!isCancelled) {
        setReferences(
          nextReferences.filter(
            (reference): reference is ImageGenerationReferencePreview => reference !== null,
          ),
        );
      }
    });

    return () => {
      isCancelled = true;
    };
  }, [showDialog, isSubmitting, selectedImageKey, store]);

  const generateImage = async () => {
    const submittedPrompt = prompt.trim();
    if (!submittedPrompt || isSubmitting) return;

    const submittedCount = count;
    const option = getImageGenerationOption(ratio);
    const placeholderSize = getImageGenerationCanvasSize(option.apiSize);
    setError(null);
    setIsSubmitting(true);
    setPrompt("");

    const placeholders = runInAction(() => {
      // One history step for the whole batch of placeholders plus their
      // provenance, so undo removes the request rather than one field at a time.
      store.beginHistoryTransaction();
      let nodes: DesignNode[];
      try {
        nodes = createGeneratedImagePlaceholders({
          count: submittedCount,
          size: placeholderSize,
          store,
          toolbarElement: toolbarRef.current,
        });
        for (const node of nodes) {
          store.runtime.updateNode(node.id, {
            imageGeneration: {
              prompt: submittedPrompt,
              modelId: references.length > 0 ? "openai-gpt-image-edit-2" : "openai-gpt-image-2",
              aspectRatio: ratio,
              ...(background !== "auto" ? { background } : {}),
              target: "image",
              referenceNodeIds: references.flatMap((reference) =>
                reference.id ? [reference.id] : [],
              ),
              status: "generating",
              startedAt: Date.now(),
            },
          });
          store.generatedImageJobs.set(node.id, { prompt: submittedPrompt, status: "generating" });
        }
        // Selection is history-recorded too; keep it inside the same step.
        store.setSelectedIds(nodes.map((node) => node.id));
        store.setTool("select");
      } finally {
        store.endHistoryTransaction();
      }
      markImageGenerationsOwned(nodes.map((node) => node.id));
      return nodes;
    });

    try {
      const result = await requestImageGeneration({
        prompt: submittedPrompt,
        size: option.apiSize,
        background,
        count: submittedCount,
        referenceImages: references,
      });
      const assets = await Promise.all(
        result.images.map(async (image, index) => {
          const naturalSize = await measureImageSource(image.dataUrl).catch(() =>
            option.apiSize === "auto" ? { width: 1024, height: 1024 } : option.apiSize,
          );
          return await uploadImageAssetFromDataUrl(
            image.dataUrl,
            naturalSize,
            getGeneratedImageResultName(submittedPrompt, submittedCount, index),
          );
        }),
      );

      runInAction(() => {
        store.beginHistoryTransaction();
        try {
          applyGeneratedImageAssetsToStore({
            assets,
            placeholders,
            store,
            submittedCount,
            submittedPrompt,
          });
        } finally {
          store.endHistoryTransaction();
        }
      });
    } catch (nextError) {
      const message = readDisplayError(nextError, "Image generation failed.");
      setError(message);
      runInAction(() => {
        store.beginHistoryTransaction();
        try {
          markGeneratedImagePlaceholdersFailed({
            message,
            placeholders,
            store,
            submittedPrompt,
          });
        } finally {
          store.endHistoryTransaction();
        }
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return {
    background,
    count,
    error,
    generateImage,
    isSubmitting,
    prompt,
    ratio,
    references,
    setCount,
    setBackground,
    setError,
    setPrompt,
    setRatio,
    setShowDialog,
    showDialog,
  };
}
