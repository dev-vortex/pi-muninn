/**
 * File intent: build bounded memory briefings for once-per-prompt injection.
 *
 * This file searches project memory and related global/user memory, ranks and
 * clips candidate rows, calculates coverage metadata, and renders the bounded
 * `TURN MEMORY BRIEFING` text with loop-safe guidance for deeper memory tool
 * calls. Use this when changing what memory evidence is injected before the
 * agent answers.
 */

import type { FanoutSearchHit } from "../project-index/fanout-retrieval.js";
import { searchProjectMemoryByMode } from "./mode-selection.js";
import { readRelatedUserMemoryCandidates } from "./related-user-memory-briefing.js";
import type {
  MemoryBriefingCoverage,
  MemoryBriefingResult,
  MemoryBriefingRow,
  BuildMemoryBriefingInput,
} from "./memory-briefing-types.js";
import {
  buildMemorySemanticSignalKey,
  clipMemoryContent,
  countTermMatches,
  formatSemanticPercent,
  normalizeSignalTokens,
  rankRows,
  readSemanticPercentFromHit,
  similarityToPercent,
} from "./memory-briefing-utils.js";
import {
  createSqliteVecProjectSemanticMemorySearchProvider,
  type ProjectSemanticMemorySearchProvider,
} from "./semantic-search-provider.js";

const DEFAULT_PROJECT_ROW_LIMIT = 7;
const DEFAULT_RELATED_ROW_LIMIT = 3;
const DEFAULT_CANDIDATE_LIMIT = 50;
const DEFAULT_ROW_CLIP_LENGTH = 320;

/**
 * Return true when a user id is an opaque generated id rather than a readable name.
 */
const isOpaqueUserId = (userId: string): boolean =>
  userId.startsWith("u_") || userId === "unknown-user";

/**
 * Convert one user id into an LLM-readable contributor label.
 */
const resolveContributorLabel = (input: {
  userId: string;
  activeUserId: string | null;
  displayNameByUserId?: Record<string, string>;
  otherMemberAliases: Map<string, string>;
}): string => {
  const displayName = input.displayNameByUserId?.[input.userId]?.trim();
  if (displayName) {
    return displayName;
  }

  if (input.activeUserId && input.userId === input.activeUserId) {
    return isOpaqueUserId(input.userId) ? "current-user" : input.userId;
  }

  if (!isOpaqueUserId(input.userId)) {
    return input.userId;
  }

  const existing = input.otherMemberAliases.get(input.userId);
  if (existing) {
    return existing;
  }

  const alias = `project-member-${input.otherMemberAliases.size + 2}`;
  input.otherMemberAliases.set(input.userId, alias);
  return alias;
};

/**
 * Build coverage metadata from candidates and shown row count.
 */
const buildCoverage = (input: {
  candidates: Array<{ timestamp: string }>;
  shown: number;
  note?: string | null;
}): MemoryBriefingCoverage => {
  const timestamps = input.candidates
    .map((candidate) => candidate.timestamp)
    .filter((timestamp) => timestamp.length > 0)
    .sort((left, right) => left.localeCompare(right));

  const total = input.candidates.length;
  const omitted = Math.max(0, total - input.shown);

  return {
    shown: input.shown,
    total,
    omitted,
    newest: timestamps.length > 0 ? timestamps[timestamps.length - 1] : null,
    oldest: timestamps.length > 0 ? timestamps[0] : null,
    moreAvailable: omitted > 0,
    note: input.note || null,
  };
};

/**
 * Render one coverage section into a compact single-line summary.
 */
const renderCoverage = (label: string, coverage: MemoryBriefingCoverage): string => {
  const newest = coverage.newest || "none";
  const oldest = coverage.oldest || "none";
  const note = coverage.note ? ` note="${coverage.note.replace(/"/g, "'")}"` : "";

  return `${label} shown=${coverage.shown} total=${coverage.total} omitted=${coverage.omitted} newest=${newest} oldest=${oldest}${note}`;
};

/**
 * Render project-memory rows into LLM-facing briefing lines.
 */
const renderProjectRows = (rows: MemoryBriefingRow[], signalTokenCount: number): string[] => {
  if (rows.length === 0) {
    return ["No project memory rows found in this bounded briefing."];
  }

  return rows.map((row) => {
    const semanticText = typeof row.semanticPercent === "number"
      ? ` semantic=${formatSemanticPercent(row.semanticPercent)}`
      : "";

    return `- scope=project contributor=${row.contributor || "unknown"} topic=${row.topic} ` +
      `timestamp=${row.timestamp || "unknown"}${semanticText} relevance=${row.termMatches}/${signalTokenCount} :: ${row.content}`;
  });
};

/**
 * Render related user-memory rows into LLM-facing briefing lines.
 */
