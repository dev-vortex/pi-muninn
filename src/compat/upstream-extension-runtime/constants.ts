/**
 * File intent: constants used by bundled upstream compatibility routing.
 *
 * Keep tool names, lifecycle events, payload fields, and result limits centralized
 * so proxy and route modules cannot silently drift from each other.
 */

export const BUNDLED_UPSTREAM_GATED_EVENTS = new Set<string>([
  "turn_end",
  "before_agent_start",
]);

export const BUNDLED_UPSTREAM_NATIVE_HEALTH_CHECK_DISABLED_ENV = "PI_UPSTREAM_NATIVE_DEPENDENCY_HEALTH_CHECK_DISABLED";

export const BUNDLED_UPSTREAM_GATED_WRITE_TOOLS = new Set<string>([
  "memory_save",
  "memory_diary_write",
  "knowledge_add",
  "knowledge_invalidate",
  "memory_delete",
]);

export const BUNDLED_UPSTREAM_CUSTOM_WRAPPED_TOOLS = new Set<string>([
  "memory_search",
  "memory_recall",
  "memory_graph",
  "memory_tunnel",
]);

export const MEMORY_SEARCH_QUERY_FIELD = "query";
export const MEMORY_SEARCH_PROJECT_FIELD = "project";
export const MEMORY_SEARCH_TOPIC_FIELD = "topic";
export const MEMORY_SEARCH_N_RESULTS_FIELD = "n_results";
export const MEMORY_SEARCH_DEFAULT_N_RESULTS = 5;
export const MEMORY_SEARCH_MAX_N_RESULTS = 20;
export const MEMORY_SEARCH_PROJECT_FETCH_MULTIPLIER = 4;
export const MEMORY_RECALL_PROJECT_FIELD = "project";
export const MEMORY_RECALL_TOPIC_FIELD = "topic";
export const MEMORY_RECALL_N_RESULTS_FIELD = "n_results";
export const MEMORY_TUNNEL_TOPIC_FIELD = "topic";
export const MEMORY_TUNNEL_USER_A_FIELD = "project_a";
export const MEMORY_TUNNEL_USER_B_FIELD = "project_b";
export const MEMORY_TUNNEL_N_RESULTS_FIELD = "n_results";

export const MEMORY_SAVE_PROJECT_CONTENT_FIELD = "project_content";
export const MEMORY_SAVE_GENERAL_CONTENT_FIELD = "general_content";
export const MEMORY_SAVE_PROJECT_TOPIC_FIELD = "project_topic";
export const MEMORY_SAVE_GENERAL_TOPIC_FIELD = "general_topic";
export const MEMORY_SAVE_PROJECT_IMPORTANCE_FIELD = "project_importance";
export const MEMORY_SAVE_GENERAL_IMPORTANCE_FIELD = "general_importance";

export const MEMORY_SAVE_LEGACY_REMOVED_FIELDS = [
  "content",
  "scope",
  "memory_scope",
  "memoryScope",
  "topic",
  "importance",
  "project",
] as const;

export const MEMORY_SAVE_PAYLOAD_PROMPT_GUIDELINES = [
  "Do not use legacy memory_save fields (`content`, `scope`, `topic`, `importance`, `project`).",
  "Use `project_content` for member-local project memory wording.",
  "Use `general_content` for reusable cross-project memory wording.",
  "Provide both `project_content` and `general_content` when both targets should be executed in one call.",
] as const;

export const MEMORY_SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "for",
  "from",
  "in",
  "is",
  "of",
  "or",
  "the",
  "this",
  "to",
  "with",
]);
