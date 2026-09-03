import { observer } from "mobx-react-lite";
import { TrashIcon } from "../../icons";
import {
  ColorField,
  IconButton,
  MixedNumberInput,
  MixedSelect,
  PropertyGrid,
  PropertyRow,
  Section,
} from "../PropertyControls";
import { aggregate, isMixed, resolveNodeStyle } from "../selection-properties";
import { parseOutlineShorthand } from "./OutlineSection";
import { isBoxLike, type SectionProps } from "./types";

const BORDER_STYLES = [
  { label: "Solid", value: "solid" },
  { label: "Dashed", value: "dashed" },
  { label: "Dotted", value: "dotted" },
  { label: "Double", value: "double" },
  { label: "Groove", value: "groove" },
  { label: "Ridge", value: "ridge" },
  { label: "Inset", value: "inset" },
  { label: "Outset", value: "outset" },
];

/**
 * Border width / colour / style.
 *
 * These already round-trip through the model and the renderer paints them; the
 * gap this closes is purely that a human had no way to reach them.
 */
export const BorderSection = observer(({ props }: SectionProps) => {
  const { nodes, style, setStyles, removeStyles, buffered } = props;
  if (!isBoxLike(nodes)) return null;

  // An imported node almost never carries a uniform `borderWidth`. Authored
  // markup uses the `border` shorthand, and CSSOM expands that into per-side
  // longhands on the way in. Reading only the uniform key shows an empty
  // Border section over a node that visibly has one, so fall through:
  // uniform -> shorthand -> per-side (top as representative).
  const readBorderPart = (
    longhand: "borderWidth" | "borderColor" | "borderStyle",
    part: "width" | "color" | "style",
    sideKey: "borderTopWidth" | "borderTopColor" | "borderTopStyle",
  ) => {
    const direct = style(longhand);
    if (direct !== undefined) return direct;
    return aggregate(nodes, (node) => {
      const shorthand = resolveNodeStyle(node, "border");
      if (shorthand !== undefined) return parseOutlineShorthand(shorthand)[part];
      return resolveNodeStyle(node, sideKey);
    });
  };

  const width = readBorderPart("borderWidth", "width", "borderTopWidth");
  // Side longhands arrive as CSS lengths ("1px"), not bare numbers.
  const widthPx = isMixed(width) ? width : width === undefined ? 0 : parseFloat(String(width)) || 0;
  const color = readBorderPart("borderColor", "color", "borderTopColor");
  const borderStyle = readBorderPart("borderStyle", "style", "borderTopStyle");
  const hasBorder =
    (!isMixed(widthPx) && widthPx > 0) ||
    isMixed(width) ||
    (!isMixed(color) && color !== undefined);

  return (
    <Section
      title="Border"
      trailing={
        hasBorder ? (
          <IconButton
            onClick={() => removeStyles(["border", "borderWidth", "borderColor", "borderStyle"])}
            title="Remove border"
          >
            <TrashIcon size={12} />
          </IconButton>
        ) : undefined
      }
    >
      <PropertyGrid>
        <MixedNumberInput
          affordance="W"
          value={widthPx}
          min={0}
          onChange={(next) =>
            // A width with no style renders nothing, so establish `solid` the
            // first time a user gives the border a width.
            setStyles(
              isMixed(borderStyle) || borderStyle !== undefined
                ? { borderWidth: next }
                : { borderWidth: next, borderStyle: "solid" },
            )
          }
          {...buffered}
        />
        <MixedSelect
          value={borderStyle ?? "solid"}
          onChange={(next) => setStyles({ borderStyle: next })}
          options={BORDER_STYLES}
          {...buffered}
        />
      </PropertyGrid>
      <PropertyRow>
        <ColorField
          value={color}
          onChange={(next) => setStyles({ borderColor: next })}
          {...buffered}
        />
      </PropertyRow>
    </Section>
  );
});
