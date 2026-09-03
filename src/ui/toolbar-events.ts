export const OPEN_IMAGE_GENERATION_DIALOG_EVENT = "leaf:open-image-generation-dialog";
export const TOGGLE_SHADER_PICKER_EVENT = "leaf:toggle-shader-picker";

export function dispatchOpenImageGenerationDialogEvent() {
  window.dispatchEvent(new Event(OPEN_IMAGE_GENERATION_DIALOG_EVENT));
}

/**
 * The shader picker's open state lives inside the toolbar, so the keyboard
 * shortcut reaches it the same way the image dialog does: through the window
 * rather than through a store field only the toolbar would ever read.
 */
export function dispatchToggleShaderPickerEvent() {
  window.dispatchEvent(new Event(TOGGLE_SHADER_PICKER_EVENT));
}
