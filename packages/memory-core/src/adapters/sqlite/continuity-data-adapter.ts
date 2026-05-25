/**
 * File intent: adapt SQLite-backed continuity persistence to memory-core ports.
 *
 * Continuity is not provided by pi-mempalace. Core owns continuity policy, while
 * this memory-core adapter owns data persistence details. Concrete SQLite helper
 * functions now live under `memory-core/src/adapters/sqlite/continuity`.
 */

import {
  readContinuityActiveCounts,
  readContinuityCompactionPreviewStatusCounts,
  readContinuityEntries,
  readContinuityMilestones,
  readContinuityStatusCounts,
} from "./continuity/continuity-store.js";
import type {
  ContinuityCompactApplyRequest,
  ContinuityCompactPreviewRequest,
  ContinuityDataAdapterPort,
  CoreTextResult,
  CoreContinuityBriefingSemanticResult,
  CoreContinuityDataPersistInput,
  CoreContinuityDataPersistResult,
  CoreContinuityDataQueryInput,
  CoreContinuityDataQueryResult,
  CoreContinuityDataStatusResult,
  CoreContinuityDataWriteInput,
  CoreContinuityDataWriteResult,
  CoreContinuityMilestoneRecord,
  CoreContinuityRecord,
  CoreContinuitySectionCounts,
  RuntimeStatusRequest,
} from "../../index.js";

/**
 * Backend result for one continuity write.
 */
export interface SqliteContinuityBackendWriteResult {
  /** Stored continuity row id. */
  id: string;
  /** Optional normalized stored row. */
  record?: CoreContinuityRecord;
}

/**
 * Backend result for one policy-aware continuity persist operation.
 */
export interface SqliteContinuityBackendPersistResult {
  /** Persistence outcome after duplicate/quality gates. */
  outcome: "stored" | "skipped";
  /** Skip reason when outcome is skipped. */
  skipReason?: "duplicate" | "low-signal";
  /** Deterministic fingerprint when available. */
  fingerprint?: string;
  /** Stored/normalized timestamp. */
  timestamp?: string;
  /** Duplicate row timestamp when available. */
  duplicateTimestamp?: string;
  /** Low-signal quality reason when available. */
  qualityReason?: string;
}

/**
 * Backend result for one continuity query.
 */
export interface SqliteContinuityBackendQueryResult {
  /** Matching active continuity rows. */
  entries: CoreContinuityRecord[];
  /** Matching milestone rows. */
  milestones?: CoreContinuityMilestoneRecord[];
}

/**
 * Backend result for continuity status counters.
 */
export interface SqliteContinuityBackendStatusResult {
  /** Active, non-compacted continuity row count. */
  activeCount: number;
  /** Compacted source row count. */
  compactedCount?: number;
  /** Milestone row count. */
  milestoneCount?: number;
}

/**
 * Minimal backend surface used by the SQLite continuity data adapter.
 */
export interface SqliteContinuityBackend {
  /** Optional concrete database path for exact briefing status counters. */
  databasePath?: string;
  /** Persist one continuity row through concrete duplicate/vector gates. */
  persistWrite?: (input: CoreContinuityDataPersistInput) => Promise<SqliteContinuityBackendPersistResult>;
  /** Preview local continuity compaction through the concrete data store. */
  previewCompaction?: (input: ContinuityCompactPreviewRequest) => Promise<CoreTextResult>;
  /** Apply local continuity compaction through the concrete data store. */
  applyCompaction?: (input: ContinuityCompactApplyRequest) => Promise<CoreTextResult>;
  /** Persist one continuity row in the concrete data store. */
  write(input: CoreContinuityDataWriteInput): Promise<SqliteContinuityBackendWriteResult>;
  /** Query continuity rows/milestones from the concrete data store. */
  query(input: CoreContinuityDataQueryInput): Promise<SqliteContinuityBackendQueryResult>;
  /** Read continuity status counters from the concrete data store. */
  readStatus(input: RuntimeStatusRequest): Promise<SqliteContinuityBackendStatusResult>;
  /** Semantic continuity rows for prompt briefing when vector search is available. */
  searchBriefingEntries?: (input: {
    context: CoreContinuityDataQueryInput["context"];
    queryText: string;
    limit?: number;
  }) => Promise<CoreContinuityBriefingSemanticResult>;
}

/**
 * Normalize thrown data-adapter failures into core result fields.
 */
const buildErrorBase = (operation: string, error: unknown): {
  status: "error";
  warnings: string[];
  diagnostics: Record<string, unknown>;
} => ({
  status: "error",
  warnings: [error instanceof Error ? error.message : String(error)],
  diagnostics: {
    operation,
    provider: "sqlite-continuity-data-adapter",
  },
});

/**
 * Return true when one optional timestamp falls inside the requested range.
 */
const isWithinTimestampRange = (input: {
  timestamp: string;
  from?: string;
  to?: string;
}): boolean => {
  if (input.from && input.timestamp < input.from) return false;
  if (input.to && input.timestamp > input.to) return false;
  return true;
};

