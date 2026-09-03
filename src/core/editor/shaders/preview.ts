import type { ShaderDefinition } from "./registry";
import { readShaderParam, type ShaderNodeValue } from "./serialization";

const MAX_PREVIEW_COLORS = 5;
const NEUTRAL_PREVIEW = "#e4e4e7";

/**
 * The colours a shader is currently set to paint with, most significant first.
 *
 * `colors` is the palette when a shader has one; otherwise the individual
 * colour props stand in, with the background last so it does not dominate.
 */
export function shaderPreviewColors(
  definition: ShaderDefinition,
  value: ShaderNodeValue,
): string[] {
  const palette: string[] = [];
  const background: string[] = [];

  for (const spec of definition.params) {
    if (spec.kind === "colors") {
      const current = readShaderParam(value, spec);
      if (Array.isArray(current)) palette.push(...current);
    } else if (spec.kind === "color") {
      const current = readShaderParam(value, spec);
      if (typeof current !== "string") continue;
      if (spec.name.toLowerCase().endsWith("back")) background.push(current);
      else palette.push(current);
    }
  }

  return [...palette, ...background].slice(0, MAX_PREVIEW_COLORS);
}

/**
 * A CSS stand-in for the shader's output.
 *
 * Used wherever running the real thing would be wrong: the picker would need
 * one WebGL context per row and browsers drop the oldest past roughly a dozen,
 * and a node that is offscreen or on a machine without WebGL2 still needs to
 * look like itself.
 */
export function shaderPreviewGradient(colors: readonly string[]): string {
  if (colors.length === 0) return NEUTRAL_PREVIEW;
  if (colors.length === 1) return colors[0]!;
  return `linear-gradient(135deg, ${colors.join(", ")})`;
}
