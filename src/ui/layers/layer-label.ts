import type { DesignNode } from "../../core/types";

const TEXT_LAYER_LABEL_MAX_LENGTH = 48;
const AUTO_TEXT_LAYER_NAME_MAX_LENGTH = 30;

export function getAutomaticTextLayerName(content: string) {
  const textLabel = content.replace(/\s+/g, " ").trim();
  if (!textLabel) return "Text";
  if (textLabel.length <= AUTO_TEXT_LAYER_NAME_MAX_LENGTH) return textLabel;
  return `${textLabel.slice(0, AUTO_TEXT_LAYER_NAME_MAX_LENGTH - 3)}...`;
}

export function getLayerLabel(node: DesignNode) {
  if (node.type !== "text") return node.name;

  const textLabel = node.content.replace(/\s+/g, " ").trim();
  if (!textLabel) return node.name;
  if (node.name !== "Text" && node.name !== getAutomaticTextLayerName(node.content)) {
    return node.name;
  }
  if (textLabel.length <= TEXT_LAYER_LABEL_MAX_LENGTH) return textLabel;
  return `${textLabel.slice(0, TEXT_LAYER_LABEL_MAX_LENGTH - 3)}...`;
}
