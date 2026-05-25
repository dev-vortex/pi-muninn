/**
 * File intent: standard text tool-result helpers for upstream compatibility.
 *
 * The upstream wrappers use this shape consistently so behavior tests can assert
 * text and details without depending on vendored helper internals.
 */

import type { BundledUpstreamRuntimeModeStatus } from "./types.js";

export const buildTextToolResult = (input: {
  text: string;
  details?: Record<string, unknown>;
}): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown> | null;
} => ({
  content: [{ type: "text", text: input.text }],
  details: input.details || null,
});

export type TextToolResult = ReturnType<typeof buildTextToolResult>;

export const readTextToolResultStatus = (result: TextToolResult): string | null => {
  if (typeof result.details !== "object" || result.details === null) {
    return null;
  }

  const status = (result.details as Record<string, unknown>).status;

  return typeof status === "string" ? status : null;
};

/**
 * Build fail-closed result for manual global-write tools when curation is active.
 */
export const buildProjectCurationBlockedToolResult = (input: {
  toolName: string;
  mode: BundledUpstreamRuntimeModeStatus;
  explanation?: string;
  details?: Record<string, unknown>;
}) => buildTextToolResult({
  text:
    `Tool '${input.toolName}' is blocked while project curation is active ` +
    `(mode=${input.mode.mode}; reason=${input.mode.reason}). ` +
    (input.explanation
      || "Use '/memory project ...' flows and promotion commands for curated global persistence."),
  details: {
    status: "blocked-project-curation",
    tool: input.toolName,
    mode: input.mode.mode,
    reason: input.mode.reason,
    ...(input.details || {}),
  },
});

/**
 * Execute internal memory_save_L1 route (project-target payload).
 *
 * Decision:
 * - keep project-curation mode fail-closed for global writes,
 * - allow explicit project payload writes through vendored MemoryStore only,
 * - avoid custom fallback inserts so L1 write semantics stay upstream-owned.
 */

export const readUnknownToolResultStatus = (result: unknown): string | null => {
  if (typeof result !== "object" || result === null) {
    return null;
  }

  const details = (result as { details?: unknown }).details;

  if (typeof details !== "object" || details === null) {
    return null;
  }

  const status = (details as Record<string, unknown>).status;

  return typeof status === "string" ? status : null;
};

/**
 * Read one numeric field from unknown tool-result details object.
 */
export const readUnknownToolResultDetailsNumber = (input: {
  result: unknown;
  field: string;
}): number | null => {
  if (typeof input.result !== "object" || input.result === null) {
    return null;
  }

  const details = (input.result as { details?: unknown }).details;
  if (typeof details !== "object" || details === null) {
    return null;
  }

  const value = (details as Record<string, unknown>)[input.field];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : null;
};

/**
 * Read plain text payload from unknown tool result.
 */
export const readUnknownToolResultText = (result: unknown): string | null => {
  if (typeof result !== "object" || result === null) {
    return null;
  }

  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return null;
  }

  const textBlocks = content
    .filter((block): block is { type: "text"; text: string } => (
      typeof block === "object"
      && block !== null
      && (block as { type?: unknown }).type === "text"
      && typeof (block as { text?: unknown }).text === "string"
    ))
    .map((block) => block.text.trim())
    .filter((text) => text.length > 0);

  if (textBlocks.length === 0) {
    return null;
  }

  return textBlocks.join("\n\n");
};
