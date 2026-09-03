import {
  DitheringShapes,
  DitheringTypes,
  DotGridShapes,
  GemSmokeShapes,
  GlassDistortionShapes,
  GlassGridShapes,
  GrainGradientShapes,
  HalftoneCmykTypes,
  HalftoneDotsGrids,
  HalftoneDotsTypes,
  LiquidMetalShapes,
  PulsingBorderAspectRatios,
  ShaderFitOptions,
  WarpPatterns,
} from "@paper-design/shaders";

/** Every value a shader parameter can hold once it has been through the schema. */
export type ShaderParamValue = string | number | boolean | string[];

export type ShaderParamGroup = "color" | "shape" | "motion" | "sizing";

interface ShaderParamBase {
  /** Prop name on the shader component, and the key inside `node.content`. */
  name: string;
  label: string;
  group: ShaderParamGroup;
}

export type ShaderParamSpec = ShaderParamBase &
  (
    | { kind: "color"; default: string }
    | { kind: "colors"; default: string[]; maxCount: number }
    | {
        kind: "number";
        default: number;
        min?: number;
        max?: number;
        step: number;
        display?: "percent";
      }
    | { kind: "select"; default: string; options: string[] }
    | { kind: "boolean"; default: boolean }
  );

/** Sizing props every shader shares, from `ShaderSizingParams`. */
const SIZING_PARAMS = new Set([
  "fit",
  "scale",
  "rotation",
  "offsetX",
  "offsetY",
  "originX",
  "originY",
  "worldWidth",
  "worldHeight",
]);

/** Playback props from `ShaderMotionParams`. */
const MOTION_PARAMS = new Set(["speed", "frame"]);

/**
 * Ranges for the props shared by every shader. The package documents these in
 * the JSDoc above each fragment shader but does not export them as data, so
 * they are the one part of the schema that is transcribed rather than derived.
 * Shader-specific numbers are deliberately left unbounded — their useful ranges
 * differ per shader and the shaders clamp internally.
 */
const SHARED_NUMBER_RANGES: Record<string, { min?: number; max?: number; step: number }> = {
  scale: { min: 0.01, max: 4, step: 0.01 },
  rotation: { min: 0, max: 360, step: 1 },
  offsetX: { min: -1, max: 1, step: 0.01 },
  offsetY: { min: -1, max: 1, step: 0.01 },
  originX: { min: 0, max: 1, step: 0.01 },
  originY: { min: 0, max: 1, step: 0.01 },
  worldWidth: { min: 0, step: 1 },
  worldHeight: { min: 0, step: 1 },
  speed: { min: -4, max: 4, step: 0.05 },
  // Animation time in milliseconds, so single units are invisible.
  frame: { step: 100 },
};

type NumberControl = { min: number; max: number; step: number; display?: "percent" };

const UNIT_INTERVAL_CONTROL: NumberControl = {
  min: 0,
  max: 1,
  step: 0.01,
  display: "percent",
};

/**
 * Parameters whose published range defaults to 0–1. Names with a shader that
 * publishes a different range are overridden in `SHADER_NUMBER_RANGES`.
 */
const UNIT_INTERVAL_NUMBER_NAMES = new Set([
  "amplitude",
  "bloom",
  "brightness",
  "caustic",
  "center",
  "contour",
  "contrast",
  "crumpleSize",
  "crumples",
  "density",
  "dispersion",
  "distortion",
  "drops",
  "edges",
  "fade",
  "fadeIn",
  "fadeOut",
  "fiber",
  "fiberSize",
  "focusCenter",
  "focusEdges",
  "folds",
  "glow",
  "gradient",
  "grainMixer",
  "grainOverlay",
  "grainSize",
  "gridNoise",
  "highlights",
  "innerDistortion",
  "innerGlow",
  "intensity",
  "layering",
  "lensCircle",
  "marginBottom",
  "marginLeft",
  "marginRight",
  "marginTop",
  "midIntensity",
  "midSize",
  "minDot",
  "mixing",
  "noise",
  "noiseFrequency",
  "opacityRange",
  "outerDistortion",
  "outerGlow",
  "perspective",
  "proportion",
  "pulse",
  "roughness",
  "roundness",
  "shadows",
  "shapeScale",
  "size",
  "sizeRange",
  "smoke",
  "smokeSize",
  "softness",
  "spotSize",
  "spotty",
  "spread",
  "spreading",
  "stretch",
  "strokeCap",
  "strokeTaper",
  "strokeWidth",
  "swirl",
  "thickness",
  "twist",
  "waveX",
  "waveXShift",
  "waveY",
  "waveYShift",
  "waves",
]);

