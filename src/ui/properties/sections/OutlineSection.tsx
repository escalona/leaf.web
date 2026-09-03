import { observer } from "mobx-react-lite";
import { TrashIcon } from "../../icons";
import {
  ColorField,
  IconButton,
  MixedNumberInput,
  MixedSelect,
  PropertyGrid,
  PropertyRow,
  SegmentedControl,
  Section,
} from "../PropertyControls";
import { aggregate, isMixed, type MaybeMixed } from "../selection-properties";
import { useEditorStore } from "../../../core/state/EditorStore";
import type { StylePatch } from "../../../core/editor/style-mutation";
import type { DesignNode } from "../../../core/types";
import type { SectionProps } from "./types";

const OUTLINE_KEYS = ["outline", "outlineWidth", "outlineColor", "outlineStyle", "outlineOffset"];

/** `outline-style` keywords, used to tell shorthand tokens apart. */
const OUTLINE_STYLE_KEYWORDS = new Set([
  "auto",
  "none",
  "hidden",
  "dotted",
  "dashed",
  "solid",
  "double",
  "groove",
  "ridge",
  "inset",
  "outset",
]);

/** The three keyword widths, in the px browsers actually use. */
const OUTLINE_WIDTH_KEYWORDS: Record<string, number> = { thin: 1, medium: 3, thick: 5 };

const OUTLINE_STYLES = [
  { label: "Solid", value: "solid" },
  { label: "Dashed", value: "dashed" },
  { label: "Dotted", value: "dotted" },
  { label: "Double", value: "double" },
  { label: "Groove", value: "groove" },
  { label: "Ridge", value: "ridge" },
  { label: "Inset", value: "inset" },
  { label: "Outset", value: "outset" },
];

/** Text omits the Outline panel, same as CornerRadius and Border. */
const OUTLINEABLE_TYPES = new Set<DesignNode["type"]>([
  "frame",
  "rectangle",
  "image",
  "interactive-surface",
  "svg",
]);

type Alignment = "inside" | "center" | "outside" | "custom";

const ALIGNMENTS: Array<{ value: Alignment; label: string; title: string }> = [
  { value: "inside", label: "Inside", title: "Offset by the full width, inward" },
  { value: "center", label: "Center", title: "Offset by half the width, inward" },
  { value: "outside", label: "Outside", title: "No offset" },
];

function plainPx(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const trimmed = value.trim();
  return /^-?\d*\.?\d+(px)?$/i.test(trimmed) ? Number.parseFloat(trimmed) : null;
}

function readPx(value: MaybeMixed<string | number | undefined>): number | null {
  return isMixed(value) ? null : plainPx(value);
}

/** Split a CSS value on top-level whitespace, keeping `rgb(1, 2, 3)` intact. */
function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value.trim()) {
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    if (/\s/.test(char) && depth === 0) {
      if (current) parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) parts.push(current);
  return parts;
}

interface OutlineParts {
  width?: string | number;
  style?: string;
  color?: string;
}

/**
 * Pull width/style/colour out of an `outline` shorthand.
 *
 * The three components are order-independent in CSS, so each token is claimed
 * by whichever slot recognises it and anything left over is the colour.
 */
export function parseOutlineShorthand(value: string | number): OutlineParts {
  const parts: OutlineParts = {};
  for (const token of splitTopLevel(String(value))) {
    const lower = token.toLowerCase();
    if (parts.style === undefined && OUTLINE_STYLE_KEYWORDS.has(lower)) parts.style = lower;
    else if (parts.width === undefined && lower in OUTLINE_WIDTH_KEYWORDS)
      parts.width = OUTLINE_WIDTH_KEYWORDS[lower];
    else if (parts.width === undefined && plainPx(token) !== null) parts.width = token;
    else if (parts.color === undefined) parts.color = token;
  }
  return parts;
}

/**
 * The outline a node actually paints.
 *
 * An agent writing `outline: 2px solid red` via `write_html` leaves no
 * longhands at all, so reading `outlineWidth` off the styles map alone shows an
 * empty control over a visibly outlined node. Walking the map in key order
 * instead reproduces the real cascade: a shorthand resets the components it
 * does not mention, and a longhand later in the map overrides just its own.
 */
export function effectiveOutline(node: DesignNode): OutlineParts {
  let parts: OutlineParts = {};
  for (const [key, value] of Object.entries(node.styles)) {
    if (key === "outline") parts = parseOutlineShorthand(value);
    else if (key === "outlineWidth") parts.width = value;
    else if (key === "outlineStyle") parts.style = String(value);
    else if (key === "outlineColor") parts.color = String(value);
  }
  return parts;
}

/** The offset that puts a stroke of `width` on a given side of the edge. */
function offsetFor(alignment: Alignment, width: number): number {
  if (alignment === "inside") return -width;
  if (alignment === "center") return -width / 2;
  return 0;
}

function alignmentOf(offset: number | null, width: number | null): Alignment {
  if (offset === null || width === null) return "custom";
  const near = (target: number) => Math.abs(offset - target) < 0.01;
  if (near(0)) return "outside";
  if (near(-width)) return "inside";
  if (near(-width / 2)) return "center";
  return "custom";
}

