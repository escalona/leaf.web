import { observer } from "mobx-react-lite";
import {
  AlignTextCenterIcon,
  AlignTextJustifyIcon,
  AlignTextLeftIcon,
  AlignTextRightIcon,
  ItalicIcon,
  TrashIcon,
  ValignBottomIcon,
  ValignMiddleIcon,
  ValignTopIcon,
} from "../../icons";
import { useRef, type ReactNode } from "react";
import { parseColor } from "../../../core/editor/paint/color";
import type { StylePatch } from "../../../core/editor/style-mutation";
import { useEditorStore } from "../../../core/state/EditorStore";
import type { DesignNode } from "../../../core/types";
import { FontPicker } from "../../font-picker/FontPicker";
import {
  ColorField,
  IconButton,
  IconInput,
  MIXED_LABEL,
  MixedSelect,
  PropertyGrid,
  PropertyRow,
  Section,
  SegmentedControl,
} from "../PropertyControls";
import { aggregate, isMixed, resolveNodeStyle, type MaybeMixed } from "../selection-properties";
import type { SelectionProperties } from "../useSelectionProperties";
import { everyType, type SectionProps } from "./types";

const FONT_WEIGHTS = [
  { label: "Thin 100", value: "100" },
  { label: "ExtraLight 200", value: "200" },
  { label: "Light 300", value: "300" },
  { label: "Regular 400", value: "400" },
  { label: "Medium 500", value: "500" },
  { label: "SemiBold 600", value: "600" },
  { label: "Bold 700", value: "700" },
  { label: "ExtraBold 800", value: "800" },
  { label: "Black 900", value: "900" },
];

const TEXT_TRANSFORMS = [
  { label: "As typed", value: "none" },
  { label: "UPPERCASE", value: "uppercase" },
  { label: "lowercase", value: "lowercase" },
  { label: "Capitalize", value: "capitalize" },
];

const DECORATION_LINES = [
  { label: "None", value: "none" },
  { label: "Underline", value: "underline" },
  { label: "Overline", value: "overline" },
  { label: "Strike", value: "line-through" },
];

const DECORATION_STYLES = [
  { label: "Solid", value: "solid" },
  { label: "Double", value: "double" },
  { label: "Dotted", value: "dotted" },
  { label: "Dashed", value: "dashed" },
  { label: "Wavy", value: "wavy" },
];

const TEXT_ALIGNMENTS: { value: string; icon: ReactNode; title: string }[] = [
  { value: "left", icon: <AlignTextLeftIcon size={12} />, title: "Align left" },
  { value: "center", icon: <AlignTextCenterIcon size={12} />, title: "Align center" },
  { value: "right", icon: <AlignTextRightIcon size={12} />, title: "Align right" },
  { value: "justify", icon: <AlignTextJustifyIcon size={12} />, title: "Justify" },
];

const VERTICAL_ALIGNMENTS: { value: string; icon: ReactNode; title: string }[] = [
  { value: "flex-start", icon: <ValignTopIcon size={12} />, title: "Align top" },
  { value: "center", icon: <ValignMiddleIcon size={12} />, title: "Align middle" },
  { value: "flex-end", icon: <ValignBottomIcon size={12} />, title: "Align bottom" },
];

/**
 * `-webkit-text-stroke-*` reaches the styles map under two spellings: the HTML
 * importer camel-cases the leading dash into `WebkitTextStrokeWidth`, while
 * CSSOM-style keys use `webkitTextStrokeWidth`. Both render, so the panel reads
 * either and collapses onto the first on the next edit.
 */
const TEXT_STROKE_WIDTH_KEYS = ["WebkitTextStrokeWidth", "webkitTextStrokeWidth"];
const TEXT_STROKE_COLOR_KEYS = ["WebkitTextStrokeColor", "webkitTextStrokeColor"];

const DECORATION_KEYS = [
  "textDecorationLine",
  "textDecorationStyle",
  "textDecorationColor",
  "textDecorationThickness",
];

const DECORATION_LINE_KEYWORDS = new Set([
  "none",
  "underline",
  "overline",
  "line-through",
  "blink",
]);

const DECORATION_STYLE_KEYWORDS = new Set(["solid", "double", "dotted", "dashed", "wavy"]);

/** Split on top-level whitespace so `rgb(255, 0, 0)` survives as one token. */
function tokenizeCssValue(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let depth = 0;

  for (const character of value.trim()) {
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;

    if (depth === 0 && /\s/.test(character)) {
      if (current) tokens.push(current);
      current = "";
    } else {
      current += character;
    }
  }

  if (current) tokens.push(current);
  return tokens;
}

