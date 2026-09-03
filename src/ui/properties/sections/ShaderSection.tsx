import { observer } from "mobx-react-lite";
import {
  ImagePlusIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  ResetIcon,
  TrashIcon,
  UploadIcon,
} from "../../icons";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ColorField,
  IconButton,
  MixedNumberInput,
  MixedSelect,
  PropertyRow,
  Section,
  SegmentedControl,
} from "../PropertyControls";
import { Slider } from "../../primitives";
import { isMixed, MIXED, type MaybeMixed } from "../selection-properties";
import { useEditorStore } from "../../../core/state/EditorStore";
import { measureImageFile } from "../../../core/editor/clipboard/image-paste";
import { uploadImageAssetFromFile } from "../../../core/state/image-assets";
import { useImageAssetUrl } from "../../../core/state/use-image-asset-url";
import type { DesignNode, ImageAssetRef } from "../../../core/types";
import type { ShaderParamSpec, ShaderParamValue } from "../../../core/editor/shaders/params";
import {
  DEFAULT_SHADER_ID,
  SHADER_DEFINITIONS,
  type ShaderDefinition,
} from "../../../core/editor/shaders/registry";
import {
  createShaderContent,
  formatShaderContent,
  parseShaderContent,
  readShaderParam,
  type ShaderNodeValue,
} from "../../../core/editor/shaders/serialization";
import { FONT_STACK } from "../../floating-styles";
import { everyType, type SectionProps } from "./types";

/** Keep the control hierarchy shallow: image, parameters, then colors. */
const PARAMETER_SECTIONS: Array<{
  groups: ShaderParamSpec["group"][];
  title: string;
}> = [
  { groups: ["shape", "motion", "sizing"], title: "Parameters" },
  { groups: ["color"], title: "Colors" },
];

/** Package-level uniforms kept out of the everyday shader inspector. */
const INTERNAL_PARAMETER_NAMES = new Set([
  "frame",
  "offsetX",
  "offsetY",
  "originX",
  "originY",
  "rotation",
  "worldHeight",
  "worldWidth",
]);

function visibleParameterSpecs(
  definition: ShaderDefinition,
  groups: ShaderParamSpec["group"][],
): ShaderParamSpec[] {
  const groupSet = new Set(groups);
  const specs = definition.params.filter((spec) => {
    if (!groupSet.has(spec.group)) return false;
    if (INTERNAL_PARAMETER_NAMES.has(spec.name)) return false;
    if (spec.name === "fit" && !definition.acceptsImage) return false;
    if (spec.name === "speed" && !definition.animated) return false;
    return true;
  });

  if (groups.length === 1 && groups[0] === "color") return specs;

  const rank = (spec: ShaderParamSpec) => {
    if (spec.name === "fit") return 0;
    if (spec.kind === "select" || spec.kind === "boolean") return 1;
    if (spec.name === "speed") return 2;
    if (spec.name === "scale") return 3;
    return 4;
  };
  return specs
    .map((spec, index) => ({ spec, index }))
    .sort((a, b) => rank(a.spec) - rank(b.spec) || a.index - b.index)
    .map(({ spec }) => spec);
}

/**
 * Collapse a per-node parameter read.
 *
 * `aggregate` from selection-properties compares with `Object.is`, which reports
 * two identical colour palettes as mixed because they are separate arrays.
 */
function aggregateParam(values: ShaderParamValue[]): MaybeMixed<ShaderParamValue | undefined> {
  const first = values[0];
  if (first === undefined) return undefined;
  const firstKey = JSON.stringify(first);
  return values.every((value) => JSON.stringify(value) === firstKey) ? first : MIXED;
}

function aggregateText(values: string[]): MaybeMixed<string | undefined> {
  const first = values[0];
  if (first === undefined) return undefined;
  return values.every((value) => value === first) ? first : MIXED;
}

function Label({ children, block = false }: { children: ReactNode; block?: boolean }) {
  return (
    <div
      style={{
        width: block ? "100%" : 92,
        flexShrink: 0,
        fontSize: 10,
        color: "var(--leaf-text-muted)",
        fontFamily: FONT_STACK,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        marginBottom: block ? 5 : 0,
      }}
      title={typeof children === "string" ? children : undefined}
    >
      {children}
    </div>
  );
}

