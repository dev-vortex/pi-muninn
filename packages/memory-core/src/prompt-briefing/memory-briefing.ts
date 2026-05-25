/**
 * File intent: render memory prompt briefings from L2 and L3 core providers.
 */

import type { PromptBriefingRequest } from "../contracts.js";
import type {
  CoreMemoryHit,
  CoreMemoryProviderPort,
  CoreProjectIndexHit,
  ProjectIndexDataAdapterPort,
} from "../ports.js";

const DEFAULT_PROJECT_ROW_LIMIT = 7;
const DEFAULT_RELATED_ROW_LIMIT = 3;
const DEFAULT_CANDIDATE_LIMIT = 50;
const DEFAULT_ROW_CLIP_LENGTH = 320;

interface MemoryBriefingRow {
  scope: "project" | "related_user";
  contributor?: string;
  topic: string;
  timestamp: string;
  content: string;
  termMatches: number;
  semanticPercent?: number;
}

interface MemoryBriefingCoverage {
  shown: number;
  total: number;
  omitted: number;
  newest: string | null;
  oldest: string | null;
  moreAvailable: boolean;
  note: string | null;
}

/**
 * Clip one memory row to the configured briefing budget.
 */
const clipMemoryContent = (content: string, maxLength: number): string => {
  const normalized = content.trim().replace(/\s+/g, " ");
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
};

/**
 * Count how many signal tokens appear in a candidate row.
 */
const countTermMatches = (tokens: string[], content: string, topic: string): number => {
  if (tokens.length === 0) return 0;
  const haystack = `${content}\n${topic}`.toLowerCase();
  return tokens.reduce((count, token) => count + (haystack.includes(token) ? 1 : 0), 0);
};

/**
 * Rank memory hits by term matches and recency.
 */
const rankRows = <T extends { termMatches: number; timestamp: string }>(rows: T[]): T[] =>
  [...rows].sort((left, right) => {
    if (right.termMatches !== left.termMatches) return right.termMatches - left.termMatches;
    return right.timestamp.localeCompare(left.timestamp);
  });

/**
 * Format semantic relevance percentages for LLM-readable rows.
 */
const formatSemanticPercent = (percent: number): string => `${Math.round(Math.max(0, Math.min(100, percent)))}%`;

/**
 * Clamp one semantic similarity ratio into a display percentage.
 */
const similarityToPercent = (similarity: number | undefined): number | undefined => {
  if (typeof similarity !== "number" || !Number.isFinite(similarity)) return undefined;
  return Math.max(0, Math.min(100, similarity * 100));
};

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
  otherMemberAliases: Map<string, string>;
}): string => {
  if (input.activeUserId && input.userId === input.activeUserId) {
    return isOpaqueUserId(input.userId) ? "current-user" : input.userId;
  }
  if (!isOpaqueUserId(input.userId)) return input.userId;
  const existing = input.otherMemberAliases.get(input.userId);
  if (existing) return existing;
  const alias = `project-member-${input.otherMemberAliases.size + 2}`;
  input.otherMemberAliases.set(input.userId, alias);
  return alias;
};

/**
 * Build coverage metadata from candidates and shown row count.
 */
const buildCoverage = (input: {
  candidates: Array<{ timestamp?: string }>;
  shown: number;
  note?: string | null;
}): MemoryBriefingCoverage => {
  const timestamps = input.candidates
    .map((candidate) => candidate.timestamp || "")
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
  if (rows.length === 0) return ["No project memory rows found in this bounded briefing."];
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
  if (rows.length === 0) return ["No related user memory rows found in this bounded briefing."];
  return rows.map((row) => {
    const semanticText = typeof row.semanticPercent === "number"
      ? ` semantic=${formatSemanticPercent(row.semanticPercent)}`
      : "";
    return `- scope=related_user topic=${row.topic} timestamp=${row.timestamp || "unknown"}${semanticText} ` +
      `relevance=${row.termMatches}/${signalTokenCount} :: ${row.content}`;
  });
};

