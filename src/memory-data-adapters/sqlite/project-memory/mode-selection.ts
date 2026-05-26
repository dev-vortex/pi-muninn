/**
 * File intent: choose and execute lexical project-memory retrieval modes.
 *
 * This file routes `/memory project search`, runtime context assembly, and
 * lexical fallback paths between direct fan-out and index-first retrieval. It
 * also benchmarks those modes and degrades safely to fan-out when the derived
 * index is stale, missing, or incomplete.
 */

import type { ProjectMemoryMode } from "../../../../packages/memory-core/src/project-memory/types.js";
import {
  fanoutProjectMemorySearch,
  type FanoutSearchHit,
} from "../project-index/fanout-retrieval.js";
import {
  computeProjectIndexSourceFingerprint,
  readProjectIndexStatus,
  rebuildProjectIndex,
  searchProjectIndex,
  type ProjectIndexBuildStatus,
} from "../project-index/project-index.js";

/**
 * Input for mode-aware project memory search.
 */
export interface ModeAwareProjectSearchInput {
  projectMemoryDir: string;
  query: string;
  mode: ProjectMemoryMode;
  topK?: number;
  perDbLimit?: number;
  indexFreshnessSeconds?: number;
  /** Active user id used for member-local L2 cache isolation. */
  activeUserId?: string;
}

/**
 * Unified result envelope for mode-aware search operations.
 */
export interface ModeAwareProjectSearchResult {
  query: string;
  requestedMode: ProjectMemoryMode;
  effectiveMode: ProjectMemoryMode;
  degraded: boolean;
  degradedReason?: string;
  indexStatus?: ProjectIndexBuildStatus;
  databaseCount: number;
  searchedDatabaseCount: number;
  results: FanoutSearchHit[];
  errors: Array<{ databasePath: string; error: string }>;
}

/**
 * Runtime benchmark input for comparing fan-out and index-first search modes.
 */
export interface ProjectMemoryModeBenchmarkInput {
  projectMemoryDir: string;
  query: string;
  iterations?: number;
  topK?: number;
  perDbLimit?: number;
  /** Optional active user id when benchmarking owner-scoped L2 cache paths. */
  activeUserId?: string;
}

/**
 * Per-strategy latency and reliability summary from benchmark runs.
 */
export interface ProjectMemoryModeBenchmarkStats {
  iterations: number;
  successCount: number;
  failureCount: number;
  avgMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  lastError: string | null;
}

/**
 * Benchmark result with recommendation for default project-memory mode.
 */
export interface ProjectMemoryModeBenchmarkResult {
  query: string;
  iterations: number;
  fanout: ProjectMemoryModeBenchmarkStats;
  indexFirst: ProjectMemoryModeBenchmarkStats;
  recommendedMode: ProjectMemoryMode;
  rationale: string;
}

/**
 * Parse ISO timestamp into epoch milliseconds.
 */
const parseIsoMillis = (value: string | null): number | null => {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

/**
 * Compute p95 latency from a list of durations.
 */
const computeP95 = (durations: number[]): number => {
  if (durations.length === 0) {
    return 0;
  }

  const sorted = [...durations].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1));
  return sorted[index];
};

/**
 * Summarize benchmark durations and errors for one strategy.
 */
const buildBenchmarkStats = (input: {
  iterations: number;
  durations: number[];
  errors: string[];
}): ProjectMemoryModeBenchmarkStats => {
  const successCount = input.durations.length;
  const failureCount = input.errors.length;
  const avgMs = successCount === 0
    ? 0
    : Math.round(input.durations.reduce((acc, value) => acc + value, 0) / successCount);

  return {
    iterations: input.iterations,
    successCount,
    failureCount,
    avgMs,
    p95Ms: Math.round(computeP95(input.durations)),
    minMs: successCount === 0 ? 0 : Math.min(...input.durations),
    maxMs: successCount === 0 ? 0 : Math.max(...input.durations),
    lastError: input.errors.length > 0 ? input.errors[input.errors.length - 1] : null,
  };
};

