type IdleWindow = Window & {
  cancelIdleCallback?: (handle: number) => void;
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
};

export function scheduleIdleWork(callback: () => void, timeout = 1000) {
  const idleWindow = window as IdleWindow;
  if (typeof idleWindow.requestIdleCallback === "function") {
    return idleWindow.requestIdleCallback(callback, { timeout });
  }
  return window.setTimeout(callback, timeout);
}

export function cancelIdleWork(handle: number | null) {
  if (handle === null) return;

  const idleWindow = window as IdleWindow;
  if (typeof idleWindow.cancelIdleCallback === "function") {
    idleWindow.cancelIdleCallback(handle);
    return;
  }

  window.clearTimeout(handle);
}