function aggregateImageAsset(nodes: DesignNode[]): {
  asset: ImageAssetRef | null;
  mixed: boolean;
} {
  const first = nodes[0]?.imageAsset ?? null;
  const firstKey = JSON.stringify(first);
  const mixed = nodes.some((node) => JSON.stringify(node.imageAsset ?? null) !== firstKey);
  return { asset: mixed ? null : first, mixed };
}

function ShaderImageField({
  asset,
  mixed,
  onFile,
  onRemove,
}: {
  asset: ImageAssetRef | null;
  mixed: boolean;
  onFile: (file: File) => Promise<void>;
  onRemove: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<"idle" | "uploading">("idle");
  const [error, setError] = useState<string | null>(null);
  const { url, handleImageLoad, handleImageLoadError } = useImageAssetUrl(asset);

  const chooseFile = () => inputRef.current?.click();
  const acceptFile = async (file: File | undefined) => {
    if (!file) return;
    setStatus("uploading");
    setError(null);
    try {
      await onFile(file);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Image upload failed");
    } finally {
      setStatus("idle");
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        data-property="shaderImageInput"
        type="file"
        accept="image/*"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          void acceptFile(file);
        }}
        style={{ display: "none" }}
      />

      {asset && !mixed ? (
        <div
          data-property="shaderImage"
          style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}
        >
          <button
            type="button"
            onClick={chooseFile}
            title="Replace image"
            style={{
              width: 42,
              height: 42,
              padding: 0,
              border: "1px solid var(--leaf-border)",
              borderRadius: 5,
              overflow: "hidden",
              background: "var(--leaf-surface-app)",
              flexShrink: 0,
            }}
          >
            {url ? (
              <img
                src={url}
                alt=""
                onLoad={handleImageLoad}
                onError={handleImageLoadError}
                style={{ width: "100%", height: "100%", display: "block", objectFit: "cover" }}
              />
            ) : (
              <ImagePlusIcon size={12} aria-hidden="true" />
            )}
          </button>
          <div style={{ flex: 1, minWidth: 0, fontFamily: FONT_STACK }}>
            <div
              style={{
                color: "var(--leaf-text)",
                fontSize: 11,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={asset.sourceName ?? "Shader image"}
            >
              {asset.sourceName ?? "Shader image"}
            </div>
            <div style={{ color: "var(--leaf-text-faint)", fontSize: 10, marginTop: 2 }}>
              {asset.width} × {asset.height}
            </div>
          </div>
          <IconButton onClick={chooseFile} title="Replace image">
            <UploadIcon size={12} />
          </IconButton>
          <IconButton onClick={onRemove} title="Remove image">
            <TrashIcon size={12} />
          </IconButton>
        </div>
      ) : (
        <button
          type="button"
          data-property="shaderImage"
          onClick={chooseFile}
          disabled={status === "uploading"}
          className="leaf-input leaf-input-filled"
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            color: "var(--leaf-text-muted)",
            fontFamily: FONT_STACK,
          }}
        >
          <ImagePlusIcon size={12} aria-hidden="true" />
          {status === "uploading"
            ? "Adding image…"
            : mixed
              ? "Replace mixed images…"
              : "Choose image…"}
        </button>
      )}
      {error ? <Hint>{error}</Hint> : null}
    </>
  );
}

function singleSliderValue(value: number | readonly number[]): number {
  return typeof value === "number" ? value : (value[0] ?? 0);
}