/**
 * Resolve normalized active user id for owner-scoped L2 operations.
 */
const resolveActiveUserId = (input: {
  requestedUserId?: string;
  cachedOwnerUserId?: string | null;
}): string =>
  input.requestedUserId?.trim() || input.cachedOwnerUserId || "default-owner";

/**
 * Evaluate whether the project index can be trusted for runtime retrieval.
 */
const evaluateIndexReadiness = async (input: {
  projectMemoryDir: string;
  indexFreshnessSeconds?: number;
  activeUserId?: string;
}): Promise<{
  usable: boolean;
  status: Awaited<ReturnType<typeof readProjectIndexStatus>>;
  activeUserId: string;
  reason?: string;
}> => {
  const status = await readProjectIndexStatus({ projectMemoryDir: input.projectMemoryDir });
  const activeUserId = resolveActiveUserId({
    requestedUserId: input.activeUserId,
    cachedOwnerUserId: status.ownerUserId,
  });

  if (status.status !== "ready" && status.status !== "partial") {
    return {
      usable: false,
      status,
      activeUserId,
      reason: `index status is '${status.status}'`,
    };
  }

  if (status.ownerUserId && status.ownerUserId !== activeUserId) {
    return {
      usable: false,
      status,
      activeUserId,
      reason: `index owner mismatch (cache=${status.ownerUserId}, active=${activeUserId})`,
    };
  }

  const fingerprint = await computeProjectIndexSourceFingerprint({
    projectMemoryDir: input.projectMemoryDir,
    activeUserId,
  });

  if (fingerprint.errors.length > 0) {
    return {
      usable: false,
      status,
      activeUserId,
      reason: `index fingerprint failed for ${fingerprint.errors.length} source db(s)`,
    };
  }

  if (status.sourceDatabaseCount !== fingerprint.sourceDatabaseCount) {
    return {
      usable: false,
      status,
      activeUserId,
      reason: `index source count mismatch (index=${status.sourceDatabaseCount}, discovered=${fingerprint.sourceDatabaseCount})`,
    };
  }

  if (!status.sourceFingerprint || status.sourceFingerprint !== fingerprint.digest) {
    return {
      usable: false,
      status,
      activeUserId,
      reason: "index source fingerprint drift detected",
    };
  }

  if (typeof input.indexFreshnessSeconds === "number" && input.indexFreshnessSeconds > 0) {
    const rebuiltAtMs = parseIsoMillis(status.lastRebuildAt);

    if (rebuiltAtMs === null) {
      return {
        usable: false,
        status,
        activeUserId,
        reason: "index has never been rebuilt",
      };
    }

    const ageSeconds = Math.floor((Date.now() - rebuiltAtMs) / 1000);
    if (ageSeconds > input.indexFreshnessSeconds) {
      return {
        usable: false,
        status,
        activeUserId,
        reason: `index is stale (${ageSeconds}s > ${input.indexFreshnessSeconds}s)`,
      };
    }
  }

  return {
    usable: true,
    status,
    activeUserId,
  };
};

/**
 * Execute project-memory search with mode selection and deterministic index rebuild fallback.
 */
