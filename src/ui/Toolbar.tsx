import { observer } from "mobx-react-lite";
import { useEffect, useRef, useState } from "react";
import { GenerateIcon, RedoIcon, ShaderIcon, UndoIcon } from "./icons";
import { screenPoint } from "../core/editor/interaction/coordinate-spaces";
import { getShaderDefinition } from "../core/editor/shaders/registry";
import { createShaderContent } from "../core/editor/shaders/serialization";
import { useEditorStore } from "../core/state/EditorStore";
import { ShaderPicker } from "./shaders/ShaderPicker";
import { ImageGenerationDialog } from "./toolbar/ImageGenerationDialog";
import { TOGGLE_SHADER_PICKER_EVENT } from "./toolbar-events";
import { toolbarTools } from "./toolbar/toolbar-model";
import { useImageGeneration } from "./toolbar/useImageGeneration";
import { isImageGenerationAvailable } from "../core/editor/image-generation-client";
import { IconButton, ToggleButton } from "./primitives";

export const Toolbar = observer(() => {
  const store = useEditorStore();
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [showShaderPicker, setShowShaderPicker] = useState(false);
  const imageGeneration = useImageGeneration(store, toolbarRef);
  const imageGenerationAvailable = isImageGenerationAvailable();

  useEffect(() => {
    const onToggleShaderPicker = () => {
      setShowShaderPicker((open) => !open);
    };

    window.addEventListener(TOGGLE_SHADER_PICKER_EVENT, onToggleShaderPicker);
    return () => {
      window.removeEventListener(TOGGLE_SHADER_PICKER_EVENT, onToggleShaderPicker);
    };
  }, []);

  return (
    <div
      data-editor-toolbar
      ref={toolbarRef}
      style={{
        position: "fixed",
        bottom: 40,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "center",
        alignItems: "center",
        gap: 2,
        width: "max-content",
        maxWidth: "calc(100% - 24px)",
        padding: "6px 8px",
        backgroundColor: "var(--leaf-surface)",
        borderRadius: 12,
        boxShadow: "var(--leaf-shadow-pill)",
        zIndex: 100,
        pointerEvents: "auto",
      }}
    >
      {imageGeneration.showDialog && (
        <ImageGenerationDialog
          prompt={imageGeneration.prompt}
          ratio={imageGeneration.ratio}
          background={imageGeneration.background}
          count={imageGeneration.count}
          referenceImages={imageGeneration.references}
          error={imageGeneration.error}
          isSubmitting={imageGeneration.isSubmitting}
          onPromptChange={imageGeneration.setPrompt}
          onRatioChange={imageGeneration.setRatio}
          onBackgroundChange={imageGeneration.setBackground}
          onCountChange={imageGeneration.setCount}
          onSubmit={() => void imageGeneration.generateImage()}
          onCancel={() => imageGeneration.setShowDialog(false)}
        />
      )}

      {toolbarTools.map((tool) => {
        const isActive = store.activeTool === tool.mode;
        const Icon = tool.icon;
        return (
          <ToggleButton
            key={tool.mode}
            size="lg"
            aria-label={tool.label}
            pressed={isActive}
            onPressedChange={() => store.setTool(tool.mode)}
            title={`${tool.label} (${tool.shortcut})`}
          >
            <Icon size={16} />
          </ToggleButton>
        );
      })}

      <div style={{ position: "relative" }}>
        <ToggleButton
          size="lg"
          aria-label="Shaders"
          pressed={showShaderPicker}
          onPressedChange={(pressed) => setShowShaderPicker(pressed)}
          title="Shaders (S)"
        >
          <ShaderIcon size={16} />
        </ToggleButton>

        {showShaderPicker && (
          <ShaderPicker
            onCancel={() => setShowShaderPicker(false)}
            onSelect={(shaderId) => {
              setShowShaderPicker(false);
              const shaderName = getShaderDefinition(shaderId)?.label ?? shaderId;
              // Drop it in the middle of the current view, the way the other
              // create affordances place their nodes.
              const center = store.screenToCanvas(
                screenPoint(store.viewportWidth / 2, store.viewportHeight / 2),
              );
              const node = store.runtime.createScriptNode("shader", {
                name: shaderName,
                x: Math.round(center.x - 200),
                y: Math.round(center.y - 150),
                content: createShaderContent(shaderId),
              });
              store.selectNode(node.id);
            }}
          />
        )}
      </div>

      <ToolbarSeparator />

      <IconButton
        variant="ghost"
        size="lg"
        aria-label="Undo"
        onClick={() => {
          if (!store.pointerGestureActive) store.undo();
        }}
        disabled={!store.canUndo || store.pointerGestureActive}
        title="Undo (Cmd/Ctrl+Z)"
      >
        <UndoIcon size={16} />
      </IconButton>

      <IconButton
        variant="ghost"
        size="lg"
        aria-label="Redo"
        onClick={() => {
          if (!store.pointerGestureActive) store.redo();
        }}
        disabled={!store.canRedo || store.pointerGestureActive}
        title="Redo (Cmd/Ctrl+Shift+Z)"
      >
        <RedoIcon size={16} />
      </IconButton>

      {imageGenerationAvailable ? (
        <>
          <ToolbarSeparator />
          <div style={{ position: "relative" }}>
            <ToggleButton
              size="lg"
              aria-label="Generate image"
              pressed={imageGeneration.showDialog}
              onPressedChange={(pressed) => {
                imageGeneration.setShowDialog(pressed);
                imageGeneration.setError(null);
              }}
              title="Generate image (Cmd/Ctrl+I)"
            >
              <GenerateIcon size={16} />
            </ToggleButton>
          </div>
        </>
      ) : null}
    </div>
  );
});

function ToolbarSeparator() {
  return (
    <div
      style={{
        width: 1,
        height: 20,
        backgroundColor: "var(--leaf-border)",
        margin: "0 4px",
      }}
    />
  );
}