/**
 * Split a `text-decoration` shorthand into the longhands the panel edits.
 *
 * An agent writing raw CSS reaches for the shorthand, and a panel reading only
 * longhands would show "None" over a visible underline. Decomposing on read —
 * and retiring the shorthand on the first edit — also keeps a shorthand and its
 * longhands from racing for precedence in the styles map.
 */
export function parseTextDecorationShorthand(value: string): Record<string, string> {
  const lines: string[] = [];
  const patch: Record<string, string> = {};

  for (const token of tokenizeCssValue(value)) {
    const lowered = token.toLowerCase();
    if (DECORATION_LINE_KEYWORDS.has(lowered)) lines.push(lowered);
    else if (DECORATION_STYLE_KEYWORDS.has(lowered)) patch.textDecorationStyle = lowered;
    else if (lowered === "auto" || lowered === "from-font" || /^[.\d]/.test(lowered)) {
      patch.textDecorationThickness = token;
    } else if (parseColor(token)) patch.textDecorationColor = token;
  }

  if (lines.length > 0) patch.textDecorationLine = lines.join(" ");
  return patch;
}

/**
 * One node's decoration longhand, falling back to what its own shorthand
 * carries.
 *
 * Resolving per node rather than off the aggregated shorthand is what keeps a
 * multi-node selection honest: two nodes with different shorthands aggregate to
 * MIXED, which cannot be decomposed, and reading through that would show
 * "None" over two visibly decorated nodes.
 */
function readNodeDecoration(node: DesignNode, key: string) {
  const longhand = resolveNodeStyle(node, key);
  if (longhand !== undefined) return longhand;
  const shorthand = resolveNodeStyle(node, "textDecoration");
  if (shorthand === undefined) return undefined;
  return parseTextDecorationShorthand(String(shorthand))[key];
}

/**
 * The patch that retires one node's `text-decoration` shorthand.
 *
 * The shorthand keeps whatever it carried, as longhands — except where the node
 * already has an explicit longhand, which outranks it and must not be
 * overwritten by the shorthand's stale value.
 */
function retireDecorationShorthand(node: DesignNode, patch: StylePatch): StylePatch {
  const shorthand = resolveNodeStyle(node, "textDecoration");
  if (shorthand === undefined) return patch;

  const carried: StylePatch = {};
  for (const [key, value] of Object.entries(parseTextDecorationShorthand(String(shorthand)))) {
    if (resolveNodeStyle(node, key) === undefined) carried[key] = value;
  }
  return { ...carried, ...patch, textDecoration: null };
}

/** The weight dropdown is numeric; the CSS keywords map onto it. */
function normalizeFontWeight(value: MaybeMixed<string | number | undefined>) {
  if (isMixed(value)) return value;
  const text = String(value ?? "400").toLowerCase();
  if (text === "normal") return "400";
  if (text === "bold") return "700";
  return text;
}

function splitLengthValue(value: string) {
  const match = /^\s*(-?\d*\.?\d+)([a-z%]*)\s*$/i.exec(value);
  if (!match) return null;
  const magnitude = Number.parseFloat(match[1]!);
  return Number.isFinite(magnitude) ? { magnitude, unit: match[2] ?? "" } : null;
}

/**
 * A length field that never rewrites the unit the author chose.
 *
 * `MixedNumberInput` renders through a numeric coercion, which would turn an
 * agent's `1.5rem` into `1.5` — a silent 10x shrink. This keeps the authored
 * string and only touches the magnitude while scrubbing. Clearing the field
 * emits `null`, the styles-map removal sentinel.
 *
 * A bare number is committed verbatim while typing so `1`, `1.`, `1.5` are all
 * reachable, then given `defaultUnit` on blur: `letter-spacing: 2` is invalid
 * CSS that paints nothing, so without this a typed value silently does nothing.
 * `allowUnitless` opts out for line-height, where a bare number is a valid
 * multiplier and attaching px would be the wrong guess.
 */
