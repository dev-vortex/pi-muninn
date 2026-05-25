/**
 * File intent: evaluate continuity compaction coverage and retrieval probes.
 *
 * These heuristics support compaction tools and status summaries while keeping
 * command/tool registration thin. Core pressure assessment lives in the
 * continuity domain and is re-exported here for existing entrypoint callers.
 */

import { createHash } from "node:crypto";

import { assessContinuityCompactionPressure } from "../../../../packages/memory-core/src/continuity/compaction-pressure.js";
import type { ContinuityCompactionProposalPayload } from "../tools/continuity-compaction-shared.js";
import {
  CONTINUITY_COMPACTION_LEXICAL_SOURCE_KEYWORD_LIMIT,
  CONTINUITY_COMPACTION_LEXICAL_STOP_WORDS,
  CONTINUITY_COMPACTION_LEXICAL_TOKEN_MIN_LENGTH,
  CONTINUITY_COMPACTION_SEMANTIC_NGRAM_SIZE,
  CONTINUITY_QUERY_COMPACTION_NOISE_MIN_LEXICAL_MATCH,
  CONTINUITY_QUERY_COMPACTION_NOISE_MIN_RESULTS,
  CONTINUITY_QUERY_COMPACTION_NOISE_RATIO_THRESHOLD,
  CONTINUITY_QUERY_COMPACTION_NOISE_STREAK_TRIGGER,
} from "./constants.js";
import { normalizeContinuityContent } from "./continuity-normalization.js";

export { assessContinuityCompactionPressure };

/**
 * Build a stable proposal fingerprint for apply/preview idempotency checks.
 */
export const buildContinuityCompactionProposalFingerprint = (proposal: ContinuityCompactionProposalPayload): string => {
  const canonical = {
    proposal_id: proposal.proposal_id,
    based_on_preview_id: proposal.based_on_preview_id || null,
    groups: proposal.groups.map((group) => ({
      group_id: group.group_id,
      source_entry_ids: [...group.source_entry_ids].sort(),
      summary: group.summary,
      section_hint: group.section_hint || "MIXED",
    })),
  };

  return createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
};

/**
 * Tokenize short query/continuity strings for lexical overlap scoring.
 */
export const tokenizeContinuityQueryText = (query: string): string[] =>
  normalizeContinuityContent(query)
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);

/**
 * Compute a bounded lexical overlap score between query and content.
 */
export const computeContinuityLexicalOverlapScore = (input: {
  queryTokens: string[];
  content: string;
}): number => {
  if (input.queryTokens.length === 0) {
    return 0;
  }

  const haystack = normalizeContinuityContent(input.content).toLowerCase();
  if (haystack.length === 0) {
    return 0;
  }

  let hits = 0;

  for (const token of input.queryTokens) {
    if (haystack.includes(token)) {
      hits += 1;
    }
  }

  return Math.min(1, hits / input.queryTokens.length);
};

/**
 * Build non-blocking compaction guidance for noisy continuity query result sets.
 */
