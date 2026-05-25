/**
 * File intent: protect continuity from low-value operational noise.
 *
 * This file holds deterministic quality gates that reject or flag semantic
 * continuity entries that look like copied command output, telemetry, or tool
 * bookkeeping instead of durable plans, decisions, discoveries, or outcomes.
 * Add new heuristics here when bad continuity content patterns are observed.
 */

import type {
  ContinuityProvenance,
  ContinuitySection,
} from "./continuity-codebook.js";

/**
 * Semantic continuity sections that should carry high-signal content.
 */
const CONTINUITY_SEMANTIC_SECTION_SET = new Set<ContinuitySection>([
  "PLANS",
  "DECISIONS",
  "DISCOVERIES",
  "OUTCOMES",
]);

/**
 * User-report style prefixes that often indicate operational run logs.
 */
const CONTINUITY_LOW_SIGNAL_USER_REPORT_PREFIX = /^(user\s+(reported|reran|ran|confirmed|noted)\b)/i;

/**
 * Generic operational telemetry markers observed in end-user traces.
 */
const CONTINUITY_LOW_SIGNAL_OPERATIONAL_TELEMETRY = /(\.\/|\/home\/|\/tmp\/|\bpnpm\b|\bnpm\b|\bnode\b|\bpython\b|wrote\s+\d+\s+(entries|rows?)\b|received:|experimental\s+warning|stdout=|stderr=|exit\s*code|status=|response=|\brpc\b)/i;

/**
 * Tool names that are commonly logged as bookkeeping telemetry instead of
 * durable semantic decisions/discoveries/outcomes.
 */
const CONTINUITY_LOW_SIGNAL_TOOL_NAME_MARKER = /\b(memory_save|memory_diary_write|knowledge_add|knowledge_invalidate|continuity_(write|file_write|db_write)|project_memory_status|project_memory_context|project_memory_observability)\b/i;

/**
 * Mechanical bookkeeping verbs indicating execution telemetry rather than
 * semantic intent.
 */
const CONTINUITY_LOW_SIGNAL_TOOL_BOOKKEEPING_VERB = /\b(stored|saved|wrote|returned|executed|succeeded|failed|status|result|response|called)\b/i;

/**
 * Detect low-signal semantic continuity entries that look like operational
 * telemetry logs captured from runtime/tool output.
 */
export const isLowSignalSemanticOperationalTelemetryEntry = (input: {
  section: ContinuitySection;
  provenance: ContinuityProvenance;
  content: string;
}): boolean => {
  if (!CONTINUITY_SEMANTIC_SECTION_SET.has(input.section)) {
    return false;
  }

  const normalized = input.content.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) {
    return false;
  }

  if (input.provenance === "USER") {
    return CONTINUITY_LOW_SIGNAL_USER_REPORT_PREFIX.test(normalized)
      && CONTINUITY_LOW_SIGNAL_OPERATIONAL_TELEMETRY.test(normalized);
  }

  if (input.provenance === "TOOL") {
    return CONTINUITY_LOW_SIGNAL_TOOL_NAME_MARKER.test(normalized)
      && CONTINUITY_LOW_SIGNAL_TOOL_BOOKKEEPING_VERB.test(normalized);
  }

  return false;
};
