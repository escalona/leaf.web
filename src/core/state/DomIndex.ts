import { observable, runInAction } from "mobx";
import type { DesignNode } from "../types";

type DomIndexEntry = {
  element: HTMLElement;
  node: DesignNode;
};

export type DomIndexElementListener = (element: HTMLElement | undefined) => void;

/**
 * Bidirectional mapping between design nodes and DOM elements.
 * This is the "domIndex bridge" — it lets
 * the editor go from DOM events directly to design nodes and back.
 *
 * Also watches registered elements via ResizeObserver so that
 * consumers (like CanvasOverlay) can re-read getBoundingClientRect()
 * whenever a tracked element changes size.
 */
export class DomIndex {
  private entriesByNodeId = new Map<string, DomIndexEntry>();
  private elementToNode = new WeakMap<HTMLElement, DesignNode>();
  private elementListenersByNodeId = new Map<string, Set<DomIndexElementListener>>();

  /** Bumped whenever any tracked element resizes. Read this in MobX
   *  observers to trigger a re-render on DOM size changes. */
  resizeTick = observable.box(0);

  private pendingResizeTick = false;
  private resizeObserver =
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => this.scheduleGeometryRefresh())
      : null;

  /**
   * Bump `resizeTick` on the next animation frame. ResizeObserver only
   * reports size changes, so a model jump that merely *moves* flow children
   * (undo/redo of a gap or padding change) never fires it and overlay chrome
   * measured during the synchronous re-render stays stale. Callers use this
   * after such jumps so live-geometry consumers remeasure once the restyle
   * has laid out.
   */
  scheduleGeometryRefresh() {
    if (this.pendingResizeTick) return;
    this.pendingResizeTick = true;
    requestAnimationFrame(() => {
      this.pendingResizeTick = false;
      runInAction(() => {
        this.resizeTick.set(this.resizeTick.get() + 1);
      });
    });
  }

  register(node: DesignNode, element: HTMLElement) {
    const elementNode = this.elementToNode.get(element);
    if (elementNode && elementNode.id !== node.id) {
      const elementEntry = this.entriesByNodeId.get(elementNode.id);
      if (elementEntry?.element === element) {
        this.removeEntry(elementNode.id, elementEntry);
      }
    }

    const previous = this.entriesByNodeId.get(node.id);
    if (previous?.element === element) {
      if (previous.node !== node) {
        previous.node = node;
        this.elementToNode.set(element, node);
      }
      return () => this.unregister(node, element);
    }
    if (previous) this.removeEntry(node.id, previous, false);

    this.entriesByNodeId.set(node.id, { element, node });
    this.elementToNode.set(element, node);
    this.resizeObserver?.observe(element);
    this.notifyElementListeners(node.id, element);

    // Ref callbacks can retain this disposer so a stale unmount never removes
    // a newer element registered for the same stable node ID.
    return () => this.unregister(node, element);
  }

  unregister(node: DesignNode, expectedElement?: HTMLElement) {
    const entry = this.entriesByNodeId.get(node.id);
    if (!entry || (expectedElement && entry.element !== expectedElement)) return false;
    this.removeEntry(node.id, entry);
    return true;
  }

  getElement(node: DesignNode): HTMLElement | undefined {
    return this.entriesByNodeId.get(node.id)?.element;
  }

  getNode(element: HTMLElement): DesignNode | undefined {
    return this.elementToNode.get(element);
  }

  /** Return rendered nodes without querying or walking the DOM tree. */
  getMountedNodes(): DesignNode[] {
    return Array.from(this.entriesByNodeId.values(), ({ node }) => node);
  }

  /**
   * Observe the rendered element for a stable node ID. The listener receives
   * the current element immediately, then every replacement or unmount.
   */
  subscribe(nodeId: string, listener: DomIndexElementListener) {
    let listeners = this.elementListenersByNodeId.get(nodeId);
    if (!listeners) {
      listeners = new Set();
      this.elementListenersByNodeId.set(nodeId, listeners);
    }
    listeners.add(listener);
    listener(this.entriesByNodeId.get(nodeId)?.element);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const currentListeners = this.elementListenersByNodeId.get(nodeId);
      currentListeners?.delete(listener);
      if (currentListeners?.size === 0) this.elementListenersByNodeId.delete(nodeId);
    };
  }

  /** Walk up the DOM to find the nearest registered design node */
  findNodeFromElement(element: HTMLElement): DesignNode | undefined {
    let current: HTMLElement | null = element;
    while (current) {
      const node = this.elementToNode.get(current);
      if (node) return node;
      current = current.parentElement;
    }
    return undefined;
  }

  private removeEntry(nodeId: string, entry: DomIndexEntry, notify = true) {
    if (this.entriesByNodeId.get(nodeId) !== entry) return;
    this.entriesByNodeId.delete(nodeId);
    this.resizeObserver?.unobserve(entry.element);
    if (this.elementToNode.get(entry.element) === entry.node) {
      this.elementToNode.delete(entry.element);
    }
    if (notify) this.notifyElementListeners(nodeId, undefined);
  }

  private notifyElementListeners(nodeId: string, element: HTMLElement | undefined) {
    const listeners = this.elementListenersByNodeId.get(nodeId);
    if (!listeners) return;
    for (const listener of Array.from(listeners)) listener(element);
  }
}