/**
 * Outline width, style, colour, and a signed offset.
 *
 * CSS `border` always paints inside the box, so `outline` plus a negative
 * `outline-offset` is the only way to get inside/center/outside stroke
 * alignment.
 */
export const OutlineSection = observer(({ props }: SectionProps) => {
  const { nodes, style, setStyles, removeStyles, buffered } = props;
  const store = useEditorStore();
  if (nodes.length === 0 || !nodes.every((node) => OUTLINEABLE_TYPES.has(node.type))) return null;

  const width = aggregate(nodes, (node) => effectiveOutline(node).width);
  const color = aggregate(nodes, (node) => effectiveOutline(node).color);
  const outlineStyle = aggregate(nodes, (node) => effectiveOutline(node).style);
  const offset = style("outlineOffset");

  const widthPx = readPx(width);
  const offsetPx = readPx(offset);
  const hasOutline = OUTLINE_KEYS.some((key) => style(key) !== undefined);
  // An unset offset renders as 0, which is the Outside alignment — so derive
  // alignment from the effective value, not from whether a key exists. With no
  // outline at all there is nothing to align, so no segment is selected.
  const alignment = !hasOutline
    ? "custom"
    : alignmentOf(offset === undefined ? 0 : offsetPx, width === undefined ? 0 : widthPx);

  /**
   * Write outline longhands, flattening any `outline` shorthand in the way.
   *
   * A shorthand later in the styles map beats the longhand this panel writes,
   * so editing a width on an agent-authored `outline: 2px solid red` would
   * update the model and change nothing on canvas. Expanding the shorthand into
   * its components — and dropping it — makes the panel authoritative.
   */
  const applyOutline = (patch: StylePatch) => {
    const shorthanded = nodes.filter((node) => node.styles.outline !== undefined);
    if (shorthanded.length === 0) {
      setStyles(patch);
      return;
    }
    store.runtime.updateStyles(
      nodes.map((node) => {
        if (node.styles.outline === undefined) return { nodeIds: [node.id], styles: patch };
        const parts = effectiveOutline(node);
        const flattened: StylePatch = { outline: null };
        if (parts.width !== undefined) flattened.outlineWidth = parts.width;
        if (parts.style !== undefined) flattened.outlineStyle = parts.style;
        if (parts.color !== undefined) flattened.outlineColor = parts.color;
        return { nodeIds: [node.id], styles: { ...flattened, ...patch } };
      }),
    );
  };

  const applyWidth = (next: number) => {
    const patch: StylePatch = { outlineWidth: next };
    // An outline with no style is `outline-style: none`, which paints nothing.
    if (outlineStyle === undefined) patch.outlineStyle = "solid";
    // Keep an established alignment true to the new width instead of leaving
    // the offset pointing at the old one. Outside stays implicit until the
    // user has an offset of their own, so the styles map picks up no noise.
    if (alignment !== "custom") {
      const nextOffset = offsetFor(alignment, next);
      if (offset !== undefined || nextOffset !== 0) patch.outlineOffset = nextOffset;
    }
    applyOutline(patch);
  };

  const applyAlignment = (next: Alignment) => {
    if (next === "custom") return;
    setStyles({ outlineOffset: offsetFor(next, widthPx ?? 0) });
  };

  return (
    <Section
      title="Outline"
      trailing={
        hasOutline ? (
          <IconButton onClick={() => removeStyles(OUTLINE_KEYS)} title="Remove outline">
            <TrashIcon size={12} />
          </IconButton>
        ) : undefined
      }
    >
      <PropertyGrid>
        <div data-property="outlineWidth" style={{ minWidth: 0 }}>
          <MixedNumberInput
            affordance="W"
            value={isMixed(width) ? width : (widthPx ?? undefined)}
            min={0}
            onChange={applyWidth}
            {...buffered}
          />
        </div>
        <div data-property="outlineOffset" style={{ minWidth: 0 }}>
          <MixedNumberInput
            affordance="O"
            value={isMixed(offset) ? offset : (offsetPx ?? undefined)}
            onChange={(next) => setStyles({ outlineOffset: next })}
            {...buffered}
          />
        </div>
      </PropertyGrid>
      <PropertyRow>
        <div data-property="outlineColor" style={{ flex: 1, minWidth: 0 }}>
          <ColorField
            value={color}
            onChange={(next) => applyOutline({ outlineColor: next })}
            {...buffered}
          />
        </div>
      </PropertyRow>
      <PropertyRow>
        <div data-property="outlineStyle" style={{ flex: 1, minWidth: 0 }}>
          <MixedSelect
            value={outlineStyle ?? "solid"}
            onChange={(next) => applyOutline({ outlineStyle: next })}
            options={OUTLINE_STYLES}
            {...buffered}
          />
        </div>
      </PropertyRow>
      <div data-property="outlineAlignment">
        <SegmentedControl<Alignment>
          value={alignment}
          options={ALIGNMENTS}
          onChange={applyAlignment}
        />
      </div>
    </Section>
  );
});
