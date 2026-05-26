/**
 * File intent: orchestrate semantic-first project-memory retrieval.
 *
 * This file implements the hybrid search path used by `memory_search`: bounded
 * semantic fan-out over project user DB vectors first, lexical/index support for
 * exact identifiers or degraded vector lanes second, and metadata that explains
 * fan-out pressure/fallback behavior. Keep strategy orchestration here; keep
 * concrete vector search mechanics in `semantic-search-provider.ts`.
 */

import path from "node:path";

import {
  discoverProjectUserDatabases,
  type FanoutSearchHit,
} from "../project-index/fanout-retrieval.js";
import { searchProjectIndex } from "../project-index/project-index.js";
import type { ProjectMemoryMode } from "../../../../packages/memory-core/src/project-memory/types.js";
import {
  searchProjectMemoryByMode,
  type ModeAwareProjectSearchInput,
  type ModeAwareProjectSearchResult,
} from "./mode-selection.js";
import {
  createSqliteVecProjectSemanticMemorySearchProvider,
  type ProjectSemanticMemorySearchProvider,
  type ProjectSemanticMemorySearchResult,
} from "./semantic-search-provider.js";

/**
 * Retrieval route used by the hybrid project-memory search path.
 */
export type HybridProjectMemoryRetrievalMode =
  | "semantic-fanout"
  | "semantic-fanout+lexical-support"
  | "lexical-fallback";

/**
 * Metadata exposed to tool details for runtime and scale observability.
 */
export interface HybridProjectMemorySearchMetadata {
  projectRetrievalMode: HybridProjectMemoryRetrievalMode;
  projectSemanticAttempted: boolean;
  projectSemanticUsed: boolean;
  projectSemanticDatabaseCount: number;
  projectSemanticSearchedDatabaseCount: number;
  projectSemanticSkippedDatabaseCount: number;
  projectSemanticHitCount: number;
  projectLexicalFallbackUsed: boolean;
  projectLexicalSupportUsed: boolean;
  projectLexicalHitCount: number;
  projectRetrievalErrorCount: number;
  projectRetrievalLatencyMs: number;
  projectExactIdentifierQuery: boolean;
  projectIndexHintUsed: boolean;
  projectSemanticAllDbThreshold: number;
  projectSemanticMaxFanoutDatabases: number;
}

/**
 * Input contract for semantic-first hybrid project-memory search.
 */
export interface HybridProjectMemorySearchInput {
  projectMemoryDir: string;
  query: string;
  topK?: number;
  perDbLimit?: number;
  indexFreshnessSeconds?: number;
  activeUserId?: string;
  lexicalMode?: ProjectMemoryMode;
  semanticAllDbThreshold?: number;
  maxSemanticFanoutDatabases?: number;
}

/**
 * Result envelope for the approved F10.9 project-memory retrieval path.
 */
export interface HybridProjectMemorySearchResult {
  query: string;
  results: FanoutSearchHit[];
  databaseCount: number;
  searchedDatabaseCount: number;
  degraded: boolean;
  degradedReason?: string;
  errors: Array<{ databasePath: string; error: string }>;
  metadata: HybridProjectMemorySearchMetadata;
}

/**
 * Dependencies injectable by tests and future backend implementations.
 */
export interface HybridProjectMemorySearchDependencies {
  discoverDatabases?: typeof discoverProjectUserDatabases;
  semanticProvider?: ProjectSemanticMemorySearchProvider;
  lexicalSearch?: (input: ModeAwareProjectSearchInput) => Promise<ModeAwareProjectSearchResult>;
  indexHintSearch?: typeof searchProjectIndex;
  nowMs?: () => number;
}

interface CandidateSelectionResult {
  databasePaths: string[];
  databaseCount: number;
  indexHintUsed: boolean;
}

/**
 * Clamp integer runtime bounds to predictable, non-zero values.
 */
const clampInt = (value: number | undefined, fallback: number, min: number, max: number): number => {
  const candidate = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(min, Math.min(candidate, max));
};

/**
 * Recognize queries where exact lexical matching must be preserved.
 */
