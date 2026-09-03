/**
 * Single source of truth for which layer names count as "generic" in MCP
 * naming lint. write_html import warnings and get_canvas_layout lint must
 * agree on this list, so both import from here.
 */
export const GENERIC_NODE_NAMES = [
  "Frame",
  "Text",
  "Rectangle",
  "SVG",
  "Interactive Surface",
  "Image",
  "Path",
  "Shader",
] as const;

export const GENERIC_NODE_NAME_PATTERN = new RegExp(
  `^(?:${GENERIC_NODE_NAMES.join("|")})(?:[\\s_-]*\\d+)?$`,
  "i",
);

export function isGenericLayerName(name: string): boolean {
  const trimmed = name.trim();
  return !trimmed || GENERIC_NODE_NAME_PATTERN.test(trimmed);
}
