/**
 * File intent: own host-neutral L2 project-index retrieval orchestration.
 *
 * This service is responsible for cross-member project retrieval policy and
 * LLM-facing result rendering. Concrete cache/fan-out/index persistence stays
 * behind `ProjectIndexDataAdapterPort`.
 */

import type {
  ContinuityQueryRequest,
  CoreTextResult,
  MemoryOperationResult,
  MemoryRecallRequest,
  MemorySearchRequest,
} from "../contracts.js";
import type {
  CoreProjectIndexContinuityMilestoneHit,
  CoreProjectIndexHit,
  ProjectIndexDataAdapterPort,
  TelemetryPort,
} from "../ports.js";

const CONTINUITY_SECTION_VALUES = [
  "PLANS",
  "DECISIONS",
  "PROGRESS",
  "DISCOVERIES",
  "OUTCOMES",
] as const;

const CONTINUITY_QUERY_COMPACTION_NOISE_MIN_LEXICAL_MATCH = 0.35;
const CONTINUITY_QUERY_COMPACTION_NOISE_RATIO_THRESHOLD = 0.55;
const CONTINUITY_QUERY_COMPACTION_NOISE_MIN_RESULTS = 6;
const CONTINUITY_QUERY_COMPACTION_NOISE_STREAK_TRIGGER = 2;

/**
 * Dependencies needed by L2 project-index retrieval orchestration.
 */
export interface ProjectIndexRetrievalServiceDependencies {
  /** Non-vendor L2 project-index data adapter. */
  projectIndexData: Pick<ProjectIndexDataAdapterPort, "search">;
  /** Optional telemetry provider for continuity query outcome events. */
  telemetry?: Pick<TelemetryPort, "record">;
}

/**
 * Normalize text for lexical retrieval and result diagnostics.
 */
const normalizeText = (value: string | undefined): string =>
  (value || "").trim().replace(/\s+/g, " ");

/**
 * Normalize continuity section labels accepted by tool/core requests.
 */
const normalizeSection = (value: string | undefined): ContinuityQueryRequest["section"] | null => {
  if (!value) return null;
  const normalized = value.trim().replace(/^\[+/, "").replace(/\]+$/, "").trim().toUpperCase();
  return CONTINUITY_SECTION_VALUES.includes(normalized as (typeof CONTINUITY_SECTION_VALUES)[number])
    ? normalized as ContinuityQueryRequest["section"]
    : null;
};

/**
 * Clamp result limits to continuity/project-index runtime bounds.
 */
const normalizeLimit = (value: number | undefined, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), 100));
};

/**
 * Normalize optional timestamps to ISO strings.
 */
const normalizeTimestamp = (value: string | undefined): string | null => {
  if (!value || value.trim().length === 0) return null;
  const parsed = Date.parse(value.trim());
  return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
};

/**
 * Return true when one optional timestamp falls inside the requested range.
 */
const isWithinRange = (input: {
  timestamp?: string;
  fromTimestamp: string | null;
  toTimestamp: string | null;
}): boolean => {
  const timestamp = input.timestamp || "";
  if (input.fromTimestamp && timestamp < input.fromTimestamp) return false;
  if (input.toTimestamp && timestamp > input.toTimestamp) return false;
  return true;
};

/**
 * Build a text result whose diagnostics are directly usable as tool details.
 */
const buildTextResult = (input: {
  status: CoreTextResult["status"];
  text: string;
  details: Record<string, unknown>;
  warnings?: string[];
}): CoreTextResult => ({
  status: input.status,
  text: input.text,
  warnings: input.warnings || [],
  diagnostics: input.details,
});

/**
 * Build a memory operation result whose diagnostics are tool-details friendly.
 */
const buildMemoryResult = (input: {
  status: MemoryOperationResult["status"];
  text: string;
  details: Record<string, unknown>;
  warnings?: string[];
}): MemoryOperationResult => ({
  status: input.status,
  text: input.text,
  warnings: input.warnings || [],
  diagnostics: input.details,
});

/**
 * Tokenize continuity query text for compaction-noise hints.
 */
const tokenizeContinuityQueryText = (query: string): string[] =>
  normalizeText(query)
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);

