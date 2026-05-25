/**
 * File intent: build bounded continuity briefings for prompt-scoped injection.
 *
 * This file owns continuity-domain selection and rendering for the prompt-scoped
 * continuity briefing. Entrypoint code should only provide prompt signals,
 * mode/config, and optional test doubles; it should not implement retrieval
 * behavior here.
 */

import type {
  ContinuityCertainty,
  ContinuityProvenance,
  ContinuitySection,
} from "../../../continuity/continuity-codebook.js";
import { assessContinuityCompactionPressure } from "../../../continuity/compaction-pressure.js";
import {
  readContinuityActiveCounts,
  readContinuityCompactionPreviewStatusCounts,
  readContinuityEntries,
  readContinuityEntriesByIds as defaultReadContinuityEntriesByIds,
  type ContinuityEntryLifecycleRecord,
  type ContinuityEntryRecord,
} from "./continuity-store.js";
import type { ContinuityVectorEmbedder } from "./continuity-vector-embedder.js";
import {
  searchContinuityVectorEntries as defaultSearchContinuityVectorEntries,
  type SearchContinuityVectorEntriesResult,
} from "./continuity-vector-store.js";

const CONTINUITY_SECTION_VALUES: ContinuitySection[] = [
  "PLANS",
  "DECISIONS",
  "PROGRESS",
  "DISCOVERIES",
  "OUTCOMES",
];
const CONTINUITY_BRIEFING_SCAN_LIMIT = 180;
const CONTINUITY_BRIEFING_RECENT_BASELINE = 3;
const CONTINUITY_BRIEFING_MAX_ENTRIES = 10;
const CONTINUITY_BRIEFING_MAX_CONTENT_LENGTH = 180;
const CONTINUITY_BRIEFING_SEMANTIC_CANDIDATE_LIMIT = 50;
const CONTINUITY_BRIEFING_SEMANTIC_MIN_ENTRIES = 0;
const CONTINUITY_BRIEFING_SEMANTIC_MAX_ENTRIES = 10;
const CONTINUITY_BRIEFING_SEMANTIC_WINDOW_PERCENTAGE_POINTS = 10;
const CONTINUITY_BRIEFING_SEMANTIC_CONFIDENCE_FLOOR_PERCENT = 65;

/**
 * Continuity briefing mode selected by project config/env.
 */
export type ContinuityBriefingRetrievalMode = "lexical" | "semantic";

/**
 * One continuity entry shape used by the renderer.
 */
interface ContinuityBriefingEntry {
  timestamp: string;
  section: ContinuitySection;
  provenance: ContinuityProvenance;
  certainty: ContinuityCertainty;
  content: string;
}

/**
 * Semantic candidate after vector hit hydration and lifecycle filtering.
 */
interface SemanticContinuityCandidate {
  entry: ContinuityEntryLifecycleRecord;
  semanticPercent: number;
}

/**
 * Optional dependencies used by tests and runtime vector injection.
 */
export interface ContinuityBriefingDependencies {
  /** Embedder required only when semantic mode is selected. */
  continuityVectorEmbedder?: ContinuityVectorEmbedder;
  /** Entry hydrator override for tests. */
  readContinuityEntriesByIds?: typeof defaultReadContinuityEntriesByIds;
  /** Semantic search override for tests/runtime provider injection. */
  searchContinuityVectorEntries?: (input: {
    databasePath: string;
    embedder: ContinuityVectorEmbedder;
    queryText: string;
    limit?: number;
  }) => Promise<SearchContinuityVectorEntriesResult>;
}

/**
 * Input for building one prompt-scoped continuity briefing.
 */
export interface BuildContinuityBriefingInput {
  /** Project user continuity DB path. */
  databasePath: string;
  /** Normalized current user prompt text. */
  signalText: string;
  /** Bounded prompt tokens used for lexical matching and diagnostics. */
  signalTokens: string[];
  /** Retrieval mode selected by config/env. */
  mode: ContinuityBriefingRetrievalMode;
}

/**
 * Normalize continuity text for deterministic clipping and identity keys.
 */
