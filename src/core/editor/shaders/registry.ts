import type { ComponentType } from "react";
import * as shadersReact from "@paper-design/shaders-react";
import { deriveParamSpec, type ShaderParamSpec, type ShaderParamValue } from "./params";

/**
 * The shader components take a different prop set each, so the registry types
 * them structurally. Every value that reaches one is validated against the
 * shader's own schema first — see `shaderComponentProps`.
 */
export type ShaderComponent = ComponentType<Record<string, unknown>>;

export interface ShaderPreset {
  name: string;
  params: Record<string, ShaderParamValue>;
}

export interface ShaderDefinition {
  /** Stable id stored in `node.content`, e.g. `meshGradient`. */
  id: string;
  label: string;
  component: ShaderComponent;
  params: ShaderParamSpec[];
  presets: ShaderPreset[];
  /** True when the shader has a `speed` prop, i.e. it costs a frame loop. */
  animated: boolean;
  /** True when the package component accepts a source image texture. */
  acceptsImage: boolean;
}

const PRESETS_SUFFIX = "Presets";

/** Names `humanizeName` cannot get right, because it cannot know an acronym. */
const LABEL_OVERRIDES: Record<string, string> = {
  halftoneCmyk: "Halftone CMYK",
};

/** Fallback when a shader publishes no `*Meta` with a real colour limit. */
const DEFAULT_MAX_COLOR_COUNT = 10;

/**
 * Optional image props are omitted from package presets, so runtime preset
 * introspection cannot discover them. Keep this narrow list aligned to the
 * package's exported `*Params` interfaces.
 */
const IMAGE_SHADER_IDS = new Set([
  "flutedGlass",
  "gemSmoke",
  "halftoneCmyk",
  "halftoneDots",
  "heatmap",
  "imageDithering",
  "lensDistortion",
  "liquidMetal",
  "paperTexture",
  "water",
]);

const GROUP_ORDER: Record<ShaderParamSpec["group"], number> = {
  color: 0,
  shape: 1,
  motion: 2,
  sizing: 3,
};

function toLabel(id: string): string {
  return (
    LABEL_OVERRIDES[id] ??
    id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (character) => character.toUpperCase())
  );
}

function readMaxColorCount(moduleExports: Record<string, unknown>, id: string): number {
  const meta = moduleExports[`${id}Meta`];
  if (typeof meta !== "object" || meta === null) return DEFAULT_MAX_COLOR_COUNT;
  const value = (meta as { maxColorCount?: unknown }).maxColorCount;
  return typeof value === "number" && value > 0 ? value : DEFAULT_MAX_COLOR_COUNT;
}

function isPresetList(
  value: unknown,
): value is Array<{ name: string; params: Record<string, unknown> }> {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { name?: unknown }).name === "string" &&
        typeof (entry as { params?: unknown }).params === "object",
    )
  );
}

/**
 * Build the shader catalogue from the installed package.
 *
 * Every shader ships a `<id>Presets` array whose first entry is a fully
 * populated `Required<Params>` default, so walking the module namespace yields
 * the exact shader set, prop names, kinds and defaults of the version on disk.
 * A hand-written catalogue would silently disagree with the package the moment
 * it moved.
 */
function buildRegistry(): ShaderDefinition[] {
  const moduleExports = shadersReact as unknown as Record<string, unknown>;
  const definitions: ShaderDefinition[] = [];

  for (const key of Object.keys(moduleExports)) {
    if (!key.endsWith(PRESETS_SUFFIX)) continue;
    const id = key.slice(0, -PRESETS_SUFFIX.length);
    if (!id) continue;

    const presets = moduleExports[key];
    if (!isPresetList(presets)) continue;

    const component = moduleExports[id[0]!.toUpperCase() + id.slice(1)];
    if (typeof component !== "function" && typeof component !== "object") continue;

    const defaults = presets[0]!.params;
    const maxColorCount = readMaxColorCount(moduleExports, id);
    const params: ShaderParamSpec[] = [];

    for (const [name, value] of Object.entries(defaults)) {
      const spec = deriveParamSpec(id, name, value, {
        maxColorCount,
        presetValues: presets.map((preset) => preset.params[name]),
      });
      if (spec) params.push(spec);
    }

    params.sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group]);

    definitions.push({
      id,
      label: toLabel(id),
      component: component as ShaderComponent,
      params,
      presets: presets.map((preset) => ({
        name: preset.name,
        params: preset.params as Record<string, ShaderParamValue>,
      })),
      animated: params.some((param) => param.name === "speed"),
      acceptsImage: IMAGE_SHADER_IDS.has(id),
    });
  }

  return definitions.sort((a, b) => a.label.localeCompare(b.label));
}

export const SHADER_DEFINITIONS: readonly ShaderDefinition[] = buildRegistry();

const BY_ID = new Map(SHADER_DEFINITIONS.map((definition) => [definition.id, definition]));

export function getShaderDefinition(id: string): ShaderDefinition | undefined {
  return BY_ID.get(id);
}

/** Open the shader menu on a mesh gradient; fall back to whatever exists. */
export const DEFAULT_SHADER_ID =
  BY_ID.get("meshGradient")?.id ?? SHADER_DEFINITIONS[0]?.id ?? "meshGradient";