/**
 * Compute a bounded lexical overlap score between query and content.
 */
const computeLexicalOverlapScore = (input: {
  queryTokens: string[];
  content: string;
}): number => {
  if (input.queryTokens.length === 0) return 0;

  const haystack = normalizeText(input.content).toLowerCase();
  if (!haystack) return 0;

  const hits = input.queryTokens.filter((token) => haystack.includes(token)).length;
  return Math.min(1, hits / input.queryTokens.length);
};

/**
 * Build non-blocking compaction guidance for noisy continuity result sets.
 */
export const buildProjectIndexContinuityCompactionHint = (input: {
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
  if (queryTokens.length === 0) return null;

  const lowLexicalMatchEntries = input.entries.filter((entry) =>
    computeLexicalOverlapScore({
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

  return {
    lexicalMatchThreshold: CONTINUITY_QUERY_COMPACTION_NOISE_MIN_LEXICAL_MATCH,
    noisyRatioThreshold: CONTINUITY_QUERY_COMPACTION_NOISE_RATIO_THRESHOLD,
    minimumResultCount: CONTINUITY_QUERY_COMPACTION_NOISE_MIN_RESULTS,
    totalEntries: input.entries.length,
    lowLexicalMatchEntries,
    lowLexicalMatchRatio,
    noisyResultSet,
    noisyStreak,
    recommendCompaction: noisyStreak >= CONTINUITY_QUERY_COMPACTION_NOISE_STREAK_TRIGGER,
  };
};

/**
 * Record continuity query telemetry without changing user-visible results.
 */
const recordContinuityQueryTelemetry = async (input: {
  telemetry?: Pick<TelemetryPort, "record">;
  request: ContinuityQueryRequest;
  valueText: string;
  valueA?: number;
  valueB?: number;
  payload: Record<string, unknown>;
}): Promise<void> => {
  if (!input.telemetry) return;

  try {
    await input.telemetry.record({
      context: input.request.context,
      eventType: "continuity_query",
      valueText: input.valueText,
      valueA: input.valueA,
      valueB: input.valueB,
      payloadJson: JSON.stringify(input.payload),
    });
  } catch {
    // Telemetry must never change continuity query semantics.
  }
};

/**
 * Render optional semantic similarity in upstream-compatible wording.
 */
const formatSimilarity = (similarity: number): string | null => {
  if (!Number.isFinite(similarity)) return null;
  return `${(Math.max(0, Math.min(1, similarity)) * 100).toFixed(1)}% match`;
};

/**
 * Render one project memory hit for L2 memory search/recall surfaces.
 */
const renderProjectMemoryHit = (hit: CoreProjectIndexHit): string => {
  const topic = hit.topic || "general";
  const timestamp = hit.timestamp || "unknown";
  const semanticText = typeof hit.semanticSimilarity === "number" ? formatSimilarity(hit.semanticSimilarity) : null;
  const metadata = semanticText ? `${semanticText}, ${timestamp}` : timestamp;
  return `[project/${topic}] (${metadata})\n${hit.content}`;
};

/**
 * Render project-lane memory search text from L2 hits.
 */
const renderProjectMemorySearchText = (input: {
  query: string;
  hits: CoreProjectIndexHit[];
}): string => {
  if (input.hits.length === 0) {
    return `Project memory lane (continuity excluded):\nNo project memories found for: "${input.query}"`;
  }

  return [
    `Project memory lane (continuity excluded):\nFound ${input.hits.length} project memories for "${input.query}":`,
    ...input.hits.map(renderProjectMemoryHit),
  ].join("\n\n---\n\n");
};

/**
 * Render project-lane memory recall text from L2 hits.
 */
const renderProjectMemoryRecallText = (input: {
  topic?: string;
  hits: CoreProjectIndexHit[];
}): string => {
  const topicLabel = input.topic ? ` (topic=${input.topic})` : "";
  if (input.hits.length === 0) {
    return `Project memory lane (continuity excluded)${topicLabel}:\nNo project memories found.`;
  }

  return [
    `Project memory lane (continuity excluded)${topicLabel}:\nFound ${input.hits.length} project memories:`,
    ...input.hits.map(renderProjectMemoryHit),
  ].join("\n\n---\n\n");
};

/**
 * Create L2 project-index retrieval orchestration around one data adapter.
 */
export const createProjectIndexRetrievalService = (
  dependencies: ProjectIndexRetrievalServiceDependencies,
): {
  memorySearch: (input: MemorySearchRequest) => Promise<MemoryOperationResult>;
  memoryRecall: (input: MemoryRecallRequest) => Promise<MemoryOperationResult>;
  continuityQuery: (input: ContinuityQueryRequest) => Promise<CoreTextResult>;
} => ({
  memorySearch: async (input: MemorySearchRequest): Promise<MemoryOperationResult> => {
    const query = normalizeText(input.query);
    if (!query) {
      return buildMemoryResult({
        status: "error",
        text: "memory_search project-index route requires a non-empty query.",
        details: { status: "error", route: "memory_search_project_index", reason: "invalid-query" },
      });
    }

    const limit = normalizeLimit(input.limit, 5);
    const result = await dependencies.projectIndexData.search({
      context: input.context,
      query,
      kindFilter: ["memory"],
      topic: input.topic,
      limit,
    });
    const hits = result.hits.filter((hit) => hit.kind === "memory").slice(0, limit);

    return buildMemoryResult({
      status: result.status,
      text: result.status === "error"
        ? `memory_search project-index route failed: ${result.warnings[0] || "unknown error"}`
        : renderProjectMemorySearchText({ query, hits }),
      details: {
        status: result.status === "error" ? "error" : "search-project-index",
        source: "l2",
        route: "memory_search_project_index",
        query,
        requestedTopicFilter: input.topic,
        projectHitCount: hits.length,
        requestedMode: result.requestedMode || null,
        effectiveMode: result.effectiveMode || null,
        degradedReason: result.degradedReason || null,
        databaseCount: result.databaseCount || 0,
        searchedDatabaseCount: result.searchedDatabaseCount || 0,
        continuityExcluded: true,
        ...result.diagnostics,
      },
      warnings: result.warnings,
    });
  },

  memoryRecall: async (input: MemoryRecallRequest): Promise<MemoryOperationResult> => {
    const limit = normalizeLimit(input.limit, 10);
    const result = await dependencies.projectIndexData.search({
      context: input.context,
      query: input.topic || "",
      kindFilter: ["memory"],
      topic: input.topic,
      limit,
    });
    const hits = result.hits.filter((hit) => hit.kind === "memory").slice(0, limit);

    return buildMemoryResult({
      status: result.status,
      text: result.status === "error"
        ? `memory_recall project-index route failed: ${result.warnings[0] || "unknown error"}`
        : renderProjectMemoryRecallText({ topic: input.topic, hits }),
      details: {
        status: result.status === "error" ? "error" : "recall-project-index",
        source: "l2",
        route: "memory_recall_project_index",
        requestedTopicFilter: input.topic,
        projectHitCount: hits.length,
        requestedMode: result.requestedMode || null,
        effectiveMode: result.effectiveMode || null,
        degradedReason: result.degradedReason || null,
        databaseCount: result.databaseCount || 0,
        searchedDatabaseCount: result.searchedDatabaseCount || 0,
        continuityExcluded: true,
        ...result.diagnostics,
      },
      warnings: result.warnings,
    });
  },

  continuityQuery: async (input: ContinuityQueryRequest): Promise<CoreTextResult> => {
    const limit = normalizeLimit(input.limit, 20);
    const queryText = normalizeText(input.query);
    const query = queryText.toLowerCase();
    const querySection = normalizeSection(input.section);

    if (input.section && !querySection) {
      return buildTextResult({
        status: "error",
        text: `continuity_query failed: invalid section '${input.section}'. Use one of: ${CONTINUITY_SECTION_VALUES.join(", ")}.`,
        details: { status: "error", reason: "invalid-section" },
      });
    }

    const fromTimestamp = normalizeTimestamp(input.from);
    const toTimestamp = normalizeTimestamp(input.to);
    const retrievalMode = "l2_lexical";
    const includeCompactedAdvisory = {
      mode: "best-effort",
      reason: "cross-user project continuity materialization may not contain complete compaction lifecycle metadata for every source row",
      requestedIncludeCompacted: Boolean(input.includeCompacted),
    };

    try {
      const search = await dependencies.projectIndexData.search({
        context: input.context,
        query: queryText,
        kindFilter: ["continuity"],
        section: querySection || undefined,
        from: fromTimestamp || undefined,
        to: toTimestamp || undefined,
        includeMilestones: input.includeMilestones,
        includeCompacted: input.includeCompacted,
        limit,
      });

      const entries = search.hits
        .filter((hit) => hit.kind === "continuity")
        .filter((entry) => !querySection || entry.section === querySection)
        .filter((entry) => isWithinRange({ timestamp: entry.timestamp, fromTimestamp, toTimestamp }))
        .filter((entry) => Boolean(input.includeCompacted) || (!entry.compactedIntoEntryId && !entry.supersededByEntryId))
        .slice(0, limit);
      const milestones = (search.milestones || [])
        .filter((milestone) => !querySection || milestone.section === querySection)
        .filter((milestone) => isWithinRange({ timestamp: milestone.timestamp, fromTimestamp, toTimestamp }))
        .slice(0, limit);
      const compactionHint = query.length > 0
        ? buildProjectIndexContinuityCompactionHint({
          queryText,
          entries,
          previousNoisyStreak: Math.max(0, Math.floor(input.previousNoisyStreak || 0)),
        })
        : null;

      const baseTelemetryPayload = {
        source: "l2",
        requestedMode: search.requestedMode || null,
        effectiveMode: search.effectiveMode || null,
        degradedReason: search.degradedReason || null,
        includeCompacted: Boolean(input.includeCompacted),
        includeCompactedAdvisory,
        compactionHint,
      };

      if (entries.length === 0 && milestones.length === 0) {
        await recordContinuityQueryTelemetry({
          telemetry: dependencies.telemetry,
          request: input,
          valueText: retrievalMode,
          valueA: 0,
          valueB: milestones.length,
          payload: { status: "empty", ...baseTelemetryPayload },
        });

        const compactionHintLine = compactionHint
          ? `\n[COMPACTION_HINT] lowLexicalMatchRatio=${(compactionHint.lowLexicalMatchRatio * 100).toFixed(1)}%; lowLexicalMatchEntries=${compactionHint.lowLexicalMatchEntries}/${compactionHint.totalEntries}; noisyResultSet=${compactionHint.noisyResultSet ? "yes" : "no"}; noisyStreak=${compactionHint.noisyStreak}; recommended=${compactionHint.recommendCompaction ? "yes" : "no"}.`
          : "";

        return buildTextResult({
          status: "ok",
          text: `continuity_query returned no rows (source=project_continuity, retrieval=lexical, effectiveMode=${search.effectiveMode || "unknown"}).${compactionHintLine}`,
          details: {
            status: "empty",
            source: "l2",
            retrievalMode,
            requestedMode: search.requestedMode || null,
            effectiveMode: search.effectiveMode || null,
            degradedReason: search.degradedReason || null,
            includeCompacted: Boolean(input.includeCompacted),
            includeCompactedAdvisory,
            compactionHint,
            databaseCount: search.databaseCount || 0,
            searchedDatabaseCount: search.searchedDatabaseCount || 0,
            entryCount: 0,
            milestoneCount: 0,
            ...search.diagnostics,
          },
          warnings: search.warnings,
        });
      }

      let text = `Continuity query results (source=project_continuity, retrieval=lexical, effectiveMode=${search.effectiveMode || "unknown"}): entries=${entries.length}, milestones=${milestones.length}.\n\n`;

      for (const entry of entries) {
        const certaintyPrefix = entry.certainty === "UNCONFIRMED" ? "UNCONFIRMED " : "";
        text += `- [ENTRY id=${entry.sourceId || entry.id}] user=${entry.userId || "unknown"} aggregate_id=${entry.id} ${entry.timestamp || ""} [${entry.section || "PROGRESS"}] [${entry.provenance || "CODE"}] ${certaintyPrefix}${entry.content}\n`;
      }

      for (const milestone of milestones as CoreProjectIndexContinuityMilestoneHit[]) {
        const certaintyPrefix = milestone.certainty === "UNCONFIRMED" ? "UNCONFIRMED " : "";
        text += `- [MILESTONE id=${milestone.id}] user=${milestone.userId} ${milestone.timestamp} [${milestone.section}] [${milestone.provenance}] ${certaintyPrefix}${milestone.summary} (sourceEntries=${milestone.sourceEntryCount}; readOnly=yes)\n`;
      }

      if (search.degradedReason) {
        text += `\n[DEGRADED] project continuity retrieval degraded: ${search.degradedReason}\n`;
      }

      text += `\n[ADVISORY] include_compacted is ${includeCompactedAdvisory.mode} in cross-user project continuity mode: ${includeCompactedAdvisory.reason}.\n`;

      if (compactionHint) {
        text +=
          `\n[COMPACTION_HINT] lowLexicalMatchRatio=${(compactionHint.lowLexicalMatchRatio * 100).toFixed(1)}%; ` +
          `lowLexicalMatchEntries=${compactionHint.lowLexicalMatchEntries}/${compactionHint.totalEntries}; ` +
          `noisyResultSet=${compactionHint.noisyResultSet ? "yes" : "no"}; ` +
          `noisyStreak=${compactionHint.noisyStreak}; ` +
          `recommended=${compactionHint.recommendCompaction ? "yes" : "no"}.\n`;

        if (compactionHint.recommendCompaction) {
          text += "[COMPACTION_HINT] Suggestion: use only active-user [ENTRY id=...] values with continuity_compact_preview; cross-user ids are read-only evidence.\n";
          text += "[COMPACTION_HINT] preview_payload_example={\"proposal_id\":\"proposal-topic-001\",\"groups\":[{\"group_id\":\"group-1\",\"source_entry_ids\":[\"<ACTIVE_USER_ENTRY_ID_1>\",\"<ACTIVE_USER_ENTRY_ID_2>\"],\"summary\":\"<bounded semantic summary>\",\"section_hint\":\"MIXED\"}]}.\n";
          text += "[COMPACTION_HINT] apply_payload_example={\"preview_id\":\"<preview_id_from_preview_result>\"}.\n";
        }
      }

      await recordContinuityQueryTelemetry({
        telemetry: dependencies.telemetry,
        request: input,
        valueText: retrievalMode,
        valueA: entries.length,
        valueB: milestones.length,
        payload: { status: "ok", ...baseTelemetryPayload },
      });

      return buildTextResult({
        status: "ok",
        text: text.trimEnd(),
        details: {
          status: "ok",
          source: "l2",
          retrievalMode,
          requestedMode: search.requestedMode || null,
          effectiveMode: search.effectiveMode || null,
          degradedReason: search.degradedReason || null,
          includeCompacted: Boolean(input.includeCompacted),
          includeCompactedAdvisory,
          compactionHint,
          databaseCount: search.databaseCount || 0,
          searchedDatabaseCount: search.searchedDatabaseCount || 0,
          entryCount: entries.length,
          milestoneCount: milestones.length,
          entryIds: entries.map((entry) => entry.sourceId || entry.id),
          l2EntryIds: entries.map((entry) => entry.id),
          milestoneIds: milestones.map((milestone) => milestone.id),
          userIds: Array.from(new Set([
            ...entries.map((entry) => entry.userId || "unknown"),
            ...milestones.map((milestone) => milestone.userId),
          ])).sort((left, right) => left.localeCompare(right)),
          ...search.diagnostics,
        },
        warnings: search.warnings,
      });
    } catch (error: unknown) {
      const dbFallbackReason = error instanceof Error ? error.message : String(error);
      await recordContinuityQueryTelemetry({
        telemetry: dependencies.telemetry,
        request: input,
        valueText: "error",
        payload: { status: "error", source: "l2", dbFallbackReason },
      });

      return buildTextResult({
        status: "error",
        text: `continuity_query failed: DB retrieval failed (${dbFallbackReason}).`,
        details: {
          status: "error",
          reason: "db-query-failed",
          source: "l2",
          dbFallbackReason,
        },
        warnings: [dbFallbackReason],
      });
    }
  },
});
