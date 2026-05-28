/**
 * File intent: hold entrypoint runtime constants that are shared by hooks, tools,
 * commands, and extracted runtime services.
 *
 * These values preserve the original package entrypoint behavior during Slice 5
 * decomposition and avoid scattering policy thresholds across registrars.
 */

import type {
  ContinuityCertainty,
  ContinuityProvenance,
  ContinuitySection,
} from "../../../../packages/memory-core/src/continuity/continuity-codebook.js";

export const MEMORY_WRITE_TOOL_NAMES = new Set([
  "memory_save",
  "memory_diary_write",
  "knowledge_add",
  "knowledge_invalidate",
  "memory_delete",
]);

export const CONTINUITY_RUNTIME_START_MARKER = "<!-- PI_CONTINUITY_RUNTIME_START -->";
export const CONTINUITY_RUNTIME_END_MARKER = "<!-- PI_CONTINUITY_RUNTIME_END -->";
export const PROJECT_MEMORY_RUNTIME_START_MARKER = "<!-- PI_PROJECT_MEMORY_RUNTIME_START -->";
export const PROJECT_MEMORY_RUNTIME_END_MARKER = "<!-- PI_PROJECT_MEMORY_RUNTIME_END -->";
export const PERSISTENCE_ORCHESTRATION_RUNTIME_START_MARKER = "<!-- PI_PERSISTENCE_ORCHESTRATION_RUNTIME_START -->";
export const PERSISTENCE_ORCHESTRATION_RUNTIME_END_MARKER = "<!-- PI_PERSISTENCE_ORCHESTRATION_RUNTIME_END -->";

export const CONTINUITY_RUNTIME_ENV_FLAG = "PI_CONTINUITY_SKILL_ENABLED";
export const PROJECT_MEMORY_RUNTIME_ENV_FLAG = "PI_PROJECT_MEMORY_POLICY_ENABLED";
export const PERSISTENCE_ORCHESTRATION_RUNTIME_ENV_FLAG = "PI_PERSISTENCE_ORCHESTRATION_POLICY_ENABLED";
export const CONTINUITY_SESSION_SUMMARY_ENV_FLAG = "PI_CONTINUITY_SESSION_SUMMARY_ENABLED";
export const CONTINUITY_MUTATION_AUTO_JOURNAL_ENV_FLAG = "PI_CONTINUITY_MUTATION_AUTO_JOURNAL_ENABLED";
export const CONTINUITY_BLOCKED_VERBOSE_ENV_FLAG = "PI_CONTINUITY_BLOCKED_VERBOSE_ENABLED";
export const CONTINUITY_COMPACTION_PROFILE_SELECTION_MODE_ENV_FLAG = "PI_CONTINUITY_COMPACTION_PROFILE_SELECTION_MODE";
export const CONTINUITY_COMPACTION_REQUEST_PROFILE_ENV_FLAG = "PI_CONTINUITY_COMPACTION_REQUEST_PROFILE";

export const CONTINUITY_REQUEST_EVIDENCE_PATH_LIMIT = 8;
export const CONTINUITY_DEDUP_LOOKBACK_LIMIT = 600;
export const CONTINUITY_DUPLICATE_WINDOW_MS = 1000 * 60 * 60 * 24 * 14;

export const CONTINUITY_SECTION_VALUES: ContinuitySection[] = [
  "PLANS",
  "DECISIONS",
  "PROGRESS",
  "DISCOVERIES",
  "OUTCOMES",
];

export const CONTINUITY_PROVENANCE_VALUES: ContinuityProvenance[] = [
  "USER",
  "CODE",
  "TOOL",
  "ASSUMPTION",
];

export const CONTINUITY_CERTAINTY_VALUES: ContinuityCertainty[] = [
  "CONFIRMED",
  "UNCONFIRMED",
];

// Only tools with explicit file-write semantics are treated as continuity mutations.
// Read and shell commands are evidence/validation activity at best; counting them
// as changed artifacts produced noisy end-of-request warnings for research-heavy turns.
export const CONTINUITY_MUTATION_TOOL_NAMES = new Set([
  "edit",
  "write",
]);

export const CONTINUITY_EXPLICIT_WRITE_TOOL_NAMES = new Set([
  "continuity_write",
  "continuity_query",
]);

export const CONTINUITY_SECTION_SET = new Set<string>(CONTINUITY_SECTION_VALUES);
export const CONTINUITY_PROVENANCE_SET = new Set<string>(CONTINUITY_PROVENANCE_VALUES);
export const CONTINUITY_CERTAINTY_SET = new Set<string>(CONTINUITY_CERTAINTY_VALUES);

export const CONTINUITY_SEMANTIC_SECTION_SET = new Set<ContinuitySection>([
  "PLANS",
  "DECISIONS",
  "DISCOVERIES",
  "OUTCOMES",
]);

