import { Menu as BaseMenu } from "@base-ui/react/menu";
import type { ComponentProps, ElementType } from "react";
import { cx } from "./cx";

type StyledProps<Part extends ElementType> = Omit<ComponentProps<Part>, "className"> & {
  className?: string;
};

function MenuPositioner({
  className,
  sideOffset = 4,
  ...props
}: StyledProps<typeof BaseMenu.Positioner>) {
  return (
    <BaseMenu.Positioner
      sideOffset={sideOffset}
      {...props}
      className={cx("leaf-positioner", className)}
    />
  );
}

function MenuPopup({ className, ...props }: StyledProps<typeof BaseMenu.Popup>) {
  return <BaseMenu.Popup {...props} className={cx("leaf-popup", "leaf-menu-popup", className)} />;
}

function MenuItem({
  className,
  danger = false,
  ...props
}: StyledProps<typeof BaseMenu.Item> & { danger?: boolean }) {
  return (
    <BaseMenu.Item
      {...props}
      className={cx("leaf-menu-item", danger && "leaf-menu-item-danger", className)}
    />
  );
}

function MenuSubmenuTrigger({ className, ...props }: StyledProps<typeof BaseMenu.SubmenuTrigger>) {
  return (
    <BaseMenu.SubmenuTrigger
      {...props}
      className={cx("leaf-menu-item", "leaf-menu-submenu-trigger", className)}
    />
  );
}

function MenuSeparator({ className, ...props }: StyledProps<typeof BaseMenu.Separator>) {
  return <BaseMenu.Separator {...props} className={cx("leaf-separator", className)} />;
}

/** Styled Base UI menu. Composition mirrors Base UI parts; visual defaults live here. */
export const Menu = {
  Root: BaseMenu.Root,
  Trigger: BaseMenu.Trigger,
  Portal: BaseMenu.Portal,
  Positioner: MenuPositioner,
  Popup: MenuPopup,
  Item: MenuItem,
  SubmenuRoot: BaseMenu.SubmenuRoot,
  SubmenuTrigger: MenuSubmenuTrigger,
  Separator: MenuSeparator,
};