const normalizeBriefingContent = (content: string): string => content.trim().replace(/\s+/g, " ");

/**
 * Clip continuity content so the prompt-scoped briefing remains bounded.
 */
const clipContinuityBriefingContent = (content: string): string => {
  const normalized = normalizeBriefingContent(content);
  return normalized.length <= CONTINUITY_BRIEFING_MAX_CONTENT_LENGTH
    ? normalized
    : `${normalized.slice(0, CONTINUITY_BRIEFING_MAX_CONTENT_LENGTH - 1).trimEnd()}…`;
};

/**
 * Format semantic relevance percentages for LLM-readable rows.
 */
const formatSemanticPercent = (percent: number): string => `${Math.round(Math.max(0, Math.min(100, percent)))}%`;

/**
 * Build a stable identity key for exact continuity row de-duplication while selecting rows.
 */
const buildContinuityBriefingIdentityKey = (input: ContinuityBriefingEntry): string => [
  input.timestamp.trim(),
  input.section,
  input.provenance,
  input.certainty,
  normalizeBriefingContent(input.content),
].join("\u001F");

/**
 * Build compaction metadata shared by lexical and semantic briefing renderers.
 */
const buildContinuityBriefingState = (input: {
  databasePath: string;
  fallbackEntries: ContinuityEntryRecord[];
}) => {
  const fallbackSectionCounts = CONTINUITY_SECTION_VALUES.reduce((accumulator, section) => {
    accumulator[section] = 0;
    return accumulator;
  }, { PLANS: 0, DECISIONS: 0, PROGRESS: 0, DISCOVERIES: 0, OUTCOMES: 0 } as Record<ContinuitySection, number>);

  for (const entry of input.fallbackEntries) {
    fallbackSectionCounts[entry.section] += 1;
  }

  const activeCounts = readContinuityActiveCounts({ databasePath: input.databasePath });
  const previewCounts = readContinuityCompactionPreviewStatusCounts({ databasePath: input.databasePath });
  const compactionPressure = assessContinuityCompactionPressure({
    activeEntryCount: activeCounts.status === "ok" ? activeCounts.activeEntryCount : input.fallbackEntries.length,
    sectionCounts: activeCounts.status === "ok" ? activeCounts.sectionCounts : fallbackSectionCounts,
    pendingPreviewCount: previewCounts.status === "ok" ? previewCounts.approvedCount + previewCounts.approvedWithAdvisoriesCount : 0,
  });

  return {
    compactionPressure,
    pendingPreviewCount: previewCounts.status === "ok"
      ? previewCounts.approvedCount + previewCounts.approvedWithAdvisoriesCount
      : 0,
    compactionReasonText: compactionPressure.reasons.length > 0 ? compactionPressure.reasons.join(",") : "none",
  };
};

/**
 * Render one lexical continuity entry line.
 */
const renderContinuityEntryLine = (entry: ContinuityBriefingEntry): string => {
  const certaintyPrefix = entry.certainty === "UNCONFIRMED" ? "UNCONFIRMED " : "";
  return `- ${entry.timestamp} [${entry.section}] [${entry.provenance}] ${certaintyPrefix}${clipContinuityBriefingContent(entry.content)}`;
};

/**
 * Render dynamic retrieval action guidance from coverage state.
 */
const renderContinuityActionLine = (moreAvailable: boolean): string => moreAvailable
  ? "ACTION REQUIRED: You MUST call targeted continuity_query before answering because this briefing may be incomplete or conflicting."
  : "ACTION: Do not call continuity_query unless the visible entries are conflicting or incomplete for the exact requested fact.";

/**
 * Build the lexical DB-first continuity briefing used as fallback/control mode.
 */
