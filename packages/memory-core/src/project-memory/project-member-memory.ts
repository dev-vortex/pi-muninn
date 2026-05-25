/**
 * File intent: own host-neutral L1 project-member memory orchestration.
 *
 * This service keeps routing/formatting policy in memory-core while delegating
 * physical storage/search/recall to a vendor-compatible memory provider. It is
 * intentionally scoped to project-member memory; global curated memory lives in
 * the sibling global-memory domain service.
 */

import type {
  MemoryOperationResult,
  MemoryRecallRequest,
  MemorySaveRequest,
  MemorySearchRequest,
} from "../contracts.js";
import type {
  CoreMemoryHit,
  CoreMemoryProviderPort,
} from "../ports.js";

/**
 * Dependencies needed by project-member memory orchestration.
 */
export interface ProjectMemberMemoryServiceDependencies {
  /** L1/L3 provider; this service uses only the project-member lane. */
  memoryProvider: Pick<CoreMemoryProviderPort, "save" | "search" | "recall">;
}

/**
 * Normalize arbitrary user/LLM text fields for persistence and diagnostics.
 */
const normalizeText = (value: string | undefined): string =>
  (value || "").trim().replace(/\s+/g, " ");

/**
 * Clamp user-supplied result limits to upstream-compatible project-member bounds.
 */
const normalizeLimit = (value: number | undefined, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), 50));
};

/**
 * Resolve the provider project/name bucket for one memory request.
 */
const resolveProjectName = (input: {
  projectName?: string;
  projectRoot: string;
}): string => normalizeText(input.projectName) || input.projectRoot;

/**
 * Resolve the timestamp used by project-member memory writes.
 */
const resolveTimestamp = (value: string | undefined): string => {
  if (value && !Number.isNaN(Date.parse(value))) {
    return new Date(Date.parse(value)).toISOString();
  }

  return new Date().toISOString();
};

/**
 * Build a text operation result whose diagnostics are tool-details friendly.
 */