function ShaderNumberField({
  spec,
  value,
  onChange,
  beginEdit,
  endEdit,
  buffered,
}: {
  spec: Extract<ShaderParamSpec, { kind: "number" }>;
  value: MaybeMixed<number | undefined>;
  onChange: (next: number) => void;
  beginEdit: () => void;
  endEdit: () => void;
  buffered: { onFocus: () => void; onBlur: () => void };
}) {
  const editingRef = useRef(false);
  const startEdit = () => {
    if (editingRef.current) return;
    editingRef.current = true;
    beginEdit();
  };
  const finishEdit = () => {
    if (!editingRef.current) return;
    editingRef.current = false;
    endEdit();
  };

  useEffect(
    () => () => {
      if (!editingRef.current) return;
      editingRef.current = false;
      endEdit();
    },
    [endEdit],
  );

  const numeric = isMixed(value) || value === undefined ? spec.default : value;
  const hasSlider = spec.min !== undefined && spec.max !== undefined;
  const isPercent = spec.display === "percent";

  return (
    <div data-property={`shaderParam:${spec.name}`} style={{ marginBottom: 10 }}>
      <Label block>{spec.label}</Label>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        {hasSlider ? (
          <div style={{ flex: 1, minWidth: 0 }} data-mixed={isMixed(value) ? "true" : undefined}>
            <Slider
              aria-label={`${spec.label} slider`}
              value={numeric}
              min={spec.min}
              max={spec.max}
              step={spec.step}
              onValueChange={(next) => {
                startEdit();
                onChange(singleSliderValue(next));
              }}
              onValueCommitted={finishEdit}
              onBlur={finishEdit}
            />
          </div>
        ) : null}
        <div style={{ width: hasSlider ? 60 : "100%", flexShrink: 0 }}>
          <MixedNumberInput
            affordance={<span />}
            value={value}
            min={spec.min}
            max={spec.max}
            step={spec.step}
            suffix={isPercent ? "%" : undefined}
            displayMultiplier={isPercent ? 100 : 1}
            onChange={onChange}
            {...buffered}
          />
        </div>
      </div>
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontSize: 10, color: "var(--leaf-text-faint)", fontFamily: FONT_STACK }}>
      {children}
    </div>
  );
}

function MixedCheckbox({
  label,
  value,
  onChange,
}: {
  label: string;
  value: MaybeMixed<boolean | undefined>;
  onChange: (next: boolean) => void;
}) {
  const mixed = isMixed(value);
  return (
    <input
      aria-label={label}
      type="checkbox"
      checked={!mixed && value === true}
      ref={(input) => {
        if (input) input.indeterminate = mixed;
      }}
      onChange={(event) => onChange(event.target.checked)}
      style={{ width: 14, height: 14, accentColor: "var(--leaf-text)" }}
    />
  );
}

/**
 * Editor for a shader's colour palette.
 *
 * The array is rewritten whole on every edit because the shader reads it as one
 * uniform; there is no per-entry write to make.
 */
function ColorListField({
  colors,
  maxCount,
  onChange,
  buffered,
}: {
  colors: MaybeMixed<string[]>;
  maxCount: number;
  onChange: (next: string[]) => void;
  buffered: { onFocus: () => void; onBlur: () => void };
}) {
  if (isMixed(colors)) {
    return <Hint>Palettes differ across the selection</Hint>;
  }

  return (
    <>
      {colors.map((color, index) => (
        <PropertyRow key={index}>
          <div data-property={`shaderColor:${index}`} style={{ flex: 1, minWidth: 0 }}>
            <ColorField
              value={color}
              onChange={(next) =>
                onChange(colors.map((entry, at) => (at === index ? next : entry)))
              }
              {...buffered}
            />
          </div>
          {colors.length > 1 && (
            <IconButton
              onClick={() => onChange(colors.filter((_, at) => at !== index))}
              title="Remove color"
            >
              <TrashIcon size={12} />
            </IconButton>
          )}
        </PropertyRow>
      ))}
      {colors.length < maxCount && (
        <PropertyRow>
          <IconButton
            onClick={() => onChange([...colors, colors[colors.length - 1] ?? "#ffffff"])}
            title="Add color"
          >
            <PlusIcon size={12} />
          </IconButton>
          <Hint>
            {colors.length} of {maxCount}
          </Hint>
        </PropertyRow>
      )}
    </>
  );
}

/**
 * Shader picker and parameter editor for shader nodes.
 *
 * Everything is read back out of `node.content`, so a shader an agent wrote
 * over MCP lands in the same controls as one created from the toolbar.
 */
