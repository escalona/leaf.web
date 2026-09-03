import type { DesignNode } from "../types";

export const DOCUMENT_SCRIPT_INTERACTION_BOUNDARY_EVENTS = [
  "click",
  "contextmenu",
  "dblclick",
  "gesturechange",
  "gestureend",
  "gesturestart",
  "keydown",
  "keypress",
  "keyup",
  "mousedown",
  "mousemove",
  "mouseup",
  "pointercancel",
  "pointerdown",
  "pointermove",
  "pointerup",
  "touchcancel",
  "touchend",
  "touchmove",
  "touchstart",
  "wheel",
] as const;

export function isDocumentScriptInteractiveSurface(node: DesignNode) {
  return node.type === "interactive-surface";
}
