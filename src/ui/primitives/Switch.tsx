import { Switch as BaseSwitch } from "@base-ui/react/switch";
import type { ComponentProps } from "react";
import { cx } from "./cx";

export type SwitchProps = Omit<ComponentProps<typeof BaseSwitch.Root>, "className"> & {
  className?: string;
};

export function Switch({ className, ...props }: SwitchProps) {
  return (
    <BaseSwitch.Root {...props} className={cx("leaf-switch", className)}>
      <BaseSwitch.Thumb className="leaf-switch-thumb" />
    </BaseSwitch.Root>
  );
}