export const ShaderSection = observer(({ props }: SectionProps) => {
  const { nodes, isMultiple, buffered, beginEdit, endEdit } = props;
  const store = useEditorStore();
  if (!everyType(nodes, "shader")) return null;

  const parsed = nodes.map((node) => ({ node, result: parseShaderContent(node.content) }));
  const broken = parsed.filter((entry) => entry.result.status === "invalid");
  const readable = parsed.flatMap((entry) =>
    entry.result.status === "ok"
      ? [{ node: entry.node, value: entry.result.value, definition: entry.result.definition }]
      : [],
  );

  const write = (updates: Array<{ nodeId: string; textContent: string }>) => {
    if (updates.length > 0) store.runtime.setTextContent(updates);
  };

  const repair = () => {
    write(
      broken.map((entry) => ({
        nodeId: entry.node.id,
        textContent: createShaderContent(DEFAULT_SHADER_ID),
      })),
    );
  };

  const shaderId = aggregateText(readable.map((entry) => entry.value.shaderId));
  // Switching shader replaces the whole parameter set: the new shader's props
  // are a different schema, so carrying the old values over is meaningless.
  const selectShader = (id: string) => {
    write(nodes.map((node) => ({ nodeId: node.id, textContent: createShaderContent(id) })));
  };

  const definition: ShaderDefinition | undefined = isMixed(shaderId)
    ? undefined
    : readable[0]?.definition;

  const writeValues = (
    next: (entry: { node: DesignNode; value: ShaderNodeValue }) => ShaderNodeValue,
  ) => {
    write(
      readable.map((entry) => ({
        nodeId: entry.node.id,
        textContent: formatShaderContent(next(entry)),
      })),
    );
  };

  const setParam = (spec: ShaderParamSpec, value: ShaderParamValue) => {
    beginEdit();
    writeValues((entry) => ({
      ...entry.value,
      params: { ...entry.value.params, [spec.name]: value },
    }));
    endEdit();
  };

  const paused = aggregateParam(readable.map((entry) => entry.value.paused === true));
  const togglePaused = () => {
    const next = !(paused === true);
    writeValues((entry) => ({ ...entry.value, paused: next }));
  };

  const applyPreset = (name: string) => {
    if (!definition) return;
    write(
      readable.map((entry) => ({
        nodeId: entry.node.id,
        textContent: createShaderContent(entry.value.shaderId, name),
      })),
    );
  };

  const activePreset = definition?.presets.find((preset) =>
    readable.every((entry) =>
      definition.params.every(
        (spec) =>
          JSON.stringify(readShaderParam(entry.value, spec)) ===
          JSON.stringify(preset.params[spec.name]),
      ),
    ),
  )?.name;

  const image = aggregateImageAsset(nodes);
  const setImageAsset = (asset: ImageAssetRef | null) => {
    beginEdit();
    try {
      for (const node of nodes) {
        store.runtime.updateNode(node.id, { imageAsset: asset ? { ...asset } : null });
      }
    } finally {
      endEdit();
    }
  };
  const uploadImage = async (file: File) => {
    const naturalSize = await measureImageFile(file);
    const asset = await uploadImageAssetFromFile(file, naturalSize);
    setImageAsset(asset);
  };

  const renderParam = (spec: ShaderParamSpec) => {
    const value = aggregateParam(readable.map((entry) => readShaderParam(entry.value, spec)));

    if (spec.kind === "colors") {
      return (
        <div key={spec.name} data-property={`shaderParam:${spec.name}`}>
          <Label>{spec.label}</Label>
          <ColorListField
            colors={isMixed(value) ? MIXED : Array.isArray(value) ? value : spec.default}
            maxCount={spec.maxCount}
            onChange={(next) => setParam(spec, next)}
            buffered={buffered}
          />
        </div>
      );
    }

    // Colour controls carry a swatch, a hex field and an alpha field, which
    // leaves no room for an inline label in a 260px panel.
    if (spec.kind === "color") {
      return (
        <div key={spec.name} data-property={`shaderParam:${spec.name}`}>
          <Label>{spec.label}</Label>
          <PropertyRow>
            <ColorField
              value={isMixed(value) ? MIXED : typeof value === "string" ? value : spec.default}
              onChange={(next) => setParam(spec, next)}
              {...buffered}
            />
          </PropertyRow>
        </div>
      );
    }

    if (spec.kind === "number") {
      return (
        <ShaderNumberField
          key={spec.name}
          spec={spec}
          value={isMixed(value) ? MIXED : typeof value === "number" ? value : spec.default}
          onChange={(next) =>
            writeValues((entry) => ({
              ...entry.value,
              params: { ...entry.value.params, [spec.name]: next },
            }))
          }
          beginEdit={beginEdit}
          endEdit={endEdit}
          buffered={buffered}
        />
      );
    }

    if (spec.kind === "select" && spec.name === "fit" && !isMixed(value)) {
      const selected = typeof value === "string" ? value : spec.default;
      return (
        <div
          key={spec.name}
          data-property={`shaderParam:${spec.name}`}
          style={{ marginBottom: 10 }}
        >
          <Label block>{spec.label}</Label>
          <SegmentedControl
            value={selected}
            options={spec.options.map((option) => ({
              value: option,
              label: option[0]!.toUpperCase() + option.slice(1),
            }))}
            onChange={(next) => setParam(spec, next)}
          />
        </div>
      );
    }

    return (
      <PropertyRow key={spec.name}>
        <Label>{spec.label}</Label>
        <div data-property={`shaderParam:${spec.name}`} style={{ flex: 1, minWidth: 0 }}>
          {spec.kind === "select" ? (
            <MixedSelect
              value={isMixed(value) ? MIXED : typeof value === "string" ? value : spec.default}
              options={spec.options.map((option) => ({ label: option, value: option }))}
              onChange={(next) => setParam(spec, next)}
              {...buffered}
            />
          ) : (
            <MixedCheckbox
              label={spec.label}
              value={isMixed(value) ? MIXED : typeof value === "boolean" ? value : spec.default}
              onChange={(next) => setParam(spec, next)}
            />
          )}
        </div>
      </PropertyRow>
    );
  };

  return (
    <>
      <Section
        title="Shader"
        trailing={
          definition?.animated ? (
            <IconButton
              onClick={togglePaused}
              active={paused === true}
              title={paused === true ? "Resume shader" : "Pause shader"}
            >
              {paused === true ? <PlayIcon size={12} /> : <PauseIcon size={12} />}
            </IconButton>
          ) : undefined
        }
      >
        <PropertyRow>
          <div data-property="shaderId" style={{ flex: 1, minWidth: 0 }}>
            <MixedSelect
              value={isMixed(shaderId) ? MIXED : (shaderId ?? DEFAULT_SHADER_ID)}
              options={SHADER_DEFINITIONS.map((entry) => ({
                label: entry.label,
                value: entry.id,
              }))}
              onChange={selectShader}
            />
          </div>
        </PropertyRow>

        {broken.length > 0 && (
          <PropertyRow>
            <div data-property="shaderRepair" style={{ flex: 1, minWidth: 0 }}>
              <Hint>
                {broken.length === 1
                  ? (broken[0]!.result as { message: string }).message
                  : `${broken.length} shaders have unreadable settings`}
              </Hint>
            </div>
            <IconButton onClick={repair} title="Reset shader settings">
              <ResetIcon size={12} />
            </IconButton>
          </PropertyRow>
        )}

        {isMixed(shaderId) && <Hint>Select one shader to edit its parameters</Hint>}
        {isMultiple && !isMixed(shaderId) && <Hint>Editing {nodes.length} shaders</Hint>}
      </Section>

      {definition && definition.presets.length > 1 ? (
        <Section title="Presets">
          <div
            data-property="shaderPreset"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              gap: 6,
            }}
          >
            {definition.presets.map((preset) => {
              const active = activePreset === preset.name;
              return (
                <button
                  key={preset.name}
                  type="button"
                  data-shader-preset={preset.name}
                  aria-pressed={active}
                  onClick={() => applyPreset(preset.name)}
                  className="leaf-input leaf-input-filled"
                  style={{
                    width: "100%",
                    color: active ? "var(--leaf-text)" : "var(--leaf-text-muted)",
                    backgroundColor: active ? "var(--leaf-surface-sunken)" : undefined,
                    fontFamily: FONT_STACK,
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  {preset.name}
                </button>
              );
            })}
          </div>
        </Section>
      ) : null}

      {definition?.acceptsImage ? (
        <Section title="Image">
          <ShaderImageField
            asset={image.asset}
            mixed={image.mixed}
            onFile={uploadImage}
            onRemove={() => setImageAsset(null)}
          />
        </Section>
      ) : null}

      {definition &&
        PARAMETER_SECTIONS.map(({ groups, title }) => {
          const specs = visibleParameterSpecs(definition, groups);
          if (specs.length === 0) return null;
          return (
            <Section key={title} title={title}>
              {specs.map(renderParam)}
            </Section>
          );
        })}
    </>
  );
});
