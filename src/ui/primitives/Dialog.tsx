import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type { ComponentProps, ComponentPropsWithRef, ElementType } from "react";
import { cx } from "./cx";

type StyledProps<Part extends ElementType> = Omit<ComponentProps<Part>, "className"> & {
  className?: string;
};

function DialogBackdrop({ className, ...props }: StyledProps<typeof BaseDialog.Backdrop>) {
  return <BaseDialog.Backdrop {...props} className={cx("leaf-dialog-backdrop", className)} />;
}

function DialogPopup({ className, ...props }: StyledProps<typeof BaseDialog.Popup>) {
  return <BaseDialog.Popup {...props} className={cx("leaf-dialog-popup", className)} />;
}

function DialogTitle({ className, ...props }: StyledProps<typeof BaseDialog.Title>) {
  return <BaseDialog.Title {...props} className={cx("leaf-dialog-title", className)} />;
}

function DialogDescription({ className, ...props }: StyledProps<typeof BaseDialog.Description>) {
  return <BaseDialog.Description {...props} className={cx("leaf-dialog-description", className)} />;
}

function DialogActions({ className, ...props }: ComponentPropsWithRef<"div">) {
  return <div {...props} className={cx("leaf-dialog-actions", className)} />;
}

/** Styled Base UI dialog. Compose Backdrop + Popup inside Portal; Actions rows the footer buttons. */
export const Dialog = {
  Root: BaseDialog.Root,
  Trigger: BaseDialog.Trigger,
  Portal: BaseDialog.Portal,
  Backdrop: DialogBackdrop,
  Popup: DialogPopup,
  Title: DialogTitle,
  Description: DialogDescription,
  Actions: DialogActions,
  Close: BaseDialog.Close,
};
