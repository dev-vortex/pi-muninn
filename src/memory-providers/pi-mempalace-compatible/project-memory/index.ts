/**
 * File intent: export root-owned pi-mempalace-compatible project-memory internals.
 *
 * These modules own compatibility helpers for the vendor-compatible project-user
 * memory DB shape. Host code should prefer higher-level memory-core APIs unless
 * it explicitly needs these low-level compatibility surfaces.
 */

export * from "./user-memory-ingest.js";
