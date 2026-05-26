/**
 * File intent: evaluate summary quality and retrieval-regression preview advisories.
 *
 * These checks are separated from structural/policy gates to keep the preview
 * validation module under the agreed file-size limit.
 */

import type { ContinuitySection } from "../../../../../packages/memory-core/src/continuity/continuity-codebook.js";
import type { ContinuityEntryLifecycleRecord } from "../../../../memory-data-adapters/sqlite/continuity/index.js";
import type { ContinuityCompactionProposalPayload, ContinuityCompactionValidationReason } from "../continuity-compaction-shared.js";
import type { ExtensionToolDependencies } from "../types.js";

/**
 * Append summary-quality and retrieval-regression advisories in-place.
 */
export const appendContinuityCompactionPreviewSummaryAdvisories = (input: {
  deps: ExtensionToolDependencies;
  reasons: ContinuityCompactionValidationReason[];
  proposal: ContinuityCompactionProposalPayload;
  sourceEntryById: Map<string, ContinuityEntryLifecycleRecord>;
  activeEntriesBefore: Array<{ id: string; timestamp?: string; content: string }>;
  nowTimestamp: string;
}): void => {
  const {
    CONTINUITY_COMPACTION_SUMMARY_MIN_CHARS,
    CONTINUITY_COMPACTION_SUMMARY_MAX_CHARS,
    CONTINUITY_COMPACTION_LEXICAL_COVERAGE_MIN_RATIO,
    CONTINUITY_COMPACTION_SEMANTIC_COVERAGE_MIN_RATIO,
    CONTINUITY_COMPACTION_SEMANTIC_MIN_SOURCE_NGRAMS,
    CONTINUITY_COMPACTION_RETRIEVAL_PROBE_TOP_K,
    CONTINUITY_COMPACTION_RETRIEVAL_PROBE_KEYWORD_COUNT,
    CONTINUITY_COMPACTION_RETRIEVAL_OVERLAP_MIN_RATIO,
    computeContinuityCompactionLexicalCoverage,
    computeContinuityCompactionSemanticCoverage,
    buildContinuityCompactionSourceKeywordSet,
    rankContinuityCompactionProbeEntries,
    isLowSignalSemanticOperationalTelemetryEntry,
  } = input.deps;
  const { reasons, proposal, sourceEntryById, activeEntriesBefore, nowTimestamp } = input;

  const retrievalRegressionFindings: string[] = [];
    
  for (const group of proposal.groups) {
    if (
      group.summary.length < CONTINUITY_COMPACTION_SUMMARY_MIN_CHARS
      || group.summary.length > CONTINUITY_COMPACTION_SUMMARY_MAX_CHARS
    ) {
      reasons.push({
        code: "advisory.summary.length",
        gate_id: "G011",
        severity: "warning",
        message: `Summary length is outside target range for group '${group.group_id}'.`,
        observed: String(group.summary.length),
        expected: `${CONTINUITY_COMPACTION_SUMMARY_MIN_CHARS}..${CONTINUITY_COMPACTION_SUMMARY_MAX_CHARS}`,
        suggestion: "Rewrite summary with bounded semantic detail and concrete evidence.",
      });
    }
    
    const sectionForNoise = group.section_hint && group.section_hint !== "MIXED"
      ? group.section_hint
      : "OUTCOMES";
    
    if (isLowSignalSemanticOperationalTelemetryEntry({
      section: sectionForNoise as ContinuitySection,
      provenance: "CODE",
      content: group.summary,
    })) {
      reasons.push({
        code: "advisory.summary.noisy",
        gate_id: "G012",
        severity: "warning",
        message: `Summary text for group '${group.group_id}' looks operational/noise-heavy.`,
        suggestion: "Rewrite summary to capture durable semantic signal, not command/report logs.",
      });
    }
    
    const groupSourceEntries = group.source_entry_ids
      .map((sourceEntryId) => sourceEntryById.get(sourceEntryId))
      .filter((entry): entry is ContinuityEntryLifecycleRecord => entry !== undefined);
    const sourceKeywordSet = buildContinuityCompactionSourceKeywordSet(groupSourceEntries);
    
    if (sourceKeywordSet.size >= 3) {
      const lexicalCoverage = computeContinuityCompactionLexicalCoverage({
        summary: group.summary,
        sourceKeywordSet,
      });
    
      if (lexicalCoverage.ratio < CONTINUITY_COMPACTION_LEXICAL_COVERAGE_MIN_RATIO) {
        reasons.push({
          code: "advisory.summary.lexical_low_coverage",
          gate_id: "G013",
          severity: "warning",
          message: `Summary text for group '${group.group_id}' misses too many dominant source terms.`,
          observed:
            `coverage=${(lexicalCoverage.ratio * 100).toFixed(2)}%; ` +
            `matched=${lexicalCoverage.matchedKeywords.length}/${sourceKeywordSet.size}; ` +
            `missing=${lexicalCoverage.missingKeywords.slice(0, 6).join(", ") || "none"}`,
          expected: `>=${(CONTINUITY_COMPACTION_LEXICAL_COVERAGE_MIN_RATIO * 100).toFixed(0)}%`,
          suggestion: "Add missing source key terms so summary preserves retrievable lexical anchors.",
        });
      }
    }
    
    const sourceBundle = groupSourceEntries
      .map((entry) => entry.content)
      .join(" ");
    const semanticCoverage = computeContinuityCompactionSemanticCoverage({
      summary: group.summary,
      sourceBundle,
    });
    
    if (
      semanticCoverage.sourceNgramCount >= CONTINUITY_COMPACTION_SEMANTIC_MIN_SOURCE_NGRAMS
      && semanticCoverage.ratio < CONTINUITY_COMPACTION_SEMANTIC_COVERAGE_MIN_RATIO
    ) {
      reasons.push({
        code: "advisory.summary.semantic_low_coverage",
        gate_id: "G014",
        severity: "warning",
        message: `Summary text for group '${group.group_id}' is semantically too far from source bundle (proxy score).`,
        observed:
          `coverage=${(semanticCoverage.ratio * 100).toFixed(2)}%; ` +
          `overlap=${semanticCoverage.overlapNgramCount}/${semanticCoverage.sourceNgramCount}; ` +
          `summaryNgrams=${semanticCoverage.summaryNgramCount}`,
        expected: `>=${(CONTINUITY_COMPACTION_SEMANTIC_COVERAGE_MIN_RATIO * 100).toFixed(0)}%`,
        suggestion: "Rewrite summary to preserve more original meaning from source rows.",
      });
    }
    
    const probeTerms = Array.from(sourceKeywordSet)
      .slice(0, CONTINUITY_COMPACTION_RETRIEVAL_PROBE_KEYWORD_COUNT);
    const probeQuery = probeTerms.join(" ").trim();
    
    if (probeQuery.length > 0) {
      const virtualSummaryId = `preview-summary-${group.group_id}`;
      const groupSourceEntryIds = new Set(group.source_entry_ids);
    
      const preTopIds = rankContinuityCompactionProbeEntries({
        entries: activeEntriesBefore,
        queryText: probeQuery,
        limit: CONTINUITY_COMPACTION_RETRIEVAL_PROBE_TOP_K,
      });
    
      if (preTopIds.length > 0) {
        const preTopNormalized = Array.from(new Set(
          preTopIds.map((entryId) =>
            groupSourceEntryIds.has(entryId)
              ? virtualSummaryId
              : entryId),
        ));
    
        const postEntries = [
          ...activeEntriesBefore.filter((entry) => !groupSourceEntryIds.has(entry.id)),
          {
            id: virtualSummaryId,
            timestamp: nowTimestamp,
            content: group.summary,
          },
        ];
    
        const postTopIds = rankContinuityCompactionProbeEntries({
          entries: postEntries,
          queryText: probeQuery,
          limit: CONTINUITY_COMPACTION_RETRIEVAL_PROBE_TOP_K,
        });
    
        const postTopSet = new Set(postTopIds);
        const overlapCount = preTopNormalized
          .filter((entryId) => postTopSet.has(entryId)).length;
        const overlapRatio = preTopNormalized.length > 0
          ? overlapCount / preTopNormalized.length
          : 1;
        const summaryHit = postTopSet.has(virtualSummaryId);
    
        if (
          overlapRatio < CONTINUITY_COMPACTION_RETRIEVAL_OVERLAP_MIN_RATIO
          || !summaryHit
        ) {
          retrievalRegressionFindings.push(
            `${group.group_id}=` +
            `overlap${(overlapRatio * 100).toFixed(1)}%/target${(CONTINUITY_COMPACTION_RETRIEVAL_OVERLAP_MIN_RATIO * 100).toFixed(0)}%; ` +
            `summaryHit=${summaryHit ? "yes" : "no"}`,
          );
        }
      }
    }
  }
    
  if (retrievalRegressionFindings.length > 0) {
    reasons.push({
      code: "advisory.retrieval.regression",
      gate_id: "G015",
      severity: "warning",
      message: "Preview simulation indicates potential retrieval quality regression after compaction.",
      observed: retrievalRegressionFindings.slice(0, 5).join(" | "),
      expected:
        `overlap>=${(CONTINUITY_COMPACTION_RETRIEVAL_OVERLAP_MIN_RATIO * 100).toFixed(0)}% and summaryHit=yes ` +
        `(topK=${CONTINUITY_COMPACTION_RETRIEVAL_PROBE_TOP_K})`,
      suggestion: "Adjust grouping/summary wording so key probes still retrieve summary replacements.",
    });
  }
    
};