const buildLexicalContinuityBriefing = (briefingInput: {
  databasePath: string;
  signalTokens: string[];
}): string => {
  const entries = readContinuityEntries({
    databasePath: briefingInput.databasePath,
    limit: CONTINUITY_BRIEFING_SCAN_LIMIT,
  });

  const { compactionPressure, pendingPreviewCount, compactionReasonText } = buildContinuityBriefingState({
    databasePath: briefingInput.databasePath,
    fallbackEntries: entries,
  });

  if (entries.length === 0) {
    const totalRows = compactionPressure.activeEntryCount;
    const omittedRows = Math.max(totalRows, 0);
    const moreAvailable = omittedRows > 0;
    return [
      "TURN CONTINUITY BRIEFING (DB-first, preloaded by extension for this user prompt): no continuity rows were found in the project DB.",
      `compaction_pressure=${compactionPressure.level}; compaction_recommended=${compactionPressure.recommended ? "true" : "false"}; active_entries=${compactionPressure.activeEntryCount}; pending_previews=${pendingPreviewCount}; reasons=${compactionReasonText}`,
      `coverage: continuity shown=0 total=${totalRows} omitted=${omittedRows} newest=none oldest=none scanned=0 scan_limit=${CONTINUITY_BRIEFING_SCAN_LIMIT}; retrieval=bounded more_available=${moreAvailable ? "true" : "false"}; exhaustive=${moreAvailable ? "false" : "true"}; deeper_search_recommended=${moreAvailable ? "true" : "false"}; deeper_query_recommended=${moreAvailable ? "true" : "false"}`,
      renderContinuityActionLine(moreAvailable),
    ].join("\n");
  }

  const matched = briefingInput.signalTokens.length === 0 ? [] : entries.filter((entry) => {
    const haystack = `${entry.section} ${entry.provenance} ${entry.content}`.toLowerCase();
    return briefingInput.signalTokens.some((token) => haystack.includes(token));
  });

  const selected: ContinuityBriefingEntry[] = [];
  const selectedKeys = new Set<string>();
  const pushEntries = (rows: typeof entries): void => {
    for (const row of rows) {
      if (selected.length >= CONTINUITY_BRIEFING_MAX_ENTRIES) return;
      const key = buildContinuityBriefingIdentityKey(row);
      if (selectedKeys.has(key)) continue;
      selectedKeys.add(key);
      selected.push(row);
    }
  };

  pushEntries(entries.slice(0, CONTINUITY_BRIEFING_RECENT_BASELINE));
  pushEntries(matched);
  if (selected.length === 0) pushEntries(entries);

  const querySignals = briefingInput.signalTokens.length > 0 ? briefingInput.signalTokens.join(", ") : "none";
  const displayRows = selected.slice(0, CONTINUITY_BRIEFING_MAX_ENTRIES);
  const lines = displayRows.map(renderContinuityEntryLine);

  const totalRows = compactionPressure.activeEntryCount;
  const shownRows = displayRows.length;
  const omittedRows = Math.max(totalRows - shownRows, 0);
  const scannedRows = entries.length;
  const scannedTimestamps = entries.map((entry) => entry.timestamp).filter((timestamp) => timestamp.length > 0).sort((left, right) => left.localeCompare(right));
  const newestTimestamp = scannedTimestamps.length > 0 ? scannedTimestamps[scannedTimestamps.length - 1] : "none";
  const oldestTimestamp = scannedTimestamps.length > 0 ? scannedTimestamps[0] : "none";
  const scanMayBeTruncated = scannedRows >= CONTINUITY_BRIEFING_SCAN_LIMIT && totalRows > scannedRows;
  const moreAvailable = omittedRows > 0 || scanMayBeTruncated;
  const exhaustive = !moreAvailable;
  const deeperSearchRecommended = moreAvailable;

  return [
    "TURN CONTINUITY BRIEFING (preloaded by extension for the current user prompt):",
    `compaction_pressure=${compactionPressure.level}; compaction_recommended=${compactionPressure.recommended ? "true" : "false"}; active_entries=${compactionPressure.activeEntryCount}; pending_previews=${pendingPreviewCount}; reasons=${compactionReasonText}`,
    `coverage: continuity shown=${shownRows} total=${totalRows} omitted=${omittedRows} newest=${newestTimestamp} oldest=${oldestTimestamp} scanned=${scannedRows} scan_limit=${CONTINUITY_BRIEFING_SCAN_LIMIT}; retrieval=bounded more_available=${moreAvailable ? "true" : "false"}; exhaustive=${exhaustive ? "true" : "false"}; deeper_search_recommended=${deeperSearchRecommended ? "true" : "false"}; deeper_query_recommended=${deeperSearchRecommended ? "true" : "false"}`,
    `query_signals=${querySignals}`,
    "Use this as bounded continuity context.",
    renderContinuityActionLine(moreAvailable),
    "",
    ...lines,
  ].join("\n").trimEnd();
};

