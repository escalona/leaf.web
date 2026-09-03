/**
 * Largest single image asset a document may carry. Shared by the renderer's
 * asset store and by native `.leaf` archives, which enforce the same bound on
 * every entry they read or write.
 */
export const MAX_NATIVE_DOCUMENT_ASSET_BYTES = 64 * 1024 * 1024;
