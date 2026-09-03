import { Slider as BaseSlider } from "@base-ui/react/slider";
import type { ComponentProps } from "react";
import { cx } from "./cx";

export type SliderProps = Omit<ComponentProps<typeof BaseSlider.Root>, "className"> & {
  className?: string;
};

export function Slider({ className, ...props }: SliderProps) {
  return (
    <BaseSlider.Root {...props} className={cx("leaf-slider", className)}>
      <BaseSlider.Control className="leaf-slider-control">
        <BaseSlider.Track className="leaf-slider-track">
          <BaseSlider.Indicator className="leaf-slider-indicator" />
          <BaseSlider.Thumb className="leaf-slider-thumb" />
        </BaseSlider.Track>
      </BaseSlider.Control>
    </BaseSlider.Root>
  );
}
