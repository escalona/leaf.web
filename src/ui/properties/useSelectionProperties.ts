import { useCallback, useEffect, useMemo, useRef } from "react";
import { ensureFontsLoaded } from "../../core/fonts/loader";
import type { StylePatch } from "../../core/editor/style-mutation";
import { useEditorStore } from "../../core/state/EditorStore";
import type { DesignNode } from "../../core/types";
import { readSelectionField, readSelectionStyle, type MaybeMixed } from "./selection-properties";

export interface SelectionProperties {
  nodes: DesignNode[];
  /** Convenience for sections that only make sense on one node (e.g. name). */
  primary: DesignNode;
  isMultiple: boolean;
  /** Effective CSS value across the selection, or MIXED. */
  style: (key: string) => MaybeMixed<string | number | undefined>;
  field: <K extends keyof DesignNode>(key: K) => MaybeMixed<DesignNode[K] | undefined>;
  /** Apply a style patch to every selected node. `null` removes a key. */
  setStyles: (patch: StylePatch) => void;
  /** Remove style keys from every selected node. */
  removeStyles: (keys: string[]) => void;
  /** Patch typed fields on every selected node. */
  updateNodes: (patch: Partial<DesignNode>) => void;
  /** Group a drag or typing burst into one undo entry. */
  beginEdit: () => void;
  endEdit: () => void;
  /** Spread onto an input to buffer its edits into a single history entry. */
  buffered: { onFocus: () => void; onBlur: () => void };
}

/**
 * Read/write access to the current selection as one unit.
 *
 * Every section builds on this, so controls are multi-node aware by
 * construction rather than retrofitted one at a time.
 */
export function useSelectionProperties(nodes: DesignNode[]): SelectionProperties {
  const store = useEditorStore();
  const transactionDepthRef = useRef(0);

  const beginEdit = useCallback(() => {
    if (transactionDepthRef.current === 0) store.beginHistoryTransaction();
    transactionDepthRef.current += 1;
  }, [store]);

  const endEdit = useCallback(() => {
    if (transactionDepthRef.current <= 0) return;
    transactionDepthRef.current -= 1;
    if (transactionDepthRef.current === 0) store.endHistoryTransaction();
  }, [store]);

  useEffect(() => {
    return () => {
      if (transactionDepthRef.current > 0) {
        transactionDepthRef.current = 0;
        store.endHistoryTransaction();
      }
    };
  }, [store]);

  const nodeIds = useMemo(() => nodes.map((node) => node.id), [nodes]);

  const setStyles = useCallback(
    (patch: StylePatch) => {
      if (nodeIds.length === 0) return;
      const touchesFont = Object.hasOwn(patch, "fontFamily");
      store.runtime.updateStyles(
        [{ nodeIds, styles: patch }],
        touchesFont ? ensureFontsLoaded : undefined,
      );
    },
    [nodeIds, store],
  );

  const removeStyles = useCallback(
    (keys: string[]) => {
      if (nodeIds.length === 0 || keys.length === 0) return;
      store.runtime.removeNodeStyles(nodeIds, keys);
    },
    [nodeIds, store],
  );

  const updateNodes = useCallback(
    (patch: Partial<DesignNode>) => {
      for (const nodeId of nodeIds) store.runtime.updateNode(nodeId, patch);
    },
    [nodeIds, store],
  );

  return {
    nodes,
    primary: nodes[0]!,
    isMultiple: nodes.length > 1,
    style: (key) => readSelectionStyle(nodes, key),
    field: (key) => readSelectionField(nodes, key),
    setStyles,
    removeStyles,
    updateNodes,
    beginEdit,
    endEdit,
    buffered: { onFocus: beginEdit, onBlur: endEdit },
  };
}
