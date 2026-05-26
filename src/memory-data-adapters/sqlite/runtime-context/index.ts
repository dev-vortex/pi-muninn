/**
 * File intent: export SQLite-backed runtime-context adapter internals.
 *
 * These modules compose context from SQLite project-memory, global memory, and
 * continuity stores. Host packages should prefer higher-level memory-core APIs
 * unless they explicitly need this legacy compatibility surface.
 */

export * from "./assembly.js";
