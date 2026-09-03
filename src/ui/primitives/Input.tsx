import { Input as BaseInput } from "@base-ui/react/input";
import type { ComponentPropsWithRef } from "react";
import { cx } from "./cx";

export type InputProps = Omit<ComponentPropsWithRef<"input">, "className"> & {
  className?: string;
};

export function Input({ className, ...props }: InputProps) {
  return <BaseInput {...props} className={cx("leaf-input", className)} />;
}