/**
 * Return true when row text matches the optional lexical query.
 */
const matchesQuery = (input: {
  text: string;
  query?: string;
}): boolean => {
  const query = input.query?.trim().toLowerCase();
  if (!query) return true;
  return input.text.toLowerCase().includes(query);
};

/**
 * Build a concrete SQLite continuity data adapter for one canonical continuity DB.
 */
export const createSqliteContinuityDataAdapterForDatabase = (input: {
  databasePath: string;
  persistWrite?: SqliteContinuityBackend["persistWrite"];
  previewCompaction?: SqliteContinuityBackend["previewCompaction"];
  applyCompaction?: SqliteContinuityBackend["applyCompaction"];
  searchBriefingEntries?: SqliteContinuityBackend["searchBriefingEntries"];
}): ContinuityDataAdapterPort => createSqliteContinuityDataAdapter({
  databasePath: input.databasePath,
  persistWrite: input.persistWrite,
  previewCompaction: input.previewCompaction,
  applyCompaction: input.applyCompaction,
  searchBriefingEntries: input.searchBriefingEntries,
  write: async () => {
    throw new Error("raw continuity write is not available through this adapter; use persistWrite");
  },
  query: async (queryInput) => {
    const requestedLimit = typeof queryInput.limit === "number"
      ? Math.max(1, Math.min(Math.floor(queryInput.limit), 200))
      : 20;
    const scanLimit = Math.max(requestedLimit * 4, 100);
    const sectionFilter = queryInput.section ? [queryInput.section] : undefined;

    const entries = readContinuityEntries({
      databasePath: input.databasePath,
      limit: scanLimit,
      sectionFilter,
      includeCompacted: Boolean(queryInput.includeCompacted),
    })
      .filter((entry) => isWithinTimestampRange({
        timestamp: entry.timestamp,
        from: queryInput.from,
        to: queryInput.to,
      }))
      .filter((entry) => matchesQuery({
        text: entry.content,
        query: queryInput.query,
      }))
      .slice(0, requestedLimit)
      .map((entry): CoreContinuityRecord => ({
        id: entry.id,
        section: entry.section,
        provenance: entry.provenance,
        certainty: entry.certainty,
        content: entry.content,
        timestamp: entry.timestamp,
      }));

    const milestones = queryInput.includeMilestones
      ? readContinuityMilestones({
        databasePath: input.databasePath,
        limit: Math.max(requestedLimit * 4, 50),
      })
        .filter((milestone) => !queryInput.section || milestone.section === queryInput.section)
        .filter((milestone) => isWithinTimestampRange({
          timestamp: milestone.timestamp,
          from: queryInput.from,
          to: queryInput.to,
        }))
        .filter((milestone) => matchesQuery({
          text: milestone.summary,
          query: queryInput.query,
        }))
        .slice(0, requestedLimit)
        .map((milestone): CoreContinuityMilestoneRecord => ({
          id: milestone.id,
          section: milestone.section,
          provenance: milestone.provenance,
          certainty: milestone.certainty,
          summary: milestone.summary,
          timestamp: milestone.timestamp,
          sourceEntryCount: milestone.sourceEntryCount,
          coveredFromTimestamp: milestone.coveredFromTimestamp,
          coveredToTimestamp: milestone.coveredToTimestamp,
        }))
      : [];

    return { entries, milestones };
  },
  readStatus: async () => {
    const counts = readContinuityStatusCounts({ databasePath: input.databasePath });
    if (counts.status === "error") {
      throw new Error(counts.warning || "continuity status unavailable");
    }

    const activeCounts = readContinuityActiveCounts({ databasePath: input.databasePath });
    return {
      activeCount: activeCounts.status === "ok" ? activeCounts.activeEntryCount : counts.entryCount,
      milestoneCount: counts.milestoneCount,
      compactedCount: Math.max(0, counts.entryCount - (activeCounts.status === "ok" ? activeCounts.activeEntryCount : counts.entryCount)),
    };
  },
});

/**
 * Build exact continuity briefing state from local SQLite counters.
 */
const readSqliteContinuityBriefingState = (databasePath: string) => {
  const activeCounts = readContinuityActiveCounts({ databasePath });
  const previewCounts = readContinuityCompactionPreviewStatusCounts({ databasePath });
  const emptySectionCounts: CoreContinuitySectionCounts = {
    PLANS: 0,
    DECISIONS: 0,
    PROGRESS: 0,
    DISCOVERIES: 0,
    OUTCOMES: 0,
  };

  if (activeCounts.status === "error") {
    throw new Error(activeCounts.warning || "continuity active counts unavailable");
  }

  return {
    activeEntryCount: activeCounts.activeEntryCount,
    sectionCounts: activeCounts.sectionCounts || emptySectionCounts,
    pendingPreviewCount: previewCounts.status === "ok"
      ? previewCounts.approvedCount + previewCounts.approvedWithAdvisoriesCount
      : 0,
  };
};

