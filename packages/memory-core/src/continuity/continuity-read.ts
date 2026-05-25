/**
 * File intent: own host-neutral local L0 continuity read/status behavior.
 *
 * This service is intentionally owner-scoped/local. Cross-user project continuity
 * retrieval is L2 behavior and remains outside this module until the project
 * index/retrieval migration slice.
 */

import type {
  ContinuityDataAdapterPort,
  CoreContinuityRecord,
  CoreContinuityMilestoneRecord,
} from "../ports.js";
import type {
  ContinuityQueryRequest,
  CoreTextResult,
  RuntimeStatusRequest,
} from "../contracts.js";

const DEFAULT_QUERY_LIMIT = 20;
const MAX_QUERY_LIMIT = 100;

/**
 * Dependencies needed by local continuity read/status orchestration.
 */
export interface ContinuityReadServiceDependencies {
  /** Non-vendor continuity data adapter used for local L0 reads. */
  continuityData: Pick<ContinuityDataAdapterPort, "query" | "readStatus">;
}

/**
 * Clamp requested continuity read limits to safe deterministic bounds.
 */
export const normalizeContinuityReadLimit = (limit?: number): number =>
  typeof limit === "number" && Number.isFinite(limit)
    ? Math.max(1, Math.min(Math.floor(limit), MAX_QUERY_LIMIT))
    : DEFAULT_QUERY_LIMIT;

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
 * Render one local continuity entry using the stable human-facing format.
 */
const renderEntry = (entry: CoreContinuityRecord): string => {
  const certaintyPrefix = entry.certainty === "UNCONFIRMED" ? "UNCONFIRMED " : "";
  return `- [ENTRY id=${entry.id}] ${entry.timestamp} [${entry.section}] [${entry.provenance}] ${certaintyPrefix}${entry.content}`;
};

/**
 * Render one local continuity milestone using the stable human-facing format.
 */
const renderMilestone = (milestone: CoreContinuityMilestoneRecord): string => {
  const certaintyPrefix = milestone.certainty === "UNCONFIRMED" ? "UNCONFIRMED " : "";
  return `- [MILESTONE id=${milestone.id}] ${milestone.timestamp} [${milestone.section}] [${milestone.provenance}] ${certaintyPrefix}${milestone.summary} (sourceEntries=${milestone.sourceEntryCount}; readOnly=yes)`;
};

/**
 * Build the local continuity query result text.
 */
const buildQueryText = (input: {
  entries: CoreContinuityRecord[];
  milestones: CoreContinuityMilestoneRecord[];
}): string => {
  if (input.entries.length === 0 && input.milestones.length === 0) {
    return "continuity_query returned no rows (source=local_continuity, retrieval=local).";
  }

  const lines = [
    `Continuity query results (source=local_continuity, retrieval=local): entries=${input.entries.length}, milestones=${input.milestones.length}.`,
    "",
    ...input.entries.map(renderEntry),
    ...input.milestones.map(renderMilestone),
  ];

  return lines.join("\n").trimEnd();
};

/**
 * Build local L0 continuity read/status orchestration around one data adapter.
 */
export const createContinuityReadService = (
  dependencies: ContinuityReadServiceDependencies,
): {
  query: (input: ContinuityQueryRequest) => Promise<CoreTextResult>;
  readStatus: (input: RuntimeStatusRequest) => Promise<CoreTextResult>;
} => ({
  query: async (input: ContinuityQueryRequest): Promise<CoreTextResult> => {
    const limit = normalizeContinuityReadLimit(input.limit);
    const result = await dependencies.continuityData.query({
      ...input,
      limit,
    });

    if (result.status === "error") {
      const warning = result.warnings[0] || "unknown error";
      return buildTextResult({
        status: "error",
        text: `continuity_query failed: local continuity retrieval failed (${warning}).`,
        details: {
          status: "error",
          reason: "local-continuity-query-failed",
          source: "local_l0",
        },
        warnings: result.warnings,
      });
    }

    const status = result.entries.length === 0 && result.milestones.length === 0 ? "empty" : "ok";
    return buildTextResult({
      status: "ok",
      text: buildQueryText({
        entries: result.entries,
        milestones: result.milestones,
      }),
      details: {
        status,
        source: "local_l0",
        retrievalMode: "local",
        entryCount: result.entries.length,
        milestoneCount: result.milestones.length,
        entryIds: result.entries.map((entry) => entry.id),
        milestoneIds: result.milestones.map((milestone) => milestone.id),
      },
      warnings: result.warnings,
    });
  },

  readStatus: async (input: RuntimeStatusRequest): Promise<CoreTextResult> => {
    const result = await dependencies.continuityData.readStatus(input);

    if (result.status === "error") {
      const warning = result.warnings[0] || "unknown error";
      return buildTextResult({
        status: "error",
        text: `continuity status failed: local continuity status failed (${warning}).`,
        details: {
          status: "error",
          reason: "local-continuity-status-failed",
          source: "local_l0",
        },
        warnings: result.warnings,
      });
    }

    const compactedCount = result.compactedCount || 0;
    const milestoneCount = result.milestoneCount || 0;
    return buildTextResult({
      status: "ok",
      text:
        `continuity(status=ok, source=local_l0, activeEntries=${result.activeCount}, ` +
        `compacted=${compactedCount}, milestones=${milestoneCount})`,
      details: {
        status: "ok",
        source: "local_l0",
        activeEntryCount: result.activeCount,
        compactedCount,
        milestoneCount,
      },
      warnings: result.warnings,
    });
  },
});
