import { Toggle as BaseToggle } from "@base-ui/react/toggle";
import type { ComponentProps } from "react";
import type { ButtonSize } from "./Button";
import { cx } from "./cx";

export type ToggleButtonProps = Omit<ComponentProps<typeof BaseToggle>, "className"> & {
  size?: ButtonSize;
  className?: string;
  "aria-label": string;
};

/** Icon toggle for tool/mode buttons. Pressed state renders ink-on-white inverted. */
export function ToggleButton({ size = "md", className, ...props }: ToggleButtonProps) {
  return (
    <BaseToggle
      {...props}
      className={cx(
        "leaf-button",
        "leaf-icon-button",
        `leaf-button-${size}`,
        "leaf-toggle",
        className,
      )}
    />
  );
}
