import { observer } from "mobx-react-lite";
import { useCallback, useLayoutEffect, useRef, type CSSProperties } from "react";
import { isFlexLayoutDisplay } from "../../core/editor/layout-display";
import { setRetainedTextContent } from "../../core/editor/retained-text";
import {
  getAnchoredTextSizePatch,
  measurePlainTextForElement,
} from "../../core/editor/text-measure";
import { ensureFontsLoaded } from "../../core/fonts/loader";
import { useEditorStore, type TextEditingSelection } from "../../core/state/EditorStore";
import type { DesignNode } from "../../core/types";
import {
  applyTypedAppearanceStyles,
  buildBaseStyle,
  getMaterializedNodeProps,
} from "./node-renderer-style";
import { GeneratedBackgroundPlaceholder, type RendererProps, useNodeRef } from "./renderer-helpers";
import { useResolvedNodeBackgroundImage } from "./node-background-image";

function setTextareaSelection(textarea: HTMLTextAreaElement, selection: TextEditingSelection) {
  const length = textarea.value.length;
  if (selection.type === "all") {
    textarea.select();
    return;
  }
  const offset = selection.type === "offset" ? selection.offset : length;
  const clampedOffset = Math.max(0, Math.min(length, offset));
  textarea.setSelectionRange(clampedOffset, clampedOffset);
}

function updateTextareaNodeSize(node: DesignNode, textarea: HTMLTextAreaElement) {
  const measured = measurePlainTextForElement(textarea, textarea.value, {
    maxWidth: node.textAutoSize ? null : node.width,
  });
  return getAnchoredTextSizePatch(
    node,
    node.textAutoSize ? measured : { width: node.width, height: measured.height },
  );
}

function resetTextareaScroll(textarea: HTMLTextAreaElement) {
  const reset = () => {
    textarea.scrollTop = 0;
    textarea.scrollLeft = 0;
  };
  reset();

  const view = textarea.ownerDocument.defaultView;
  if (!view) return;
  if (typeof view.requestAnimationFrame === "function") {
    view.requestAnimationFrame(reset);
  } else {
    view.setTimeout(reset, 0);
  }
}