/**
 * Convert project-index hits into briefing rows with readable contributor labels.
 */
const mapProjectHitsToRows = (input: {
  hits: CoreProjectIndexHit[];
  activeUserId: string | null;
  signalTokens: string[];
  rowClipLength: number;
}): MemoryBriefingRow[] => {
  const aliases = new Map<string, string>();
  return input.hits.map((hit) => ({
    scope: "project" as const,
    contributor: resolveContributorLabel({
      userId: hit.userId || "unknown-user",
      activeUserId: input.activeUserId,
      otherMemberAliases: aliases,
    }),
    topic: hit.topic || "general",
    timestamp: hit.timestamp || "",
    content: clipMemoryContent(hit.content, input.rowClipLength),
    termMatches: countTermMatches(input.signalTokens, hit.content, hit.topic || "general"),
    semanticPercent: similarityToPercent(hit.semanticSimilarity),
  }));
};

/**
 * Convert global-curated provider hits into related-user briefing rows.
 */
const mapRelatedHitsToRows = (input: {
  hits: CoreMemoryHit[];
  signalTokens: string[];
  rowClipLength: number;
}): MemoryBriefingRow[] => input.hits.map((hit) => ({
  scope: "related_user" as const,
  topic: hit.topic || "general",
  timestamp: hit.timestamp || "",
  content: clipMemoryContent(hit.content, input.rowClipLength),
  termMatches: countTermMatches(input.signalTokens, hit.content, hit.topic || "general"),
  semanticPercent: similarityToPercent(hit.semanticSimilarity),
}));

/**
 * Read project memory candidates through the L2 project-index adapter.
 */
