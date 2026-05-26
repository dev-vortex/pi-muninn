/**
 * File intent: export SQLite-backed project-index adapter internals.
 *
 * These modules own concrete project-index fan-out and cache DB behavior. Host
 * packages should prefer higher-level root adapter factories unless they
 * explicitly need the low-level compatibility surface.
 */

export * from "./fanout-retrieval.js";
export * from "./project-index.js";
