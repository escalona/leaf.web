import { action, runInAction } from "mobx";
import { startTransition, useCallback, useEffect, useRef, type RefObject } from "react";
import {
  classifyPastedContent,
  insertPastedContent,
  type PastedContent,
} from "../../core/editor/clipboard/content-paste";
import { getClipboardImageFiles } from "../../core/editor/clipboard/image-paste";
import {
  NODE_CLIPBOARD_MIME_TYPE,
  parseNodeClipboardPayload,
  serializeNodeClipboardPayload,
  type NodeClipboardPayload,
} from "../../core/editor/clipboard/node-paste";
import {
  copySelectionStyles,
  pasteSelectionStyles,
} from "../../core/editor/clipboard/style-clipboard";
import { isFlowLayoutDisplay } from "../../core/editor/layout-display";
import { screenPoint } from "../../core/editor/interaction/coordinate-spaces";
import { isEventTargetEditable } from "../../core/lib/keyboard-shortcuts";
import type { EditorStore } from "../../core/state/EditorStore";
import type { PasteNodeResult, PreparedPasteNode } from "../../core/state/document-adapter";
import { designNodeToPersistedNode } from "../../core/state/document";
import type { DesignNode, Point } from "../../core/types";
import { pasteImages, resolveStyleShortcutKey, splitDroppedFiles } from "./clipboard-file-drop";
import {
  clonePersistedNodeWithPosition,
  getClipboardBounds,
  getClipboardEntryIds,
  getClipboardPayloadNodeCount,
  getCommonSelectedPasteParent,
  getNodesInDocumentOrder,
  getSourceSiblingPasteParent,
  getViewportCanvasCenter,
  getViewportCenterPasteParent,
  isFlowChildEntry,
} from "./clipboard-placement";
import { timeLeafPerfTrace, timeLeafPerfTraceAsync } from "../../core/lib/perf-trace";
import { refreshSelectionAfterMount } from "./selection-refresh";
import { isNodeLocked } from "./selection-targets";
import { reportEditorFailure } from "../editor-feedback";

export { settleClipboardImageUploads, splitDroppedFiles } from "./clipboard-file-drop";

export const INCREMENTAL_PASTE_NODE_THRESHOLD = 250;

export async function runNodePasteWithIndicator(
  store: EditorStore,
  paste: () => Promise<void>,
): Promise<void> {
  runInAction(() => store.beginImagePaste());
  try {
    await paste();
  } finally {
    runInAction(() => store.endImagePaste());
  }
}

/**
 * True while the user is really editing text, which is when canvas
 * copy/cut/paste must stand down. Judged by the focused element alone:
 * clipboard events target the *selection's* focus node when nothing editable
 * has focus, and a committed rename leaves a collapsed selection inside the
 * blurred file-name input — so `event.target` can point at an input the user
 * left long ago, and treating that as text editing swallows every canvas
 * clipboard action until a reload clears the stale selection.
 */
function isTextEditingContext() {
  return isEventTargetEditable(document.activeElement);
}

type ClipboardState = {
  serialized: string;
  payload: NodeClipboardPayload;
  nodeCount: number;
  pasteCount: number;
  lastPastedRootIds: Set<string>;
  lastPastedIds: Set<string>;
};