function LengthInput({
  affordance,
  value,
  placeholder,
  defaultUnit,
  allowUnitless = false,
  step = 1,
  min,
  onChange,
  onFocus,
  onBlur,
}: {
  affordance: ReactNode;
  value: MaybeMixed<string | number | undefined>;
  placeholder?: string;
  defaultUnit: string;
  allowUnitless?: boolean;
  step?: number;
  min?: number;
  onChange: (value: string | null) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}) {
  const mixed = isMixed(value);
  const raw = mixed || value === undefined ? "" : String(value);
  const editedRef = useRef(false);

  const scrubBy = (delta: number) => {
    const parts = splitLengthValue(raw);
    // `var(--tracking)`, `calc(...)` and `clamp(...)` have no single magnitude
    // to nudge; scrubbing them would swap the authored expression for a number.
    if (parts === null && raw !== "") return;
    const magnitude = parts?.magnitude ?? 0;
    const unit = parts?.unit || defaultUnit;
    const next = magnitude + delta * step;
    const clamped = min !== undefined ? Math.max(min, next) : next;
    // Tracking is scrubbed in hundredths of an em, which would otherwise
    // surface as 0.060000000000000005.
    onChange(`${Number(clamped.toFixed(4))}${unit}`);
  };

  const handleBlur = () => {
    if (editedRef.current) {
      editedRef.current = false;
      const parts = splitLengthValue(raw);
      if (!allowUnitless && parts !== null && parts.unit === "") {
        onChange(`${parts.magnitude}${defaultUnit}`);
      }
    }
    onBlur?.();
  };

  return (
    <IconInput
      affordance={affordance}
      type="text"
      value={mixed ? MIXED_LABEL : raw === "" ? (placeholder ?? "") : raw}
      onChange={(next) => {
        editedRef.current = true;
        onChange(next.trim() === "" ? null : next);
      }}
      onFocus={onFocus}
      onBlur={handleBlur}
      scrub={{ onChange: scrubBy }}
    />
  );
}

/** The first spelling of an aliased key that the selection actually carries. */
function readAliasedStyle(props: SelectionProperties, keys: string[]) {
  for (const key of keys) {
    const value = props.style(key);
    if (isMixed(value) || value !== undefined) return value;
  }
  return undefined;
}

/** Write the canonical spelling of an aliased key and drop the alternates. */
function aliasedPatch(keys: string[], value: string | null): StylePatch {
  const patch: StylePatch = { [keys[0]!]: value };
  for (const alias of keys.slice(1)) patch[alias] = null;
  return patch;
}

const TextSection = observer(({ props }: SectionProps) => {
  const { style, setStyles, buffered } = props;

  const fontFamily = style("fontFamily");
  const fontStyle = style("fontStyle");
  const isItalic = !isMixed(fontStyle) && fontStyle === "italic";
  const display = style("display");
  const isFlexContainer = !isMixed(display) && (display === "flex" || display === "inline-flex");
  const textAlign = style("textAlign");
  const alignItems = style("alignItems");

  return (
    <Section title="Text">
      <PropertyRow>
        <FontPicker
          value={isMixed(fontFamily) ? "" : String(fontFamily ?? "")}
          mixed={isMixed(fontFamily)}
          onChange={(next) => setStyles({ fontFamily: next })}
        />
      </PropertyRow>
      <PropertyRow>
        <div style={{ flex: 1, minWidth: 0 }}>
          <MixedSelect
            value={normalizeFontWeight(style("fontWeight"))}
            onChange={(next) => setStyles({ fontWeight: next })}
            options={FONT_WEIGHTS}
            {...buffered}
          />
        </div>
        <IconButton
          active={isItalic}
          title="Italic"
          onClick={() => setStyles({ fontStyle: isItalic ? null : "italic" })}
        >
          <ItalicIcon size={12} />
        </IconButton>
      </PropertyRow>
      <PropertyGrid>
        <LengthInput
          affordance={<span style={{ fontSize: 10 }}>Aa</span>}
          value={style("fontSize")}
          defaultUnit="px"
          min={1}
          onChange={(next) => setStyles({ fontSize: next })}
          {...buffered}
        />
        <LengthInput
          affordance={<span style={{ fontSize: 10 }}>LH</span>}
          value={style("lineHeight")}
          placeholder="normal"
          defaultUnit="px"
          allowUnitless
          min={0}
          onChange={(next) => setStyles({ lineHeight: next })}
          {...buffered}
        />
      </PropertyGrid>
      <PropertyGrid>
        <LengthInput
          affordance={<span style={{ fontSize: 10 }}>LS</span>}
          value={style("letterSpacing")}
          placeholder="normal"
          defaultUnit="em"
          step={0.01}
          onChange={(next) => setStyles({ letterSpacing: next })}
          {...buffered}
        />
        <MixedSelect
          value={style("textTransform") ?? "none"}
          onChange={(next) => setStyles({ textTransform: next === "none" ? null : next })}
          options={TEXT_TRANSFORMS}
          {...buffered}
        />
      </PropertyGrid>
      <PropertyRow>
        <SegmentedControl
          value={isMixed(textAlign) ? "" : String(textAlign ?? "left")}
          options={TEXT_ALIGNMENTS}
          onChange={(next) => setStyles({ textAlign: next })}
        />
      </PropertyRow>
      {isFlexContainer && (
        <PropertyRow>
          <SegmentedControl
            value={isMixed(alignItems) ? "" : String(alignItems ?? "")}
            options={VERTICAL_ALIGNMENTS}
            onChange={(next) => setStyles({ alignItems: next })}
          />
        </PropertyRow>
      )}
    </Section>
  );
});

