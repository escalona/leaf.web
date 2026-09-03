import { makeAutoObservable } from "mobx";

/**
 * Which path node is in vector edit mode, and which anchors are selected.
 *
 * Vector editing state lives here rather than on the editor store because it
 * is transient session UI — nothing durable, nothing
 * synced — and because it has to be readable from both the overlay and the
 * inspector without either owning the other.
 */
export class VectorEditSession {
  nodeId: string | null = null;
  /** Anchor indices whose handles are shown; the last one is the caret. */
  selectedAnchors: number[] = [];

  constructor() {
    makeAutoObservable(this);
  }

  get isActive(): boolean {
    return this.nodeId !== null;
  }

  isEditing(nodeId: string): boolean {
    return this.nodeId === nodeId;
  }

  enter(nodeId: string) {
    if (this.nodeId === nodeId) return;
    this.nodeId = nodeId;
    this.selectedAnchors = [];
  }

  exit() {
    this.nodeId = null;
    this.selectedAnchors = [];
  }

  selectAnchor(index: number, additive = false) {
    if (!additive) {
      this.selectedAnchors = [index];
      return;
    }
    this.selectedAnchors = this.selectedAnchors.includes(index)
      ? this.selectedAnchors.filter((existing) => existing !== index)
      : [...this.selectedAnchors, index];
  }

  clearAnchorSelection() {
    this.selectedAnchors = [];
  }
}

export const vectorEdit = new VectorEditSession();
