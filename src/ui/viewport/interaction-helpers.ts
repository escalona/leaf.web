/**
 * Compatibility barrel for viewport interaction helpers.
 *
 * Keep existing imports stable while the implementation lives in domain
 * modules with one-way dependencies.
 */
export * from "./direct-manipulation";
export * from "./drop-targets";
export * from "./selection-targets";