/** Published ranges that are shared by name and are not the unit interval. */
const NUMBER_RANGES_BY_NAME: Record<string, NumberControl> = {
  angle: { min: 0, max: 360, step: 1 },
  angle1: { min: -1, max: 1, step: 0.01, display: "percent" },
  angle2: { min: -1, max: 1, step: 0.01, display: "percent" },
  bandCount: { min: 0, max: 15, step: 1 },
  bias: { min: -1, max: 1, step: 0.01, display: "percent" },
  distortionFreq: { min: 0, max: 20, step: 0.1 },
  distortionShift: { min: -1, max: 1, step: 0.01, display: "percent" },
  dotSize: { min: 1, max: 100, step: 1 },
  focalAngle: { min: 0, max: 360, step: 1 },
  focalDistance: { min: 0, max: 3, step: 0.01 },
  frequency: { min: 0, max: 2, step: 0.01 },
  gap: { min: 0, max: 0.1, step: 0.001, display: "percent" },
  gapX: { min: 2, max: 500, step: 1 },
  gapY: { min: 2, max: 500, step: 1 },
  imageX: { min: -1, max: 1, step: 0.01, display: "percent" },
  imageY: { min: -1, max: 1, step: 0.01, display: "percent" },
  innerShape: { min: 0, max: 4, step: 0.01 },
  lacunarity: { min: 1.5, max: 10, step: 0.1 },
  length: { min: 0, max: 3, step: 0.01 },
  lensBulge: { min: -1, max: 1, step: 0.01, display: "percent" },
  noiseIterations: { min: 1, max: 8, step: 1 },
  noiseScale: { min: 0.01, max: 5, step: 0.01 },
  octaveCount: { min: 1, max: 8, step: 1 },
  offset: { min: -1, max: 1, step: 0.01, display: "percent" },
  persistence: { min: 0.3, max: 1, step: 0.01, display: "percent" },
  repetition: { min: 1, max: 10, step: 1 },
  seed: { min: 0, max: 1000, step: 0.1 },
  shape: { min: 0, max: 3, step: 1 },
  shift: { min: -1, max: 1, step: 0.01, display: "percent" },
  shiftBlue: { min: -1, max: 1, step: 0.01, display: "percent" },
  shiftRed: { min: -1, max: 1, step: 0.01, display: "percent" },
  spacing: { min: 0, max: 2, step: 0.01 },
  spots: { min: 1, max: 20, step: 1 },
  swirlIterations: { min: 0, max: 20, step: 1 },
};

/** Shader-specific ranges published in the package's parameter JSDoc. */
const SHADER_NUMBER_RANGES: Record<string, NumberControl> = {
  "colorPanels.blur": { min: 0, max: 0.5, step: 0.01, display: "percent" },
  "colorPanels.density": { min: 0.25, max: 7, step: 0.01 },
  "dithering.size": { min: 0.5, max: 20, step: 0.5 },
  "dotGrid.strokeWidth": { min: 0, max: 50, step: 0.1 },
  "flutedGlass.angle": { min: 0, max: 180, step: 1 },
  "flutedGlass.blur": { min: 0, max: 1, step: 0.01, display: "percent" },
  "halftoneCmyk.contrast": { min: 0, max: 2, step: 0.01 },
  "halftoneCmyk.floodC": { min: -1, max: 1, step: 0.01, display: "percent" },
  "halftoneCmyk.floodK": { min: -1, max: 1, step: 0.01, display: "percent" },
  "halftoneCmyk.floodM": { min: -1, max: 1, step: 0.01, display: "percent" },
  "halftoneCmyk.floodY": { min: -1, max: 1, step: 0.01, display: "percent" },
  "halftoneDots.radius": { min: 0, max: 2, step: 0.01 },
  "imageDithering.size": { min: 0.5, max: 20, step: 0.5 },
  "imageDithering.colorSteps": { min: 1, max: 7, step: 1 },
  "lensDistortion.dispersionShift": {
    min: -1,
    max: 1,
    step: 0.01,
    display: "percent",
  },
  "lensDistortion.swirl": { min: -1, max: 1, step: 0.01, display: "percent" },
  "paperTexture.foldCount": { min: 1, max: 15, step: 1 },
  "smokeRing.thickness": { min: 0.01, max: 1, step: 0.01, display: "percent" },
  "staticRadialGradient.falloff": {
    min: -1,
    max: 1,
    step: 0.01,
    display: "percent",
  },
  "staticRadialGradient.radius": { min: 0, max: 3, step: 0.01 },
  "voronoi.distortion": { min: 0, max: 0.5, step: 0.01, display: "percent" },
  "water.size": { min: 0.01, max: 7, step: 0.01 },
};

/**
 * String params resolved against the package's own option maps, so the
 * inspector can never offer a value the shader would reject. Keyed by
 * `<shaderId>.<param>`; a bare param name applies to every shader.
 */