const TextDecorationSection = observer(({ props }: SectionProps) => {
  const { nodes, removeStyles, buffered } = props;
  const store = useEditorStore();

  const readDecoration = (key: string) => aggregate(nodes, (node) => readNodeDecoration(node, key));

  // Each node retires its own shorthand, so a selection whose nodes carry
  // different shorthands keeps each one's colour and style instead of writing
  // the first node's decomposition over the rest.
  const applyDecoration = (patch: StylePatch) =>
    store.runtime.updateStyles(
      nodes.map((node) => ({
        nodeIds: [node.id],
        styles: retireDecorationShorthand(node, patch),
      })),
    );

  const line = readDecoration("textDecorationLine");
  const color = readDecoration("textDecorationColor");
  const thickness = readDecoration("textDecorationThickness");
  // Colour and thickness stay hidden behind a chosen line, except when an agent
  // already wrote one — no other section panels these keys, so hiding them
  // unconditionally would make them uneditable.
  const hasDecoration =
    isMixed(line) ||
    (line !== undefined && String(line) !== "none") ||
    color !== undefined ||
    thickness !== undefined;

  return (
    <Section
      title="Decoration"
      trailing={
        hasDecoration ? (
          <IconButton
            onClick={() => removeStyles(["textDecoration", ...DECORATION_KEYS])}
            title="Remove decoration"
          >
            <TrashIcon size={12} />
          </IconButton>
        ) : undefined
      }
    >
      <PropertyGrid>
        <MixedSelect
          value={line ?? "none"}
          onChange={(next) => applyDecoration({ textDecorationLine: next })}
          options={DECORATION_LINES}
          {...buffered}
        />
        <MixedSelect
          value={readDecoration("textDecorationStyle") ?? "solid"}
          onChange={(next) => applyDecoration({ textDecorationStyle: next })}
          options={DECORATION_STYLES}
          {...buffered}
        />
      </PropertyGrid>
      {hasDecoration && (
        <>
          <PropertyRow>
            <ColorField
              value={color}
              onChange={(next) => applyDecoration({ textDecorationColor: next })}
              {...buffered}
            />
          </PropertyRow>
          <PropertyRow>
            <LengthInput
              affordance={<span style={{ fontSize: 10 }}>T</span>}
              value={thickness}
              placeholder="auto"
              defaultUnit="px"
              min={0}
              onChange={(next) => applyDecoration({ textDecorationThickness: next })}
              {...buffered}
            />
          </PropertyRow>
        </>
      )}
    </Section>
  );
});

const TextStrokeSection = observer(({ props }: SectionProps) => {
  const { setStyles, removeStyles, buffered } = props;

  const width = readAliasedStyle(props, TEXT_STROKE_WIDTH_KEYS);
  const color = readAliasedStyle(props, TEXT_STROKE_COLOR_KEYS);
  const hasStroke = isMixed(width) || width !== undefined;

  return (
    <Section
      title="Text stroke"
      trailing={
        hasStroke ? (
          <IconButton
            onClick={() => removeStyles([...TEXT_STROKE_WIDTH_KEYS, ...TEXT_STROKE_COLOR_KEYS])}
            title="Remove text stroke"
          >
            <TrashIcon size={12} />
          </IconButton>
        ) : undefined
      }
    >
      <PropertyGrid>
        <LengthInput
          affordance="W"
          value={width}
          placeholder="0"
          defaultUnit="px"
          min={0}
          onChange={(next) => setStyles(aliasedPatch(TEXT_STROKE_WIDTH_KEYS, next))}
          {...buffered}
        />
        <ColorField
          value={color}
          allowAlpha={false}
          onChange={(next) => setStyles(aliasedPatch(TEXT_STROKE_COLOR_KEYS, next))}
          {...buffered}
        />
      </PropertyGrid>
    </Section>
  );
});

/**
 * The Text, TextDecoration, and TextStroke panels.
 *
 * They gate together on a text-only selection because only text nodes own
 * type settings — a Frame inherits type from its
 * ancestors rather than owning a type panel.
 */
export const TypographySection = observer(({ props }: SectionProps) => {
  if (!everyType(props.nodes, "text")) return null;

  return (
    <>
      <TextSection props={props} />
      <TextDecorationSection props={props} />
      <TextStrokeSection props={props} />
    </>
  );
});