const readProjectMemoryCandidates = async (input: {
  projectIndexData?: ProjectIndexDataAdapterPort;
  request: PromptBriefingRequest;
  signalTokens: string[];
  candidateLimit: number;
}): Promise<{ candidates: CoreProjectIndexHit[]; retrieval: "normal" | "fallback" | "unavailable"; note: string | null }> => {
  if (!input.projectIndexData) {
    return {
      candidates: [],
      retrieval: "unavailable",
      note: "project memory unavailable: project index data adapter not configured",
    };
  }

  try {
    const search = await input.projectIndexData.search({
      context: input.request.context,
      query: input.signalTokens.join(" "),
      kindFilter: ["memory"],
      limit: input.candidateLimit,
    });
    const candidates = rankRows(search.hits
      .filter((hit) => hit.kind === "memory")
      .map((hit) => ({
        ...hit,
        termMatches: countTermMatches(input.signalTokens, hit.content, hit.topic || "general"),
        timestamp: hit.timestamp || "",
      })));

    if (search.status === "error") {
      return {
        candidates,
        retrieval: "unavailable",
        note: search.warnings[0] || "project memory retrieval failed",
      };
    }

    return {
      candidates,
      retrieval: search.degradedReason ? "fallback" : "normal",
      note: search.degradedReason || null,
    };
  } catch (error: unknown) {
    return {
      candidates: [],
      retrieval: "unavailable",
      note: `project memory unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

/**
 * Read related user/global memory candidates through the L3 memory provider.
 */
const readRelatedMemoryCandidates = async (input: {
  memoryProvider?: Pick<CoreMemoryProviderPort, "search">;
  request: PromptBriefingRequest;
  signalTokens: string[];
  candidateLimit: number;
}): Promise<{ candidates: CoreMemoryHit[]; note: string | null }> => {
  if (!input.memoryProvider) {
    return {
      candidates: [],
      note: "related user memory unavailable: memory provider not configured",
    };
  }

  const result = await input.memoryProvider.search({
    context: input.request.context,
    query: input.signalTokens.join(" "),
    lanes: ["global-curated"],
    projectName: "general",
    limit: input.candidateLimit,
  });

  if (result.status === "error") {
    const warning = result.warnings[0] || "memory provider search failed";
    return {
      candidates: [],
      note: warning.startsWith("related user memory unavailable:")
        ? warning
        : `related user memory unavailable: ${warning}`,
    };
  }

  return {
    candidates: rankRows(result.hits
      .filter((hit) => hit.lane === "global-curated")
      .map((hit) => ({
        ...hit,
        termMatches: countTermMatches(input.signalTokens, hit.content, hit.topic || "general"),
        timestamp: hit.timestamp || "",
      }))),
    note: null,
  };
};

/**
 * Build a bounded memory briefing for the current user prompt.
 */
export const buildMemoryPromptBriefing = async (input: {
  projectIndexData?: ProjectIndexDataAdapterPort;
  memoryProvider?: Pick<CoreMemoryProviderPort, "search">;
  request: PromptBriefingRequest;
  signalTokens: string[];
}): Promise<string> => {
  const projectRead = await readProjectMemoryCandidates({
    projectIndexData: input.projectIndexData,
    request: input.request,
    signalTokens: input.signalTokens,
    candidateLimit: DEFAULT_CANDIDATE_LIMIT,
  });
  const projectDisplayHits = projectRead.candidates.slice(0, DEFAULT_PROJECT_ROW_LIMIT);
  const relatedRead = DEFAULT_RELATED_ROW_LIMIT > 0
    ? await readRelatedMemoryCandidates({
      memoryProvider: input.memoryProvider,
      request: input.request,
      signalTokens: input.signalTokens,
      candidateLimit: DEFAULT_CANDIDATE_LIMIT,
    })
    : { candidates: [], note: null };
  const relatedDisplayCandidates = relatedRead.candidates.slice(0, DEFAULT_RELATED_ROW_LIMIT);
  const projectRows = mapProjectHitsToRows({
    hits: projectDisplayHits,
    activeUserId: input.request.context.userId,
    signalTokens: input.signalTokens,
    rowClipLength: DEFAULT_ROW_CLIP_LENGTH,
  });
  const relatedRows = mapRelatedHitsToRows({
    hits: relatedDisplayCandidates,
    signalTokens: input.signalTokens,
    rowClipLength: DEFAULT_ROW_CLIP_LENGTH,
  });
  const projectCoverage = buildCoverage({ candidates: projectRead.candidates, shown: projectRows.length, note: projectRead.note });
  const relatedCoverage = buildCoverage({ candidates: relatedRead.candidates, shown: relatedRows.length, note: relatedRead.note });
  const degraded = projectRead.retrieval !== "normal" || Boolean(projectCoverage.note || relatedCoverage.note);
  const deeperSearchRecommended = degraded || projectCoverage.moreAvailable || relatedCoverage.moreAvailable;
  const moreAvailable = projectCoverage.moreAvailable || relatedCoverage.moreAvailable;
  const memoryActionLine = deeperSearchRecommended
    ? "ACTION REQUIRED: You MUST call targeted memory_search before answering because this briefing may be incomplete or conflicting."
    : "ACTION: Do not call memory_search unless the visible memory rows are conflicting or incomplete for the exact requested fact.";
  const signalLabel = input.signalTokens.length > 0 ? input.signalTokens.join(", ") : "none";
  const relevanceDenominator = Math.max(1, input.signalTokens.length);
  const semanticSignalAvailable = [...projectRows, ...relatedRows].some((row) => typeof row.semanticPercent === "number");
  const semanticSignalSuffix = semanticSignalAvailable ? "; semantic_signal=available quality_basis=vector_similarity" : "";

  return [
    "TURN MEMORY BRIEFING (preloaded by extension for the current user prompt):",
    `coverage: ${renderCoverage("project_memory", projectCoverage)}; ` +
      `${renderCoverage("related_user_memory", relatedCoverage)}; ` +
      `retrieval=${projectRead.retrieval}; degraded=${degraded ? "true" : "false"}; ` +
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
};
