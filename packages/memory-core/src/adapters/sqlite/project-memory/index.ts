/**
 * File intent: export SQLite-backed project-memory adapter internals.
 *
 * These modules own concrete project-memory retrieval over SQLite user DBs and
 * sqlite-vec. Host packages should prefer higher-level memory-core APIs unless
 * they explicitly need these low-level compatibility surfaces.
 */

export * from "./mode-selection.js";
export * from "./hybrid-retrieval.js";
export * from "./semantic-search-provider.js";
export * from "./memory-briefing-types.js";
export * from "./memory-briefing-utils.js";
export * from "./memory-briefing.js";
export * from "./related-user-memory-briefing.js";
export * from "./local-model-curation-gate.js";
export * from "./promotion-pipeline.js";