export const hasExactIdentifierHints = (query: string): boolean => {
  const tokens = query.trim().split(/\s+/).filter(Boolean);

  return tokens.some((token) => {
    const unquoted = token.replace(/^["'`“”‘’]+|["'`“”‘’.,;:!?]+$/g, "");

    return /[./:_-]/.test(unquoted)
      || /[A-Z][A-Z0-9_]{4,}/.test(unquoted)
      || /\b[A-Za-z]+\d+(?:\.\d+)+\b/.test(unquoted)
      || /\b\d+[A-Za-z]+\d*\b/.test(unquoted);
  });
};

/**
 * Infer the user id represented by one project user DB path.
 */
const userIdFromDatabasePath = (databasePath: string): string =>
  path.basename(databasePath, ".db");

/**
 * Add a DB path once while preserving insertion order.
 */
const addCandidatePath = (selected: Map<string, string>, databasePath: string): void => {
  if (!selected.has(databasePath)) {
    selected.set(databasePath, databasePath);
  }
};

/**
 * Select bounded semantic fan-out sources without forcing all-DB vector search.
 */
const selectSemanticCandidateDatabases = async (input: {
  projectMemoryDir: string;
  query: string;
  activeUserId?: string;
  semanticAllDbThreshold: number;
  maxSemanticFanoutDatabases: number;
  discoverDatabases: typeof discoverProjectUserDatabases;
  indexHintSearch: typeof searchProjectIndex;
}): Promise<CandidateSelectionResult> => {
  const allDatabasePaths = await input.discoverDatabases(input.projectMemoryDir);

  if (allDatabasePaths.length <= input.semanticAllDbThreshold) {
    return {
      databasePaths: allDatabasePaths,
      databaseCount: allDatabasePaths.length,
      indexHintUsed: false,
    };
  }

  const selected = new Map<string, string>();
  const activeUserId = input.activeUserId?.trim();

  if (activeUserId) {
    const activeDatabasePath = allDatabasePaths.find((databasePath) =>
      userIdFromDatabasePath(databasePath) === activeUserId);
    if (activeDatabasePath) {
      addCandidatePath(selected, activeDatabasePath);
    }
  }

  let indexHintUsed = false;
  try {
    const hints = await input.indexHintSearch({
      projectMemoryDir: input.projectMemoryDir,
      query: input.query,
      topK: input.maxSemanticFanoutDatabases,
      activeUserId,
    });

    if (hints.indexReady && !hints.error) {
      for (const hit of hints.results) {
        if (hit.kind === "memory" && allDatabasePaths.includes(hit.databasePath)) {
          addCandidatePath(selected, hit.databasePath);
          indexHintUsed = true;
        }

        if (selected.size >= input.maxSemanticFanoutDatabases) {
          break;
        }
      }
    }
  } catch {
    // Candidate hints are opportunistic; deterministic fallback below still bounds search.
  }

  for (const databasePath of allDatabasePaths) {
    if (selected.size >= input.maxSemanticFanoutDatabases) {
      break;
    }
    addCandidatePath(selected, databasePath);
  }

  return {
    databasePaths: Array.from(selected.values()),
    databaseCount: allDatabasePaths.length,
    indexHintUsed,
  };
};

/**
 * Keep memory-search output scoped to memories only; continuity has dedicated tools.
 */
const onlyMemoryHits = (hits: FanoutSearchHit[]): FanoutSearchHit[] =>
  hits.filter((hit) => hit.kind === "memory");

/**
 * Stable key for de-duplicating semantic and lexical hits.
 */
const hitKey = (hit: FanoutSearchHit): string =>
  `${hit.kind}:${hit.databasePath}:${hit.id}`;

/**
 * Merge hit lists while preserving priority order and removing duplicates.
 */
const mergeHits = (primary: FanoutSearchHit[], secondary: FanoutSearchHit[], limit: number): FanoutSearchHit[] => {
  const merged: FanoutSearchHit[] = [];
  const seen = new Set<string>();

  for (const hit of [...primary, ...secondary]) {
    const key = hitKey(hit);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(hit);

    if (merged.length >= limit) {
      break;
    }
  }

  return merged;
};

/**
 * Join degraded notes in a readable, bounded string.
 */
const joinReasons = (reasons: Array<string | null | undefined>): string | undefined => {
  const joined = reasons
    .filter((reason): reason is string => typeof reason === "string" && reason.trim().length > 0)
    .join("; ");

  return joined.length > 0 ? joined : undefined;
};

/**
 * Execute the approved semantic-first project-memory search path for memory_search.
 */
export const searchProjectMemoryHybrid = async (
  input: HybridProjectMemorySearchInput,
  dependencies: HybridProjectMemorySearchDependencies = {},
): Promise<HybridProjectMemorySearchResult> => {
  const nowMs = dependencies.nowMs || Date.now;
  const startedAtMs = nowMs();
  const topK = clampInt(input.topK, 20, 1, 200);
  const perDbLimit = clampInt(input.perDbLimit, Math.max(topK * 3, 10), 1, 50);
  const semanticAllDbThreshold = clampInt(input.semanticAllDbThreshold, 8, 1, 100);
  const maxSemanticFanoutDatabases = clampInt(input.maxSemanticFanoutDatabases, 20, 1, 200);
  const discoverDatabases = dependencies.discoverDatabases || discoverProjectUserDatabases;
  const semanticProvider = dependencies.semanticProvider || createSqliteVecProjectSemanticMemorySearchProvider();
  const lexicalSearch = dependencies.lexicalSearch || searchProjectMemoryByMode;
  const indexHintSearch = dependencies.indexHintSearch || searchProjectIndex;
  const exactIdentifierQuery = hasExactIdentifierHints(input.query);

  const candidates = await selectSemanticCandidateDatabases({
    projectMemoryDir: input.projectMemoryDir,
    query: input.query,
    activeUserId: input.activeUserId,
    semanticAllDbThreshold,
    maxSemanticFanoutDatabases,
    discoverDatabases,
    indexHintSearch,
  });

  let semantic: ProjectSemanticMemorySearchResult;
  try {
    semantic = await semanticProvider.search({
      query: input.query,
      databasePaths: candidates.databasePaths,
      topK,
      perDbLimit,
    });
  } catch (error: unknown) {
    semantic = {
      query: input.query,
      databaseCount: candidates.databasePaths.length,
      searchedDatabaseCount: 0,
      results: [],
      errors: [{
        databasePath: "<semantic-provider>",
        error: error instanceof Error ? error.message : String(error),
      }],
    };
  }

  const semanticMemoryHits = onlyMemoryHits(semantic.results);
  const semanticUsable = semanticMemoryHits.length > 0;
  const shouldRunLexical = exactIdentifierQuery || !semanticUsable;

  let lexicalResult: ModeAwareProjectSearchResult | null = null;
  let lexicalMemoryHits: FanoutSearchHit[] = [];
  const lexicalErrors: Array<{ databasePath: string; error: string }> = [];

  if (shouldRunLexical) {
    try {
      lexicalResult = await lexicalSearch({
        projectMemoryDir: input.projectMemoryDir,
        query: input.query,
        mode: input.lexicalMode || "index-first",
        topK,
        perDbLimit,
        indexFreshnessSeconds: input.indexFreshnessSeconds,
        activeUserId: input.activeUserId,
      });
      lexicalMemoryHits = onlyMemoryHits(lexicalResult.results);
      lexicalErrors.push(...lexicalResult.errors);
    } catch (error: unknown) {
      lexicalErrors.push({
        databasePath: "<lexical-fallback>",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const lexicalFallbackUsed = !semanticUsable && shouldRunLexical;
  const lexicalSupportUsed = semanticUsable && exactIdentifierQuery && lexicalMemoryHits.length > 0;
  const finalResults = lexicalFallbackUsed
    ? mergeHits(lexicalMemoryHits, semanticMemoryHits, topK)
    : lexicalSupportUsed
      ? mergeHits(lexicalMemoryHits, semanticMemoryHits, topK)
      : mergeHits(semanticMemoryHits, lexicalMemoryHits, topK);
  const projectRetrievalMode: HybridProjectMemoryRetrievalMode = lexicalFallbackUsed
    ? "lexical-fallback"
    : lexicalSupportUsed
      ? "semantic-fanout+lexical-support"
      : "semantic-fanout";
  const allErrors = [...semantic.errors, ...lexicalErrors];
  const skippedDatabaseCount = Math.max(0, candidates.databaseCount - candidates.databasePaths.length);
  const searchedDatabaseCount = lexicalResult
    ? Math.max(semantic.searchedDatabaseCount, lexicalResult.searchedDatabaseCount)
    : semantic.searchedDatabaseCount;
  const degradedReason = joinReasons([
    skippedDatabaseCount > 0
      ? `semantic fan-out searched ${candidates.databasePaths.length}/${candidates.databaseCount} DBs within budget`
      : null,
    semantic.errors.length > 0
      ? `semantic retrieval had ${semantic.errors.length} warning(s)`
      : null,
    lexicalFallbackUsed
      ? "semantic retrieval returned no memory hits; lexical fallback used"
      : null,
    lexicalResult?.degradedReason,
    lexicalErrors.length > 0
      ? `lexical retrieval had ${lexicalErrors.length} warning(s)`
      : null,
  ]);

  const latencyMs = Math.max(0, Math.round(nowMs() - startedAtMs));

  return {
    query: input.query,
    results: finalResults,
    databaseCount: candidates.databaseCount,
    searchedDatabaseCount,
    degraded: Boolean(degradedReason),
    degradedReason,
    errors: allErrors,
    metadata: {
      projectRetrievalMode,
      projectSemanticAttempted: true,
      projectSemanticUsed: semanticUsable,
      projectSemanticDatabaseCount: candidates.databaseCount,
      projectSemanticSearchedDatabaseCount: semantic.searchedDatabaseCount,
      projectSemanticSkippedDatabaseCount: skippedDatabaseCount,
      projectSemanticHitCount: semanticMemoryHits.length,
      projectLexicalFallbackUsed: lexicalFallbackUsed,
      projectLexicalSupportUsed: lexicalSupportUsed,
      projectLexicalHitCount: lexicalMemoryHits.length,
      projectRetrievalErrorCount: allErrors.length,
      projectRetrievalLatencyMs: latencyMs,
      projectExactIdentifierQuery: exactIdentifierQuery,
      projectIndexHintUsed: candidates.indexHintUsed,
      projectSemanticAllDbThreshold: semanticAllDbThreshold,
      projectSemanticMaxFanoutDatabases: maxSemanticFanoutDatabases,
    },
  };
};