/**
 * Build the semantic continuity briefing when vector retrieval is available.
 */
const buildSemanticContinuityBriefing = async (
  briefingInput: BuildContinuityBriefingInput,
  dependencies: ContinuityBriefingDependencies,
): Promise<string | null> => {
  const queryText = briefingInput.signalText.trim();
  const embedder = dependencies.continuityVectorEmbedder;
  if (!embedder || queryText.length === 0) {
    return null;
  }

  const searchContinuityVectorEntries = dependencies.searchContinuityVectorEntries || defaultSearchContinuityVectorEntries;
  const semanticSearch = await searchContinuityVectorEntries({
    databasePath: briefingInput.databasePath,
    embedder,
    queryText,
    limit: CONTINUITY_BRIEFING_SEMANTIC_CANDIDATE_LIMIT,
  });

  if (semanticSearch.status !== "ok" || semanticSearch.results.length === 0) {
    return null;
  }

  const fallbackEntries = readContinuityEntries({
    databasePath: briefingInput.databasePath,
    limit: CONTINUITY_BRIEFING_SCAN_LIMIT,
  });
  const { compactionPressure, pendingPreviewCount, compactionReasonText } = buildContinuityBriefingState({
    databasePath: briefingInput.databasePath,
    fallbackEntries,
  });

  const readContinuityEntriesByIds = dependencies.readContinuityEntriesByIds || defaultReadContinuityEntriesByIds;
  const hydratedRows = readContinuityEntriesByIds({
    databasePath: briefingInput.databasePath,
    entryIds: semanticSearch.results.map((hit) => hit.entryId),
  });
  const entryById = new Map(hydratedRows.map((entry) => [entry.id, entry]));
  const candidates: SemanticContinuityCandidate[] = semanticSearch.results
    .map((hit) => {
      const entry = entryById.get(hit.entryId);
      if (!entry || entry.compactedIntoEntryId || entry.supersededByEntryId) {
        return null;
      }

      return {
        entry,
        semanticPercent: Math.max(0, Math.min(100, hit.similarity * 100)),
      };
    })
    .filter((candidate): candidate is SemanticContinuityCandidate => candidate !== null)
    .sort((left, right) => right.semanticPercent - left.semanticPercent || right.entry.timestamp.localeCompare(left.entry.timestamp));

  if (candidates.length === 0) {
    return null;
  }

  const topSemanticPercent = candidates[0].semanticPercent;
  const semanticCutoffPercent = Math.max(0, topSemanticPercent - CONTINUITY_BRIEFING_SEMANTIC_WINDOW_PERCENTAGE_POINTS);
  const semanticFloorMet = topSemanticPercent >= CONTINUITY_BRIEFING_SEMANTIC_CONFIDENCE_FLOOR_PERCENT;
  const selectionBasis = semanticFloorMet ? "semantic_window" : "low_confidence_top_k";
  const selectableCandidates = semanticFloorMet
    ? candidates.filter((candidate) => candidate.semanticPercent >= semanticCutoffPercent)
    : candidates;
  const selected = selectableCandidates.slice(0, CONTINUITY_BRIEFING_SEMANTIC_MAX_ENTRIES);
  const omittedRows = Math.max(selectableCandidates.length - selected.length, 0);
  const candidateLimitReached = semanticSearch.results.length >= CONTINUITY_BRIEFING_SEMANTIC_CANDIDATE_LIMIT;
  const lastCandidateSemanticPercent = candidates[candidates.length - 1]?.semanticPercent ?? 0;
  const candidateLimitMayHideRows = candidateLimitReached && (!semanticFloorMet || lastCandidateSemanticPercent >= semanticCutoffPercent);

  const querySignals = briefingInput.signalTokens.length > 0 ? briefingInput.signalTokens.join(", ") : "none";
  const lines = selected.map((candidate) => {
    const certaintyPrefix = candidate.entry.certainty === "UNCONFIRMED" ? "UNCONFIRMED " : "";
    return `- semantic=${formatSemanticPercent(candidate.semanticPercent)} ${candidate.entry.timestamp} [${candidate.entry.section}] [${candidate.entry.provenance}] ${certaintyPrefix}${clipContinuityBriefingContent(candidate.entry.content)}`;
  });

  const shownRows = selected.length;
  const selectedTimestamps = selected.map((candidate) => candidate.entry.timestamp).filter((timestamp) => timestamp.length > 0).sort((left, right) => left.localeCompare(right));
  const newestTimestamp = selectedTimestamps.length > 0 ? selectedTimestamps[selectedTimestamps.length - 1] : "none";
  const oldestTimestamp = selectedTimestamps.length > 0 ? selectedTimestamps[0] : "none";
  const deeperSearchRecommended = !semanticFloorMet || omittedRows > 0 || candidateLimitMayHideRows;
  const exhaustive = !deeperSearchRecommended;

  return [
    "TURN CONTINUITY BRIEFING (semantic DB vector retrieval, preloaded by extension for the current user prompt):",
    `compaction_pressure=${compactionPressure.level}; compaction_recommended=${compactionPressure.recommended ? "true" : "false"}; active_entries=${compactionPressure.activeEntryCount}; pending_previews=${pendingPreviewCount}; reasons=${compactionReasonText}`,
    `coverage: continuity shown=${shownRows} total=${selectableCandidates.length} omitted=${omittedRows} newest=${newestTimestamp} oldest=${oldestTimestamp} scanned=${candidates.length} scan_limit=${CONTINUITY_BRIEFING_SEMANTIC_CANDIDATE_LIMIT}; retrieval=semantic quality_basis=vector_similarity semantic_top=${formatSemanticPercent(topSemanticPercent)} semantic_cutoff=${formatSemanticPercent(semanticCutoffPercent)} semantic_window=${CONTINUITY_BRIEFING_SEMANTIC_WINDOW_PERCENTAGE_POINTS}pp semantic_floor=${formatSemanticPercent(CONTINUITY_BRIEFING_SEMANTIC_CONFIDENCE_FLOOR_PERCENT)} semantic_floor_met=${semanticFloorMet ? "true" : "false"} semantic_confidence=${semanticFloorMet ? "normal" : "low"} selection_basis=${selectionBasis} min_entries=${CONTINUITY_BRIEFING_SEMANTIC_MIN_ENTRIES} max_entries=${CONTINUITY_BRIEFING_SEMANTIC_MAX_ENTRIES} candidate_limit_reached=${candidateLimitReached ? "true" : "false"} last_candidate_semantic=${formatSemanticPercent(lastCandidateSemanticPercent)} more_available=${deeperSearchRecommended ? "true" : "false"}; exhaustive=${exhaustive ? "true" : "false"}; deeper_search_recommended=${deeperSearchRecommended ? "true" : "false"}; deeper_query_recommended=${deeperSearchRecommended ? "true" : "false"}`,
    `query_signals=${querySignals}`,
    "Use this as bounded continuity context.",
    renderContinuityActionLine(deeperSearchRecommended),
    "",
    ...lines,
  ].join("\n").trimEnd();
};

/**
 * Build continuity briefing text for prompt-scoped system prompt augmentation.
 */
export const buildContinuityBriefing = async (
  input: BuildContinuityBriefingInput,
  dependencies: ContinuityBriefingDependencies = {},
): Promise<string> => {
  if (input.mode === "semantic") {
    const semanticBriefing = await buildSemanticContinuityBriefing(input, dependencies);
    if (semanticBriefing) {
      return semanticBriefing;
    }
  }

  return buildLexicalContinuityBriefing({
    databasePath: input.databasePath,
    signalTokens: input.signalTokens,
  });
};
