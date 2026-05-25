/**
 * File intent: define host-neutral project-memory contracts owned by memory-core.
 *
 * Keep root/Pi package configuration and identity persistence types out of this
 * file. Host packages may store these values in their own config, but the shared
 * meaning of retrieval and briefing modes belongs in memory-core.
 */

/**
 * Project-memory retrieval strategy used when project memory mode is enabled.
 */
export type ProjectMemoryMode = "fanout" | "index-first";

/**
 * Selection strategy used for once-per-prompt continuity briefing retrieval.
 * Host defaults should prefer `semantic`; `lexical` is retained as a fallback/control mode.
 */
export type ContinuityBriefingMode = "lexical" | "semantic";