const renderRelatedRows = (rows: MemoryBriefingRow[], signalTokenCount: number): string[] => {
  if (rows.length === 0) {
    return ["No related user memory rows found in this bounded briefing."];
  }

  return rows.map((row) => {
    const semanticText = typeof row.semanticPercent === "number"
      ? ` semantic=${formatSemanticPercent(row.semanticPercent)}`
      : "";

    return `- scope=related_user topic=${row.topic} timestamp=${row.timestamp || "unknown"}${semanticText} ` +
      `relevance=${row.termMatches}/${signalTokenCount} :: ${row.content}`;
  });
};

/**
 * Convert project retrieval hits into briefing rows with readable contributor labels.
 */
const mapProjectHitsToRows = (input: {
  hits: FanoutSearchHit[];
  activeUserId: string | null;
  signalTokens: string[];
  rowClipLength: number;
  semanticPercentByRowKey?: Map<string, number>;
  displayNameByUserId?: Record<string, string>;
}): MemoryBriefingRow[] => {
  const aliases = new Map<string, string>();

  return input.hits.map((hit) => ({
    scope: "project" as const,
    contributor: input.displayNameByUserId?.[hit.userId]?.trim() || hit.contributorLabel || resolveContributorLabel({
      userId: hit.userId,
      activeUserId: input.activeUserId,
      displayNameByUserId: input.displayNameByUserId,
      otherMemberAliases: aliases,
    }),
    topic: hit.topic || "general",
    timestamp: hit.timestamp || "",
    content: clipMemoryContent(hit.content, input.rowClipLength),
    termMatches: countTermMatches(input.signalTokens, hit.content, hit.topic),
    semanticPercent: readSemanticPercentFromHit(hit)
      ?? input.semanticPercentByRowKey?.get(buildMemorySemanticSignalKey(hit.databasePath, hit.id)),
  }));
};

/**
 * Annotate selected memory rows with semantic similarity when vendor-compatible vectors expose it.
 */
const buildSemanticSignalLookup = async (input: {
  query: string;
  rows: Array<{ databasePath: string; id: string }>;
  provider?: ProjectSemanticMemorySearchProvider;
}): Promise<Map<string, number>> => {
  const selectedRows = input.rows.filter((row) => row.databasePath.length > 0 && row.id.length > 0);
  if (input.query.trim().length === 0 || selectedRows.length === 0) {
    return new Map();
  }

  const selectedKeys = new Set(selectedRows.map((row) => buildMemorySemanticSignalKey(row.databasePath, row.id)));
  const databasePaths = [...new Set(selectedRows.map((row) => row.databasePath))];
  const provider = input.provider || createSqliteVecProjectSemanticMemorySearchProvider();

  try {
    const semantic = await provider.search({
      query: input.query,
      databasePaths,
      topK: Math.max(selectedRows.length * 4, 20),
      perDbLimit: Math.max(selectedRows.length * 4, 10),
    });

    const semanticPercentByRowKey = new Map<string, number>();
    for (const hit of semantic.results) {
      const key = buildMemorySemanticSignalKey(hit.databasePath, hit.id);
      const semanticPercent = similarityToPercent(hit.semanticSimilarity);
      if (selectedKeys.has(key) && typeof semanticPercent === "number") {
        semanticPercentByRowKey.set(key, semanticPercent);
      }
    }

    return semanticPercentByRowKey;
  } catch {
    // Semantic annotation is metadata-only; never change briefing row selection/ranking on failure.
    return new Map();
  }
};

/**
 * Build a bounded memory briefing for the current user prompt.
 */
