import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, CloseIcon, ImageIcon } from "../icons";
import { Button, IconButton, Menu, Switch } from "../primitives";
import {
  getImageGenerationOption,
  IMAGE_GENERATION_OPTIONS,
  type ImageGenerationAspectRatio,
  type ImageGenerationBackground,
} from "../../core/editor/image-generation";
import type { ImageGenerationReferencePreview } from "./toolbar-model";

export function ImageGenerationDialog({
  prompt,
  ratio,
  background,
  count,
  referenceImages,
  error,
  isSubmitting,
  onPromptChange,
  onRatioChange,
  onBackgroundChange,
  onCountChange,
  onSubmit,
  onCancel,
}: {
  prompt: string;
  ratio: ImageGenerationAspectRatio;
  background: ImageGenerationBackground;
  count: number;
  referenceImages: ImageGenerationReferencePreview[];
  error: string | null;
  isSubmitting: boolean;
  onPromptChange: (prompt: string) => void;
  onRatioChange: (ratio: ImageGenerationAspectRatio) => void;
  onBackgroundChange: (background: ImageGenerationBackground) => void;
  onCountChange: (count: number) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [isRatioMenuOpen, setIsRatioMenuOpen] = useState(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const groupedOptions = IMAGE_GENERATION_OPTIONS.reduce<
    Record<"Square" | "Landscape" | "Portrait", typeof IMAGE_GENERATION_OPTIONS>
  >(
    (groups, option) => {
      if (option.ratio === "auto") return groups;
      groups[option.group].push(option);
      return groups;
    },
    { Square: [], Landscape: [], Portrait: [] },
  );

  const selectedOption = getImageGenerationOption(ratio);
  const isSubmitDisabled = !prompt.trim() || isSubmitting;

  return (
    <div
      role="dialog"
      aria-label="Create image"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // Close from any focused control, and stop here: the window-level
        // Escape ladder must not also clear the selection or tool.
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
      style={{
        position: "absolute",
        bottom: "calc(100% + 12px)",
        left: "50%",
        transform: "translateX(-50%)",
        width: "min(680px, calc(100vw - 48px))",
        backgroundColor: "var(--leaf-surface)",
        borderRadius: 12,
        padding: 12,
        zIndex: 220,
        boxShadow: "var(--leaf-shadow-pill)",
      }}
    >
      {referenceImages.length > 0 ? <ImageReferenceStrip images={referenceImages} /> : null}

      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <textarea
          ref={inputRef}
          aria-label="Image description"
          value={prompt}
          placeholder="A beautiful sunset over a calm ocean"
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") onSubmit();
          }}
          rows={2}
          style={{
            flex: 1,
            minWidth: 0,
            resize: "none",
            border: "none",
            outline: "none",
            background: "transparent",
            color: "var(--leaf-text)",
            fontSize: "var(--leaf-text-md)",
            lineHeight: 1.5,
            fontFamily: "var(--leaf-font-sans)",
            padding: "4px 2px",
          }}
        />
        <IconButton
          type="button"
          variant="ghost"
          size="md"
          onClick={onCancel}
          title="Close"
          aria-label="Close"
          style={{ color: "var(--leaf-text-faint)", borderRadius: 6 }}
        >
          <CloseIcon size={12} />
        </IconButton>
      </div>

      <div
        style={{
          marginTop: 10,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            flex: "1 1 280px",
            flexWrap: "wrap",
            gap: 6,
            minWidth: 0,
          }}
        >
          <Menu.Root open={isRatioMenuOpen} onOpenChange={setIsRatioMenuOpen}>
            <Menu.Trigger
              render={
                <button
                  type="button"
                  style={{
                    height: 28,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "0 10px",
                    borderRadius: 7,
                    border: "none",
                    background: isRatioMenuOpen
                      ? "var(--leaf-border)"
                      : "var(--leaf-surface-sunken)",
                    color: "var(--leaf-text-secondary)",
                    fontSize: "var(--leaf-text-sm)",
                    fontFamily: "var(--leaf-font-sans)",
                    fontWeight: 500,
                    transition: "all 0.15s",
                  }}
                />
              }
            >
              <ImageIcon size={12} color="var(--leaf-text-faint)" />
              <span>{selectedOption.ratio}</span>
              <ChevronDownIcon size={12} color="var(--leaf-text-faint)" />
            </Menu.Trigger>

            <AspectRatioMenu
              groupedOptions={groupedOptions}
              selectedRatio={ratio}
              onSelect={onRatioChange}
            />
          </Menu.Root>

          <label
            style={{
              height: 28,
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "0 10px",
              borderRadius: 7,
              background: "var(--leaf-surface-sunken)",
              color: "var(--leaf-text-secondary)",
              fontSize: "var(--leaf-text-sm)",
              fontFamily: "var(--leaf-font-sans)",
              fontWeight: 500,
            }}
          >
            <span>Count</span>
            <input
              type="number"
              min={1}
              step={1}
              disabled={isSubmitting}
              value={count}
              onChange={(event) => {
                const nextValue = Number.parseInt(event.target.value, 10);
                onCountChange(Number.isFinite(nextValue) && nextValue > 0 ? nextValue : 1);
              }}
              style={{
                width: 48,
                border: "none",
                outline: "none",
                background: "transparent",
                color: "var(--leaf-text)",
                fontSize: "var(--leaf-text-sm)",
                fontFamily: "var(--leaf-font-sans)",
                fontWeight: 600,
              }}
            />
          </label>

          <label
            title="Works best for isolated subjects; background instructions in the prompt can override transparency."
            style={{
              height: 28,
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "0 10px",
              borderRadius: 7,
              background: "var(--leaf-surface-sunken)",
              color: "var(--leaf-text-secondary)",
              fontSize: "var(--leaf-text-sm)",
              fontFamily: "var(--leaf-font-sans)",
              fontWeight: 500,
            }}
          >
            <span>Transparent background</span>
            <Switch
              aria-label="Transparent background"
              checked={background === "transparent"}
              disabled={isSubmitting}
              onCheckedChange={(checked) => onBackgroundChange(checked ? "transparent" : "auto")}
            />
          </label>
        </div>

        <Button
          type="button"
          variant="ink"
          size="md"
          onClick={onSubmit}
          disabled={isSubmitDisabled}
        >
          {isSubmitting ? "Creating..." : count === 1 ? "Create image" : `Create ${count} images`}
        </Button>
      </div>

      {error ? (
        <div
          style={{
            marginTop: 8,
            color: "var(--leaf-danger-strong)",
            fontSize: "var(--leaf-text-sm)",
            lineHeight: 1.4,
            fontFamily: "var(--leaf-font-sans)",
          }}
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}

function ImageReferenceStrip({ images }: { images: ImageGenerationReferencePreview[] }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 6,
        alignItems: "center",
        overflowX: "auto",
        paddingBottom: 10,
        marginBottom: 8,
        borderBottom: "1px solid var(--leaf-surface-sunken)",
      }}
    >
      {images.map((image) => (
        <img
          key={image.id ?? image.dataUrl}
          src={image.dataUrl}
          alt={image.name ?? "Reference image"}
          title={image.name ?? "Reference image"}
          draggable={false}
          style={{
            width: 44,
            height: 44,
            flex: "0 0 auto",
            borderRadius: 6,
            background: "var(--leaf-surface-sunken)",
            objectFit: "cover",
          }}
        />
      ))}
    </div>
  );
}

