/**
 * Compatibility facade for normalized collaboration persistence.
 *
 * Runtime code should continue importing this module; the contracts, transactional
 * core, and browser storage adapter are isolated behind it.
 */

export * from "./collaboration-persistence-contracts";
export * from "./collaboration-persistence-core";
export * from "./collaboration-persistence-indexeddb";
