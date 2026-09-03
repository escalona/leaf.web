import { Popover as BasePopover } from "@base-ui/react/popover";
import type { ComponentProps, ElementType } from "react";
import { cx } from "./cx";

type StyledProps<Part extends ElementType> = Omit<ComponentProps<Part>, "className"> & {
  className?: string;
};

function PopoverPositioner({
  className,
  sideOffset = 6,
  ...props
}: StyledProps<typeof BasePopover.Positioner>) {
  return (
    <BasePopover.Positioner
      sideOffset={sideOffset}
      {...props}
      className={cx("leaf-positioner", className)}
    />
  );
}

function PopoverPopup({ className, ...props }: StyledProps<typeof BasePopover.Popup>) {
  return (
    <BasePopover.Popup {...props} className={cx("leaf-popup", "leaf-popover-popup", className)} />
  );
}

function PopoverTitle({ className, ...props }: StyledProps<typeof BasePopover.Title>) {
  return <BasePopover.Title {...props} className={cx("leaf-popover-title", className)} />;
}

function PopoverDescription({ className, ...props }: StyledProps<typeof BasePopover.Description>) {
  return (
    <BasePopover.Description {...props} className={cx("leaf-popover-description", className)} />
  );
}

/** Styled Base UI popover for lightweight floating panels anchored to editor chrome. */
export const Popover = {
  Root: BasePopover.Root,
  Trigger: BasePopover.Trigger,
  Portal: BasePopover.Portal,
  Positioner: PopoverPositioner,
  Popup: PopoverPopup,
  Title: PopoverTitle,
  Description: PopoverDescription,
  Close: BasePopover.Close,
};
