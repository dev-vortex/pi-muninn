/**
 * File intent: orchestrate once-per-prompt briefing assembly for prompt injection.
 *
 * This entrypoint service binds Pi runtime paths/providers into memory-core.
 * Prompt signal extraction, retrieval selection, rendering, and telemetry routing
 * now live in `packages/memory-core`.
 */

import path from "node:path";

import {
  storeContinuityTelemetryEvent,
  type ContinuityVectorEmbedder,
  type SearchContinuityVectorEntriesResult,
  readContinuityEntriesByIds as defaultReadContinuityEntriesByIds,
  searchContinuityVectorEntries as defaultSearchContinuityVectorEntries,
} from "../../../../packages/memory-core/src/adapters/sqlite/continuity/index.js";
import {
  createMemoryCore,
  extractPromptSignalTokens,
  normalizePromptSignalText,
  type CoreContinuityBriefingSemanticResult,
} from "../../../../packages/memory-core/src/index.js";
import { createPiMempalaceMemoryProvider } from "../../../../packages/memory-core/src/adapters/pi-mempalace-compatible/index.js";
import {
  createSqliteContinuityDataAdapterForDatabase,
  createSqliteContinuityTelemetryProviderForDatabase,
  createSqliteProjectIndexDataAdapterForProjectMemoryDir,
} from "../../../../packages/memory-core/src/adapters/sqlite/index.js";
import { resolveProjectContinuityBriefingMode } from "../../../project-memory/config.js";
import { readRelatedUserMemoryCandidates } from "../../../../packages/memory-core/src/adapters/sqlite/project-memory/related-user-memory-briefing.js";
import { buildMemorySemanticSignalKey } from "../../../../packages/memory-core/src/adapters/sqlite/project-memory/memory-briefing-utils.js";
import { createSqliteVecProjectSemanticMemorySearchProvider } from "../../../../packages/memory-core/src/adapters/sqlite/project-memory/semantic-search-provider.js";

interface PromptBriefingServiceDependencies {
  continuityVectorEmbedder?: ContinuityVectorEmbedder;
  env?: NodeJS.ProcessEnv;
  readContinuityEntriesByIds?: typeof defaultReadContinuityEntriesByIds;
  searchContinuityVectorEntries?: (input: {
    databasePath: string;
    embedder: ContinuityVectorEmbedder;
    queryText: string;
    limit?: number;
  }) => Promise<SearchContinuityVectorEntriesResult>;
}

/**
 * Resolve a stable event key for telemetry recorded once per user prompt.
 */
const resolvePromptBriefingKey = (event: unknown): string => {
  const turnIndexRaw = (event as { turnIndex?: unknown })?.turnIndex;
  const timestampRaw = (event as { timestamp?: unknown })?.timestamp;

  const turnIndex = typeof turnIndexRaw === "number" && Number.isFinite(turnIndexRaw)
    ? String(turnIndexRaw)
    : "unknown-turn";

  const timestamp = typeof timestampRaw === "number" || typeof timestampRaw === "string"
    ? String(timestampRaw)
    : "unknown-ts";

  return `${turnIndex}:${timestamp}`;
};

/**
 * Extract normalized signal text from the pi prompt event.
 */
const extractPromptSignalTextFromEvent = (event: unknown): string => {
  const prompt = (event as { prompt?: unknown })?.prompt;
  return typeof prompt === "string" ? normalizePromptSignalText(prompt) : "";
};

/**
 * Build briefing services bound to runtime dependencies.
 */
