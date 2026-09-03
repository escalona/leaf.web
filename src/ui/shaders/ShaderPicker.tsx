import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_SHADER_ID,
  SHADER_DEFINITIONS,
  type ShaderDefinition,
} from "../../core/editor/shaders/registry";
import { shaderPreviewColors, shaderPreviewGradient } from "../../core/editor/shaders/preview";
import { isEventTargetEditable } from "../../core/lib/keyboard-shortcuts";
import { FONT_STACK } from "../floating-styles";

/**
 * Swatch for a shader row.
 *
 * Deliberately CSS and not a live surface: the menu lists every shader in the
 * package at once, and one WebGL2 context per row would exhaust the browser's
 * limit and start evicting the contexts the canvas is already using.
 */
function shaderSwatch(definition: ShaderDefinition): string {
  const preset = definition.presets[0];
  return shaderPreviewGradient(
    shaderPreviewColors(definition, {
      shaderId: definition.id,
      params: preset ? preset.params : {},
    }),
  );
}

export function ShaderPicker({
  onSelect,
  onCancel,
}: {
  onSelect: (shaderId: string) => void;
  onCancel?: () => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const closesPicker =
        event.key === "Escape" ||
        (event.key.toLowerCase() === "s" &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !isEventTargetEditable(event.target));
      if (!closesPicker) return;
      event.preventDefault();
      event.stopPropagation();
      onCancel?.();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      // The picker and its toolbar trigger share one positioned wrapper. Keep
      // the trigger inside the boundary so its own pressed-state handler can
      // close the menu without a pointerdown-close followed by a click-reopen.
      const boundary = pickerRef.current?.parentElement ?? pickerRef.current;
      if (target instanceof Node && boundary?.contains(target)) return;
      onCancel?.();
    };

    // Capture before the editor's window shortcuts so S closes exactly once
    // outside editable controls while remaining available to the search field.
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [onCancel]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return SHADER_DEFINITIONS;
    return SHADER_DEFINITIONS.filter(
      (definition) =>
        definition.label.toLowerCase().includes(needle) ||
        definition.id.toLowerCase().includes(needle),
    );
  }, [query]);

  return (
    <div
      ref={pickerRef}
      data-shader-picker
      style={{
        position: "absolute",
        bottom: "calc(100% + 8px)",
        left: "50%",
        transform: "translateX(-50%)",
        width: 260,
        backgroundColor: "var(--leaf-surface)",
        border: "1px solid var(--leaf-border)",
        borderRadius: "var(--leaf-radius-lg)",
        padding: 8,
        zIndex: 200,
        boxShadow: "0 4px 16px rgba(0,0,0,0.1)",
      }}
    >
      <input
        ref={inputRef}
        type="text"
        aria-label="Search shaders"
        placeholder="Search shaders"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          const shaderId = query.trim() ? matches[0]?.id : DEFAULT_SHADER_ID;
          if (shaderId) onSelect(shaderId);
        }}
        style={{
          width: "100%",
          padding: "6px 10px",
          marginBottom: 6,
          borderRadius: 6,
          border: "1px solid var(--leaf-border)",
          backgroundColor: "var(--leaf-surface-raised)",
          color: "var(--leaf-text)",
          fontSize: "var(--leaf-text-sm)",
          fontFamily: FONT_STACK,
          outline: "none",
          boxSizing: "border-box",
        }}
      />

      <div style={{ maxHeight: 280, overflowY: "auto" }}>
        {matches.length === 0 ? (
          <div
            style={{
              padding: 8,
              fontSize: "var(--leaf-text-xs)",
              color: "var(--leaf-text-faint)",
              fontFamily: FONT_STACK,
            }}
          >
            No shaders match “{query}”
          </div>
        ) : (
          matches.map((definition) => (
            <button
              key={definition.id}
              type="button"
              data-shader-option={definition.id}
              onClick={() => onSelect(definition.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                padding: 4,
                border: "none",
                borderRadius: 6,
                backgroundColor: "transparent",
                textAlign: "left",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 28,
                  height: 20,
                  flexShrink: 0,
                  borderRadius: 4,
                  border: "1px solid rgba(0,0,0,0.08)",
                  background: shaderSwatch(definition),
                }}
              />
              <span
                style={{
                  fontSize: "var(--leaf-text-sm)",
                  color: "var(--leaf-text)",
                  fontFamily: FONT_STACK,
                }}
              >
                {definition.label}
              </span>
              {!definition.animated && (
                <span
                  style={{
                    marginLeft: "auto",
                    fontSize: 9,
                    color: "var(--leaf-text-faint)",
                    fontFamily: FONT_STACK,
                  }}
                >
                  Static
                </span>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
