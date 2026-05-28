/**
 * File intent: build project-memory and continuity runtime status summaries.
 *
 * Commands and tools share these summaries; extracting them keeps status math out
 * of the package entrypoint while preserving user-visible text.
 */

import type { ContinuitySection } from "../../../../packages/memory-core/src/continuity/continuity-codebook.js";
import {
  readContinuityActiveCounts,
  readContinuityCompactionPreviewStatusCounts,
  readContinuityStatusCounts,
  readContinuityTelemetrySummary,
  readContinuityTelemetryTrendReport,
} from "../../../memory-data-adapters/sqlite/continuity/index.js";
import { readProjectIndexStatus } from "../../../memory-data-adapters/sqlite/project-index/index.js";
import { readProjectUserMemoryStatusCounts } from "../../../memory-providers/pi-mempalace-compatible/project-memory/user-memory-ingest.js";
import type { MemoryExtensionRuntimeState } from "../runtime-state.js";
import { CONTINUITY_SECTION_VALUES } from "./constants.js";
import { assessContinuityCompactionPressure } from "./continuity-compaction-analysis.js";
import { resolveSessionId } from "./common-runtime-services.js";

/**
 * Build status summary services bound to runtime state.
 */
export const createStatusSummaryServices = (input: {
  state: MemoryExtensionRuntimeState;
  buildLastQuerySuffix: (query: string | undefined) => string;
  getRuntimeContextObservabilitySnapshot: (tracker: any) => any;
}): {
  buildContinuityRuntimeStatusSummary: (runtime: any | null) => { summary: string; details: Record<string, unknown> };
  buildProjectRuntimeStatusSummary: (runtime: any | null) => { summary: string; details: Record<string, unknown> };
  buildProjectRetrievalStatusSummary: (ctx: any) => { summary: string; details: Record<string, unknown> };
  buildProjectCacheStatusSummary: (runtime: any | null) => Promise<{ summary: string; details: Record<string, unknown> }>;
} => {
  const buildContinuityRuntimeStatusSummary = (runtime: any | null): {
    summary: string;
    details: Record<string, unknown>;
  } => {
    if (!runtime) {
      return { summary: "continuity(status=runtime-unavailable)", details: { status: "runtime-unavailable" } };
    }

    if (!runtime.config.projectMemoryEnabled || runtime.storePaths.activeScope !== "project-enabled") {
      return {
        summary: `continuity(status=inactive, scope=${runtime.storePaths.activeScope})`,
        details: {
          status: "inactive",
          scope: runtime.storePaths.activeScope,
          projectMemoryEnabled: runtime.config.projectMemoryEnabled,
        },
      };
    }

    const counts = readContinuityStatusCounts({ databasePath: runtime.storePaths.projectUserDatabasePath });
    if (counts.status === "error") {
      return {
        summary: `continuity(status=error, warning=${counts.warning || "unknown"})`,
        details: { ...counts, databasePath: runtime.storePaths.projectUserDatabasePath },
      };
    }

    if (counts.status === "no-db") {
      return {
        summary: "continuity(status=no-db, entries=0, milestones=0)",
        details: { ...counts, databasePath: runtime.storePaths.projectUserDatabasePath },
      };
    }

    const previewCounts = readContinuityCompactionPreviewStatusCounts({ databasePath: runtime.storePaths.projectUserDatabasePath });
    const previewSummary = previewCounts.status === "ok"
      ? `, previews=${previewCounts.totalCount}, previewPending=${previewCounts.approvedCount + previewCounts.approvedWithAdvisoriesCount}, previewApplied=${previewCounts.appliedCount}, previewRejected=${previewCounts.rejectedCount}`
      : previewCounts.status === "no-db"
        ? ", previews=0"
        : `, previews=error(${previewCounts.warning || "unknown"})`;

    const activeCounts = readContinuityActiveCounts({ databasePath: runtime.storePaths.projectUserDatabasePath });
    const fallbackSectionCounts = CONTINUITY_SECTION_VALUES.reduce((accumulator, section) => {
      accumulator[section] = 0;
      return accumulator;
    }, { PLANS: 0, DECISIONS: 0, PROGRESS: 0, DISCOVERIES: 0, OUTCOMES: 0 } as Record<ContinuitySection, number>);

    const compactionPressure = assessContinuityCompactionPressure({
      activeEntryCount: activeCounts.status === "ok" ? activeCounts.activeEntryCount : counts.entryCount,
      sectionCounts: activeCounts.status === "ok" ? activeCounts.sectionCounts : fallbackSectionCounts,
      pendingPreviewCount: previewCounts.status === "ok" ? previewCounts.approvedCount + previewCounts.approvedWithAdvisoriesCount : 0,
    });

    const compactionPressureText =
      `, compactionPressure=${compactionPressure.level}, ` +
      `compactRecommended=${compactionPressure.recommended ? "yes" : "no"}, ` +
      `activeEntries=${compactionPressure.activeEntryCount}`;

    const telemetrySummary = readContinuityTelemetrySummary({ databasePath: runtime.storePaths.projectUserDatabasePath });
    const telemetryTrendReport = readContinuityTelemetryTrendReport({
      databasePath: runtime.storePaths.projectUserDatabasePath,
      windowDays: 30,
      reviewSampleLimit: 12,
    });

    const telemetryText = telemetrySummary.status === "ok"
      ? `, kpiEvents=${telemetrySummary.totalEvents}, ` +
        `queryModes(h=${telemetrySummary.queryHybridCount}, d=${telemetrySummary.queryHybridDegradedCount}, l=${telemetrySummary.queryLexicalOnlyCount}), ` +
        `queryDegradedRatio=${(telemetrySummary.queryHybridDegradedRatio * 100).toFixed(1)}%, ` +
        `writeSkips(dup=${telemetrySummary.continuityWriteSkippedDuplicateCount}, low=${telemetrySummary.continuityWriteSkippedLowSignalCount}, rate=${(telemetrySummary.continuityWriteSkipRate * 100).toFixed(1)}%), ` +
        `review(candidates=${telemetrySummary.falseRejectReviewCandidateCount}, labeled=${telemetrySummary.falseRejectReviewLabeledCount}, pending=${telemetrySummary.falseRejectReviewPendingCount}, false=${telemetrySummary.falseRejectLabeledFalseRejectCount}), ` +
        `briefing(avgChars=${Math.round(telemetrySummary.turnBriefingAverageChars)}, maxChars=${Math.round(telemetrySummary.turnBriefingMaxChars)})`
      : telemetrySummary.status === "no-db"
        ? ", kpiEvents=0"
        : `, kpiEvents=error(${telemetrySummary.warning || "unknown"})`;

    const warningSuffix = counts.warning ? `, note=${counts.warning}` : "";
    const previewWarningSuffix = previewCounts.warning ? `, previewNote=${previewCounts.warning}` : "";
    const activeWarningSuffix = activeCounts.warning ? `, activeNote=${activeCounts.warning}` : "";
    const telemetryWarningSuffix = telemetrySummary.warning ? `, telemetryNote=${telemetrySummary.warning}` : "";
    const telemetryTrendWarningSuffix = telemetryTrendReport.warning ? `, telemetryTrendNote=${telemetryTrendReport.warning}` : "";

    return {
      summary:
        `continuity(entries=${counts.entryCount}, semantic=${counts.semanticEntryCount}, ` +
        `user=${counts.userProvenanceEntryCount}, milestones=${counts.milestoneCount}, ` +
        `latest=${counts.latestEntryTimestamp || "none"}, ` +
        `latestSection=${counts.latestEntrySection || "none"}, ` +
        `latestProvenance=${counts.latestEntryProvenance || "none"}` +
        `${previewSummary}${compactionPressureText}${telemetryText}${warningSuffix}${previewWarningSuffix}${activeWarningSuffix}${telemetryWarningSuffix}${telemetryTrendWarningSuffix})`,
      details: {
        ...counts,
        active: activeCounts,
        compaction: compactionPressure,
        compactionPreviews: previewCounts,
        telemetry: telemetrySummary,
        telemetryTrend: telemetryTrendReport,
        databasePath: runtime.storePaths.projectUserDatabasePath,
      },
    };
  };

  const buildProjectRuntimeStatusSummary = (runtime: any | null): { summary: string; details: Record<string, unknown> } => {
    if (!runtime) {
      return { summary: "projectMemory(status=runtime-unavailable)", details: { status: "runtime-unavailable" } };
    }

    const baseSummary =
      `projectMemory(enabled=${runtime.config.projectMemoryEnabled ? "true" : "false"}, ` +
      `scope=${runtime.storePaths.activeScope}, mode=${runtime.config.mode}, ` +
      `continuityBriefing=${runtime.config.continuityBriefing?.mode || "semantic"}, ` +
      `checkpoint=${runtime.config.checkpoint.mode}/${runtime.config.checkpoint.pragmaMode}`;

    const baseDetails = {
      status: "ok",
      projectMemoryEnabled: runtime.config.projectMemoryEnabled,
      scope: runtime.storePaths.activeScope,
      mode: runtime.config.mode,
      checkpointMode: runtime.config.checkpoint.mode,
      checkpointPragmaMode: runtime.config.checkpoint.pragmaMode,
      continuityBriefingMode: runtime.config.continuityBriefing?.mode || "semantic",
    };

    if (!runtime.config.projectMemoryEnabled || runtime.storePaths.activeScope !== "project-enabled") {
      return { summary: `${baseSummary})`, details: { ...baseDetails, projectUserMemory: { status: "inactive" } } };
    }

    const projectUserMemoryCounts = readProjectUserMemoryStatusCounts({ databasePath: runtime.storePaths.projectUserDatabasePath });
    if (projectUserMemoryCounts.status === "error") {
      return {
        summary: `${baseSummary}, userMemories=error(${projectUserMemoryCounts.warning || "unknown"}))`,
        details: { ...baseDetails, projectUserMemory: { ...projectUserMemoryCounts, databasePath: runtime.storePaths.projectUserDatabasePath } },
      };
    }

    const warningSuffix = projectUserMemoryCounts.warning ? `, userMemoryNote=${projectUserMemoryCounts.warning}` : "";
    return {
      summary:
        `${baseSummary}, userMemories=${projectUserMemoryCounts.memoryCount}, ` +
        `topics=${projectUserMemoryCounts.distinctTopicCount}, ` +
        `sources=${projectUserMemoryCounts.distinctSourceCount}, ` +
        `latestMemory=${projectUserMemoryCounts.latestMemoryTimestamp || "none"}, ` +
        `latestTopic=${projectUserMemoryCounts.latestMemoryTopic || "none"}, ` +
        `latestSource=${projectUserMemoryCounts.latestMemorySource || "none"}${warningSuffix})`,
      details: { ...baseDetails, projectUserMemory: { ...projectUserMemoryCounts, databasePath: runtime.storePaths.projectUserDatabasePath } },
    };
  };

  const buildProjectRetrievalStatusSummary = (ctx: any): { summary: string; details: Record<string, unknown> } => {
    const tracker = input.state.observabilityBySession.get(resolveSessionId(ctx));
    if (!tracker) {
      return {
        summary: "retrieval(total=0, degraded=0, fallback=0, avgLatencyMs=0, p95LatencyMs=0)",
        details: { totalAssemblies: 0, degradedAssemblies: 0, fallbackCount: 0, avgTotalLatencyMs: 0, p95TotalLatencyMs: 0 },
      };
    }

    const snapshot = input.getRuntimeContextObservabilitySnapshot(tracker);
    const lastQuerySuffix = input.buildLastQuerySuffix(snapshot.recent.at(-1)?.query);
    return {
      summary:
        `retrieval(total=${snapshot.totalAssemblies}, degraded=${snapshot.degradedAssemblies}, ` +
        `fallback=${snapshot.fallbackCount}, avgLatencyMs=${snapshot.avgTotalLatencyMs}, ` +
        `p95LatencyMs=${snapshot.p95TotalLatencyMs}${lastQuerySuffix})`,
      details: { ...snapshot },
    };
  };

  const buildProjectCacheStatusSummary = async (runtime: any | null): Promise<{ summary: string; details: Record<string, unknown> }> => {
    if (!runtime || !runtime.config.projectMemoryEnabled || runtime.storePaths.activeScope !== "project-enabled") {
      return { summary: "l2(status=inactive)", details: { status: "inactive" } };
    }

    const status = await readProjectIndexStatus({ projectMemoryDir: runtime.storePaths.projectMemoryDir });
    const warningSuffix = status.lastError ? `, lastError=${status.lastError}` : "";
    return {
      summary:
        `l2(status=${status.status}, owner=${status.ownerUserId || "none"}, ` +
        `rows=${status.indexedRowCount}, l1Rows=${status.indexedMemoryRowCount}, ` +
        `l0Rows=${status.indexedContinuityRowCount}, members=${status.memberCount}, ` +
        `memberConflicts=${status.memberConflictCount}, parallelGroups=${status.parallelEvidenceGroupCount}, ` +
        `lastRebuildAt=${status.lastRebuildAt || "never"}${warningSuffix})`,
      details: { ...status },
    };
  };

  return {
    buildContinuityRuntimeStatusSummary,
    buildProjectRuntimeStatusSummary,
    buildProjectRetrievalStatusSummary,
    buildProjectCacheStatusSummary,
  };
};
