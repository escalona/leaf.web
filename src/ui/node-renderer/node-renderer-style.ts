import type { CSSProperties } from "react";
import type { DesignNode } from "../../core/types";
import type { EditorStore } from "../../core/state/EditorStore";

/**
 * Build the inline style for a node by merging typed properties with the
 * flexible `styles` map. The styles map takes precedence.
 *
 * For layout-flow children, we keep width/height but omit absolute positioning.
 * Direct manipulation can either preserve the layout slot with `position: relative`
 * or detach the node into absolute canvas coordinates for drag performance.
 */
/**
 * Inline custom properties written alongside a remote drag preview translate.
 * They mirror exactly what is committed to the DOM, so geometry code can
 * recover the committed rect from a measurement even during frames where
 * `store.remoteDragPreviews` and the rendered DOM disagree.
 */
export const REMOTE_DRAG_APPLIED_X_VAR = "--leaf-remote-drag-x";
export const REMOTE_DRAG_APPLIED_Y_VAR = "--leaf-remote-drag-y";

export function buildBaseStyle(
  store: Pick<EditorStore, "remoteDragPreviews">,
  node: DesignNode,
  isFlowChild: boolean,
  isInteractionSuppressed = false,
): CSSProperties {
  const remoteDragOffset = store.remoteDragPreviews.get(node.id);
  const style: CSSProperties = {
    pointerEvents: isInteractionSuppressed ? "none" : "all",
    boxSizing: "border-box" as const,
  };

  let positionTransform = "";

  // Most nodes keep their stored size unless an explicit CSS size overrides it.
  // Imported flex text can opt into content-based sizing via styles.width/height="auto".
  style.width = node.width;
  style.height = node.height;

  if (!isFlowChild) {
    // Move absolute-positioned nodes via transforms so dragging stays on the compositor path.
    style.position = "absolute";
    style.left = 0;
    style.top = 0;
    positionTransform = `translate(${node.x}px, ${node.y}px)`;
  } else if (node.styles.position === "relative") {
    style.position = "relative";
    positionTransform = `translate(${node.x}px, ${node.y}px)`;
  }
  // For flex/grid children: let CSS flow determine placement.
  // Explicit CSS dimensions (e.g., width: "240px") still come from the styles map below.

  for (const [key, value] of Object.entries(node.styles)) {
    if (key === "position" && !isFlowChild) continue;
    (style as Record<string, unknown>)[key] = value;
  }

  // Rotation composes after the position translate so the node spins about its
  // own center rather than orbiting the canvas origin. An authored `transform`
  // still comes last and wins, matching how the styles map beats typed props
  // everywhere else.
  const rotation = node.rotation ?? 0;
  const modelTransform = rotation
    ? `${positionTransform} rotate(${rotation}deg)`.trim()
    : positionTransform;

  // A remote peer's in-flight drag composes before the model placement so the
  // element previews the move in parent space without a durable model write.
  const remoteDragTransform = remoteDragOffset
    ? `translate(${remoteDragOffset.x}px, ${remoteDragOffset.y}px)`
    : "";
  if (remoteDragOffset) {
    (style as Record<string, unknown>)[REMOTE_DRAG_APPLIED_X_VAR] = `${remoteDragOffset.x}px`;
    (style as Record<string, unknown>)[REMOTE_DRAG_APPLIED_Y_VAR] = `${remoteDragOffset.y}px`;
  }

  const composedTransform = [remoteDragTransform, modelTransform, style.transform]
    .filter(Boolean)
    .join(" ");
  if (composedTransform) {
    style.transform = composedTransform;
  }

  return style;
}

export function applyTypedAppearanceStyles(node: DesignNode, style: CSSProperties): CSSProperties {
  // Typed appearance fields are defaults. Temporarily remove authored border
  // declarations so those declarations can be re-applied afterward in their
  // original order; otherwise a typed borderColor/borderStyle appended here
  // can erase imported per-side paint.
  const authoredBorderEntries = Object.entries(node.styles).filter(
    ([key]) => key.startsWith("border") && Object.hasOwn(style, key),
  );
  for (const [key] of authoredBorderEntries) {
    delete (style as Record<string, unknown>)[key];
  }
  const hasBackgroundOverride =
    node.styles.background !== undefined || node.styles.backgroundColor !== undefined;
  const hasBorderRadiusOverride = node.styles.borderRadius !== undefined;
  const hasBorderOverride = node.styles.border !== undefined;
  const hasBorderWidthOverride = node.styles.borderWidth !== undefined;
  const hasBorderColorOverride = node.styles.borderColor !== undefined;
  const hasBorderStyleOverride = node.styles.borderStyle !== undefined;

  if (!hasBackgroundOverride && node.backgroundColor && node.backgroundColor !== "transparent") {
    style.backgroundColor = node.backgroundColor;
  }
  if (!hasBorderRadiusOverride && node.borderRadius) {
    style.borderRadius = node.borderRadius;
  }
  if (node.borderWidth > 0 && !hasBorderOverride) {
    if (!hasBorderWidthOverride) {
      style.borderWidth = node.borderWidth;
    }
    if (!hasBorderColorOverride) {
      style.borderColor = node.borderColor;
    }
    if (!hasBorderStyleOverride) {
      style.borderStyle = "solid";
    }
  }
  for (const [key, value] of authoredBorderEntries) {
    (style as Record<string, string | number>)[key] = value;
  }

  return style;
}

export function getMaterializedNodeProps(
  store: EditorStore,
  nodeId: string,
  baseStyle: CSSProperties,
): { style: CSSProperties; className?: string } {
  const delay = store.materializingIds.get(nodeId);
  if (delay === undefined) return { style: baseStyle };
  return {
    style: { ...baseStyle, "--mat-delay": `${delay}ms` } as CSSProperties,
    className: "node-materializing",
  };
}