export function useViewportClipboard({
  beginHistoryTransaction,
  endHistoryTransaction,
  store,
  viewportRef,
}: {
  beginHistoryTransaction: () => void;
  endHistoryTransaction: () => void;
  store: EditorStore;
  viewportRef: RefObject<HTMLDivElement | null>;
}) {
  const clipboardRef = useRef<ClipboardState | null>(null);
  const largePasteQueueRef = useRef<Promise<void>>(Promise.resolve());

  const pasteNodeClipboardPayload = useCallback(
    (payload: NodeClipboardPayload, pasteCount: number, previousPastedIds: ReadonlySet<string>) => {
      const viewportEl = viewportRef.current;
      const clipboardBounds = getClipboardBounds(payload.nodes);
      if (!viewportEl || !clipboardBounds) return false;

      const copiedIds = new Set<string>();
      payload.nodes.forEach((entry) => getClipboardEntryIds(entry, copiedIds));
      const payloadNodeCount = copiedIds.size;
      for (const pastedId of previousPastedIds) copiedIds.add(pastedId);

      const contextualParent = timeLeafPerfTrace(
        "clipboard.target",
        () =>
          getCommonSelectedPasteParent(store, copiedIds) ??
          // Copy-then-paste with the source still selected is the common case,
          // and the source's own parent is the answer the user expects: the
          // copy lands beside the thing it was copied from. Without this the
          // selection filters itself out above and paste falls through to
          // whatever frame happens to sit under the viewport centre.
          getSourceSiblingPasteParent(store, payload) ??
          getViewportCenterPasteParent(store, viewportEl, copiedIds),
      );
      const contextualParentCanvasPosition = contextualParent
        ? (store.getCanvasPosition(contextualParent.id) ?? {
            x: contextualParent.x,
            y: contextualParent.y,
          })
        : null;
      const viewportCenter = getViewportCanvasCenter(store, viewportEl);
      const targetCenter = contextualParent
        ? {
            x: contextualParentCanvasPosition!.x + contextualParent.width / 2,
            y: contextualParentCanvasPosition!.y + contextualParent.height / 2,
          }
        : viewportCenter;
      // Pasting a flow child back into a flow container should join the flow —
      // it becomes the next tab, row, or card. Forcing `position: absolute`
      // here (which is what this used to do for every flow parent) yanks the
      // clone out of layout and drops it over its own siblings.
      //
      // Absolute placement is still right when the source was itself absolutely
      // positioned, or when a canvas-level node is pasted into a container that
      // has no flow to join.
      const parentIsFlow = !!(
        contextualParent && isFlowLayoutDisplay(contextualParent.styles.display)
      );
      // The deciding question is whether the source was *already* laid out by a
      // flow parent. A canvas-level node dropped into a flex frame keeps the
      // placement the user gave it, so it stays absolute; a node lifted out of
      // a flex row belongs back in a flex row.
      const sourceWasFlowChild = payload.nodes.every((entry) => isFlowChildEntry(store, entry));
      const insertsIntoFlow = parentIsFlow && sourceWasFlowChild;
      const shouldAbsolutelyPositionInParent = parentIsFlow && !sourceWasFlowChild;

      // A flow insert takes its position from layout, so nudging it by the
      // paste count would only desynchronise the model from what is painted.
      const centerOffset = insertsIntoFlow
        ? { x: 0, y: 0 }
        : {
            x: targetCenter.x - (clipboardBounds.x + clipboardBounds.width / 2) + pasteCount * 20,
            y: targetCenter.y - (clipboardBounds.y + clipboardBounds.height / 2) + pasteCount * 20,
          };

      const requests = timeLeafPerfTrace("clipboard.prepare", () =>
        payload.nodes.map((entry) => {
          const canvasPosition = {
            x: entry.canvasPosition.x + centerOffset.x,
            y: entry.canvasPosition.y + centerOffset.y,
          };
          const parentId = contextualParent?.id;
          const parentCanvasPosition = parentId
            ? (store.getCanvasPosition(parentId) ?? null)
            : null;
          const localPosition = parentCanvasPosition
            ? {
                x: canvasPosition.x - parentCanvasPosition.x,
                y: canvasPosition.y - parentCanvasPosition.y,
              }
            : canvasPosition;

          // Land the clone directly after the node it came from, so a copied
          // tab becomes the next tab rather than appearing at the end of the
          // row. Only meaningful for a flow insert; absolute clones have no
          // meaningful sibling order.
          //
          // Carried as the source id rather than a resolved index: these
          // requests are all built before any of them is inserted, so an index
          // would be stale for every entry after the first. `commitPreparedPaste`
          // resolves the anchor against the live sibling list instead.
          const afterNodeId = insertsIntoFlow ? entry.node.id : undefined;

          return {
            node: clonePersistedNodeWithPosition(entry, localPosition, {
              absoluteWithinParent: shouldAbsolutelyPositionInParent,
            }),
            parentId,
            ...(afterNodeId === undefined ? {} : { afterNodeId }),
          };
        }),
      );

      const commit = (prepared: PreparedPasteNode[]) => {
        let pasted: PasteNodeResult[] = [];
        runInAction(() => {
          beginHistoryTransaction();
          try {
            pasted = timeLeafPerfTrace("clipboard.runtime", () =>
              store.runtime.commitPreparedPaste(prepared),
            );
            timeLeafPerfTrace("clipboard.selection", () => {
              store.setSelectedIds(pasted.map(({ newId }) => newId));
              store.setTool("select");
            });
          } finally {
            endHistoryTransaction();
          }
        });

        // The selection chrome for a flow child can only come from a DOM
        // measurement, and the overlay renders before React has attached the
        // new node's ref — so its first pass finds no element and falls back to
        // the node's parent-relative (0, 0), drawing the marquee at the canvas
        // origin. Re-assert the selection once the node is mounted so the
        // overlay measures it for real.
        if (pasted.length > 0) {
          refreshSelectionAfterMount(
            store,
            pasted.map(({ newId }) => newId),
          );
        }
        return pasted;
      };

      if (payloadNodeCount < INCREMENTAL_PASTE_NODE_THRESHOLD) {
        return commit(store.runtime.preparePasteNodes(requests));
      }
      return timeLeafPerfTraceAsync("clipboard.prepareIncremental", () =>
        store.runtime.preparePasteNodesIncrementally(requests),
      ).then(commit);
    },
    [beginHistoryTransaction, endHistoryTransaction, store, viewportRef],
  );

  const insertContentAtPoint = useCallback(
    (content: PastedContent, canvasPoint: Point) => {
      try {
        return runInAction(() => {
          beginHistoryTransaction();
          try {
            return insertPastedContent(store, content, { canvasPoint });
          } finally {
            endHistoryTransaction();
          }
        });
      } catch (error) {
        reportEditorFailure(error, "The pasted content could not be imported.", store);
        return [];
      }
    },
    [beginHistoryTransaction, endHistoryTransaction, store],
  );

  useEffect(() => {
    const writeSelectedNodesToClipboard = (
      event: ClipboardEvent,
      nodes: readonly DesignNode[] = store.selectedNodes,
    ): DesignNode[] | null => {
      const selectedNodes = getNodesInDocumentOrder(store, nodes);
      if (selectedNodes.length === 0) return null;

      const payload: NodeClipboardPayload = {
        version: 1,
        nodes: selectedNodes.map((node) => ({
          node: designNodeToPersistedNode(node),
          canvasPosition: store.getCanvasPosition(node.id) ?? { x: node.x, y: node.y },
          parentId: store.parentMap.get(node.id),
        })),
      };
      const serialized = serializeNodeClipboardPayload(payload);
      const selectedText = selectedNodes
        .filter((node) => node.type === "text")
        .map((node) => node.content)
        .join("\n");

      clipboardRef.current = {
        serialized,
        payload,
        nodeCount: getClipboardPayloadNodeCount(payload),
        pasteCount: 0,
        lastPastedRootIds: new Set(),
        lastPastedIds: new Set(),
      };

      if (!event.clipboardData) return null;

      event.clipboardData.setData(NODE_CLIPBOARD_MIME_TYPE, serialized);
      if (selectedText) event.clipboardData.setData("text/plain", selectedText);
      event.preventDefault();
      return selectedNodes;
    };

    const onCopy = (event: ClipboardEvent) => {
      if (isTextEditingContext()) return;
      writeSelectedNodesToClipboard(event);
    };

    const onCut = action((event: ClipboardEvent) => {
      if (isTextEditingContext()) return;
      // Cut is copy plus delete, and delete never touches a locked node (see
      // deleteSelection). Copy only what will actually leave the canvas, and
      // when nothing can, leave both the clipboard and the document alone.
      const cutNodes = store.selectedNodes.filter((node) => !isNodeLocked(store, node.id));
      const selectedNodes = writeSelectedNodesToClipboard(event, cutNodes);
      if (!selectedNodes) return;
      store.runtime.deleteNodes(selectedNodes.map((node) => node.id));
      store.setTool("select");
    });

    window.addEventListener("copy", onCopy);
    window.addEventListener("cut", onCut);
    return () => {
      window.removeEventListener("copy", onCopy);
      window.removeEventListener("cut", onCut);
    };
  }, [store]);

  useEffect(() => {
    const pasteClipboardState = (clipboardState: ClipboardState, pasteCount: number) => {
      const selectionMatchesPreviousPaste =
        clipboardState.lastPastedRootIds.size > 0 &&
        clipboardState.lastPastedRootIds.size === store.selectedIds.size &&
        [...clipboardState.lastPastedRootIds].every((nodeId) => store.selectedIds.has(nodeId));
      const result = pasteNodeClipboardPayload(
        clipboardState.payload,
        pasteCount,
        selectionMatchesPreviousPaste ? clipboardState.lastPastedIds : new Set(),
      );
      const recordPasted = (pasted: PasteNodeResult[] | false) => {
        if (!pasted) return;
        clipboardState.lastPastedRootIds = new Set(pasted.map(({ newId }) => newId));
        clipboardState.lastPastedIds = new Set(
          pasted.flatMap(({ newId, descendantIdMap }) => [
            newId,
            ...Object.values(descendantIdMap),
          ]),
        );
      };
      if (result instanceof Promise) {
        return result.then((pasted) => {
          recordPasted(pasted);
        });
      }
      recordPasted(result);
    };

    const scheduleClipboardPaste = (clipboardState: ClipboardState) => {
      const pasteCount = clipboardState.pasteCount;
      if (clipboardState.nodeCount < INCREMENTAL_PASTE_NODE_THRESHOLD) {
        try {
          void Promise.resolve(pasteClipboardState(clipboardState, pasteCount)).catch((error) => {
            console.error("Failed to paste clipboard nodes", error);
            reportEditorFailure(error, "The copied nodes could not be pasted.", store);
          });
        } catch (error) {
          console.error("Failed to paste clipboard nodes", error);
          reportEditorFailure(error, "The copied nodes could not be pasted.", store);
        }
        return;
      }

      const run = () =>
        runNodePasteWithIndicator(store, () =>
          Promise.resolve(pasteClipboardState(clipboardState, pasteCount)),
        );
      largePasteQueueRef.current = largePasteQueueRef.current.then(run, run).catch((error) => {
        console.error("Failed to paste clipboard nodes", error);
        reportEditorFailure(error, "The copied nodes could not be pasted.", store);
      });
    };

    const onPaste = (event: ClipboardEvent) => {
      if (isTextEditingContext()) return;

      const clipboardData = event.clipboardData;
      const serializedNodes = clipboardData?.getData(NODE_CLIPBOARD_MIME_TYPE) || "";
      const cachedClipboardState =
        serializedNodes && clipboardRef.current?.serialized === serializedNodes
          ? clipboardRef.current
          : null;
      const parsedNodes =
        cachedClipboardState?.payload ??
        (serializedNodes ? parseNodeClipboardPayload(serializedNodes) : null);

      if (parsedNodes) {
        const clipboardState = cachedClipboardState ?? {
          serialized: serializedNodes,
          payload: parsedNodes,
          nodeCount: getClipboardPayloadNodeCount(parsedNodes),
          pasteCount: 0,
          lastPastedRootIds: new Set<string>(),
          lastPastedIds: new Set<string>(),
        };
        clipboardState.pasteCount += 1;
        clipboardRef.current = clipboardState;
        event.preventDefault();
        startTransition(() => scheduleClipboardPaste(clipboardState));
        return;
      }

      if (!clipboardData && clipboardRef.current) {
        const clipboardState = clipboardRef.current;
        clipboardState.pasteCount += 1;
        event.preventDefault();
        startTransition(() => scheduleClipboardPaste(clipboardState));
        return;
      }

      const viewportEl = viewportRef.current;
      if (!viewportEl) return;

      const imageFiles = getClipboardImageFiles(clipboardData);
      if (imageFiles.length > 0) {
        event.preventDefault();
        void pasteImages(imageFiles, store, viewportEl).catch((error) => {
          console.error("Failed to paste clipboard image", error);
          reportEditorFailure(error, "The clipboard image could not be pasted.", store);
        });
        return;
      }

      const content = classifyPastedContent({
        html: clipboardData?.getData("text/html"),
        text: clipboardData?.getData("text/plain"),
      });
      if (!content) return;
      event.preventDefault();

      insertContentAtPoint(content, getViewportCanvasCenter(store, viewportEl));
    };

    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [insertContentAtPoint, pasteNodeClipboardPayload, store, viewportRef]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.altKey || event.shiftKey) return;
      // Alt rewrites `key` to the alternate glyph on macOS (Alt+C reports "ç"),
      // so the physical `code` is what actually identifies the combo — the same
      // reason the shortcut registry matches Equal/Minus/Digit0 by code.
      const key = resolveStyleShortcutKey(event);
      if (key !== "c" && key !== "v") return;
      if (isEventTargetEditable(event.target) || isEventTargetEditable(document.activeElement)) {
        return;
      }

      const handled =
        key === "c"
          ? copySelectionStyles(store)
          : runInAction(() => {
              beginHistoryTransaction();
              try {
                return pasteSelectionStyles(store);
              } finally {
                endHistoryTransaction();
              }
            });
      if (handled) event.preventDefault();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [beginHistoryTransaction, endHistoryTransaction, store]);

  useEffect(() => {
    const isInsideViewport = (target: EventTarget | null) => {
      const viewportEl = viewportRef.current;
      return !!viewportEl && target instanceof Node && viewportEl.contains(target);
    };

    const onDragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files") || !isInsideViewport(event.target)) return;
      // Without this the browser opens the file instead of handing us the drop.
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    };

    const onDrop = (event: DragEvent) => {
      const viewportEl = viewportRef.current;
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (!viewportEl || files.length === 0 || !isInsideViewport(event.target)) return;
      event.preventDefault();

      const rect = viewportEl.getBoundingClientRect();
      const canvasPoint = store.screenToCanvas(
        screenPoint(event.clientX - rect.left, event.clientY - rect.top),
      );
      const { imageFiles, textFiles } = splitDroppedFiles(files);

      if (imageFiles.length > 0) {
        void pasteImages(imageFiles, store, viewportEl, canvasPoint).catch((error) => {
          console.error("Failed to import dropped image", error);
          reportEditorFailure(error, "The dropped image could not be imported.", store);
        });
      }
      if (textFiles.length > 0) {
        void insertDroppedTextFiles(textFiles, canvasPoint).catch((error) => {
          console.error("Failed to import dropped file", error);
          reportEditorFailure(error, "The dropped file could not be imported.", store);
        });
      }
    };

    const insertDroppedTextFiles = async (files: File[], canvasPoint: Point) => {
      for (const [index, file] of files.entries()) {
        const text = await file.text();
        const content = classifyPastedContent({ text });
        if (!content) continue;
        insertContentAtPoint(content, {
          x: canvasPoint.x + index * 24,
          y: canvasPoint.y + index * 24,
        });
      }
    };

    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [insertContentAtPoint, store, viewportRef]);
}
