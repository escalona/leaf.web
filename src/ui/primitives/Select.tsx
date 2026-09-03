import { Select as BaseSelect } from "@base-ui/react/select";
import { CheckIcon, ChevronDownIcon } from "../icons";
import type { ReactNode } from "react";
import type { ButtonSize } from "./Button";
import { cx } from "./cx";

export type SelectOption<Value extends string = string> = {
  value: Value;
  label: ReactNode;
  disabled?: boolean;
};

export type SelectProps<Value extends string = string> = {
  value: Value | null;
  onValueChange: (value: Value) => void;
  options: ReadonlyArray<SelectOption<Value>>;
  placeholder?: ReactNode;
  size?: ButtonSize;
  disabled?: boolean;
  className?: string;
};

export function Select<Value extends string = string>({
  value,
  onValueChange,
  options,
  placeholder,
  size = "md",
  disabled = false,
  className,
}: SelectProps<Value>) {
  return (
    <BaseSelect.Root<Value>
      items={options}
      value={value}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
      disabled={disabled}
    >
      <BaseSelect.Trigger
        className={cx(
          "leaf-button",
          "leaf-button-secondary",
          `leaf-button-${size}`,
          "leaf-select-trigger",
          className,
        )}
      >
        <BaseSelect.Value placeholder={placeholder} />
        <BaseSelect.Icon className="leaf-select-icon">
          <ChevronDownIcon size={12} />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner className="leaf-positioner" sideOffset={4}>
          <BaseSelect.Popup className="leaf-popup">
            {options.map((option) => (
              <BaseSelect.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className="leaf-menu-item leaf-select-item"
              >
                <BaseSelect.ItemText>{option.label}</BaseSelect.ItemText>
                <BaseSelect.ItemIndicator className="leaf-select-item-indicator">
                  <CheckIcon size={12} />
                </BaseSelect.ItemIndicator>
              </BaseSelect.Item>
            ))}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