export const searchProjectMemoryByMode = async (
  input: ModeAwareProjectSearchInput,
): Promise<ModeAwareProjectSearchResult> => {
  const topK = Math.max(1, Math.min(input.topK ?? 20, 200));
  const perDbLimit = Math.max(1, Math.min(input.perDbLimit ?? 10, 100));

  if (input.mode === "fanout") {
    const fanout = await fanoutProjectMemorySearch({
      projectMemoryDir: input.projectMemoryDir,
      query: input.query,
      topK,
      perDbLimit,
    });

    return {
      query: input.query,
      requestedMode: "fanout",
      effectiveMode: "fanout",
      degraded: false,
      databaseCount: fanout.databaseCount,
      searchedDatabaseCount: fanout.searchedDatabaseCount,
      results: fanout.results,
      errors: fanout.errors,
    };
  }

  const readiness = await evaluateIndexReadiness({
    projectMemoryDir: input.projectMemoryDir,
    indexFreshnessSeconds: input.indexFreshnessSeconds,
    activeUserId: input.activeUserId,
  });

  const fallbackErrors: Array<{ databasePath: string; error: string }> = [];

  const buildFanoutFallback = async (reason: string, indexStatus?: ProjectIndexBuildStatus) => {
    const fanoutFallback = await fanoutProjectMemorySearch({
      projectMemoryDir: input.projectMemoryDir,
      query: input.query,
      topK,
      perDbLimit,
    });

    return {
      query: input.query,
      requestedMode: "index-first" as const,
      effectiveMode: "fanout" as const,
      degraded: true,
      degradedReason: reason,
      indexStatus,
      databaseCount: fanoutFallback.databaseCount,
      searchedDatabaseCount: fanoutFallback.searchedDatabaseCount,
      results: fanoutFallback.results,
      errors: [...fallbackErrors, ...fanoutFallback.errors],
    };
  };

  let rebuildTriggered = false;
  let rebuildReason: string | null = null;
  let currentIndexStatus: ProjectIndexBuildStatus | undefined = readiness.status.status;

  const attemptRebuild = async (reason: string): Promise<boolean> => {
    rebuildTriggered = true;

    const rebuild = await rebuildProjectIndex({
      projectMemoryDir: input.projectMemoryDir,
      activeUserId: readiness.activeUserId,
    });

    currentIndexStatus = rebuild.status;

    if (rebuild.errors.length > 0) {
      fallbackErrors.push(...rebuild.errors);
    }

    if (rebuild.status !== "ready" && rebuild.status !== "partial") {
      fallbackErrors.unshift({
        databasePath: rebuild.indexDatabasePath,
        error: `index rebuild did not reach ready state (status='${rebuild.status}')`,
      });
      return false;
    }

    rebuildReason = reason;
    return true;
  };

  if (!readiness.usable) {
    const rebuilt = await attemptRebuild(readiness.reason || "index readiness check failed");
    if (!rebuilt) {
      return buildFanoutFallback(
        readiness.reason || "index readiness check failed",
        currentIndexStatus,
      );
    }
  }

  let indexSearch = await searchProjectIndex({
    projectMemoryDir: input.projectMemoryDir,
    query: input.query,
    topK,
    activeUserId: readiness.activeUserId,
  });

  currentIndexStatus = indexSearch.indexStatus;

  if (!indexSearch.indexReady || indexSearch.error) {
    fallbackErrors.unshift({
      databasePath: indexSearch.indexDatabasePath,
      error: indexSearch.error || `index status is '${indexSearch.indexStatus}'`,
    });

    if (!rebuildTriggered) {
      const rebuilt = await attemptRebuild(indexSearch.error || `index status is '${indexSearch.indexStatus}'`);
      if (rebuilt) {
        indexSearch = await searchProjectIndex({
          projectMemoryDir: input.projectMemoryDir,
          query: input.query,
          topK,
          activeUserId: readiness.activeUserId,
        });

        currentIndexStatus = indexSearch.indexStatus;
      }
    }
  }

  if (!indexSearch.indexReady || indexSearch.error) {
    return buildFanoutFallback(
      indexSearch.error || `index status is '${indexSearch.indexStatus}'`,
      currentIndexStatus,
    );
  }

  const partialReason = indexSearch.indexStatus === "partial"
    ? "index status is partial; some source DBs failed during last rebuild"
    : null;

  const degradedReason = [
    rebuildReason ? `index rebuilt before search (${rebuildReason})` : null,
    partialReason,
  ].filter((value): value is string => typeof value === "string").join("; ");

  if (indexSearch.results.length === 0 && indexSearch.sourceDatabaseCount > 0) {
    const fanoutRecovery = await fanoutProjectMemorySearch({
      projectMemoryDir: input.projectMemoryDir,
      query: input.query,
      topK,
      perDbLimit,
    });

    if (fanoutRecovery.results.length > 0) {
      const recoveryReason = [
        degradedReason.length > 0 ? degradedReason : null,
        "index returned no hits; direct fanout recovered results",
      ].filter((value): value is string => typeof value === "string").join("; ");

      return {
        query: input.query,
        requestedMode: "index-first",
        effectiveMode: "fanout",
        degraded: true,
        degradedReason: recoveryReason,
        indexStatus: indexSearch.indexStatus,
        databaseCount: fanoutRecovery.databaseCount,
        searchedDatabaseCount: fanoutRecovery.searchedDatabaseCount,
        results: fanoutRecovery.results,
        errors: [...fallbackErrors, ...fanoutRecovery.errors],
      };
    }
  }

  return {
    query: input.query,
    requestedMode: "index-first",
    effectiveMode: "index-first",
    degraded: degradedReason.length > 0,
    degradedReason: degradedReason.length > 0 ? degradedReason : undefined,
    indexStatus: indexSearch.indexStatus,
    databaseCount: indexSearch.sourceDatabaseCount,
    searchedDatabaseCount: indexSearch.sourceDatabaseCount,
    results: indexSearch.results,
    errors: [],
  };
};

