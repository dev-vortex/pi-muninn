/**
 * File intent: project-curation `memory_recall` combined-lane wrapper.
 *
 * The wrapper preserves upstream general recall while adding project-memory rows
 * from the project index/fanout path and excluding continuity rows.
 */

import { searchProjectMemoryByMode } from "../../memory-data-adapters/sqlite/project-memory/mode-selection.js";
import {
  loadProjectMemoryConfig,
  resolveProjectMemoryDirectory,
} from "../../project-memory/config.js";
import { resolveProjectUserId } from "../../project-memory/user-id.js";
import { MEMORY_SEARCH_PROJECT_FETCH_MULTIPLIER } from "./constants.js";
import { resolveContextCwd } from "./environment.js";
import { readMemoryRecallPayloadContract } from "./payload-contracts.js";
import {
  appendProjectLaneNote,
  selectProjectMemoryHits,
} from "./project-memory-lane.js";
import {
  buildTextToolResult,
  readUnknownToolResultDetailsNumber,
  readUnknownToolResultText,
} from "./text-tool-result.js";

export const renderProjectMemoryRecallHits = (input: {
  topicFilter: string | null;
  hits: Array<{
    userId: string;
    topic: string;
    timestamp: string;
    content: string;
  }>;
}): string => {
  const filterLabel = input.topicFilter
    ? ` (topic=${input.topicFilter})`
    : "";

  if (input.hits.length === 0) {
    return `Project memory lane (continuity excluded)${filterLabel}:\nNo project memories found.`;
  }

  let text =
    `Project memory lane (continuity excluded)${filterLabel}:\n` +
    `Found ${input.hits.length} project memories:\n\n`;

  for (const hit of input.hits) {
    text += `[project/${hit.userId}/${hit.topic}] (${hit.timestamp})\n`;
    text += `${hit.content}\n\n---\n\n`;
  }

  return text.trimEnd();
};

/**
 * Execute memory_recall in project-curation mode with combined project/general lanes.
 */
export const executeProjectAwareMemoryRecall = async (input: {
  toolInput: unknown;
  ctx: unknown;
  executeArgs: any[];
  originalExecute: (...args: any[]) => Promise<unknown> | unknown;
}): Promise<unknown> => {
  const payload = readMemoryRecallPayloadContract(input.toolInput);
  const cwd = resolveContextCwd(input.ctx);

  const executeGeneralLane = async (): Promise<unknown> => {
    const forwardedArgs = [...input.executeArgs];
    const originalToolInput = typeof forwardedArgs[1] === "object" && forwardedArgs[1] !== null
      ? forwardedArgs[1] as Record<string, unknown>
      : {};

    forwardedArgs[1] = {
      ...originalToolInput,
      project: "general",
      ...(payload.topic ? { topic: payload.topic } : {}),
      n_results: payload.nResults,
    };

    return input.originalExecute(...forwardedArgs);
  };

  let projectHits: Array<{
    userId: string;
    topic: string;
    timestamp: string;
    content: string;
  }> = [];
  let projectSearchDegradedReason: string | null = null;
  let projectSearchError: string | null = null;

  try {
    const config = await loadProjectMemoryConfig(cwd);

    if (config.projectMemoryEnabled) {
      const resolvedUserId = resolveProjectUserId({
        projectConfigUserId: config.myUserId,
        projectRoot: cwd,
      });

      const topicFilter = payload.topic?.toLowerCase() || null;
      const topK = topicFilter
        ? Math.min(Math.max(payload.nResults * 20, 50), 200)
        : Math.min(payload.nResults * MEMORY_SEARCH_PROJECT_FETCH_MULTIPLIER, 200);

      const projectSearch = await searchProjectMemoryByMode({
        projectMemoryDir: resolveProjectMemoryDirectory(cwd),
        query: payload.topic || "",
        mode: config.mode,
        topK,
        perDbLimit: Math.max(payload.nResults * 2, 10),
        indexFreshnessSeconds: config.index.intervalSeconds,
        activeUserId: resolvedUserId.userId || config.myUserId,
      });

      projectSearchDegradedReason = projectSearch.degradedReason || null;

      let selectedProjectHits = selectProjectMemoryHits({
        results: projectSearch.results,
        topicFilter,
        limit: payload.nResults,
      });

      if (selectedProjectHits.length === 0 && projectSearch.effectiveMode === "index-first" && projectSearch.databaseCount > 0) {
        const fanoutRecovery = await searchProjectMemoryByMode({
          projectMemoryDir: resolveProjectMemoryDirectory(cwd),
          query: payload.topic || "",
          mode: "fanout",
          topK,
          perDbLimit: Math.max(payload.nResults * 2, 10),
          activeUserId: resolvedUserId.userId || config.myUserId,
        });

        const recoveredHits = selectProjectMemoryHits({
          results: fanoutRecovery.results,
          topicFilter,
          limit: payload.nResults,
        });

        if (recoveredHits.length > 0) {
          selectedProjectHits = recoveredHits;
          projectSearchDegradedReason = appendProjectLaneNote(
            projectSearchDegradedReason,
            "index returned no project memory hits; direct fanout recovered project lane",
          );
        }
      }

      projectHits = selectedProjectHits;
    }
  } catch (error: unknown) {
    projectSearchError = error instanceof Error ? error.message : String(error);
  }

  const generalResult = await executeGeneralLane();
  const generalText = readUnknownToolResultText(generalResult)
    || "No general memories found.";

  const projectText = renderProjectMemoryRecallHits({
    topicFilter: payload.topic,
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
      "memory_recall combined lanes:\n\n" +
      `${projectText}\n\nRelated user memory lane (reusable across projects):\n${generalText}${degradedSuffix}${errorSuffix}`,
    details: {
      status: "recall-project-general",
      route: "memory_recall_project_general",
      requestedProjectFilter: payload.project,
      requestedTopicFilter: payload.topic,
      projectHitCount: projectHits.length,
      generalHitCount: readUnknownToolResultDetailsNumber({
        result: generalResult,
        field: "count",
      }) || readUnknownToolResultDetailsNumber({
        result: generalResult,
        field: "hitCount",
      }),
      projectSearchDegradedReason,
      projectSearchError,
      continuityExcluded: true,
      generalResult,
    },
  });
};

/**
 * Build user graph from project user-memory databases.
 */
