import { formatColor, parseColor, toHex6 } from "../../core/editor/paint/color";
import { cx, IconButton as KitIconButton } from "../primitives";
import { isMixed, type MaybeMixed } from "./selection-properties";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { useRef, useState } from "react";

/** Kit classes for the quiet gray properties-panel input treatment. */
const filledInputClass = cx("leaf-input", "leaf-input-filled");

/** Layout the kit classes intentionally leave to callers. */
const inputLayout: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
};

export function Section({
  title,
  trailing,
  children,
  bordered = true,
}: {
  title?: string;
  trailing?: ReactNode;
  children: ReactNode;
  bordered?: boolean;
}) {
  return (
    <div
      style={{
        padding: "12px 12px 14px",
        borderTop: bordered ? "1px solid #ececec" : "none",
        minWidth: 0,
      }}
    >
      {title && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 10,
            minHeight: 20,
          }}
        >
          <div
            style={{
              fontSize: "var(--leaf-text-sm)",
              fontWeight: 600,
              color: "var(--leaf-text)",
              fontFamily: "var(--leaf-font-sans)",
            }}
          >
            {title}
          </div>
          {trailing && (
            <div style={{ display: "flex", alignItems: "center", gap: 2 }}>{trailing}</div>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

export function PropertyRow({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        marginBottom: 6,
        minWidth: 0,
      }}
    >
      {children}
    </div>
  );
}

export function PropertyGrid({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
        gap: 6,
        marginBottom: 6,
        minWidth: 0,
      }}
    >
      {children}
    </div>
  );
}

function clampSelectAll(input: HTMLInputElement | null) {
  if (!input) return;
  requestAnimationFrame(() => {
    try {
      input.select();
    } catch {
      // ignore
    }
  });
}

/**
 * Escape in a live-committing field: put back the value the field held when
 * it took focus, then leave it. Fields commit on every keystroke, so this is
 * the only way to abandon an edit; the key is consumed here so the viewport's
 * own Escape (deselect, cancel gesture) does not also fire from inside a form.
 */
function useEscapeRevert<T extends HTMLInputElement | HTMLTextAreaElement>(
  value: string | number,
  onChange: (value: string) => void,
) {
  const focusValueRef = useRef<string | null>(null);
  const captureFocusValue = () => {
    focusValueRef.current = String(value);
  };
  const handleKeyDown = (event: KeyboardEvent<T>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    const captured = focusValueRef.current;
    if (captured !== null && captured !== String(value)) onChange(captured);
    event.currentTarget.blur();
  };
  return { captureFocusValue, handleKeyDown };
}

export function IconInput({
  affordance,
  ariaLabel,
  value,
  onBlur,
  onChange,
  onFocus,
  type = "text",
  monospace = false,
  scrub,
  selectOnFocus = true,
}: {
  affordance: ReactNode;
  ariaLabel?: string;
  value: string | number;
  onBlur?: () => void;
  onChange: (value: string) => void;
  onFocus?: () => void;
  type?: "text" | "number";
  monospace?: boolean;
  scrub?: { onChange: (delta: number) => void; step?: number };
  selectOnFocus?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const scrubStateRef = useRef<{ startX: number; pointerId: number } | null>(null);
  const { captureFocusValue, handleKeyDown } = useEscapeRevert<HTMLInputElement>(value, onChange);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrub) return;
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    scrubStateRef.current = { startX: e.clientX, pointerId: e.pointerId };
    onFocus?.();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const state = scrubStateRef.current;
    if (!scrub || !state) return;
    const step = scrub.step ?? 1;
    const delta = Math.round((e.clientX - state.startX) * step);
    if (delta !== 0) {
      scrub.onChange(delta);
      scrubStateRef.current = { ...state, startX: e.clientX };
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrub) return;
    const state = scrubStateRef.current;
    if (state) {
      try {
        e.currentTarget.releasePointerCapture(state.pointerId);
      } catch {
        // ignore
      }
      scrubStateRef.current = null;
      onBlur?.();
    }
  };

  return (
    <div
      className={filledInputClass}
      style={{
        ...inputLayout,
        display: "flex",
        alignItems: "center",
        padding: 0,
        gap: 0,
      }}
    >
      <div
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 22,
          height: "100%",
          color: "var(--leaf-text-faint)",
          fontSize: "var(--leaf-text-xs)",
          fontFamily: "var(--leaf-font-sans)",
          flexShrink: 0,
          cursor: scrub ? "ew-resize" : "default",
          userSelect: "none",
          touchAction: "none",
        }}
      >
        {affordance}
      </div>
      <input
        ref={inputRef}
        aria-label={
          ariaLabel ??
          (typeof affordance === "string" || typeof affordance === "number"
            ? `${affordance} value`
            : "Property value")
        }
        type={type}
        size={1}
        value={type === "number" ? Math.round(Number(value)) : String(value)}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => {
          captureFocusValue();
          onFocus?.();
          if (selectOnFocus) clampSelectAll(inputRef.current);
        }}
        onBlur={() => onBlur?.()}
        style={{
          flex: 1,
          minWidth: 0,
          width: "100%",
          height: "100%",
          padding: "0 8px 0 0",
          backgroundColor: "transparent",
          border: "none",
          outline: "none",
          color: "var(--leaf-text)",
          fontSize: "var(--leaf-text-sm)",
          fontFamily: monospace ? "var(--leaf-font-mono)" : "var(--leaf-font-sans)",
          textAlign: "left",
          MozAppearance: "textfield" as CSSProperties["MozAppearance"],
        }}
      />
    </div>
  );
}

