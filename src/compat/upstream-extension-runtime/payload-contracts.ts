/**
 * File intent: parse and publish upstream memory tool payload contracts.
 *
 * This module owns the strict `memory_save` payload-target contract and the
 * small parsing helpers used by project-aware search/recall/tunnel wrappers.
 */

import type { UpstreamToolDefinition } from "./types.js";
import {
  MEMORY_RECALL_N_RESULTS_FIELD,
  MEMORY_RECALL_PROJECT_FIELD,
  MEMORY_RECALL_TOPIC_FIELD,
  MEMORY_SAVE_GENERAL_CONTENT_FIELD,
  MEMORY_SAVE_GENERAL_IMPORTANCE_FIELD,
  MEMORY_SAVE_GENERAL_TOPIC_FIELD,
  MEMORY_SAVE_LEGACY_REMOVED_FIELDS,
  MEMORY_SAVE_PAYLOAD_PROMPT_GUIDELINES,
  MEMORY_SAVE_PROJECT_CONTENT_FIELD,
  MEMORY_SAVE_PROJECT_IMPORTANCE_FIELD,
  MEMORY_SAVE_PROJECT_TOPIC_FIELD,
  MEMORY_SEARCH_DEFAULT_N_RESULTS,
  MEMORY_SEARCH_MAX_N_RESULTS,
  MEMORY_SEARCH_N_RESULTS_FIELD,
  MEMORY_SEARCH_PROJECT_FIELD,
  MEMORY_SEARCH_QUERY_FIELD,
  MEMORY_SEARCH_TOPIC_FIELD,
  MEMORY_TUNNEL_N_RESULTS_FIELD,
  MEMORY_TUNNEL_TOPIC_FIELD,
  MEMORY_TUNNEL_USER_A_FIELD,
  MEMORY_TUNNEL_USER_B_FIELD,
} from "./constants.js";

export interface MemorySavePayloadContract {
  projectContent: string | null;
  generalContent: string | null;
  projectTopic: string | null;
  generalTopic: string | null;
  projectImportance: number | null;
  generalImportance: number | null;
  legacyFields: string[];
}

/**
 * Read one string field from unknown object payload.
 */
export const readObjectStringField = (input: unknown, field: string): string | null => {
  if (typeof input !== "object" || input === null) {
    return null;
  }

  const value = (input as Record<string, unknown>)[field];

  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
};

/**
 * Read one finite number field from unknown object payload.
 */
export const readObjectNumberField = (input: unknown, field: string): number | null => {
  if (typeof input !== "object" || input === null) {
    return null;
  }

  const value = (input as Record<string, unknown>)[field];

  return typeof value === "number" && Number.isFinite(value)
    ? value
    : null;
};

/**
 * Check whether unknown object payload contains one field key.
 */
export const hasObjectField = (input: unknown, field: string): boolean => (
  typeof input === "object"
  && input !== null
  && field in (input as Record<string, unknown>)
);

/**
 * Parsed memory_search payload fields used by project/general aggregation path.
 */
export interface MemorySearchPayloadContract {
  query: string | null;
  project: string | null;
  topic: string | null;
  nResults: number;
}

/**
 * Clamp memory_search n_results to upstream-compatible bounds.
 */
export const normalizeMemorySearchResultCount = (value: number | null): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return MEMORY_SEARCH_DEFAULT_N_RESULTS;
  }

  return Math.max(1, Math.min(Math.floor(value), MEMORY_SEARCH_MAX_N_RESULTS));
};

/**
 * Parse memory_search payload fields with safe defaults.
 */
export const readMemorySearchPayloadContract = (toolInput: unknown): MemorySearchPayloadContract => ({
  query: readObjectStringField(toolInput, MEMORY_SEARCH_QUERY_FIELD),
  project: readObjectStringField(toolInput, MEMORY_SEARCH_PROJECT_FIELD),
  topic: readObjectStringField(toolInput, MEMORY_SEARCH_TOPIC_FIELD),
  nResults: normalizeMemorySearchResultCount(readObjectNumberField(toolInput, MEMORY_SEARCH_N_RESULTS_FIELD)),
});

/**
 * Parsed memory_recall payload fields used by project/general aggregation path.
 */
export interface MemoryRecallPayloadContract {
  project: string | null;
  topic: string | null;
  nResults: number;
}

/**
 * Parse memory_recall payload fields with safe defaults.
 */
export const readMemoryRecallPayloadContract = (toolInput: unknown): MemoryRecallPayloadContract => ({
  project: readObjectStringField(toolInput, MEMORY_RECALL_PROJECT_FIELD),
  topic: readObjectStringField(toolInput, MEMORY_RECALL_TOPIC_FIELD),
  nResults: normalizeMemorySearchResultCount(readObjectNumberField(toolInput, MEMORY_RECALL_N_RESULTS_FIELD)),
});

/**
 * Parsed memory_tunnel payload fields interpreted as user endpoints in project mode.
 */
