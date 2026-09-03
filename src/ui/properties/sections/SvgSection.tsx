import { observer } from "mobx-react-lite";
import { TrashIcon } from "../../icons";
import {
  ColorField,
  IconButton,
  MixedNumberInput,
  PropertyRow,
  Section,
  Textarea,
} from "../PropertyControls";
import { isMixed, resolveNodeStyle, type MaybeMixed } from "../selection-properties";
import { useEditorStore } from "../../../core/state/EditorStore";
import type { StylePatch } from "../../../core/editor/style-mutation";
import type { DesignNode } from "../../../core/types";
import { FONT_STACK } from "../../floating-styles";
import { isSvgElementNode } from "./SvgFillStrokeSection";
import { type SectionProps } from "./types";

/** Paint keys that cascade from the wrapper element into the SVG artwork. */
const PAINT_KEYS = ["fill", "stroke", "strokeWidth"] as const;

const PAINT_DECLARATIONS: Record<(typeof PAINT_KEYS)[number], string> = {
  fill: "fill:inherit",
  stroke: "stroke:inherit",
  strokeWidth: "stroke-width:inherit",
};

const INHERIT_MARKER = "data-leaf-svg-paint";
const INHERIT_STYLE_PATTERN = new RegExp(`<style ${INHERIT_MARKER}>[\\s\\S]*?</style>`, "g");
const SVG_OPEN_TAG = /<svg\b[^>]*>/i;

function plainPx(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const trimmed = value.trim();
  return /^-?\d*\.?\d+(px)?$/i.test(trimmed) ? Number.parseFloat(trimmed) : null;
}

function readPx(value: MaybeMixed<string | number | undefined>): number | null {
  return isMixed(value) ? null : plainPx(value);
}

/**
 * Rewrite the injected paint rule inside an SVG's markup.
 *
 * Inner elements usually carry `fill="…"` presentation attributes, and a
 * specified value always beats an inherited one — so a fill on the wrapper
 * alone would do nothing. Injecting `fill: inherit` is what lets the cascade
 * through, and it is reversible: the marker is stripped when no paint is set,
 * leaving the imported markup byte-identical.
 *
 * The rule is wrapped in `@scope` because a `<style>` inside inline SVG is a
 * document-wide stylesheet, not a scoped one. Browsers without `@scope` drop
 * the whole rule, which degrades to plain inheritance rather than repainting
 * every other SVG on the canvas.
 */
export function withPaintInheritance(markup: string, keys: readonly string[]): string {
  const stripped = markup.replace(INHERIT_STYLE_PATTERN, "");
  const declarations = PAINT_KEYS.filter((key) => keys.includes(key))
    .map((key) => PAINT_DECLARATIONS[key])
    .join(";");
  if (!declarations) return stripped;

  const open = SVG_OPEN_TAG.exec(stripped);
  // A self-closing root has no artwork to cascade into.
  if (!open || open[0].endsWith("/>")) return stripped;

  const insertAt = open.index + open[0].length;
  const rule = `<style ${INHERIT_MARKER}>@scope{*{${declarations}}}</style>`;
  return stripped.slice(0, insertAt) + rule + stripped.slice(insertAt);
}

function readLengthAttribute(tag: string, name: string): number | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  const raw = match?.[2] ?? match?.[3];
  if (raw === undefined) return null;
  const numeric = /^\s*(\d*\.?\d+)(px)?\s*$/i.exec(raw);
  return numeric ? Number.parseFloat(numeric[1]!) : null;
}

/**
 * Give a root `<svg>` a `viewBox` derived from its width/height attributes.
 *
 * Without one, resizing the node crops the artwork instead of scaling it,
 * because the SVG has no user-space to map onto the new box.
 */
export function withDerivedViewBox(markup: string): string {
  const open = SVG_OPEN_TAG.exec(markup);
  if (!open) return markup;
  const tag = open[0];
  if (/\bviewBox\s*=/i.test(tag)) return markup;

  const width = readLengthAttribute(tag, "width");
  const height = readLengthAttribute(tag, "height");
  if (width === null || height === null || width <= 0 || height <= 0) return markup;

  const next = tag.replace(/^<svg\b/i, `<svg viewBox="0 0 ${width} ${height}"`);
  return markup.slice(0, open.index) + next + markup.slice(open.index + tag.length);
}

function needsViewBox(node: DesignNode): boolean {
  return withDerivedViewBox(node.content) !== node.content;
}

