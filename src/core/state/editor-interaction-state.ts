import type { DesignNode, ToolMode } from "../types";
import { isDocumentScriptInteractiveSurface } from "../nodes/interactive-surface";
import type { DomIndex } from "./DomIndex";

export interface EditorInteractionState {
  nodeMap: ReadonlyMap<string, DesignNode>;
  parentMap: ReadonlyMap<string, string>;
  selectedIds: ReadonlySet<string>;
  scriptInteractionRootIds: Set<string>;
  activeInteractiveSurfaceId: string | null;
  activeTool: ToolMode;
  domIndex: DomIndex;
  finishTextEditing(): void;
  clearHoveredNode(): void;
}

export function activateInteractiveSurface(state: EditorInteractionState, nodeId: string) {
  const node = state.nodeMap.get(nodeId);
  if (!node || !isDocumentScriptInteractiveSurface(node)) return;
  prepareInteractionActivation(state);
  state.activeInteractiveSurfaceId = nodeId;
}

export function registerScriptInteractionRoot(state: EditorInteractionState, nodeId: string) {
  if (!state.nodeMap.has(nodeId)) {
    throw new Error(`Node ${nodeId} does not exist`);
  }
  state.scriptInteractionRootIds.add(nodeId);
}

export function unregisterScriptInteractionRoot(state: EditorInteractionState, nodeId: string) {
  state.scriptInteractionRootIds.delete(nodeId);
  if (state.activeInteractiveSurfaceId === nodeId) state.activeInteractiveSurfaceId = null;
}

export function getScriptInteractionRootId(state: EditorInteractionState, nodeId: string) {
  let currentId: string | undefined = nodeId;
  while (currentId) {
    if (state.scriptInteractionRootIds.has(currentId)) return currentId;
    currentId = state.parentMap.get(currentId);
  }
  return null;
}

export function getInteractionTargetId(state: EditorInteractionState, nodeId: string) {
  const scriptRootId = getScriptInteractionRootId(state, nodeId);
  if (scriptRootId) return scriptRootId;
  const node = state.nodeMap.get(nodeId);
  return node && isDocumentScriptInteractiveSurface(node) ? nodeId : null;
}

export function getSelectedInteractionTargetId(state: EditorInteractionState) {
  if (state.selectedIds.size !== 1) return null;
  const selectedId = state.selectedIds.values().next().value as string | undefined;
  return selectedId ? getInteractionTargetId(state, selectedId) : null;
}

export type InteractionDeactivationReason = "missing" | "selection" | "hidden" | "locked";

/**
 * Why the active interaction can no longer stand, or `null` while it can.
 *
 * Interaction mode is a claim on one root: the selection sits inside it, and
 * the root is something the user can see and act on. A root (or any ancestor)
 * that becomes hidden has left the canvas, and one that becomes locked has
 * been put beyond editing — either way keeping mode alive would leave the
 * viewport routing input to a node that no longer receives it. The store's
 * safety net and the shell's guard both ask this one question.
 */
export function getInteractionDeactivationReason(
  state: Pick<
    EditorInteractionState,
    "activeInteractiveSurfaceId" | "nodeMap" | "parentMap" | "selectedIds"
  >,
  isDescendant: (nodeId: string, ancestorId: string) => boolean,
): InteractionDeactivationReason | null {
  const rootId = state.activeInteractiveSurfaceId;
  if (!rootId) return null;
  if (!state.nodeMap.has(rootId)) return "missing";
  const selectedId = state.selectedIds.values().next().value as string | undefined;
  if (state.selectedIds.size !== 1 || !selectedId || !isDescendant(selectedId, rootId)) {
    return "selection";
  }
  for (let currentId: string | undefined = rootId; currentId; ) {
    const node = state.nodeMap.get(currentId);
    if (!node) break;
    if (node.visible === false) return "hidden";
    if (node.locked) return "locked";
    currentId = state.parentMap.get(currentId);
  }
  return null;
}

export function activateInteraction(state: EditorInteractionState, nodeId: string) {
  if (state.scriptInteractionRootIds.has(nodeId)) {
    activateScriptInteraction(state, nodeId);
    return;
  }
  activateInteractiveSurface(state, nodeId);
}

export function activateScriptInteraction(state: EditorInteractionState, nodeId: string) {
  if (!state.scriptInteractionRootIds.has(nodeId)) return;
  prepareInteractionActivation(state);
  state.activeInteractiveSurfaceId = nodeId;
  state.domIndex.getElement(state.nodeMap.get(nodeId)!)?.focus({ preventScroll: true });
}

function prepareInteractionActivation(state: EditorInteractionState) {
  state.finishTextEditing();
  state.activeTool = "select";
  state.clearHoveredNode();
}
