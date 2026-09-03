import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { cx } from "./cx";

export type TooltipProps = {
  /** Tooltip text. When empty, the child renders without a tooltip. */
  content: ReactNode;
  /** The interactive element the tooltip describes. */
  children: ReactElement;
  side?: ComponentProps<typeof BaseTooltip.Positioner>["side"];
  className?: string;
};

export function Tooltip({ content, children, side = "top", className }: TooltipProps) {
  if (
    content == null ||
    typeof content === "boolean" ||
    (typeof content === "string" && content.trim() === "")
  ) {
    return children;
  }
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={6} className="leaf-positioner">
          <BaseTooltip.Popup className={cx("leaf-tooltip", className)}>{content}</BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