export const buildContinuityQueryCompactionHint = (input: {
  queryText: string;
  entries: Array<{ content: string }>;
  previousNoisyStreak: number;
}): {
  lexicalMatchThreshold: number;
  noisyRatioThreshold: number;
  minimumResultCount: number;
  totalEntries: number;
  lowLexicalMatchEntries: number;
  lowLexicalMatchRatio: number;
  noisyResultSet: boolean;
  noisyStreak: number;
  recommendCompaction: boolean;
} | null => {
  const queryTokens = tokenizeContinuityQueryText(input.queryText);

  if (queryTokens.length === 0) {
    return null;
  }

  const lowLexicalMatchEntries = input.entries.filter((entry) =>
    computeContinuityLexicalOverlapScore({
      queryTokens,
      content: entry.content,
    }) < CONTINUITY_QUERY_COMPACTION_NOISE_MIN_LEXICAL_MATCH).length;

  const lowLexicalMatchRatio = input.entries.length > 0
    ? lowLexicalMatchEntries / input.entries.length
    : 0;

  const noisyResultSet =
    input.entries.length >= CONTINUITY_QUERY_COMPACTION_NOISE_MIN_RESULTS
    && lowLexicalMatchRatio >= CONTINUITY_QUERY_COMPACTION_NOISE_RATIO_THRESHOLD;

  const noisyStreak = noisyResultSet ? input.previousNoisyStreak + 1 : 0;
  const recommendCompaction = noisyStreak >= CONTINUITY_QUERY_COMPACTION_NOISE_STREAK_TRIGGER;

  return {
    lexicalMatchThreshold: CONTINUITY_QUERY_COMPACTION_NOISE_MIN_LEXICAL_MATCH,
    noisyRatioThreshold: CONTINUITY_QUERY_COMPACTION_NOISE_RATIO_THRESHOLD,
    minimumResultCount: CONTINUITY_QUERY_COMPACTION_NOISE_MIN_RESULTS,
    totalEntries: input.entries.length,
    lowLexicalMatchEntries,
    lowLexicalMatchRatio,
    noisyResultSet,
    noisyStreak,
    recommendCompaction,
  };
};

/**
 * Tokenize text for source-summary lexical coverage checks.
 */
export const tokenizeContinuityCompactionCoverageText = (value: string): string[] =>
  normalizeContinuityContent(value)
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= CONTINUITY_COMPACTION_LEXICAL_TOKEN_MIN_LENGTH)
    .filter((token) => !CONTINUITY_COMPACTION_LEXICAL_STOP_WORDS.has(token));

/**
 * Pick dominant source keywords for compaction lexical coverage checks.
 */
export const buildContinuityCompactionSourceKeywordSet = (sourceEntries: Array<{ content: string }>): Set<string> => {
  const tokenFrequency = new Map<string, number>();

  for (const entry of sourceEntries) {
    for (const token of tokenizeContinuityCompactionCoverageText(entry.content)) {
      tokenFrequency.set(token, (tokenFrequency.get(token) || 0) + 1);
    }
  }

  const rankedTokens = Array.from(tokenFrequency.entries())
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }

      return left[0].localeCompare(right[0]);
    })
    .slice(0, CONTINUITY_COMPACTION_LEXICAL_SOURCE_KEYWORD_LIMIT)
    .map(([token]) => token);

  return new Set(rankedTokens);
};

/**
 * Compute source keyword coverage for one compaction summary.
 */
export const computeContinuityCompactionLexicalCoverage = (input: {
  summary: string;
  sourceKeywordSet: Set<string>;
}): {
  ratio: number;
  matchedKeywords: string[];
  missingKeywords: string[];
} => {
  const sourceKeywords = Array.from(input.sourceKeywordSet);
  if (sourceKeywords.length === 0) {
    return {
      ratio: 1,
      matchedKeywords: [],
      missingKeywords: [],
    };
  }

  const summaryTokens = new Set(tokenizeContinuityCompactionCoverageText(input.summary));
  const matchedKeywords = sourceKeywords.filter((token) => summaryTokens.has(token));
  const missingKeywords = sourceKeywords.filter((token) => !summaryTokens.has(token));

  return {
    ratio: matchedKeywords.length / sourceKeywords.length,
    matchedKeywords,
    missingKeywords,
  };
};

/**
 * Build semantic n-gram set for lightweight compaction drift checks.
 */