export const createPromptBriefingServices = (dependencies: PromptBriefingServiceDependencies = {}): {
  buildPromptBriefing: (input: {
    event: unknown;
    runtime: any | null;
    includeContinuity: boolean;
    includeProjectMemory: boolean;
    recordTelemetry?: boolean;
    debugShowBriefing?: (briefing: string) => void;
  }) => Promise<string | null>;
  resolveLatestUserRequestKey: (messages: unknown[]) => string;
  recordContinuityTelemetry: (input: {
    databasePath: string;
    eventType: "continuity_turn_briefing" | "continuity_query" | "continuity_write_stored" | "continuity_write_skipped_duplicate" | "continuity_compact_preview_result" | "continuity_compact_apply_result" | "continuity_write_skipped_low_signal";
    valueA?: number;
    valueB?: number;
    valueText?: string;
    payloadJson?: string;
  }) => void;
} => {
  const recordContinuityTelemetry = (telemetryInput: {
    databasePath: string;
    eventType: "continuity_turn_briefing" | "continuity_query" | "continuity_write_stored" | "continuity_write_skipped_duplicate" | "continuity_write_skipped_low_signal" | "continuity_compact_preview_result" | "continuity_compact_apply_result";
    valueA?: number;
    valueB?: number;
    valueText?: string;
    payloadJson?: string;
  }): void => {
    const result = storeContinuityTelemetryEvent(telemetryInput);
    if (result.status === "error") {
      // eslint-disable-next-line no-console
      console.warn(`[project-memory] continuity telemetry event failed: ${result.warning || "unknown error"}`);
    }
  };

  const resolveProjectMemoryDirFromRuntime = (runtime: any): string =>
    runtime.storePaths.projectMemoryDir || path.dirname(runtime.storePaths.projectUserDatabasePath);

  const resolveProjectRootFromRuntime = (runtime: any): string =>
    path.dirname(path.dirname(resolveProjectMemoryDirFromRuntime(runtime)));

  const createContinuityDataAdapterForBriefing = (runtime: any) =>
    createSqliteContinuityDataAdapterForDatabase({
      databasePath: runtime.storePaths.projectUserDatabasePath,
      searchBriefingEntries: async (searchInput): Promise<CoreContinuityBriefingSemanticResult> => {
        const embedder = dependencies.continuityVectorEmbedder;
        if (!embedder) {
          return {
            status: "unavailable",
            hits: [],
            warnings: ["continuity vector embedder unavailable"],
            diagnostics: { provider: "sqlite-continuity-data-adapter" },
          };
        }

        const searchContinuityVectorEntries = dependencies.searchContinuityVectorEntries || defaultSearchContinuityVectorEntries;
        const semanticSearch = await searchContinuityVectorEntries({
          databasePath: runtime.storePaths.projectUserDatabasePath,
          embedder,
          queryText: searchInput.queryText,
          limit: searchInput.limit,
        });
        if (semanticSearch.status !== "ok") {
          return {
            status: semanticSearch.status === "error" ? "error" : "unavailable",
            hits: [],
            warnings: semanticSearch.warning ? [semanticSearch.warning] : [],
            diagnostics: { provider: "sqlite-continuity-data-adapter" },
          };
        }

        const readContinuityEntriesByIds = dependencies.readContinuityEntriesByIds || defaultReadContinuityEntriesByIds;
        const hydratedRows = readContinuityEntriesByIds({
          databasePath: runtime.storePaths.projectUserDatabasePath,
          entryIds: semanticSearch.results.map((hit) => hit.entryId),
        });
        const entryById = new Map(hydratedRows.map((entry) => [entry.id, entry]));
        return {
          status: "ok",
          hits: semanticSearch.results.flatMap((hit) => {
            const entry = entryById.get(hit.entryId);
            if (!entry) return [];
            return [{
              record: {
                id: entry.id,
                section: entry.section,
                provenance: entry.provenance,
                certainty: entry.certainty,
                content: entry.content,
                timestamp: entry.timestamp,
                compacted: Boolean(entry.compactedIntoEntryId || entry.supersededByEntryId),
              },
              semanticSimilarity: hit.similarity,
            }];
          }),
          warnings: [],
          diagnostics: { provider: "sqlite-continuity-data-adapter" },
        };
      },
    });

  const createRelatedUserMemoryProvider = (runtime: any) => createPiMempalaceMemoryProvider({
    store: async () => {
      throw new Error("prompt briefing never writes through related-user memory provider");
    },
    search: async (searchInput) => {
      const relatedRead = readRelatedUserMemoryCandidates({
        globalDatabasePath: runtime.storePaths.globalDatabasePath,
        signalTokens: extractPromptSignalTokens(searchInput.query),
        candidateLimit: searchInput.limit || 50,
      });
      if (relatedRead.note) {
        throw new Error(relatedRead.note);
      }

      const semanticSimilarityByKey = new Map<string, number>();
      if (searchInput.query.trim().length > 0 && relatedRead.candidates.length > 0) {
        try {
          const semantic = await createSqliteVecProjectSemanticMemorySearchProvider().search({
            query: searchInput.query,
            databasePaths: [runtime.storePaths.globalDatabasePath],
            topK: Math.max(relatedRead.candidates.length * 4, 20),
            perDbLimit: Math.max(relatedRead.candidates.length * 4, 10),
          });
          const selectedKeys = new Set(relatedRead.candidates.map((candidate) => buildMemorySemanticSignalKey(runtime.storePaths.globalDatabasePath, candidate.id)));
          for (const hit of semantic.results) {
            const key = buildMemorySemanticSignalKey(hit.databasePath, hit.id);
            if (selectedKeys.has(key)) {
              semanticSimilarityByKey.set(key, hit.semanticSimilarity);
            }
          }
        } catch {
          // Related-memory semantic percentages are annotation-only; lexical rows remain useful without them.
        }
      }

      return relatedRead.candidates.map((candidate) => ({
        id: candidate.id,
        text: candidate.content,
        project: "general",
        topic: candidate.topic,
        timestamp: candidate.timestamp,
        similarity: semanticSimilarityByKey.get(buildMemorySemanticSignalKey(runtime.storePaths.globalDatabasePath, candidate.id)),
      }));
    },
    recall: async () => [],
  });

  const buildPromptBriefing = async (briefingInput: {
    event: unknown;
    runtime: any | null;
    includeContinuity: boolean;
    includeProjectMemory: boolean;
    recordTelemetry?: boolean;
    debugShowBriefing?: (briefing: string) => void;
  }): Promise<string | null> => {
    const runtime = briefingInput.runtime;
    if (!runtime || !runtime.config.projectMemoryEnabled || runtime.storePaths.activeScope !== "project-enabled") {
      return null;
    }

    const signalText = extractPromptSignalTextFromEvent(briefingInput.event);
    const signalTokens = extractPromptSignalTokens(signalText);
    const continuityBriefingMode = resolveProjectContinuityBriefingMode(
      runtime.config,
      dependencies.env || process.env,
    );
    const core = createMemoryCore({
      continuityData: createContinuityDataAdapterForBriefing(runtime),
      projectIndexData: createSqliteProjectIndexDataAdapterForProjectMemoryDir({
        projectMemoryDir: resolveProjectMemoryDirFromRuntime(runtime),
        mode: runtime.config.mode || "fanout",
        activeUserId: runtime.userId,
        indexFreshnessSeconds: runtime.config.index?.intervalSeconds,
      }),
      memoryProvider: createRelatedUserMemoryProvider(runtime),
      telemetry: createSqliteContinuityTelemetryProviderForDatabase({
        databasePath: runtime.storePaths.projectUserDatabasePath,
      }),
    });
    const result = await core.buildPromptBriefing({
      context: {
        projectRoot: resolveProjectRootFromRuntime(runtime),
        userId: runtime.userId,
        requestId: resolvePromptBriefingKey(briefingInput.event),
      },
      prompt: signalText,
      includeContinuity: briefingInput.includeContinuity,
      includeProjectMemory: briefingInput.includeProjectMemory,
      recordTelemetry: briefingInput.recordTelemetry,
      continuityMode: continuityBriefingMode.mode,
      telemetrySource: "before_agent_start",
    });

    const prompt = result.briefingText;
    if (prompt && briefingInput.debugShowBriefing) {
      // Debug visibility is injected by dev-only command wiring; release has no enabling command.
      briefingInput.debugShowBriefing(prompt);
    }

    if (result.warnings.length > 0) {
      for (const warning of result.warnings) {
        // eslint-disable-next-line no-console
        console.warn(`[project-memory] ${warning}`);
      }
    }

    return prompt;
  };

  const buildContinuityRequestContentKey = (content: unknown): string => {
    if (typeof content === "string") return content.trim().replace(/\s+/g, " ").slice(0, 200);
    try {
      return JSON.stringify(content).slice(0, 200);
    } catch {
      return "UNSERIALIZABLE";
    }
  };

  const resolveLatestUserRequestKey = (messages: unknown[]): string => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (typeof message !== "object" || message === null) continue;
      const role = (message as { role?: unknown }).role;
      if (role !== "user") continue;

      const timestampRaw = (message as { timestamp?: unknown }).timestamp;
      const timestamp = typeof timestampRaw === "number" || typeof timestampRaw === "string" ? String(timestampRaw) : "no-ts";
      const contentKey = buildContinuityRequestContentKey((message as { content?: unknown }).content);
      return `${timestamp}:${contentKey}`;
    }

    return "no-user-message";
  };

  return {
    buildPromptBriefing,
    resolveLatestUserRequestKey,
    recordContinuityTelemetry,
  };
};