export function TextInput({
  affordance,
  value,
  onBlur,
  onChange,
  onFocus,
}: {
  affordance?: ReactNode;
  value: string;
  onBlur?: () => void;
  onChange: (value: string) => void;
  onFocus?: () => void;
}) {
  return (
    <IconInput
      affordance={affordance ?? <span />}
      type="text"
      value={value}
      onChange={onChange}
      onFocus={onFocus}
      onBlur={onBlur}
    />
  );
}

export function Select({
  value,
  options,
  onChange,
  onFocus,
  onBlur,
  "aria-label": ariaLabel = "Property option",
}: {
  value: string;
  options: { label: string; value: string }[];
  onChange: (value: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  "aria-label"?: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onFocus={onFocus}
      onBlur={onBlur}
      className={filledInputClass}
      style={{
        ...inputLayout,
        appearance: "none",
        WebkitAppearance: "none",
        MozAppearance: "none",
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg width='8' height='5' viewBox='0 0 8 5' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l3 3 3-3' stroke='%2371717a' stroke-width='1.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")",
        backgroundRepeat: "no-repeat",
        backgroundPosition: "right 8px center",
        paddingRight: 22,
      }}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label?: string; icon?: ReactNode; title?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        backgroundColor: "var(--leaf-surface-app)",
        borderRadius: 6,
        padding: 2,
        gap: 2,
        width: "100%",
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            title={opt.title}
            style={{
              // Basis `auto` so labels keep their own width and only the slack
              // is shared; equal thirds would crowd a long label next to a
              // short one.
              flex: "1 1 auto",
              minWidth: 0,
              height: 24,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              padding: "0 5px",
              whiteSpace: "nowrap",
              overflow: "hidden",
              border: "none",
              borderRadius: 4,
              // Literal #fff (== --leaf-surface): section tests identify the
              // active segment by this computed inline background color.
              backgroundColor: active ? "#fff" : "transparent",
              color: active ? "var(--leaf-text)" : "var(--leaf-text-muted)",
              fontSize: "var(--leaf-text-xs)",
              fontFamily: "var(--leaf-font-sans)",
              fontWeight: 500,
              boxShadow: active ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
              transition: "background-color 0.12s, color 0.12s",
            }}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Panel-density icon button: the kit's ghost IconButton at the 22px geometry
 * the properties panel rows are built around, with an `active` state.
 */
export function IconButton({
  onClick,
  title,
  active = false,
  children,
}: {
  onClick: () => void;
  title?: string;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <KitIconButton
      type="button"
      variant="ghost"
      size="sm"
      aria-label={title ?? "Property action"}
      title={title}
      onClick={onClick}
      style={{
        width: 22,
        height: 22,
        borderRadius: 4,
        ...(active
          ? { backgroundColor: "var(--leaf-surface-sunken)", color: "var(--leaf-text)" }
          : {}),
      }}
    >
      {children}
    </KitIconButton>
  );
}

export function Textarea({
  value,
  onChange,
  onFocus,
  onBlur,
  minHeight = 60,
  monospace = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  minHeight?: number;
  monospace?: boolean;
}) {
  const { captureFocusValue, handleKeyDown } = useEscapeRevert<HTMLTextAreaElement>(
    value,
    onChange,
  );
  return (
    <textarea
      aria-label="Property value"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={handleKeyDown}
      onFocus={() => {
        captureFocusValue();
        onFocus?.();
      }}
      onBlur={onBlur}
      className={filledInputClass}
      style={{
        ...inputLayout,
        // `.leaf-input` pins height to 28px for single-line inputs; let the
        // textarea grow from its minHeight instead.
        height: "auto",
        minHeight,
        padding: "6px 8px",
        fontFamily: monospace ? "var(--leaf-font-mono)" : undefined,
        resize: "vertical",
        lineHeight: 1.4,
      }}
    />
  );
}

if (typeof document !== "undefined") {
  const style = document.createElement("style");
  style.textContent = `
    .properties-panel input[type="number"]::-webkit-outer-spin-button,
    .properties-panel input[type="number"]::-webkit-inner-spin-button {
      -webkit-appearance: none;
      margin: 0;
    }
  `;
  document.head.appendChild(style);
}

// --- Multi-selection aware controls -----------------------------------------
//
// Every control below accepts MIXED so a multi-node selection shows an
// indeterminate state instead of the first node's value. Committing from a
// mixed control writes the new value to the whole selection, which is what the
// "Click to replace mixed …" affordance means.

/** Placeholder text a control shows when the selection disagrees. */
export const MIXED_LABEL = "Mixed";

export function MixedNumberInput({
  affordance,
  value,
  onBlur,
  onChange,
  onFocus,
  min,
  max,
  step = 1,
  suffix,
  displayMultiplier = 1,
}: {
  affordance: ReactNode;
  value: MaybeMixed<number | undefined>;
  onBlur?: () => void;
  onChange: (value: number) => void;
  onFocus?: () => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  displayMultiplier?: number;
}) {
  const mixed = isMixed(value);
  const numeric = mixed || value === undefined ? 0 : value;
  const apply = (next: number) => {
    if (Number.isNaN(next)) return;
    let clamped = next;
    if (min !== undefined) clamped = Math.max(min, clamped);
    if (max !== undefined) clamped = Math.min(max, clamped);
    onChange(clamped);
  };
  return (
    <IconInput
      affordance={affordance}
      type="text"
      value={
        mixed
          ? MIXED_LABEL
          : value === undefined
            ? ""
            : `${Math.round(value * displayMultiplier * 1000) / 1000}${suffix ?? ""}`
      }
      onChange={(raw) => {
        const parsed = Number.parseFloat(raw);
        if (Number.isFinite(parsed)) apply(parsed / displayMultiplier);
      }}
      onFocus={onFocus}
      onBlur={onBlur}
      scrub={{ onChange: (delta) => apply(numeric + delta * step) }}
    />
  );
}

export function MixedTextInput({
  affordance,
  value,
  placeholder,
  onBlur,
  onChange,
  onFocus,
  monospace = false,
}: {
  affordance?: ReactNode;
  value: MaybeMixed<string | number | undefined>;
  placeholder?: string;
  onBlur?: () => void;
  onChange: (value: string) => void;
  onFocus?: () => void;
  monospace?: boolean;
}) {
  const mixed = isMixed(value);
  return (
    <IconInput
      affordance={affordance ?? <span />}
      type="text"
      monospace={monospace}
      value={mixed ? MIXED_LABEL : value === undefined ? (placeholder ?? "") : String(value)}
      onChange={onChange}
      onFocus={onFocus}
      onBlur={onBlur}
    />
  );
}

export function MixedSelect({
  value,
  onChange,
  onBlur,
  onFocus,
  options,
}: {
  value: MaybeMixed<string | number | undefined>;
  onChange: (value: string) => void;
  onBlur?: () => void;
  onFocus?: () => void;
  options: Array<{ label: string; value: string }>;
}) {
  const mixed = isMixed(value);
  return (
    <Select
      value={mixed ? "" : value === undefined ? "" : String(value)}
      onChange={onChange}
      onBlur={onBlur}
      onFocus={onFocus}
      options={mixed ? [{ label: MIXED_LABEL, value: "" }, ...options] : options}
    />
  );
}

/**
 * Colour control with real alpha.
 *
 * The native `<input type="color">` is 6-digit hex only, so binding a value
 * straight to it destroys the alpha of anything an agent wrote as `rgba(...)`
 * or `#rrggbbaa`. Here the native picker only ever drives the RGB channels and
 * alpha is edited separately, so a round trip is lossless.
 *
 * The text field commits live but only values that parse: a half-typed `#f2`
 * never reaches the document, where it would paint as transparent. The field
 * keeps the raw keystrokes in a draft while focused so it can still be cleared
 * and retyped from scratch, and drops the draft on blur so the committed
 * colour is what it shows again.
 */
export function ColorField({
  value,
  onChange,
  onBlur,
  onFocus,
  trailing,
  allowAlpha = true,
}: {
  value: MaybeMixed<string | number | undefined>;
  onChange: (value: string) => void;
  onBlur?: () => void;
  onFocus?: () => void;
  trailing?: ReactNode;
  allowAlpha?: boolean;
}) {
  const mixed = isMixed(value);
  const raw = mixed || value === undefined ? "" : String(value);
  const parsed = parseColor(raw);
  const alphaPercent = Math.round((parsed?.a ?? 1) * 100);
  const [draft, setDraft] = useState<string | null>(null);

  const commitTyped = (next: string) => {
    setDraft(next);
    const color = next.trim();
    if (color && parseColor(color)) onChange(color);
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }}>
      <div
        style={{
          position: "relative",
          width: 22,
          height: 22,
          borderRadius: 4,
          border: "1px solid rgba(0,0,0,0.1)",
          overflow: "hidden",
          flexShrink: 0,
          // Checkerboard shows through a translucent colour so alpha is visible.
          backgroundImage: "conic-gradient(from 0deg, #ddd 25%, #fff 0 50%, #ddd 0 75%, #fff 0)",
          backgroundSize: "8px 8px",
        }}
        title={mixed ? MIXED_LABEL : raw}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundColor: parsed ? formatColor(parsed) : undefined,
          }}
        />
        <input
          aria-label="Choose color"
          type="color"
          value={parsed ? toHex6(parsed) : "#000000"}
          onChange={(event) => {
            // Preserve the existing alpha; the native picker cannot carry it.
            const next = parseColor(event.target.value);
            if (!next) return;
            onChange(formatColor({ ...next, a: parsed?.a ?? 1 }));
          }}
          onFocus={onFocus}
          onBlur={onBlur}
          style={{
            position: "absolute",
            inset: -4,
            width: "calc(100% + 8px)",
            height: "calc(100% + 8px)",
            padding: 0,
            border: "none",
            background: "transparent",
            opacity: 0,
          }}
        />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <IconInput
          ariaLabel="Color value"
          affordance={<span />}
          type="text"
          monospace
          value={draft ?? (mixed ? MIXED_LABEL : raw)}
          onChange={commitTyped}
          onFocus={() => {
            setDraft(mixed ? "" : raw);
            onFocus?.();
          }}
          onBlur={() => {
            setDraft(null);
            onBlur?.();
          }}
        />
      </div>
      {allowAlpha && (
        <div style={{ width: 52, flexShrink: 0 }}>
          <IconInput
            ariaLabel="Opacity"
            affordance={<span style={{ fontSize: 9 }}>%</span>}
            type="text"
            value={mixed ? "" : String(alphaPercent)}
            onChange={(next) => {
              const percent = Number.parseFloat(next);
              if (!Number.isFinite(percent) || !parsed) return;
              onChange(formatColor({ ...parsed, a: Math.min(100, Math.max(0, percent)) / 100 }));
            }}
            onFocus={onFocus}
            onBlur={onBlur}
            scrub={{
              onChange: (delta) => {
                if (!parsed) return;
                const percent = Math.min(100, Math.max(0, alphaPercent + delta));
                onChange(formatColor({ ...parsed, a: percent / 100 }));
              },
            }}
          />
        </div>
      )}
      {trailing}
    </div>
  );
}
