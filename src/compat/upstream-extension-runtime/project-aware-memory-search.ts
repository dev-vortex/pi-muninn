/**
 * File intent: project-curation `memory_search` combined-lane wrapper.
 *
 * The wrapper preserves the upstream reusable-memory lane while adding a
 * project-memory lane and deterministic lexical fallback for broad misses.
 */

import { searchProjectMemoryHybrid, type HybridProjectMemorySearchMetadata } from "../../../packages/memory-core/src/adapters/sqlite/project-memory/hybrid-retrieval.js";
import {
  loadProjectMemoryConfig,
  resolveProjectMemoryDirectory,
} from "../../project-memory/config.js";
import { resolveProjectUserId } from "../../project-memory/user-id.js";
import { MEMORY_SEARCH_PROJECT_FETCH_MULTIPLIER } from "./constants.js";
import { resolveContextCwd, resolveHomeDirectory } from "./environment.js";
import {
  formatMemorySearchSimilarity,
  selectProjectMemoryHits,
} from "./project-memory-lane.js";
import { readMemorySearchPayloadContract } from "./payload-contracts.js";
import {
  isNoMemoryResultText,
  readGeneralMemoryLexicalFallbackHits,
  resolveGlobalMemoryDatabasePath,
} from "./sqlite-read-models.js";
import {
  buildTextToolResult,
  readUnknownToolResultDetailsNumber,
  readUnknownToolResultText,
} from "./text-tool-result.js";

export const renderGeneralMemoryFallbackHits = (input: {
  query: string;
  hits: Array<{
    topic: string;
    timestamp: string;
    content: string;
    termMatches: number;
  }>;
}): string => {
  if (input.hits.length === 0) {
    return `No related user memories found for: "${input.query}"`;
  }

  let text = `Found ${input.hits.length} related user memories for "${input.query}" via fallback lexical search:\n\n`;

  for (const hit of input.hits) {
    text += `[related_user/${hit.topic}] (${hit.timestamp}; lexical_matches=${hit.termMatches})\n`;
    text += `${hit.content}\n\n---\n\n`;
  }

  return text.trimEnd();
};

/**
 * Select bounded project-memory rows while preserving optional semantic metadata.
 */

export const renderProjectMemorySearchHits = (input: {
  query: string;
  hits: Array<{
    topic: string;
    timestamp: string;
    content: string;
    semanticSimilarity?: number;
  }>;
}): string => {
  if (input.hits.length === 0) {
    return `Project memory lane (continuity excluded):\nNo project memories found for: "${input.query}"`;
  }

  let text = `Project memory lane (continuity excluded):\nFound ${input.hits.length} project memories for "${input.query}":\n\n`;

  for (const hit of input.hits) {
    const semanticText = typeof hit.semanticSimilarity === "number"
      ? formatMemorySearchSimilarity(hit.semanticSimilarity)
      : null;
    const metadata = semanticText ? `${semanticText}, ${hit.timestamp}` : hit.timestamp;
    text += `[project/${hit.topic}] (${metadata})\n`;
    text += `${hit.content}\n\n---\n\n`;
  }

  return text.trimEnd();
};

/**
 * Execute memory_search in project-curation mode using combined project+general lanes.
 *
 * Decision:
 * - keep upstream semantic search for the related reusable user-memory lane,
 * - add project lane retrieval from project index/fanout,
 * - exclude continuity rows from memory_search output (continuity has dedicated tools).
 */