/**
 * Benchmark fan-out and index-first search paths to guide default mode selection.
 */
export const benchmarkProjectMemoryModes = async (
  input: ProjectMemoryModeBenchmarkInput,
): Promise<ProjectMemoryModeBenchmarkResult> => {
  const iterations = Math.max(1, Math.min(input.iterations ?? 3, 20));
  const topK = Math.max(1, Math.min(input.topK ?? 20, 200));
  const perDbLimit = Math.max(1, Math.min(input.perDbLimit ?? 10, 100));

  const fanoutDurations: number[] = [];
  const fanoutErrors: string[] = [];
  const indexDurations: number[] = [];
  const indexErrors: string[] = [];

  for (let i = 0; i < iterations; i += 1) {
    const fanoutStarted = Date.now();
    try {
      await fanoutProjectMemorySearch({
        projectMemoryDir: input.projectMemoryDir,
        query: input.query,
        topK,
        perDbLimit,
      });
      fanoutDurations.push(Date.now() - fanoutStarted);
    } catch (error: unknown) {
      fanoutErrors.push(error instanceof Error ? error.message : String(error));
    }

    const indexStarted = Date.now();
    try {
      const indexSearch = await searchProjectIndex({
        projectMemoryDir: input.projectMemoryDir,
        query: input.query,
        topK,
        activeUserId: input.activeUserId,
      });

      if (!indexSearch.indexReady || indexSearch.error) {
        const message = indexSearch.error || `index status is '${indexSearch.indexStatus}'`;
        indexErrors.push(message);
      } else {
        indexDurations.push(Date.now() - indexStarted);
      }
    } catch (error: unknown) {
      indexErrors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const fanout = buildBenchmarkStats({
    iterations,
    durations: fanoutDurations,
    errors: fanoutErrors,
  });

  const indexFirst = buildBenchmarkStats({
    iterations,
    durations: indexDurations,
    errors: indexErrors,
  });

  let recommendedMode: ProjectMemoryMode = "index-first";
  let rationale = "index-first selected as default for performance-first runtime.";

  if (indexFirst.successCount === 0) {
    recommendedMode = "fanout";
    rationale = "index-first unavailable; fan-out is the only healthy retrieval path.";
  } else if (fanout.successCount > 0 && indexFirst.p95Ms > Math.round(fanout.p95Ms * 1.1)) {
    recommendedMode = "fanout";
    rationale = `fan-out p95 (${fanout.p95Ms}ms) is meaningfully faster than index-first p95 (${indexFirst.p95Ms}ms).`;
  } else {
    rationale = `index-first p95 (${indexFirst.p95Ms}ms) is within performance tolerance of fan-out p95 (${fanout.p95Ms}ms).`;
  }

  return {
    query: input.query,
    iterations,
    fanout,
    indexFirst,
    recommendedMode,
    rationale,
  };
};