/**
 * Create a continuity data adapter around a concrete SQLite-like backend.
 */
export const createSqliteContinuityDataAdapter = (
  backend: SqliteContinuityBackend,
): ContinuityDataAdapterPort => ({
  previewCompaction: backend.previewCompaction
    ? async (input) => {
      try {
        return await backend.previewCompaction!(input);
      } catch (error: unknown) {
        const base = buildErrorBase("previewCompaction", error);
        return {
          ...base,
          text: `continuity_compact_preview failed: ${base.warnings[0] || "unknown error"}`,
        };
      }
    }
    : undefined,
  searchBriefingEntries: backend.searchBriefingEntries
    ? async (input) => backend.searchBriefingEntries!(input)
    : undefined,
  applyCompaction: backend.applyCompaction
    ? async (input) => {
      try {
        return await backend.applyCompaction!(input);
      } catch (error: unknown) {
        const base = buildErrorBase("applyCompaction", error);
        return {
          ...base,
          text: `continuity_compact_apply failed: ${base.warnings[0] || "unknown error"}`,
        };
      }
    }
    : undefined,
  persistWrite: async (input: CoreContinuityDataPersistInput): Promise<CoreContinuityDataPersistResult> => {
    try {
      if (backend.persistWrite) {
        const result = await backend.persistWrite(input);
        return {
          status: "ok",
          outcome: result.outcome,
          skipReason: result.skipReason,
          fingerprint: result.fingerprint,
          timestamp: result.timestamp,
          duplicateTimestamp: result.duplicateTimestamp,
          qualityReason: result.qualityReason,
          warnings: [],
          diagnostics: {
            provider: "sqlite-continuity-data-adapter",
          },
        };
      }

      const result = await backend.write(input);
      return {
        status: "ok",
        outcome: "stored",
        timestamp: input.timestamp,
        warnings: [],
        diagnostics: {
          provider: "sqlite-continuity-data-adapter",
          storedId: result.id,
        },
      };
    } catch (error: unknown) {
      return {
        ...buildErrorBase("persistWrite", error),
        outcome: "skipped",
      };
    }
  },

  write: async (input: CoreContinuityDataWriteInput): Promise<CoreContinuityDataWriteResult> => {
    try {
      const result = await backend.write(input);

      return {
        status: "ok",
        id: result.id,
        record: result.record,
        warnings: [],
        diagnostics: {
          provider: "sqlite-continuity-data-adapter",
        },
      };
    } catch (error: unknown) {
      return {
        ...buildErrorBase("write", error),
        id: null,
      };
    }
  },

  query: async (input: CoreContinuityDataQueryInput): Promise<CoreContinuityDataQueryResult> => {
    try {
      const result = await backend.query(input);

      return {
        status: "ok",
        entries: result.entries,
        milestones: result.milestones || [],
        warnings: [],
        diagnostics: {
          provider: "sqlite-continuity-data-adapter",
          entryCount: result.entries.length,
          milestoneCount: result.milestones?.length || 0,
        },
      };
    } catch (error: unknown) {
      return {
        ...buildErrorBase("query", error),
        entries: [],
        milestones: [],
      };
    }
  },

  readBriefingState: async (input) => {
    if (!backend.databasePath) {
      return {
        status: "unavailable",
        activeEntryCount: 0,
        sectionCounts: { PLANS: 0, DECISIONS: 0, PROGRESS: 0, DISCOVERIES: 0, OUTCOMES: 0 },
        pendingPreviewCount: 0,
        warnings: ["briefing state is unavailable for injected backend"],
        diagnostics: {
          provider: "sqlite-continuity-data-adapter",
          operation: "readBriefingState",
          projectRoot: input.context.projectRoot,
        },
      };
    }

    try {
      const state = readSqliteContinuityBriefingState(backend.databasePath);
      return {
        status: "ok",
        ...state,
        warnings: [],
        diagnostics: {
          provider: "sqlite-continuity-data-adapter",
          databasePath: backend.databasePath,
        },
      };
    } catch (error: unknown) {
      return {
        status: "error",
        activeEntryCount: 0,
        sectionCounts: { PLANS: 0, DECISIONS: 0, PROGRESS: 0, DISCOVERIES: 0, OUTCOMES: 0 },
        pendingPreviewCount: 0,
        warnings: [error instanceof Error ? error.message : String(error)],
        diagnostics: {
          provider: "sqlite-continuity-data-adapter",
          operation: "readBriefingState",
        },
      };
    }
  },

  readStatus: async (input: RuntimeStatusRequest): Promise<CoreContinuityDataStatusResult> => {
    try {
      const result = await backend.readStatus(input);

      return {
        status: "ok",
        activeCount: result.activeCount,
        compactedCount: result.compactedCount,
        milestoneCount: result.milestoneCount,
        warnings: [],
        diagnostics: {
          provider: "sqlite-continuity-data-adapter",
        },
      };
    } catch (error: unknown) {
      return {
        ...buildErrorBase("readStatus", error),
        activeCount: 0,
      };
    }
  },
});