function AspectRatioMenuItem({
  ratio,
  isSelected,
  onSelect,
}: {
  ratio: ImageGenerationAspectRatio;
  isSelected: boolean;
  onSelect: (ratio: ImageGenerationAspectRatio) => void;
}) {
  return (
    <Menu.Item onClick={() => onSelect(ratio)}>
      <span style={{ width: 12, display: "grid", placeItems: "center" }}>
        {isSelected ? <CheckIcon size={12} color="var(--leaf-text)" /> : null}
      </span>
      <span>{ratio}</span>
    </Menu.Item>
  );
}

/** Popup half of the ratio picker; must render inside the trigger's Menu.Root. */
function AspectRatioMenu({
  groupedOptions,
  selectedRatio,
  onSelect,
}: {
  groupedOptions: Record<"Square" | "Landscape" | "Portrait", typeof IMAGE_GENERATION_OPTIONS>;
  selectedRatio: ImageGenerationAspectRatio;
  onSelect: (ratio: ImageGenerationAspectRatio) => void;
}) {
  const autoOption = IMAGE_GENERATION_OPTIONS[0];

  return (
    <Menu.Portal>
      <Menu.Positioner side="top" align="start" sideOffset={6}>
        <Menu.Popup style={{ minWidth: 160 }}>
          {autoOption ? (
            <>
              <AspectRatioMenuItem
                ratio={autoOption.ratio}
                isSelected={autoOption.ratio === selectedRatio}
                onSelect={onSelect}
              />
              <Menu.Separator />
            </>
          ) : null}
          {(["Square", "Landscape", "Portrait"] as const).map((group, groupIndex) => (
            <div key={group}>
              {groupIndex > 0 ? <Menu.Separator /> : null}
              <div
                style={{
                  padding: "6px 10px 4px",
                  color: "var(--leaf-text-faint)",
                  fontSize: "var(--leaf-text-xs)",
                  fontWeight: 500,
                  letterSpacing: "0.02em",
                  textTransform: "uppercase",
                }}
              >
                {group}
              </div>
              {groupedOptions[group].map((option) => (
                <AspectRatioMenuItem
                  key={option.ratio}
                  ratio={option.ratio}
                  isSelected={option.ratio === selectedRatio}
                  onSelect={onSelect}
                />
              ))}
            </div>
          ))}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  );
}