/** SVG markup plus fill/stroke paint that reaches the artwork inside it. */
export const SvgSection = observer(({ props }: SectionProps) => {
  const {
    nodes,
    primary,
    isMultiple,
    style,
    setStyles,
    removeStyles,
    beginEdit,
    endEdit,
    buffered,
  } = props;
  const store = useEditorStore();
  // Only the root of an SVG. Its decomposed sub-elements are svg nodes too, but
  // they own a shape rather than the document, and get their own section.
  const isSvgRootSelection =
    nodes.length > 0 &&
    nodes.every((node) => node.type === "svg" && !isSvgElementNode(store, node));
  if (!isSvgRootSelection) return null;

  const fill = style("fill");
  const stroke = style("stroke");
  const strokeWidth = style("strokeWidth");
  const hasPaint = PAINT_KEYS.some((key) => style(key) !== undefined);
  const viewBoxCandidates = nodes.filter(needsViewBox);

  /**
   * Keep each node's injected rule in step with the keys it actually paints.
   * Content is only rewritten when the rule text changes, so recolouring does
   * not churn `innerHTML` and destroy the artwork's DOM identity.
   */
  const syncInheritance = () => {
    const updates = nodes.flatMap((node) => {
      const active = PAINT_KEYS.filter((key) => resolveNodeStyle(node, key) !== undefined);
      const content = withPaintInheritance(node.content, active);
      return content === node.content ? [] : [{ nodeId: node.id, textContent: content }];
    });
    if (updates.length > 0) store.runtime.setTextContent(updates);
  };

  const applyPaint = (patch: StylePatch) => {
    beginEdit();
    setStyles(patch);
    syncInheritance();
    endEdit();
  };

  const removePaint = () => {
    beginEdit();
    removeStyles([...PAINT_KEYS]);
    syncInheritance();
    endEdit();
  };

  const addViewBoxes = () => {
    store.runtime.setTextContent(
      viewBoxCandidates.map((node) => ({
        nodeId: node.id,
        textContent: withDerivedViewBox(node.content),
      })),
    );
  };

  return (
    <Section
      title="SVG"
      trailing={
        hasPaint ? (
          <IconButton onClick={removePaint} title="Remove SVG paint">
            <TrashIcon size={12} />
          </IconButton>
        ) : undefined
      }
    >
      <PropertyRow>
        <div
          style={{
            width: 40,
            flexShrink: 0,
            fontSize: 10,
            color: "var(--leaf-text-muted)",
            fontFamily: FONT_STACK,
          }}
        >
          Fill
        </div>
        <div data-property="fill" style={{ flex: 1, minWidth: 0 }}>
          <ColorField value={fill} onChange={(next) => applyPaint({ fill: next })} {...buffered} />
        </div>
      </PropertyRow>
      <PropertyRow>
        <div
          style={{
            width: 40,
            flexShrink: 0,
            fontSize: 10,
            color: "var(--leaf-text-muted)",
            fontFamily: FONT_STACK,
          }}
        >
          Stroke
        </div>
        <div data-property="stroke" style={{ flex: 1, minWidth: 0 }}>
          <ColorField
            value={stroke}
            onChange={(next) => applyPaint({ stroke: next })}
            {...buffered}
          />
        </div>
        <div data-property="strokeWidth" style={{ width: 62, flexShrink: 0 }}>
          <MixedNumberInput
            affordance="W"
            value={isMixed(strokeWidth) ? strokeWidth : (readPx(strokeWidth) ?? undefined)}
            min={0}
            step={0.5}
            onChange={(next) => applyPaint({ strokeWidth: next })}
            {...buffered}
          />
        </div>
      </PropertyRow>

      {viewBoxCandidates.length > 0 && (
        <button
          type="button"
          data-property="addViewBox"
          onClick={addViewBoxes}
          title="Derive a viewBox from the root width/height so resizing scales the artwork"
          style={{
            width: "100%",
            height: 26,
            marginBottom: 6,
            border: "1px solid #ececec",
            borderRadius: 6,
            backgroundColor: "transparent",
            color: "var(--leaf-text-muted)",
            fontSize: 11,
            fontFamily: FONT_STACK,
          }}
        >
          Add viewBox
        </button>
      )}

      {isMultiple ? (
        <div style={{ fontSize: 10, color: "var(--leaf-text-faint)", fontFamily: FONT_STACK }}>
          Select a single SVG to edit its markup
        </div>
      ) : (
        <div data-property="svgMarkup">
          <Textarea
            value={primary.content}
            onChange={(next) =>
              store.runtime.setTextContent([{ nodeId: primary.id, textContent: next }])
            }
            minHeight={120}
            monospace
            {...buffered}
          />
          {primary.children.length > 0 && (
            <div
              data-property="svgShapeCount"
              style={{
                marginTop: 6,
                fontSize: 10,
                color: "var(--leaf-text-faint)",
                fontFamily: FONT_STACK,
              }}
            >
              {primary.children.length === 1
                ? "1 shape is a child layer"
                : `${primary.children.length} shapes are child layers`}
              {" — select one to edit its fill and stroke."}
            </div>
          )}
        </div>
      )}
    </Section>
  );
});
