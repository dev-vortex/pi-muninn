/**
 * File intent: export pi-mempalace-compatible project-memory adapter internals.
 *
 * These modules own compatibility helpers for the vendor-compatible project-user
 * memory DB shape. Host packages should prefer higher-level memory-core APIs
 * unless they explicitly need these low-level compatibility surfaces.
 */

export * from "./user-memory-ingest.js";
