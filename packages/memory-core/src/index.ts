/**
 * File intent: expose the host-neutral memory-core public surface.
 *
 * Keep this package free of host lifecycle adapters. Pi/OpenCode/KiloCode host
 * packages should import memory-core, provide concrete data/provider adapters,
 * and bind host events/tools around these APIs.
 */

export * from "./contracts.js";
export * from "./ports.js";
export * from "./continuity/index.js";
export * from "./project-memory/index.js";
export * from "./global-memory/index.js";
export * from "./memory-routing/index.js";
export * from "./prompt-briefing/index.js";
export * from "./project-index/index.js";
export * from "./memory-core.js";