export const CONTINUITY_SOURCE_REF_REQUIRED_SECTION_SET = new Set<ContinuitySection>([
  "DECISIONS",
  "DISCOVERIES",
  "OUTCOMES",
]);

export const CONTINUITY_SOURCE_REF_LIMIT = 8;
export const CONTINUITY_COMPACTION_PREVIEW_TTL_HOURS = 6;
export const CONTINUITY_COMPACTION_PREVIEW_TTL_MAX_HOURS = 24;
export const CONTINUITY_COMPACTION_APPLIED_RETENTION_DAYS = 14;
export const CONTINUITY_COMPACTION_APPLIED_RETENTION_MIN_DAYS = 7;
export const CONTINUITY_COMPACTION_APPLIED_RETENTION_MAX_DAYS = 30;
export const CONTINUITY_COMPACTION_MAX_PREVIEW_REVISIONS = 3;
export const CONTINUITY_COMPACTION_STRICT_MAX_PREVIEWS_PER_REQUEST = 8;
export const CONTINUITY_COMPACTION_STRICT_MAX_APPLIES_PER_REQUEST = 1;
export const CONTINUITY_COMPACTION_LONG_MAX_PREVIEWS_PER_REQUEST = 12;
export const CONTINUITY_COMPACTION_LONG_MAX_APPLIES_PER_REQUEST = 2;
export const CONTINUITY_COMPACTION_LONG_REQUEST_SOURCE_ENTRY_THRESHOLD = 180;
export const CONTINUITY_COMPACTION_LONG_REQUEST_GROUP_THRESHOLD = 8;
export const CONTINUITY_COMPACTION_RECENT_FREEZE_HOURS = 24;
export const CONTINUITY_COMPACTION_PER_SECTION_ACTIVE_FLOOR = 20;
export const CONTINUITY_COMPACTION_GLOBAL_ACTIVE_RETAIN_FLOOR = 120;
export const CONTINUITY_COMPACTION_MAX_BATCH_COMPACT_PERCENT = 0.15;
export const CONTINUITY_COMPACTION_MAX_BATCH_COMPACT_ROWS = 60;
export const CONTINUITY_COMPACTION_SUMMARY_MIN_CHARS = 140;
export const CONTINUITY_COMPACTION_SUMMARY_MAX_CHARS = 1600;
export const CONTINUITY_QUERY_COMPACTION_NOISE_MIN_LEXICAL_MATCH = 0.35;
export const CONTINUITY_QUERY_COMPACTION_NOISE_RATIO_THRESHOLD = 0.55;
export const CONTINUITY_QUERY_COMPACTION_NOISE_MIN_RESULTS = 6;
export const CONTINUITY_QUERY_COMPACTION_NOISE_STREAK_TRIGGER = 2;
export const CONTINUITY_COMPACTION_LEXICAL_COVERAGE_MIN_RATIO = 0.30;
export const CONTINUITY_COMPACTION_LEXICAL_SOURCE_KEYWORD_LIMIT = 16;
export const CONTINUITY_COMPACTION_LEXICAL_TOKEN_MIN_LENGTH = 4;

export const CONTINUITY_COMPACTION_LEXICAL_STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "before",
  "because",
  "current",
  "during",
  "entry",
  "from",
  "have",
  "into",
  "memory",
  "project",
  "should",
  "source",
  "summary",
  "that",
  "their",
  "there",
  "these",
  "this",
  "with",
  "would",
]);

export const CONTINUITY_COMPACTION_SEMANTIC_COVERAGE_MIN_RATIO = 0.22;
export const CONTINUITY_COMPACTION_SEMANTIC_NGRAM_SIZE = 3;
export const CONTINUITY_COMPACTION_SEMANTIC_MIN_SOURCE_NGRAMS = 48;
export const CONTINUITY_COMPACTION_RETRIEVAL_PROBE_TOP_K = 10;
export const CONTINUITY_COMPACTION_RETRIEVAL_PROBE_KEYWORD_COUNT = 3;
export const CONTINUITY_COMPACTION_RETRIEVAL_OVERLAP_MIN_RATIO = 0.90;

export const CONTINUITY_COMPACTION_SECTION_HINT_VALUES = [
  ...CONTINUITY_SECTION_VALUES,
  "MIXED",
] as const;

export const CONTINUITY_USER_INTENT_SIGNAL_PATTERNS = [
  /\buser\b/i,
  /\brequest(?:ed|s)?\b/i,
  /\bask(?:ed|s)?\b/i,
  /\bapprov(?:e|ed|al)\b/i,
  /\bconstraint(?:s)?\b/i,
  /\brequirement(?:s)?\b/i,
  /\bdirect(?:ed|ive|ion)\b/i,
  /\bper\s+request\b/i,
  /\bas\s+requested\b/i,
] as const;

export type ContinuityCompactionSectionHint = (typeof CONTINUITY_COMPACTION_SECTION_HINT_VALUES)[number];
export type ContinuityCompactionProfileSelectionMode = "operator_only" | "auto_detect_long_request";