export const executeProjectAwareMemorySearch = async (input: {
  toolInput: unknown;
  ctx: unknown;
  executeArgs: any[];
  originalExecute: (...args: any[]) => Promise<unknown> | unknown;
  homeDirectory?: string;
}): Promise<unknown> => {
  const payload = readMemorySearchPayloadContract(input.toolInput);

  // Preserve upstream behavior for invalid payloads.
  if (!payload.query) {
    return input.originalExecute(...input.executeArgs);
  }

  const cwd = resolveContextCwd(input.ctx);

  const executeGeneralLane = async (): Promise<unknown> => {
    const forwardedArgs = [...input.executeArgs];
    const originalToolInput = typeof forwardedArgs[1] === "object" && forwardedArgs[1] !== null
      ? forwardedArgs[1] as Record<string, unknown>
      : {};

    forwardedArgs[1] = {
      ...originalToolInput,
      query: payload.query,
      project: "general",
      ...(payload.topic ? { topic: payload.topic } : {}),
      n_results: payload.nResults,
    };

    return input.originalExecute(...forwardedArgs);
  };

  let projectHits: Array<{
    topic: string;
    timestamp: string;
    content: string;
    semanticSimilarity?: number;
  }> = [];
  let projectSearchDegradedReason: string | null = null;
  let projectSearchError: string | null = null;
  let projectSearchMetadata: HybridProjectMemorySearchMetadata | null = null;

  try {
    const config = await loadProjectMemoryConfig(cwd);

    if (config.projectMemoryEnabled) {
      const resolvedUserId = resolveProjectUserId({
        projectConfigUserId: config.myUserId,
        projectRoot: cwd,
      });
      const projectMemoryDir = resolveProjectMemoryDirectory(cwd);
      const topicFilter = payload.topic?.toLowerCase() || null;
      const topK = Math.min(payload.nResults * MEMORY_SEARCH_PROJECT_FETCH_MULTIPLIER, 200);

      const projectSearch = await searchProjectMemoryHybrid({
        projectMemoryDir,
        query: payload.query,
        topK,
        perDbLimit: Math.max(payload.nResults * 3, 10),
        indexFreshnessSeconds: config.index.intervalSeconds,
        activeUserId: resolvedUserId.userId || config.myUserId,
        lexicalMode: config.mode,
      });

      projectSearchDegradedReason = projectSearch.degradedReason || null;
      projectSearchMetadata = projectSearch.metadata;

      const selectedProjectHits = selectProjectMemoryHits({
        results: projectSearch.results,
        topicFilter,
        limit: payload.nResults,
      });

      projectHits = selectedProjectHits.map((hit) => ({
        topic: hit.topic,
        timestamp: hit.timestamp,
        content: hit.content,
        ...(typeof hit.semanticSimilarity === "number" ? { semanticSimilarity: hit.semanticSimilarity } : {}),
      }));
    }
  } catch (error: unknown) {
    projectSearchError = error instanceof Error ? error.message : String(error);
  }

  const generalResult = await executeGeneralLane();
  const upstreamGeneralText = readUnknownToolResultText(generalResult);
  const upstreamGeneralHitCount = readUnknownToolResultDetailsNumber({
    result: generalResult,
    field: "hitCount",
  });
  const shouldUseGeneralFallback = upstreamGeneralHitCount === 0 || isNoMemoryResultText(upstreamGeneralText);
  const generalFallbackHits = shouldUseGeneralFallback
    ? readGeneralMemoryLexicalFallbackHits({
      databasePath: resolveGlobalMemoryDatabasePath(input.homeDirectory || resolveHomeDirectory()),
      query: payload.query,
      topicFilter: payload.topic?.toLowerCase() || null,
      limit: payload.nResults,
    })
    : [];
  const generalText = generalFallbackHits.length > 0
    ? renderGeneralMemoryFallbackHits({
      query: payload.query,
      hits: generalFallbackHits,
    })
    : (isNoMemoryResultText(upstreamGeneralText)
      ? `No related user memories found for: "${payload.query}"`
      : upstreamGeneralText || `No related user memories found for: "${payload.query}"`);

  const projectText = renderProjectMemorySearchHits({
    query: payload.query,
    hits: projectHits,
  });

  const degradedSuffix = projectSearchDegradedReason
    ? `\n\nProject lane note: ${projectSearchDegradedReason}.`
    : "";
  const errorSuffix = projectSearchError
    ? `\n\nProject lane warning: ${projectSearchError}`
    : "";

  return buildTextToolResult({
    text:
      `memory_search combined lanes for "${payload.query}":\n\n` +
      `${projectText}\n\nRelated user memory lane (reusable across projects):\n${generalText}${degradedSuffix}${errorSuffix}`,
    details: {
      status: "search-project-general",
      route: "memory_search_project_general",
      query: payload.query,
      requestedProjectFilter: payload.project,
      requestedTopicFilter: payload.topic,
      projectHitCount: projectHits.length,
      generalHitCount: generalFallbackHits.length > 0
        ? generalFallbackHits.length
        : upstreamGeneralHitCount,
      projectSearchDegradedReason,
      projectSearchError,
      projectRetrievalMode: projectSearchMetadata?.projectRetrievalMode || null,
      projectSemanticAttempted: projectSearchMetadata?.projectSemanticAttempted || false,
      projectSemanticUsed: projectSearchMetadata?.projectSemanticUsed || false,
      projectSemanticDatabaseCount: projectSearchMetadata?.projectSemanticDatabaseCount || 0,
      projectSemanticSearchedDatabaseCount: projectSearchMetadata?.projectSemanticSearchedDatabaseCount || 0,
      projectSemanticSkippedDatabaseCount: projectSearchMetadata?.projectSemanticSkippedDatabaseCount || 0,
      projectSemanticHitCount: projectSearchMetadata?.projectSemanticHitCount || 0,
      projectLexicalFallbackUsed: projectSearchMetadata?.projectLexicalFallbackUsed || false,
      projectLexicalSupportUsed: projectSearchMetadata?.projectLexicalSupportUsed || false,
      projectLexicalHitCount: projectSearchMetadata?.projectLexicalHitCount || 0,
      projectRetrievalErrorCount: projectSearchMetadata?.projectRetrievalErrorCount || 0,
      projectRetrievalLatencyMs: projectSearchMetadata?.projectRetrievalLatencyMs || 0,
      projectExactIdentifierQuery: projectSearchMetadata?.projectExactIdentifierQuery || false,
      projectIndexHintUsed: projectSearchMetadata?.projectIndexHintUsed || false,
      continuityExcluded: true,
      generalFallbackUsed: generalFallbackHits.length > 0,
      generalFallbackHitCount: generalFallbackHits.length,
      generalResult,
    },
  });
};

/**
 * Render project-memory hits for combined memory_recall output.
 */