export const TextNodeRenderer = observer(
  ({ node, isFlowChild = false, isInteractionSuppressed = false }: RendererProps) => {
    const store = useEditorStore();
    const ref = useNodeRef(node);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const textContentRef = useRef<HTMLDivElement | null>(null);
    const lastTextContentRef = useRef<string | null>(null);
    const isEditing = store.editingTextNodeId === node.id;
    const editingSession = isEditing ? store.editingTextSession : null;

    const style = buildBaseStyle(store, node, isFlowChild, isInteractionSuppressed);
    applyTypedAppearanceStyles(node, style);
    useResolvedNodeBackgroundImage(node, style);

    if (!node.styles.color) style.color = node.color;
    if (!node.styles.fontSize) style.fontSize = node.fontSize;
    if (!node.styles.fontFamily) style.fontFamily = node.fontFamily;
    if (!node.styles.fontWeight) style.fontWeight = node.fontWeight;
    if (!node.styles.lineHeight && !isFlowChild) style.lineHeight = 1.4;
    if (!node.styles.whiteSpace) style.whiteSpace = "pre-wrap";
    if (!node.styles.overflowWrap && !node.styles.wordBreak) style.overflowWrap = "break-word";
    if (!node.styles.userSelect) style.userSelect = "none";
    style.cursor = isEditing ? "text" : style.cursor;
    if (isEditing && style.position === undefined) style.position = "relative";

    const textLayoutSignature = JSON.stringify([
      node.content,
      node.width,
      node.textAutoSize,
      node.fontFamily,
      node.fontSize,
      node.fontWeight,
      node.styles,
    ]);
    const previousTextLayoutSignatureRef = useRef<string | null>(null);

    const effectiveFontFamily = typeof style.fontFamily === "string" ? style.fontFamily : null;

    useLayoutEffect(() => {
      const element = textContentRef.current;
      if (!element || lastTextContentRef.current === node.content) return;
      setRetainedTextContent(element, node.content);
      lastTextContentRef.current = node.content;
    }, [node.content]);

    useLayoutEffect(() => {
      const previousSignature = previousTextLayoutSignatureRef.current;
      previousTextLayoutSignatureRef.current = textLayoutSignature;
      if (previousSignature === textLayoutSignature) return;

      let cancelled = false;
      const measureIfMounted = () => {
        if (cancelled) return;
        const element = textareaRef.current ?? textContentRef.current;
        const currentNode = store.getNode(node.id);
        if (!element || !currentNode) return;
        const measured = measurePlainTextForElement(element, currentNode.content, {
          maxWidth: currentNode.textAutoSize ? null : currentNode.width,
        });
        const patch = getAnchoredTextSizePatch(
          currentNode,
          currentNode.textAutoSize
            ? measured
            : { width: currentNode.width, height: measured.height },
        );
        if (
          patch.width !== currentNode.width ||
          patch.height !== currentNode.height ||
          patch.x !== undefined
        ) {
          store.runtime.updateNode(currentNode.id, patch);
        }
      };

      const fontLoad = effectiveFontFamily ? ensureFontsLoaded(effectiveFontFamily) : undefined;
      void Promise.resolve(fontLoad).then(measureIfMounted, measureIfMounted);
      return () => {
        cancelled = true;
      };
    }, [effectiveFontFamily, node.id, store, textLayoutSignature]);

    useLayoutEffect(() => {
      if (!isEditing) return;
      const textarea = textareaRef.current;
      if (!textarea || !editingSession) return;
      textarea.value = node.content;
      textarea.focus({ preventScroll: true });
      setTextareaSelection(textarea, editingSession.selection);
      resetTextareaScroll(textarea);
      const timeout = window.setTimeout(() => {
        if (store.editingTextNodeId !== node.id) return;
        textarea.focus({ preventScroll: true });
        setTextareaSelection(textarea, editingSession.selection);
        resetTextareaScroll(textarea);
      }, 0);

      const patch = updateTextareaNodeSize(node, textarea);
      if (patch.width !== node.width || patch.height !== node.height || patch.x !== undefined) {
        store.runtime.updateNode(node.id, patch);
      }
      resetTextareaScroll(textarea);
      return () => window.clearTimeout(timeout);
    }, [editingSession, isEditing, node, store]);

    const handleInput = useCallback(
      (event: React.FormEvent<HTMLTextAreaElement>) => {
        const textarea = event.currentTarget;
        store.runtime.setTextContent([{ nodeId: node.id, textContent: textarea.value }]);
        const patch = updateTextareaNodeSize(node, textarea);
        if (patch.width !== node.width || patch.height !== node.height || patch.x !== undefined) {
          store.runtime.updateNode(node.id, patch);
        }
        resetTextareaScroll(textarea);
      },
      [node, store],
    );

    const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const text = event.clipboardData.getData("text/plain");
      event.preventDefault();
      event.currentTarget.setRangeText(
        text,
        event.currentTarget.selectionStart,
        event.currentTarget.selectionEnd,
        "end",
      );
      event.currentTarget.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }, []);

    const handleKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          store.finishTextEditing();
        } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          event.stopPropagation();
          store.finishTextEditing();
        } else if (event.key === "Enter") {
          resetTextareaScroll(event.currentTarget);
        } else if (event.key === "Tab" && !event.shiftKey) {
          event.preventDefault();
          event.currentTarget.setRangeText(
            "\t",
            event.currentTarget.selectionStart,
            event.currentTarget.selectionEnd,
            "end",
          );
          event.currentTarget.dispatchEvent(new InputEvent("input", { bubbles: true }));
        }
      },
      [store],
    );

    const handleBlur = useCallback(
      (event: React.FocusEvent<HTMLTextAreaElement>) => {
        if (store.editingTextNodeId !== node.id) return;
        // Focus landing on another part of the app — a properties field, the
        // pages bar — ends the session the way a canvas press does. A blur with
        // no destination is not that: the window lost focus, or the browser's
        // default mouseup handling parked focus on the body (which happens on
        // the very click that created this node). Those keep the session; a
        // canvas press ends it through the pointer path instead.
        if (!event.relatedTarget) return;
        store.finishTextEditing();
      },
      [node.id, store],
    );

    const usesFlowAlignment = isFlexLayoutDisplay(node.styles.display as string | undefined);
    const textContentStyle: CSSProperties = {
      width: "100%",
      height: usesFlowAlignment ? "auto" : "100%",
      color: "inherit",
      font: "inherit",
      lineHeight: "inherit",
      letterSpacing: "inherit",
      textAlign: "inherit",
      textTransform: "inherit",
      whiteSpace: "inherit",
      overflowWrap: "inherit",
      wordBreak: "inherit",
      opacity: isEditing ? 0 : 1,
      pointerEvents: isEditing ? "none" : undefined,
    };
    const textareaStyle: CSSProperties = {
      position: "absolute",
      inset: 0,
      width: "100%",
      height: "100%",
      minWidth: 1,
      minHeight: 1,
      margin: 0,
      padding: 0,
      border: "none",
      outline: "none",
      resize: "none",
      overflow: "hidden",
      background: "transparent",
      color: "inherit",
      font: "inherit",
      lineHeight: "inherit",
      letterSpacing: "inherit",
      textAlign: "inherit",
      textTransform: "inherit",
      whiteSpace: "pre-wrap",
      overflowWrap: node.textAutoSize ? "normal" : "break-word",
      wordBreak: "normal",
      boxSizing: "border-box",
      cursor: "text",
      userSelect: "text",
      WebkitUserSelect: "text",
      caretColor: "currentColor",
    };

    return (
      <div ref={ref} data-node-id={node.id} {...getMaterializedNodeProps(store, node.id, style)}>
        <GeneratedBackgroundPlaceholder node={node} />
        <div ref={textContentRef} data-text-content style={textContentStyle} />
        {isEditing ? (
          <textarea
            ref={textareaRef}
            aria-label={`Edit ${node.name}`}
            data-inline-text-editor
            defaultValue={node.content}
            spellCheck
            dir="auto"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            onBlur={handleBlur}
            onDoubleClick={(event) => event.stopPropagation()}
            onDragStart={(event) => event.preventDefault()}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onPointerDownCapture={(event) => event.stopPropagation()}
            onTouchEnd={(event) => event.stopPropagation()}
            style={textareaStyle}
          />
        ) : null}
      </div>
    );
  },
);
