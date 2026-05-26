/**
 * File intent: export root-owned SQLite data-adapter implementations.
 *
 * These adapters bind memory-core ports to the current SQLite-backed continuity,
 * project-index, telemetry, config, and related data paths. Concrete SQLite
 * engine helpers live under `common/` so memory-core depends only on ports.
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
