import { useCallback, useRef } from "react";
import { useEditorStore } from "../../core/state/EditorStore";
import type { DesignNode, GeneratedImageJob } from "../../core/types";

export interface RendererProps {
  node: DesignNode;
  isFlowChild?: boolean;
  isInteractionSuppressed?: boolean;
  renderChildren?: boolean;
  forceDetail?: boolean;
}

export function useNodeRef(node: DesignNode) {
  const store = useEditorStore();
  const disposeRegistration = useRef<(() => void) | null>(null);

  return useCallback(
    (element: HTMLDivElement | null) => {
      disposeRegistration.current?.();
      disposeRegistration.current = element ? store.domIndex.register(node, element) : null;
    },
    [node, store.domIndex],
  );
}

export function EmptyPlaceholder({ message }: { message: string }) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#f5f5f5",
        color: "#999",
        fontSize: 14,
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      {message}
    </div>
  );
}

export function GeneratedImagePlaceholder({
  status,
  error,
  overlay = false,
}: {
  status: GeneratedImageJob["status"];
  error?: string;
  overlay?: boolean;
}) {
  const message =
    status === "failed"
      ? (error ?? "Image generation failed")
      : status === "ready"
        ? "Preparing image…"
        : "Generating image…";
  return (
    <div
      className={[
        "generated-image-placeholder",
        status === "failed" ? "generated-image-placeholder-failed" : "",
        overlay ? "generated-image-placeholder-overlay" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      title={
        status === "failed" ? error : status === "ready" ? "Generated image" : "Generating image"
      }
    >
      <span>{message}</span>
    </div>
  );
}

export function getGeneratedImagePlaceholderState(
  node: DesignNode,
  job: GeneratedImageJob | undefined,
) {
  if (node.imageGeneration) {
    const status = node.imageGeneration.status ?? (node.imageAsset ? "ready" : "generating");
    return { status, error: node.imageGeneration.error, target: node.imageGeneration.target };
  }
  if (job) return { status: job.status, error: job.error, target: job.target };
  return null;
}

export function GeneratedBackgroundPlaceholder({ node }: { node: DesignNode }) {
  const store = useEditorStore();
  const state = getGeneratedImagePlaceholderState(node, store.generatedImageJobs.get(node.id));
  if (!state || state.target !== "background" || state.status === "ready") return null;
  return <GeneratedImagePlaceholder status={state.status} error={state.error} overlay />;
}