export interface MemoryTunnelPayloadContract {
  topic: string | null;
  userA: string | null;
  userB: string | null;
  nResults: number;
}

/**
 * Parse memory_tunnel payload fields with safe defaults.
 */
export const readMemoryTunnelPayloadContract = (toolInput: unknown): MemoryTunnelPayloadContract => ({
  topic: readObjectStringField(toolInput, MEMORY_TUNNEL_TOPIC_FIELD),
  userA: readObjectStringField(toolInput, MEMORY_TUNNEL_USER_A_FIELD),
  userB: readObjectStringField(toolInput, MEMORY_TUNNEL_USER_B_FIELD),
  nResults: normalizeMemorySearchResultCount(readObjectNumberField(toolInput, MEMORY_TUNNEL_N_RESULTS_FIELD)),
});

/**
 * Parse memory_save payload targets and legacy-field violations.
 */
export const readMemorySavePayloadContract = (toolInput: unknown): MemorySavePayloadContract => ({
  projectContent: readObjectStringField(toolInput, MEMORY_SAVE_PROJECT_CONTENT_FIELD),
  generalContent: readObjectStringField(toolInput, MEMORY_SAVE_GENERAL_CONTENT_FIELD),
  projectTopic: readObjectStringField(toolInput, MEMORY_SAVE_PROJECT_TOPIC_FIELD),
  generalTopic: readObjectStringField(toolInput, MEMORY_SAVE_GENERAL_TOPIC_FIELD),
  projectImportance: readObjectNumberField(toolInput, MEMORY_SAVE_PROJECT_IMPORTANCE_FIELD),
  generalImportance: readObjectNumberField(toolInput, MEMORY_SAVE_GENERAL_IMPORTANCE_FIELD),
  legacyFields: MEMORY_SAVE_LEGACY_REMOVED_FIELDS.filter((fieldName) => hasObjectField(toolInput, fieldName)),
});

/**
 * Ensure prompt guideline list is unique and stable.
 */
export const appendUniquePromptGuidelines = (input: {
  existing: unknown;
  additions: ReadonlyArray<string>;
}): string[] => {
  const merged: string[] = Array.isArray(input.existing)
    ? input.existing.filter((item): item is string => typeof item === "string")
    : [];

  for (const item of input.additions) {
    if (!merged.includes(item)) {
      merged.push(item);
    }
  }

  return merged;
};

/**
 * Extend memory_save contract to strict payload-target routing (development phase).
 */
export const applyMemorySavePayloadContract = (tool: UpstreamToolDefinition): UpstreamToolDefinition => {
  if (tool.name !== "memory_save") {
    return tool;
  }

  const payloadTool: UpstreamToolDefinition = {
    ...tool,
    promptSnippet:
      "memory_save(project_content?, general_content?, project_topic?, general_topic?) — payload-target routed project/general memory save",
    promptGuidelines: appendUniquePromptGuidelines({
      existing: tool.promptGuidelines,
      additions: MEMORY_SAVE_PAYLOAD_PROMPT_GUIDELINES,
    }),
  };

  if (typeof tool.parameters !== "object" || tool.parameters === null) {
    return payloadTool;
  }

  const rawParameters = tool.parameters as Record<string, unknown>;

  if (rawParameters.type !== "object") {
    return payloadTool;
  }

  // Some providers (including OpenAI tools/functions) reject top-level
  // combinators (`anyOf`/`oneOf`/`allOf`/`enum`/`not`) for function params.
  // Keep the schema provider-compatible and enforce target presence at runtime.
  const {
    anyOf: _ignoredAnyOf,
    oneOf: _ignoredOneOf,
    allOf: _ignoredAllOf,
    enum: _ignoredEnum,
    not: _ignoredNot,
    ...providerSafeParameters
  } = rawParameters;

  payloadTool.parameters = {
    ...providerSafeParameters,
    type: "object",
    required: [],
    additionalProperties: false,
    properties: {
      [MEMORY_SAVE_PROJECT_CONTENT_FIELD]: {
        type: "string",
        description: "Project-targeted memory content for the active workspace/member.",
      },
      [MEMORY_SAVE_GENERAL_CONTENT_FIELD]: {
        type: "string",
        description: "Reusable cross-project memory content for the user.",
      },
      [MEMORY_SAVE_PROJECT_TOPIC_FIELD]: {
        type: "string",
        description: "Optional topic for project_content.",
      },
      [MEMORY_SAVE_GENERAL_TOPIC_FIELD]: {
        type: "string",
        description: "Optional topic for general_content.",
      },
      [MEMORY_SAVE_PROJECT_IMPORTANCE_FIELD]: {
        type: "number",
        description: "Optional future-compat importance hint for project_content route.",
      },
      [MEMORY_SAVE_GENERAL_IMPORTANCE_FIELD]: {
        type: "number",
        description: "Optional future-compat importance hint for general_content route.",
      },
    },
  };

  return payloadTool;
};