const buildOperationResult = (input: {
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
 * Render one project-member hit with optional semantic similarity metadata.
 */
const renderProjectMemberHit = (hit: CoreMemoryHit): string => {
  const similarity = typeof hit.semanticSimilarity === "number" && Number.isFinite(hit.semanticSimilarity)
    ? `${(Math.max(0, Math.min(1, hit.semanticSimilarity)) * 100).toFixed(1)}% match, `
    : "";
  const topic = hit.topic || "general";
  const timestamp = hit.timestamp || "unknown";
  return `[project/${topic}] (${similarity}${timestamp})\n${hit.content}`;
};

/**
 * Render search results for the project-member lane.
 */
const renderSearchResultText = (input: {
  query: string;
  hits: CoreMemoryHit[];
}): string => {
  if (input.hits.length === 0) {
    return `Project memory lane (continuity excluded):\nNo project memories found for: "${input.query}"`;
  }

  return [
    `Project memory lane (continuity excluded):\nFound ${input.hits.length} project memories for "${input.query}":`,
    ...input.hits.map(renderProjectMemberHit),
  ].join("\n\n---\n\n");
};

/**
 * Render recall results for the project-member lane.
 */
const renderRecallResultText = (input: {
  topic?: string;
  hits: CoreMemoryHit[];
}): string => {
  const topicLabel = input.topic ? ` (topic=${input.topic})` : "";

  if (input.hits.length === 0) {
    return `Project memory lane (continuity excluded)${topicLabel}:\nNo project memories found.`;
  }

  return [
    `Project memory lane (continuity excluded)${topicLabel}:\nFound ${input.hits.length} project memories:`,
    ...input.hits.map(renderProjectMemberHit),
  ].join("\n\n---\n\n");
};

/**
 * Create project-member memory orchestration around one memory provider.
 */
export const createProjectMemberMemoryService = (
  dependencies: ProjectMemberMemoryServiceDependencies,
): {
  save: (input: MemorySaveRequest) => Promise<MemoryOperationResult>;
  search: (input: MemorySearchRequest) => Promise<MemoryOperationResult>;
  recall: (input: MemoryRecallRequest) => Promise<MemoryOperationResult>;
} => ({
  save: async (input: MemorySaveRequest): Promise<MemoryOperationResult> => {
    const projectContent = normalizeText(input.projectContent);
    const generalContent = normalizeText(input.generalContent);

    if (!projectContent && !generalContent) {
      return buildOperationResult({
        status: "error",
        text: "memory_save requires at least one target payload (`project_content` and/or `general_content`).",
        details: {
          status: "blocked-project-curation",
          route: "memory_save_dispatch",
          reason: "missing-target-payload",
        },
      });
    }

    if (!projectContent) {
      return buildOperationResult({
        status: "unimplemented",
        text: "memory_save general route is handled by the global curated memory service, not the project-member service.",
        details: {
          status: "unimplemented",
          target: "general",
          route: "memory_save_L3",
          reason: "use-global-curated-memory-service",
        },
        warnings: ["use-global-curated-memory-service"],
      });
    }

    const topic = normalizeText(input.projectTopic) || "general";
    const timestamp = resolveTimestamp(input.context.now);
    const importance = typeof input.importance === "number" && Number.isFinite(input.importance)
      ? input.importance
      : 0.8;
    const providerResult = await dependencies.memoryProvider.save({
      context: {
        ...input.context,
        now: timestamp,
      },
      lane: "project-member",
      content: projectContent,
      projectName: resolveProjectName({
        projectName: input.projectName,
        projectRoot: input.context.projectRoot,
      }),
      topic,
      source: "manual-save",
      timestamp,
      importance,
    });

    if (providerResult.status === "error") {
      const warning = providerResult.warnings[0] || "unknown error";
      return buildOperationResult({
        status: "error",
        text: `memory_save project route failed: ${warning}`,
        details: {
          status: "error-project-specific-route",
          target: "project",
          route: "memory_save_L1",
          reason: "provider-save-failed",
          error: warning,
          ...providerResult.diagnostics,
        },
        warnings: providerResult.warnings,
      });
    }

    const isDuplicate = providerResult.duplicate;
    const warnings = generalContent
      ? ["general-route-ignored-by-project-member-service"]
      : [];

    return buildOperationResult({
      status: "ok",
      text: isDuplicate
        ? "memory_save routed project payload to project memory (duplicate already existed)."
        : "memory_save stored project payload in project memory (active member scope).",
      details: {
        status: isDuplicate ? "duplicate-project-specific" : "stored-project-specific",
        target: "project",
        route: "memory_save_L1",
        storageLayer: "project_memory",
        topic,
        source: "manual-save",
        timestamp,
        importance,
        memoryId: providerResult.id,
        vendorStatus: providerResult.duplicate ? "duplicate" : "stored",
        ...providerResult.diagnostics,
        ...(generalContent ? { generalRoute: "ignored-by-project-member-service" } : {}),
      },
      warnings,
    });
  },

  search: async (input: MemorySearchRequest): Promise<MemoryOperationResult> => {
    const query = normalizeText(input.query);
    if (!query) {
      return buildOperationResult({
        status: "error",
        text: "memory_search project-member route requires a non-empty query.",
        details: {
          status: "error",
          route: "memory_search_project_member",
          reason: "invalid-query",
        },
      });
    }

    const limit = normalizeLimit(input.limit, 5);
    const providerResult = await dependencies.memoryProvider.search({
      context: input.context,
      lanes: ["project-member"],
      query,
      projectName: input.projectName,
      topic: input.topic,
      limit,
    });

    return buildOperationResult({
      status: providerResult.status,
      text: providerResult.status === "error"
        ? `memory_search project-member route failed: ${providerResult.warnings[0] || "unknown error"}`
        : renderSearchResultText({ query, hits: providerResult.hits }),
      details: {
        status: providerResult.status === "error" ? "error" : "search-project-member",
        route: "memory_search_project_member",
        query,
        requestedTopicFilter: input.topic,
        projectHitCount: providerResult.hits.length,
        continuityExcluded: true,
        ...providerResult.diagnostics,
      },
      warnings: providerResult.warnings,
    });
  },

  recall: async (input: MemoryRecallRequest): Promise<MemoryOperationResult> => {
    const limit = normalizeLimit(input.limit, 10);
    const providerResult = await dependencies.memoryProvider.recall({
      context: input.context,
      lanes: ["project-member"],
      projectName: input.projectName,
      topic: input.topic,
      limit,
    });

    return buildOperationResult({
      status: providerResult.status,
      text: providerResult.status === "error"
        ? `memory_recall project-member route failed: ${providerResult.warnings[0] || "unknown error"}`
        : renderRecallResultText({ topic: input.topic, hits: providerResult.hits }),
      details: {
        status: providerResult.status === "error" ? "error" : "recall-project-member",
        route: "memory_recall_project_member",
        requestedTopicFilter: input.topic,
        projectHitCount: providerResult.hits.length,
        continuityExcluded: true,
        ...providerResult.diagnostics,
      },
      warnings: providerResult.warnings,
    });
  },
});
