/**
 * File intent: export SQLite data-adapter implementations owned by memory-core.
 *
 * These adapters bind memory-core ports to the current SQLite-backed continuity,
 * project-index, telemetry, config, and related data paths. Concrete SQLite
 * engine helpers live under `common/` so memory-core never imports root `src/*`.
 */

export * from "./common/index.js";
export * from "./continuity/index.js";
export * from "./project-index/index.js";
export * from "./project-memory/index.js";
export * from "./runtime-context/index.js";
export * from "./runtime/index.js";
export * from "./continuity-data-adapter.js";
export * from "./continuity-telemetry-adapter.js";
export * from "./project-index-data-adapter.js";