const ENUM_OPTIONS: Record<string, Record<string, number>> = {
  fit: ShaderFitOptions,
  "dithering.shape": DitheringShapes,
  "dithering.type": DitheringTypes,
  "imageDithering.type": DitheringTypes,
  "dotGrid.shape": DotGridShapes,
  "gemSmoke.shape": GemSmokeShapes,
  "grainGradient.shape": GrainGradientShapes,
  "flutedGlass.shape": GlassGridShapes,
  "flutedGlass.distortionShape": GlassDistortionShapes,
  "halftoneDots.type": HalftoneDotsTypes,
  "halftoneDots.grid": HalftoneDotsGrids,
  "halftoneCmyk.type": HalftoneCmykTypes,
  "liquidMetal.shape": LiquidMetalShapes,
  "warp.shape": WarpPatterns,
  "pulsingBorder.aspectRatio": PulsingBorderAspectRatios,
};

const COLOR_PATTERN = /^(#[0-9a-f]{3,8}|(rgb|hsl|oklch|lab)a?\()/i;

export function isColorString(value: string): boolean {
  return COLOR_PATTERN.test(value.trim());
}

/** `waveXShift` → `Wave X Shift`. */
export function humanizeName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(" ")
    .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(" ");
}

function groupOf(name: string, kind: ShaderParamSpec["kind"]): ShaderParamGroup {
  if (SIZING_PARAMS.has(name)) return "sizing";
  if (MOTION_PARAMS.has(name)) return "motion";
  if (kind === "color" || kind === "colors") return "color";
  return "shape";
}

/**
 * Pick a scrub step for a shader-specific number.
 *
 * Whole numbers of two or more are counts and iteration limits, where a step
 * below one does nothing; everything else is a normalized 0–1-ish control.
 */
function stepFor(value: number): number {
  return Number.isInteger(value) && Math.abs(value) >= 2 ? 1 : 0.01;
}

function numberControl(
  shaderId: string,
  name: string,
  value: number,
): { min?: number; max?: number; step: number; display?: "percent" } {
  const explicit =
    SHADER_NUMBER_RANGES[`${shaderId}.${name}`] ??
    SHARED_NUMBER_RANGES[name] ??
    NUMBER_RANGES_BY_NAME[name] ??
    (UNIT_INTERVAL_NUMBER_NAMES.has(name) ? UNIT_INTERVAL_CONTROL : undefined);
  if (explicit) {
    const display =
      name === "scale" || name === "speed" || (explicit.min >= 0 && explicit.max <= 1)
        ? "percent"
        : explicit.display;
    return { ...explicit, ...(display ? { display } : {}) };
  }

  return { step: stepFor(value) };
}

/**
 * Turn one entry of a shader's default preset into an editable spec.
 *
 * The preset is the schema: the package ships `Required<Params>` defaults for
 * every shader, so the key set, the value kinds, and the defaults all come from
 * the installed version rather than from a list here that could drift from it.
 */
export function deriveParamSpec(
  shaderId: string,
  name: string,
  value: unknown,
  context: { maxColorCount: number; presetValues: readonly unknown[] },
): ShaderParamSpec | null {
  const label = humanizeName(name);

  if (Array.isArray(value)) {
    // `colors` is the only array param in the package, and it is always colors.
    if (!value.every((entry) => typeof entry === "string")) return null;
    return {
      name,
      label,
      group: "color",
      kind: "colors",
      default: value as string[],
      maxCount: context.maxColorCount,
    };
  }

  if (typeof value === "boolean") {
    return { name, label, group: groupOf(name, "boolean"), kind: "boolean", default: value };
  }

  if (typeof value === "number") {
    const control = numberControl(shaderId, name, value);
    return {
      name,
      label,
      group: groupOf(name, "number"),
      kind: "number",
      default: value,
      ...control,
    };
  }

  if (typeof value !== "string") return null;

  if (isColorString(value)) {
    return { name, label, group: "color", kind: "color", default: value };
  }

  const enumMap = ENUM_OPTIONS[`${shaderId}.${name}`] ?? ENUM_OPTIONS[name];
  // Without a published option map the shader's own presets are the only
  // evidence of what it accepts, which is narrow but never wrong.
  const options = enumMap
    ? Object.keys(enumMap)
    : [
        ...new Set(
          context.presetValues.filter((entry): entry is string => typeof entry === "string"),
        ),
      ];

  return {
    name,
    label,
    group: groupOf(name, "select"),
    kind: "select",
    default: value,
    options: options.includes(value) ? options : [value, ...options],
  };
}

/** True when `value` is something this param can actually be set to. */
export function isValidParamValue(
  spec: ShaderParamSpec,
  value: unknown,
): value is ShaderParamValue {
  switch (spec.kind) {
    case "color":
      return typeof value === "string" && value.trim().length > 0;
    case "colors":
      return (
        Array.isArray(value) &&
        value.length > 0 &&
        value.every((entry) => typeof entry === "string" && entry.trim().length > 0)
      );
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "select":
      return typeof value === "string" && spec.options.includes(value);
    case "boolean":
      return typeof value === "boolean";
  }
}
