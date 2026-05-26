/**
 * File intent: export SQLite-backed continuity adapter internals.
 *
 * These modules own concrete continuity SQL, vector, and database-path based
 * helper behavior. Host packages should prefer higher-level root adapter
 * factories unless they explicitly need the low-level compatibility surface.
 */

export * from "./continuity-store.js";
export * from "./continuity-vector-store.js";
export * from "./continuity-vector-embedder.js";
export * from "./continuity-startup-summary.js";
export * from "./continuity-briefing.js";
