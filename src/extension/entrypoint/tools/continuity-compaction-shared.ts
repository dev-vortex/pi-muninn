/**
 * File intent: share small compaction payload helpers across extracted compaction tools.
 *
 * These helpers are tool-surface behavior, not storage logic: they normalize the
 * LLM proposal payload and render validation/advisory lines exactly as before.
 */

import type { ContinuitySection } from "../../../../packages/memory-core/src/continuity/continuity-codebook.js";

/**
 * One proposed compaction group from the LLM/tool caller.
 */
export interface ContinuityCompactionProposalGroup {
  group_id: string;
  source_entry_ids: string[];
  summary: string;
  section_hint?: ContinuitySection | "MIXED";
}

/**
 * Normalized compaction preview payload.
 */
export interface ContinuityCompactionProposalPayload {
  proposal_id: string;
  based_on_preview_id?: string;
  generated_at?: string;
  groups: ContinuityCompactionProposalGroup[];
}

/**
 * Validation/advisory reason displayed by compaction preview/apply tools.
 */
export interface ContinuityCompactionValidationReason {
  code: string;
  gate_id: string;
  severity: "error" | "warning";
  message: string;
  observed?: string;
  expected?: string;
  suggestion?: string;
}

/**
 * Normalize raw preview params into deterministic compaction proposal payload.
 */
export const normalizeContinuityCompactionProposalPayload = (input: {
  params: {
    proposal_id: string;
    based_on_preview_id?: string;
    generated_at?: string;
    groups: Array<{
      group_id: string;
      source_entry_ids: string[];
      summary: string;
      section_hint?: string;
    }>;
  };
  normalizeContinuityTimestamp: (value: string | undefined) => string;
  normalizeContinuityCompactionSourceEntryIds: (values: string[]) => string[];
  normalizeContinuityContent: (value: string) => string;
  normalizeContinuityCompactionSectionHint: (value: string | undefined) => ContinuitySection | "MIXED" | null;
}): ContinuityCompactionProposalPayload => ({
  proposal_id: input.params.proposal_id.trim(),
  based_on_preview_id: typeof input.params.based_on_preview_id === "string"
    && input.params.based_on_preview_id.trim().length > 0
    ? input.params.based_on_preview_id.trim()
    : undefined,
  generated_at: typeof input.params.generated_at === "string" && input.params.generated_at.trim().length > 0
    ? input.normalizeContinuityTimestamp(input.params.generated_at)
    : undefined,
  groups: input.params.groups.map((group, index) => ({
    group_id: group.group_id.trim().length > 0 ? group.group_id.trim() : `group-${index + 1}`,
    source_entry_ids: input.normalizeContinuityCompactionSourceEntryIds(group.source_entry_ids),
    summary: input.normalizeContinuityContent(group.summary || ""),
    section_hint: input.normalizeContinuityCompactionSectionHint(group.section_hint) || "MIXED",
  })),
});

/**
 * Render one compact reason line for compaction preview/apply diagnostics.
 */
export const renderContinuityCompactionReasonLine = (reason: ContinuityCompactionValidationReason): string => {
  const observed = reason.observed ? ` observed=${reason.observed};` : "";
  const expected = reason.expected ? ` expected=${reason.expected};` : "";
  const suggestion = reason.suggestion ? ` suggestion=${reason.suggestion}` : "";
  return `- [${reason.severity.toUpperCase()}] ${reason.code} (${reason.gate_id}) ${reason.message}${observed}${expected}${suggestion}`;
};
