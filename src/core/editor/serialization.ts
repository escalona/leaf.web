import type { DesignNode } from "../types";

type DimensionKey = "width" | "height";

const REDACTED_IMAGE_SOURCE_COMMENT =
  "Pasted image data omitted from get_jsx output. Export the asset separately and replace src.";

function buildJsxStyleString(styles: Record<string, unknown>): string {
  const pairs = Object.entries(styles)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? `"${value}"` : String(value)}`)
    .join(", ");
  return `style={{ ${pairs} }}`;
}

function serializeImageContent(node: DesignNode) {
  if (node.type !== "image") return node.content;
  if (node.imageAsset) return `[image asset ${node.imageAsset.assetId}]`;
  if (node.content.startsWith("data:")) return "[image data — use get_screenshot to view]";
  return node.content;
}

export function getMcpDimension(node: DesignNode, key: DimensionKey): string | number {
  const styleValue = node.styles[key];
  if (typeof styleValue === "string" || typeof styleValue === "number") return styleValue;
  return node[key];
}

export function serializeNode(node: DesignNode) {
  return {
    id: node.id,
    type: node.isArtboard ? "artboard" : node.type,
    name: node.name,
    x: node.x,
    y: node.y,
    width: getMcpDimension(node, "width"),
    height: getMcpDimension(node, "height"),
    visible: node.visible !== false,
    childCount: node.children.length,
  };
}

export function serializeNodeFull(node: DesignNode) {
  const imageAsset = node.imageAsset ? { ...node.imageAsset } : node.imageAsset;
  const styles = { ...node.styles };

  return {
    id: node.id,
    type: node.isArtboard ? "artboard" : node.type,
    name: node.name,
    x: node.x,
    y: node.y,
    width: getMcpDimension(node, "width"),
    height: getMcpDimension(node, "height"),
    visible: node.visible !== false,
    backgroundColor: node.backgroundColor,
    borderRadius: node.borderRadius,
    borderColor: node.borderColor,
    borderWidth: node.borderWidth,
    content: serializeImageContent(node),
    imageAsset,
    fontSize: node.fontSize,
    fontFamily: node.fontFamily,
    color: node.color,
    fontWeight: node.fontWeight,
    isArtboard: node.isArtboard,
    styles,
    childCount: node.children.length,
    childrenIds: node.children.map((child) => child.id),
  };
}

export function getComputedStyles(node: DesignNode) {
  return {
    backgroundColor: node.backgroundColor,
    borderRadius: node.borderRadius,
    borderColor: node.borderColor,
    borderWidth: node.borderWidth,
    color: node.color,
    fontSize: node.fontSize,
    fontFamily: node.fontFamily,
    fontWeight: node.fontWeight,
    width: node.width,
    height: node.height,
    x: node.x,
    y: node.y,
    ...node.styles,
  };
}

export function generateJsx(node: DesignNode, indent: number): string {
  const pad = "  ".repeat(indent);
  const allStyles: Record<string, unknown> = {};

  if (
    node.backgroundColor &&
    node.backgroundColor !== "transparent" &&
    node.styles.background === undefined &&
    node.styles.backgroundColor === undefined
  ) {
    allStyles.backgroundColor = node.backgroundColor;
  }
  if (node.borderRadius) allStyles.borderRadius = node.borderRadius;
  if (
    node.borderWidth &&
    node.styles.border === undefined &&
    node.styles.borderWidth === undefined &&
    node.styles.borderColor === undefined &&
    node.styles.borderStyle === undefined
  ) {
    allStyles.border = `${node.borderWidth}px solid ${node.borderColor}`;
  } else if (node.borderWidth && node.styles.border === undefined) {
    if (node.styles.borderWidth === undefined) {
      allStyles.borderWidth = node.borderWidth;
    }
    if (node.styles.borderColor === undefined) {
      allStyles.borderColor = node.borderColor;
    }
    if (node.styles.borderStyle === undefined) {
      allStyles.borderStyle = "solid";
    }
  }
  if (node.type === "text") {
    if (node.styles.color === undefined) allStyles.color = node.color;
    if (node.styles.fontSize === undefined) allStyles.fontSize = node.fontSize;
    if (node.styles.fontFamily === undefined) allStyles.fontFamily = node.fontFamily;
    if (node.fontWeight !== "normal" && node.styles.fontWeight === undefined) {
      allStyles.fontWeight = node.fontWeight;
    }
  }

  Object.assign(allStyles, node.styles);
  allStyles.width = getMcpDimension(node, "width");
  allStyles.height = getMcpDimension(node, "height");

  const styleStr = buildJsxStyleString(allStyles);

  if (node.type === "text" && node.children.length === 0) {
    return `${pad}<div ${styleStr}>${node.content}</div>`;
  }

  if (node.type === "image") {
    const frameStyles = { ...allStyles };
    delete frameStyles.objectFit;
    delete frameStyles.objectPosition;
    const frameStyleStr = buildJsxStyleString({ ...frameStyles, overflow: "hidden" });
    const imageStyleStr = buildJsxStyleString({
      width: "100%",
      height: "100%",
      display: "block",
      objectFit: typeof node.styles.objectFit === "string" ? node.styles.objectFit : "contain",
      objectPosition:
        typeof node.styles.objectPosition === "string" ? node.styles.objectPosition : "top left",
    });
    const isAssetRef = Boolean(node.imageAsset);
    const isRedactedDataUrl = node.content.startsWith("data:");
    let imgSourceAttr = `src=${JSON.stringify(node.content)}`;
    if (isAssetRef) {
      imgSourceAttr = `src={undefined} data-leaf-asset-id=${JSON.stringify(node.imageAsset?.assetId)}`;
    } else if (isRedactedDataUrl) {
      imgSourceAttr = "src={undefined} data-leaf-source-redacted={true}";
    }
    const commentPad = "  ".repeat(indent + 1);
    let commentLine = "";
    if (isAssetRef) {
      commentLine = `${commentPad}{/* Image asset stored outside the normalized document: ${node.imageAsset?.assetId} */}\n`;
    } else if (isRedactedDataUrl) {
      commentLine = `${commentPad}{/* ${REDACTED_IMAGE_SOURCE_COMMENT} */}\n`;
    }

    return `${pad}<div ${frameStyleStr}>\n${commentLine}${commentPad}<img ${imgSourceAttr} alt=${JSON.stringify(node.name)} ${imageStyleStr} />\n${pad}</div>`;
  }

  if (node.type === "svg") {
    const frameStyleStr = buildJsxStyleString({ ...allStyles, overflow: "hidden" });
    return `${pad}<div ${frameStyleStr} dangerouslySetInnerHTML={{ __html: ${JSON.stringify(node.content)} }} />`;
  }

  if (node.children.length === 0) {
    return `${pad}<div ${styleStr} />`;
  }

  const childrenJsx = node.children.map((child) => generateJsx(child, indent + 1)).join("\n");
  return `${pad}<div ${styleStr}>\n${childrenJsx}\n${pad}</div>`;
}
