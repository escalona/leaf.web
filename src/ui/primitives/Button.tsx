import { Button as BaseButton } from "@base-ui/react/button";
import type { ComponentPropsWithRef } from "react";
import { cx } from "./cx";

export type ButtonVariant = "primary" | "ink" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

type NativeButtonProps = Omit<ComponentPropsWithRef<"button">, "className">;

export type ButtonProps = NativeButtonProps & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
};

export function Button({ variant = "secondary", size = "md", className, ...props }: ButtonProps) {
  return (
    <BaseButton
      {...props}
      className={cx("leaf-button", `leaf-button-${variant}`, `leaf-button-${size}`, className)}
    />
  );
}

export type IconButtonProps = ButtonProps & { "aria-label": string };

export function IconButton({ className, ...props }: IconButtonProps) {
  return <Button {...props} className={cx("leaf-icon-button", className)} />;
}
