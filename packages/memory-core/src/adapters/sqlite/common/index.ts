/**
 * File intent: export shared SQLite engine helpers for memory-core adapters.
 *
 * This is still a concrete better-sqlite3 boundary, not a generic database
 * abstraction. Domain portability belongs in memory-core ports above it.
 */

export * from "./better-sqlite3-adapter.js";
