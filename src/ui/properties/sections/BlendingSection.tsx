import { observer } from "mobx-react-lite";
import { MixedNumberInput, MixedSelect, PropertyGrid, Section } from "../PropertyControls";
import { isMixed } from "../selection-properties";
import type { SectionProps } from "./types";

/** The full CSS blend-mode set. */
const BLEND_MODES = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
  "plus-lighter",
].map((mode) => ({
  label: mode.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
  value: mode,
}));

/** Opacity and mix-blend-mode. */
export const BlendingSection = observer(({ props }: SectionProps) => {
  const { style, setStyles, buffered } = props;

  const opacity = style("opacity");
  const opacityPercent = isMixed(opacity)
    ? opacity
    : Math.round((opacity === undefined ? 1 : Number(opacity)) * 100);

  return (
    <Section title="Blending">
      <PropertyGrid>
        <MixedNumberInput
          affordance="%"
          value={opacityPercent}
          min={0}
          max={100}
          onChange={(next) => setStyles({ opacity: next / 100 })}
          {...buffered}
        />
        <MixedSelect
          value={style("mixBlendMode") ?? "normal"}
          onChange={(next) => setStyles({ mixBlendMode: next === "normal" ? null : next })}
          options={BLEND_MODES}
          {...buffered}
        />
      </PropertyGrid>
    </Section>
  );
});
