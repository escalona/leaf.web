export type KeyboardShortcutEventType = "keydown" | "keyup";

export type KeyboardShortcutModifierRequirement = boolean | "any";

export type KeyboardShortcutCombo = {
  key?: string;
  code?: string;
  accel?: boolean;
  alt?: KeyboardShortcutModifierRequirement;
  ctrl?: KeyboardShortcutModifierRequirement;
  meta?: KeyboardShortcutModifierRequirement;
  shift?: KeyboardShortcutModifierRequirement;
};

export type KeyboardShortcutContextPredicate<Context> = (
  context: Context,
  event: KeyboardEvent,
) => boolean;

export type KeyboardShortcutHandler<Context> = (context: Context, event: KeyboardEvent) => void;

export type KeyboardShortcut<Context> = {
  id: string;
  combos: KeyboardShortcutCombo | KeyboardShortcutCombo[];
  description?: string;
  eventType?: KeyboardShortcutEventType;
  allowInEditable?: boolean;
  preventDefault?: boolean;
  stopPropagation?: boolean;
  when?: KeyboardShortcutContextPredicate<Context>;
  handler: KeyboardShortcutHandler<Context>;
};

export type DispatchKeyboardShortcutsOptions<Context> = {
  event: KeyboardEvent;
  eventType: KeyboardShortcutEventType;
  shortcuts: readonly KeyboardShortcut<Context>[];
  context: Context;
  isEditableTarget?: (target: EventTarget | null) => boolean;
};

export type DispatchKeyboardShortcutsResult = {
  handled: boolean;
  shortcutId: string | null;
};

export function defineKeyboardShortcuts<Context>(
  shortcuts: readonly KeyboardShortcut<Context>[],
): readonly KeyboardShortcut<Context>[] {
  return shortcuts;
}

export function dispatchKeyboardShortcuts<Context>({
  event,
  eventType,
  shortcuts,
  context,
  isEditableTarget = isEventTargetEditable,
}: DispatchKeyboardShortcutsOptions<Context>): DispatchKeyboardShortcutsResult {
  const isEditable = isEditableTarget(event.target);

  for (const shortcut of shortcuts) {
    if ((shortcut.eventType ?? "keydown") !== eventType) continue;
    if (isEditable && !shortcut.allowInEditable) continue;
    if (shortcut.when && !shortcut.when(context, event)) continue;

    const combos = Array.isArray(shortcut.combos) ? shortcut.combos : [shortcut.combos];
    if (!combos.some((combo) => matchesKeyboardShortcut(event, combo))) continue;

    if (shortcut.preventDefault) {
      event.preventDefault();
    }
    if (shortcut.stopPropagation) {
      event.stopPropagation();
    }

    shortcut.handler(context, event);
    return { handled: true, shortcutId: shortcut.id };
  }

  return { handled: false, shortcutId: null };
}

export function matchesKeyboardShortcut(
  event: KeyboardEvent,
  combo: KeyboardShortcutCombo,
): boolean {
  if (!combo.key && !combo.code) return false;

  if (combo.key && normalizeKey(event.key) !== normalizeKey(combo.key)) return false;
  if (combo.code && event.code !== combo.code) return false;

  if (combo.accel) {
    if (!event.metaKey && !event.ctrlKey) return false;
  } else {
    if (!matchesModifier(event.metaKey, combo.meta ?? false)) return false;
    if (!matchesModifier(event.ctrlKey, combo.ctrl ?? false)) return false;
  }

  if (combo.accel && combo.meta !== undefined && !matchesModifier(event.metaKey, combo.meta)) {
    return false;
  }
  if (combo.accel && combo.ctrl !== undefined && !matchesModifier(event.ctrlKey, combo.ctrl)) {
    return false;
  }

  if (!matchesModifier(event.altKey, combo.alt ?? false)) return false;
  if (!matchesModifier(event.shiftKey, combo.shift ?? false)) return false;

  return true;
}

export function isEventTargetEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable ||
    target.getAttribute("contenteditable") === "true" ||
    target.closest('[contenteditable="true"]') !== null
  );
}

function matchesModifier(
  actual: boolean,
  requirement: KeyboardShortcutModifierRequirement,
): boolean {
  return requirement === "any" ? true : actual === requirement;
}

function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}
