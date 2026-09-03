import { observer } from "mobx-react-lite";
import { EyeIcon, EyeOffIcon, TrashIcon } from "../../icons";
import {
  ColorField,
  IconButton,
  MixedNumberInput,
  PropertyRow,
  Section,
} from "../PropertyControls";
import { isMixed, type MaybeMixed } from "../selection-properties";
import { useEditorStore } from "../../../core/state/EditorStore";
import type { EditorStore } from "../../../core/state/EditorStore";
import { SVG_PAINT_KEYS } from "../../../core/editor/svg-decomposition";
import type { DesignNode } from "../../../core/types";
import { FONT_STACK } from "../../floating-styles";
import type { SectionProps } from "./types";

/**
 * A node produced by decomposing an `<svg>` — a path, shape, or group that the
 * parent SVG node composes back into its markup.
 *
 * Identity comes from the tree rather than a marker on the node: an svg node
 * whose parent is an svg node is a sub-element by construction, and nothing can
 * write that relationship out of sync.
 */
export function isSvgElementNode(store: EditorStore, node: DesignNode): boolean {
  return node.type === "svg" && store.getParent(node.id)?.type === "svg";
}

export function isSvgElementSelection(store: EditorStore, nodes: readonly DesignNode[]): boolean {
  return nodes.length > 0 && nodes.every((node) => isSvgElementNode(store, node));
}

function plainPx(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const trimmed = value.trim();
  return /^-?\d*\.?\d+(px)?$/i.test(trimmed) ? Number.parseFloat(trimmed) : null;
}

function readPx(value: MaybeMixed<string | number | undefined>): number | null {
  return isMixed(value) ? null : plainPx(value);
}

const LABEL_STYLE = {
  width: 40,
  flexShrink: 0,
  fontSize: 10,
  color: "var(--leaf-text-muted)",
  fontFamily: FONT_STACK,
} as const;

/**
 * Paint for one shape inside an SVG: its fill and stroke.
 *
 * The values live in the node's styles map, which is where import hoists the
 * element's `fill`/`stroke`/`stroke-width` presentation attributes to, so a
 * shape an agent wrote reads back here exactly as it paints.
 */
export const SvgFillStrokeSection = observer(({ props }: SectionProps) => {
  const { nodes, style, setStyles, removeStyles, updateNodes, beginEdit, endEdit, buffered } =
    props;
  const store = useEditorStore();
  if (!isSvgElementSelection(store, nodes)) return null;

  const fill = style("fill");
  const stroke = style("stroke");
  const strokeWidth = style("strokeWidth");
  const hasPaint = SVG_PAINT_KEYS.some((key) => style(key) !== undefined);
  const allVisible = nodes.every((node) => node.visible !== false);

  const applyPaint = (patch: Record<string, string | number>) => {
    beginEdit();
    setStyles(patch);
    endEdit();
  };

  return (
    <Section
      title="Shape"
      trailing={
        <>
          <IconButton
            onClick={() => updateNodes({ visible: !allVisible })}
            title={allVisible ? "Hide shape" : "Show shape"}
          >
            {allVisible ? <EyeIcon size={12} /> : <EyeOffIcon size={12} />}
          </IconButton>
          {hasPaint ? (
            <IconButton
              onClick={() => removeStyles([...SVG_PAINT_KEYS])}
              title="Remove shape paint"
            >
              <TrashIcon size={12} />
            </IconButton>
          ) : null}
        </>
      }
    >
      <PropertyRow>
        <div style={LABEL_STYLE}>Fill</div>
        <div data-property="svgElementFill" style={{ flex: 1, minWidth: 0 }}>
          <ColorField value={fill} onChange={(next) => applyPaint({ fill: next })} {...buffered} />
        </div>
      </PropertyRow>
      <PropertyRow>
        <div style={LABEL_STYLE}>Stroke</div>
        <div data-property="svgElementStroke" style={{ flex: 1, minWidth: 0 }}>
          <ColorField
            value={stroke}
            onChange={(next) => applyPaint({ stroke: next })}
            {...buffered}
          />
        </div>
        <div data-property="svgElementStrokeWidth" style={{ width: 62, flexShrink: 0 }}>
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
    </Section>
  );
});
