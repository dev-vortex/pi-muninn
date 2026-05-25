/**
 * File intent: export the pi-mempalace-compatible memory adapter.
 *
 * This adapter is a memory-core-owned convenience wrapper around a compatible
 * backend contract. It keeps vendor-shaped memory behavior replaceable while
 * preventing host lifecycle concerns from entering memory-core.
 */

export * from "./memory-store-adapter.js";
export * from "./project-memory/index.js";