export const buildMemoryBriefing = async (
  input: BuildMemoryBriefingInput,
): Promise<MemoryBriefingResult> => {
  const signalTokens = normalizeSignalTokens(input.signalTokens);
  const signalText = signalTokens.join(" ");
  const projectRowLimit = Math.max(1, Math.min(input.projectRowLimit ?? DEFAULT_PROJECT_ROW_LIMIT, 20));
  const relatedRowLimit = Math.max(0, Math.min(input.relatedRowLimit ?? DEFAULT_RELATED_ROW_LIMIT, 20));
  const candidateLimit = Math.max(projectRowLimit, Math.min(input.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT, 200));
  const rowClipLength = Math.max(80, Math.min(input.rowClipLength ?? DEFAULT_ROW_CLIP_LENGTH, 1_000));

  let projectCandidates: FanoutSearchHit[] = [];
  let retrieval: MemoryBriefingResult["retrieval"] = "normal";
  let projectNote: string | null = null;

  try {
    const projectSearch = await searchProjectMemoryByMode({
      projectMemoryDir: input.projectMemoryDir,
      query: signalText,
      mode: input.mode,
      topK: candidateLimit,
      perDbLimit: Math.max(projectRowLimit * 4, 10),
      indexFreshnessSeconds: input.indexFreshnessSeconds,
      activeUserId: input.activeUserId || undefined,
    });

    projectCandidates = rankRows(
      projectSearch.results
        .filter((hit) => hit.kind === "memory")
        .map((hit) => ({
          ...hit,
          termMatches: countTermMatches(signalTokens, hit.content, hit.topic),
        })),
    );

    if (projectSearch.degraded) {
      retrieval = "fallback";
      projectNote = projectSearch.degradedReason || "project memory retrieval used fallback";
    }
  } catch (error: unknown) {
    retrieval = "unavailable";
    projectNote = `project memory unavailable: ${error instanceof Error ? error.message : String(error)}`;
    projectCandidates = [];
  }

  const projectDisplayHits = projectCandidates.slice(0, projectRowLimit);
  const relatedRead = relatedRowLimit > 0
    ? readRelatedUserMemoryCandidates({
      globalDatabasePath: input.globalDatabasePath,
      signalTokens,
      candidateLimit,
    })
    : { candidates: [], note: null };
  const relatedDisplayCandidates = relatedRead.candidates.slice(0, relatedRowLimit);

  const semanticPercentByRowKey = await buildSemanticSignalLookup({
    query: signalText,
    provider: input.semanticSignalProvider,
    rows: [
      ...projectDisplayHits.map((hit) => ({ databasePath: hit.databasePath, id: hit.id })),
      ...relatedDisplayCandidates.map((candidate) => ({ databasePath: input.globalDatabasePath, id: candidate.id })),
    ],
  });

  const projectRows = mapProjectHitsToRows({
    hits: projectDisplayHits,
    activeUserId: input.activeUserId,
    signalTokens,
    rowClipLength,
    semanticPercentByRowKey,
    displayNameByUserId: input.displayNameByUserId,
  });

  const relatedRows: MemoryBriefingRow[] = relatedDisplayCandidates
    .map((candidate) => ({
      scope: "related_user" as const,
      topic: candidate.topic,
      timestamp: candidate.timestamp,
      content: clipMemoryContent(candidate.content, rowClipLength),
      termMatches: candidate.termMatches,
      semanticPercent: semanticPercentByRowKey.get(buildMemorySemanticSignalKey(input.globalDatabasePath, candidate.id)),
    }));

  const projectCoverage = buildCoverage({
    candidates: projectCandidates,
    shown: projectRows.length,
    note: projectNote,
  });
  const relatedCoverage = buildCoverage({
    candidates: relatedRead.candidates,
    shown: relatedRows.length,
    note: relatedRead.note,
  });

  const degraded = retrieval !== "normal" || Boolean(projectCoverage.note || relatedCoverage.note);
  const deeperSearchRecommended = degraded || projectCoverage.moreAvailable || relatedCoverage.moreAvailable;
  const moreAvailable = projectCoverage.moreAvailable || relatedCoverage.moreAvailable;
  const memoryActionLine = deeperSearchRecommended
    ? "ACTION REQUIRED: You MUST call targeted memory_search before answering because this briefing may be incomplete or conflicting."
    : "ACTION: Do not call memory_search unless the visible memory rows are conflicting or incomplete for the exact requested fact.";
  const signalLabel = signalTokens.length > 0 ? signalTokens.join(", ") : "none";
  const relevanceDenominator = Math.max(1, signalTokens.length);
  const semanticSignalAvailable = [...projectRows, ...relatedRows]
    .some((row) => typeof row.semanticPercent === "number");
  const semanticSignalSuffix = semanticSignalAvailable
    ? "; semantic_signal=available quality_basis=vector_similarity"
    : "";

  const briefing = [
    "TURN MEMORY BRIEFING (preloaded by extension for the current user prompt):",
    `coverage: ${renderCoverage("project_memory", projectCoverage)}; ` +
      `${renderCoverage("related_user_memory", relatedCoverage)}; ` +
      `retrieval=${retrieval}; degraded=${degraded ? "true" : "false"}; ` +
      `more_available=${moreAvailable ? "true" : "false"}; ` +
      `deeper_search_recommended=${deeperSearchRecommended ? "true" : "false"}${semanticSignalSuffix}`,
    `query_signals=${signalLabel}`,
    "Use this as bounded memory context.",
    memoryActionLine,
    "",
    "[PROJECT MEMORY]",
    ...renderProjectRows(projectRows, relevanceDenominator),
    "",
    "[RELATED USER MEMORY]",
    ...renderRelatedRows(relatedRows, relevanceDenominator),
  ].join("\n").trimEnd();

  return {
    briefing,
    projectCoverage,
    relatedCoverage,
    retrieval,
    degraded,
    deeperSearchRecommended,
  };
};