export const buildContinuityCompactionSemanticNgramSet = (input: {
  text: string;
  ngramSize?: number;
}): Set<string> => {
  const ngramSize = input.ngramSize ?? CONTINUITY_COMPACTION_SEMANTIC_NGRAM_SIZE;
  const normalized = normalizeContinuityContent(input.text)
    .toLowerCase()
    .replace(/\s+/g, " ");

  if (normalized.length < ngramSize) {
    return new Set();
  }

  const ngrams = new Set<string>();

  for (let index = 0; index <= normalized.length - ngramSize; index += 1) {
    const ngram = normalized.slice(index, index + ngramSize);

    // Keep only meaningful lexical n-grams to avoid punctuation-only noise.
    if (!/[a-z0-9]/.test(ngram)) {
      continue;
    }

    ngrams.add(ngram);
  }

  return ngrams;
};

/**
 * Compute lightweight semantic n-gram coverage between sources and summary.
 */
export const computeContinuityCompactionSemanticCoverage = (input: {
  summary: string;
  sourceBundle: string;
}): {
  ratio: number;
  sourceNgramCount: number;
  summaryNgramCount: number;
  overlapNgramCount: number;
} => {
  const sourceNgrams = buildContinuityCompactionSemanticNgramSet({
    text: input.sourceBundle,
  });
  const summaryNgrams = buildContinuityCompactionSemanticNgramSet({
    text: input.summary,
  });

  if (sourceNgrams.size === 0 || summaryNgrams.size === 0) {
    return {
      ratio: 1,
      sourceNgramCount: sourceNgrams.size,
      summaryNgramCount: summaryNgrams.size,
      overlapNgramCount: 0,
    };
  }

  let overlap = 0;

  for (const ngram of sourceNgrams) {
    if (summaryNgrams.has(ngram)) {
      overlap += 1;
    }
  }

  return {
    ratio: (2 * overlap) / (sourceNgrams.size + summaryNgrams.size),
    sourceNgramCount: sourceNgrams.size,
    summaryNgramCount: summaryNgrams.size,
    overlapNgramCount: overlap,
  };
};

/**
 * Rank active entries for retrieval-regression probes.
 */
export const rankContinuityCompactionProbeEntries = <TEntry extends {
  id: string;
  timestamp: string;
  content: string;
}>(input: {
  entries: TEntry[];
  queryText: string;
  limit: number;
}): string[] => {
  const queryTokens = tokenizeContinuityQueryText(input.queryText);
  if (queryTokens.length === 0) {
    return [];
  }

  const recencyScores = buildContinuityRecencyScoreMap(input.entries);

  return input.entries
    .map((entry) => {
      const lexicalScore = computeContinuityLexicalOverlapScore({
        queryTokens,
        content: entry.content,
      });
      const recencyScore = recencyScores.get(entry.id) ?? 0;

      return {
        id: entry.id,
        lexicalScore,
        recencyScore,
        score: (lexicalScore * 0.85) + (recencyScore * 0.15),
        timestamp: entry.timestamp,
      };
    })
    // Keep retrieval probes focused on rows actually matching the query.
    .filter((row) => row.lexicalScore > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return right.timestamp.localeCompare(left.timestamp);
    })
    .slice(0, input.limit)
    .map((row) => row.id);
};

/**
 * Build relative recency score map for continuity entries.
 */
export const buildContinuityRecencyScoreMap = (entries: Array<{ id: string; timestamp: string }>): Map<string, number> => {
  const scored = new Map<string, number>();

  if (entries.length === 0) {
    return scored;
  }

  const epochs = entries.map((entry) => ({
    id: entry.id,
    epoch: Number.isFinite(Date.parse(entry.timestamp))
      ? Date.parse(entry.timestamp)
      : 0,
  }));

  const maxEpoch = Math.max(...epochs.map((row) => row.epoch));
  const minEpoch = Math.min(...epochs.map((row) => row.epoch));

  if (maxEpoch === minEpoch) {
    for (const row of epochs) {
      scored.set(row.id, 1);
    }

    return scored;
  }

  const denominator = maxEpoch - minEpoch;

  for (const row of epochs) {
    scored.set(row.id, Math.max(0, Math.min(1, (row.epoch - minEpoch) / denominator)));
  }

  return scored;
};

