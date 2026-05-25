/**
 * File intent: render continuity prompt briefings from L0 data-adapter rows.
 */

import type {
  ContinuityWriteRequest,
  PromptBriefingRequest,
} from "../contracts.js";
import type {
  ContinuityDataAdapterPort,
  CoreContinuitySectionCounts,
} from "../ports.js";

const CONTINUITY_SECTION_VALUES: ContinuityWriteRequest["section"][] = [
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
const MEDIUM_ACTIVE_ENTRY_PRESSURE = 160;
const HIGH_ACTIVE_ENTRY_PRESSURE = 220;
const MEDIUM_SECTION_ENTRY_PRESSURE = 45;
const HIGH_SECTION_ENTRY_PRESSURE = 65;

type ContinuitySection = ContinuityWriteRequest["section"];
type ContinuityCertainty = NonNullable<ContinuityWriteRequest["certainty"]>;
type ContinuityProvenance = ContinuityWriteRequest["provenance"];

interface ContinuityBriefingEntry {
  id?: string;
  timestamp: string;
  section: ContinuitySection;
  provenance: ContinuityProvenance;
  certainty: ContinuityCertainty;
  content: string;
  compacted?: boolean;
}

interface SemanticContinuityCandidate {
  entry: ContinuityBriefingEntry;
  semanticPercent: number;
}

/**
 * Normalize continuity text for deterministic clipping and identity keys.
 */
const normalizeContinuityContent = (content: string): string => content.trim().replace(/\s+/g, " ");

/**
 * Clip continuity content so the prompt-scoped briefing remains bounded.
 */
const clipContinuityContent = (content: string): string => {
  const normalized = normalizeContinuityContent(content);
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
const buildContinuityIdentityKey = (input: ContinuityBriefingEntry): string => [
  input.timestamp.trim(),
  input.section,
  input.provenance,
  input.certainty,
  normalizeContinuityContent(input.content),
].join("\u001F");

/**
 * Render one lexical continuity entry line.
 */
const renderContinuityEntryLine = (entry: ContinuityBriefingEntry): string => {
  const certaintyPrefix = entry.certainty === "UNCONFIRMED" ? "UNCONFIRMED " : "";
  return `- ${entry.timestamp} [${entry.section}] [${entry.provenance}] ${certaintyPrefix}${clipContinuityContent(entry.content)}`;
};

/**
 * Render dynamic retrieval action guidance from coverage state.
 */
const renderContinuityActionLine = (moreAvailable: boolean): string => moreAvailable
  ? "ACTION REQUIRED: You MUST call targeted continuity_query before answering because this briefing may be incomplete or conflicting."
  : "ACTION: Do not call continuity_query unless the visible entries are conflicting or incomplete for the exact requested fact.";

/**
 * Build baseline zero section counts.
 */
const buildEmptySectionCounts = (): CoreContinuitySectionCounts => ({
  PLANS: 0,
  DECISIONS: 0,
  PROGRESS: 0,
  DISCOVERIES: 0,
  OUTCOMES: 0,
});

/**
 * Count active continuity rows by section from an entry sample.
 */
const countSections = (entries: ContinuityBriefingEntry[]): CoreContinuitySectionCounts => {
  const counts = buildEmptySectionCounts();
  for (const entry of entries) counts[entry.section] += 1;
  return counts;
};

/**
 * Assess compaction pressure for active continuity rows.
 */
const assessCompactionPressure = (input: {
  activeEntryCount: number;
  sectionCounts: CoreContinuitySectionCounts;
  pendingPreviewCount: number;
}) => {
  const highPressureSections = CONTINUITY_SECTION_VALUES
    .filter((section) => input.sectionCounts[section] >= HIGH_SECTION_ENTRY_PRESSURE);
  const mediumPressureSections = CONTINUITY_SECTION_VALUES
    .filter((section) => input.sectionCounts[section] >= MEDIUM_SECTION_ENTRY_PRESSURE)
    .filter((section) => !highPressureSections.includes(section));
  const reasons: string[] = [];
  let level: "low" | "medium" | "high" = "low";

  if (input.activeEntryCount >= HIGH_ACTIVE_ENTRY_PRESSURE) {
    level = "high";
    reasons.push("pressure.active_entries.high");
  } else if (input.activeEntryCount >= MEDIUM_ACTIVE_ENTRY_PRESSURE) {
    level = "medium";
    reasons.push("pressure.active_entries.medium");
  }

  if (highPressureSections.length > 0) {
    level = "high";
    reasons.push("pressure.section_counts.high");
  } else if (mediumPressureSections.length > 0 && level === "low") {
    level = "medium";
    reasons.push("pressure.section_counts.medium");
  }

  if (input.pendingPreviewCount > 0) {
    if (level === "low") level = "medium";
    reasons.push("pressure.preview_pending");
  }

  return {
    level,
    recommended: level !== "low" || input.pendingPreviewCount > 0,
    reasons: Array.from(new Set(reasons)),
    activeEntryCount: input.activeEntryCount,
  };
};

/**
 * Read active continuity entries for prompt briefing selection.
 */
const readContinuityBriefingEntries = async (input: {
  continuityData: ContinuityDataAdapterPort;
  request: PromptBriefingRequest;
}): Promise<ContinuityBriefingEntry[]> => {
  const result = await input.continuityData.query({
    context: input.request.context,
    query: "",
    limit: CONTINUITY_BRIEFING_SCAN_LIMIT,
    includeCompacted: false,
  });
  if (result.status === "error") return [];

  return result.entries.map((entry): ContinuityBriefingEntry => ({
    id: entry.id,
    timestamp: entry.timestamp,
    section: entry.section,
    provenance: entry.provenance,
    certainty: entry.certainty,
    content: entry.content,
    compacted: entry.compacted,
  }));
};

/**
 * Build continuity briefing state from exact adapter data when available.
 */
const buildContinuityState = async (input: {
  continuityData: ContinuityDataAdapterPort;
  request: PromptBriefingRequest;
  fallbackEntries: ContinuityBriefingEntry[];
}) => {
  if (input.continuityData.readBriefingState) {
    const state = await input.continuityData.readBriefingState({ context: input.request.context });
    if (state.status !== "error") {
      const compactionPressure = assessCompactionPressure({
        activeEntryCount: state.activeEntryCount,
        sectionCounts: state.sectionCounts,
        pendingPreviewCount: state.pendingPreviewCount,
      });
      return {
        compactionPressure,
        pendingPreviewCount: state.pendingPreviewCount,
        compactionReasonText: compactionPressure.reasons.length > 0 ? compactionPressure.reasons.join(",") : "none",
      };
    }
  }

  const status = await input.continuityData.readStatus({
    context: input.request.context,
    scope: "continuity",
  });
  const pendingPreviewCount = 0;
  const compactionPressure = assessCompactionPressure({
    activeEntryCount: status.status === "error" ? input.fallbackEntries.length : status.activeCount,
    sectionCounts: countSections(input.fallbackEntries),
    pendingPreviewCount,
  });
  return {
    compactionPressure,
    pendingPreviewCount,
    compactionReasonText: compactionPressure.reasons.length > 0 ? compactionPressure.reasons.join(",") : "none",
  };
};

/**
 * Build the lexical DB-first continuity briefing used as fallback/control mode.
 */
const buildLexicalContinuityBriefing = async (input: {
  continuityData: ContinuityDataAdapterPort;
  request: PromptBriefingRequest;
  signalTokens: string[];
}): Promise<string> => {
  const entries = await readContinuityBriefingEntries(input);
  const { compactionPressure, pendingPreviewCount, compactionReasonText } = await buildContinuityState({
    ...input,
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

  const matched = input.signalTokens.length === 0 ? [] : entries.filter((entry) => {
    const haystack = `${entry.section} ${entry.provenance} ${entry.content}`.toLowerCase();
    return input.signalTokens.some((token) => haystack.includes(token));
  });
  const selected: ContinuityBriefingEntry[] = [];
  const selectedKeys = new Set<string>();
  const pushEntries = (rows: ContinuityBriefingEntry[]): void => {
    for (const row of rows) {
      if (selected.length >= CONTINUITY_BRIEFING_MAX_ENTRIES) return;
      const key = buildContinuityIdentityKey(row);
      if (selectedKeys.has(key)) continue;
      selectedKeys.add(key);
      selected.push(row);
    }
  };

  pushEntries(entries.slice(0, CONTINUITY_BRIEFING_RECENT_BASELINE));
  pushEntries(matched);
  if (selected.length === 0) pushEntries(entries);

  const querySignals = input.signalTokens.length > 0 ? input.signalTokens.join(", ") : "none";
  const displayRows = selected.slice(0, CONTINUITY_BRIEFING_MAX_ENTRIES);
  const scannedTimestamps = entries.map((entry) => entry.timestamp).filter((timestamp) => timestamp.length > 0).sort((left, right) => left.localeCompare(right));
  const newestTimestamp = scannedTimestamps.length > 0 ? scannedTimestamps[scannedTimestamps.length - 1] : "none";
  const oldestTimestamp = scannedTimestamps.length > 0 ? scannedTimestamps[0] : "none";
  const totalRows = compactionPressure.activeEntryCount;
  const omittedRows = Math.max(totalRows - displayRows.length, 0);
  const scanMayBeTruncated = entries.length >= CONTINUITY_BRIEFING_SCAN_LIMIT && totalRows > entries.length;
  const moreAvailable = omittedRows > 0 || scanMayBeTruncated;

  return [
    "TURN CONTINUITY BRIEFING (preloaded by extension for the current user prompt):",
    `compaction_pressure=${compactionPressure.level}; compaction_recommended=${compactionPressure.recommended ? "true" : "false"}; active_entries=${compactionPressure.activeEntryCount}; pending_previews=${pendingPreviewCount}; reasons=${compactionReasonText}`,
    `coverage: continuity shown=${displayRows.length} total=${totalRows} omitted=${omittedRows} newest=${newestTimestamp} oldest=${oldestTimestamp} scanned=${entries.length} scan_limit=${CONTINUITY_BRIEFING_SCAN_LIMIT}; retrieval=bounded more_available=${moreAvailable ? "true" : "false"}; exhaustive=${moreAvailable ? "false" : "true"}; deeper_search_recommended=${moreAvailable ? "true" : "false"}; deeper_query_recommended=${moreAvailable ? "true" : "false"}`,
    `query_signals=${querySignals}`,
    "Use this as bounded continuity context.",
    renderContinuityActionLine(moreAvailable),
    "",
    ...displayRows.map(renderContinuityEntryLine),
  ].join("\n").trimEnd();
};

/**
 * Build the semantic continuity briefing when vector retrieval is available.
 */
const buildSemanticContinuityBriefing = async (input: {
  continuityData: ContinuityDataAdapterPort;
  request: PromptBriefingRequest;
  signalText: string;
  signalTokens: string[];
}): Promise<string | null> => {
  const queryText = input.signalText.trim();
  if (!input.continuityData.searchBriefingEntries || queryText.length === 0) return null;

  const semanticSearch = await input.continuityData.searchBriefingEntries({
    context: input.request.context,
    queryText,
    limit: CONTINUITY_BRIEFING_SEMANTIC_CANDIDATE_LIMIT,
  });
  if (semanticSearch.status !== "ok" || semanticSearch.hits.length === 0) return null;

  const fallbackEntries = await readContinuityBriefingEntries(input);
  const { compactionPressure, pendingPreviewCount, compactionReasonText } = await buildContinuityState({
    ...input,
    fallbackEntries,
  });
  const candidates: SemanticContinuityCandidate[] = semanticSearch.hits
    .map((hit) => ({
      entry: {
        id: hit.record.id,
        timestamp: hit.record.timestamp,
        section: hit.record.section,
        provenance: hit.record.provenance,
        certainty: hit.record.certainty,
        content: hit.record.content,
        compacted: hit.record.compacted,
      },
      semanticPercent: Math.max(0, Math.min(100, hit.semanticSimilarity * 100)),
    }))
    .filter((candidate) => !candidate.entry.compacted)
    .sort((left, right) => right.semanticPercent - left.semanticPercent || right.entry.timestamp.localeCompare(left.entry.timestamp));
  if (candidates.length === 0) return null;

  const topSemanticPercent = candidates[0].semanticPercent;
  const semanticCutoffPercent = Math.max(0, topSemanticPercent - CONTINUITY_BRIEFING_SEMANTIC_WINDOW_PERCENTAGE_POINTS);
  const semanticFloorMet = topSemanticPercent >= CONTINUITY_BRIEFING_SEMANTIC_CONFIDENCE_FLOOR_PERCENT;
  const selectionBasis = semanticFloorMet ? "semantic_window" : "low_confidence_top_k";
  const selectableCandidates = semanticFloorMet
    ? candidates.filter((candidate) => candidate.semanticPercent >= semanticCutoffPercent)
    : candidates;
  const selected = selectableCandidates.slice(0, CONTINUITY_BRIEFING_SEMANTIC_MAX_ENTRIES);
  const omittedRows = Math.max(selectableCandidates.length - selected.length, 0);
  const candidateLimitReached = semanticSearch.hits.length >= CONTINUITY_BRIEFING_SEMANTIC_CANDIDATE_LIMIT;
  const lastCandidateSemanticPercent = candidates[candidates.length - 1]?.semanticPercent ?? 0;
  const candidateLimitMayHideRows = candidateLimitReached && (!semanticFloorMet || lastCandidateSemanticPercent >= semanticCutoffPercent);

  const selectedTimestamps = selected.map((candidate) => candidate.entry.timestamp).filter((timestamp) => timestamp.length > 0).sort((left, right) => left.localeCompare(right));
  const newestTimestamp = selectedTimestamps.length > 0 ? selectedTimestamps[selectedTimestamps.length - 1] : "none";
  const oldestTimestamp = selectedTimestamps.length > 0 ? selectedTimestamps[0] : "none";
  const deeperSearchRecommended = !semanticFloorMet || omittedRows > 0 || candidateLimitMayHideRows;
  const renderedRows = selected.map((candidate) => {
    const certaintyPrefix = candidate.entry.certainty === "UNCONFIRMED" ? "UNCONFIRMED " : "";
    return `- semantic=${formatSemanticPercent(candidate.semanticPercent)} ${candidate.entry.timestamp} [${candidate.entry.section}] [${candidate.entry.provenance}] ${certaintyPrefix}${clipContinuityContent(candidate.entry.content)}`;
  });

  return [
    "TURN CONTINUITY BRIEFING (semantic DB vector retrieval, preloaded by extension for the current user prompt):",
    `compaction_pressure=${compactionPressure.level}; compaction_recommended=${compactionPressure.recommended ? "true" : "false"}; active_entries=${compactionPressure.activeEntryCount}; pending_previews=${pendingPreviewCount}; reasons=${compactionReasonText}`,
    `coverage: continuity shown=${selected.length} total=${selectableCandidates.length} omitted=${omittedRows} newest=${newestTimestamp} oldest=${oldestTimestamp} scanned=${candidates.length} scan_limit=${CONTINUITY_BRIEFING_SEMANTIC_CANDIDATE_LIMIT}; retrieval=semantic quality_basis=vector_similarity semantic_top=${formatSemanticPercent(topSemanticPercent)} semantic_cutoff=${formatSemanticPercent(semanticCutoffPercent)} semantic_window=${CONTINUITY_BRIEFING_SEMANTIC_WINDOW_PERCENTAGE_POINTS}pp semantic_floor=${formatSemanticPercent(CONTINUITY_BRIEFING_SEMANTIC_CONFIDENCE_FLOOR_PERCENT)} semantic_floor_met=${semanticFloorMet ? "true" : "false"} semantic_confidence=${semanticFloorMet ? "normal" : "low"} selection_basis=${selectionBasis} min_entries=${CONTINUITY_BRIEFING_SEMANTIC_MIN_ENTRIES} max_entries=${CONTINUITY_BRIEFING_SEMANTIC_MAX_ENTRIES} candidate_limit_reached=${candidateLimitReached ? "true" : "false"} last_candidate_semantic=${formatSemanticPercent(lastCandidateSemanticPercent)} more_available=${deeperSearchRecommended ? "true" : "false"}; exhaustive=${deeperSearchRecommended ? "false" : "true"}; deeper_search_recommended=${deeperSearchRecommended ? "true" : "false"}; deeper_query_recommended=${deeperSearchRecommended ? "true" : "false"}`,
    `query_signals=${input.signalTokens.length > 0 ? input.signalTokens.join(", ") : "none"}`,
    "Use this as bounded continuity context.",
    renderContinuityActionLine(deeperSearchRecommended),
    "",
    ...renderedRows,
  ].join("\n").trimEnd();
};

/**
 * Build continuity briefing text for prompt-scoped system prompt augmentation.
 */
export const buildContinuityPromptBriefing = async (input: {
  continuityData: ContinuityDataAdapterPort;
  request: PromptBriefingRequest;
  signalText: string;
  signalTokens: string[];
}): Promise<string> => {
  if (input.request.continuityMode === "semantic") {
    const semanticBriefing = await buildSemanticContinuityBriefing(input);
    if (semanticBriefing) return semanticBriefing;
  }

  return buildLexicalContinuityBriefing(input);
};
