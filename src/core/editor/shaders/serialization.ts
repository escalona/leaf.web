import { isValidParamValue, type ShaderParamValue } from "./params";
import { DEFAULT_SHADER_ID, getShaderDefinition, type ShaderDefinition } from "./registry";

/** What a shader node stores, serialized as JSON in `node.content`. */
export interface ShaderNodeValue {
  shaderId: string;
  params: Record<string, ShaderParamValue>;
  /**
   * Leaf-side playback flag rather than a shader param: the library treats
   * `speed: 0` as stopped, so pausing by zeroing speed would throw away the
   * speed the user chose.
   */
  paused?: boolean;
}

export type ShaderContentResult =
  | { status: "ok"; value: ShaderNodeValue; definition: ShaderDefinition }
  | { status: "invalid"; message: string };

function isParamValue(value: unknown): value is ShaderParamValue {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
  );
}

function readParams(raw: unknown): Record<string, ShaderParamValue> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const params: Record<string, ShaderParamValue> = {};
  for (const [name, value] of Object.entries(raw)) {
    // Unknown keys survive the round trip: an agent may be writing against a
    // newer shader than this build knows about, and dropping its data here
    // would make the inspector destructive just by opening the node.
    if (isParamValue(value)) params[name] = value;
  }
  return params;
}

/**
 * Read a shader node's content.
 *
 * Never throws. A shader node whose content is corrupt still has to render
 * something, and a parse error inside a renderer would unmount the whole
 * canvas subtree rather than just that node.
 */
export function parseShaderContent(content: string): ShaderContentResult {
  const trimmed = content.trim();
  // A freshly created node has no content yet; show the default shader rather
  // than an error, the same way an empty text node is empty and not broken.
  if (trimmed === "") {
    const definition = getShaderDefinition(DEFAULT_SHADER_ID);
    if (!definition) return { status: "invalid", message: "No shaders are available" };
    return { status: "ok", value: { shaderId: definition.id, params: {} }, definition };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { status: "invalid", message: "Shader settings are not valid JSON" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "invalid", message: "Shader settings must be an object" };
  }

  const shaderId = (parsed as { shaderId?: unknown }).shaderId;
  if (typeof shaderId !== "string" || shaderId === "") {
    return { status: "invalid", message: "Shader settings have no shaderId" };
  }

  const definition = getShaderDefinition(shaderId);
  if (!definition) return { status: "invalid", message: `Unknown shader "${shaderId}"` };

  const paused = (parsed as { paused?: unknown }).paused;
  return {
    status: "ok",
    definition,
    value: {
      shaderId,
      params: readParams((parsed as { params?: unknown }).params),
      ...(paused === true ? { paused: true } : {}),
    },
  };
}

export function formatShaderContent(value: ShaderNodeValue): string {
  return JSON.stringify({
    shaderId: value.shaderId,
    params: value.params,
    ...(value.paused ? { paused: true } : {}),
  });
}

/**
 * Content for a new shader node, with a preset's parameters written out in
 * full so the stored document says what it renders instead of leaning on
 * defaults that live inside the package.
 */
export function createShaderContent(shaderId: string, presetName?: string): string {
  const definition = getShaderDefinition(shaderId);
  if (!definition) return formatShaderContent({ shaderId, params: {} });

  const preset =
    definition.presets.find((candidate) => candidate.name === presetName) ?? definition.presets[0];
  const params: Record<string, ShaderParamValue> = {};
  for (const spec of definition.params) {
    const value = preset?.params[spec.name];
    params[spec.name] = isValidParamValue(spec, value) ? value : spec.default;
  }
  return formatShaderContent({ shaderId, params });
}

/** The value a control should show for `spec`, falling back to the shader's default. */
export function readShaderParam(
  value: ShaderNodeValue,
  spec: { name: string; default: ShaderParamValue },
): ShaderParamValue {
  const stored = value.params[spec.name];
  return stored === undefined ? spec.default : stored;
}

/**
 * Props for the shader component.
 *
 * Only known params that pass their own spec are forwarded: everything here
 * ends up as a WebGL uniform, and an agent-written `speed: "fast"` would
 * otherwise reach the GL call as a string.
 */
export function shaderComponentProps(
  definition: ShaderDefinition,
  value: ShaderNodeValue,
): Record<string, ShaderParamValue> {
  const props: Record<string, ShaderParamValue> = {};
  for (const spec of definition.params) {
    const stored = value.params[spec.name];
    if (stored === undefined || !isValidParamValue(spec, stored)) continue;
    props[spec.name] =
      spec.kind === "colors" ? (stored as string[]).slice(0, spec.maxCount) : stored;
  }
  return props;
}
