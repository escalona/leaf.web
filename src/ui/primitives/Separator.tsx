import { Separator as BaseSeparator } from "@base-ui/react/separator";
import type { ComponentProps } from "react";
import { cx } from "./cx";

export type SeparatorProps = Omit<ComponentProps<typeof BaseSeparator>, "className"> & {
  className?: string;
};

export function Separator({ className, ...props }: SeparatorProps) {
  return <BaseSeparator {...props} className={cx("leaf-separator", className)} />;
}
