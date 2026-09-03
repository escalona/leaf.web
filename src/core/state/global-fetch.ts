/**
 * Calls the current global fetch with its platform receiver intact.
 *
 * Browser and worker implementations may reject a detached `fetch` function
 * with "Illegal invocation", so production defaults should use this wrapper
 * instead of storing the bare global function.
 */
export const fetchWithGlobalReceiver: typeof fetch = (input, init) => globalThis.fetch(input, init);
