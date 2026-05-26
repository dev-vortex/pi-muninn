/**
 * File intent: create the cross-user continuity_query tool handler.
 *
 * Slice 5 routes L2 project-continuity retrieval through memory-core while the
 * SQLite project-index adapter preserves current index/fan-out behavior.
 */

import { createMemoryCore } from "../../../../../packages/memory-core/src/index.js";
import {
  createSqliteContinuityTelemetryProviderForDatabase,
  createSqliteProjectIndexDataAdapterForProjectMemoryDir,
} from "../../../../memory-data-adapters/sqlite/index.js";
import type { ExtensionToolDependencies } from "./../types.js";

/**
 * Build the continuity_query execute handler.
 */
export const createContinuityQueryTool = (deps: ExtensionToolDependencies) => {
  const {
    CONTINUITY_SECTION_VALUES,
    buildTextToolResult,
    resolveSessionId,
    continuityQueryNoiseStreakBySession,
    normalizeContinuitySection,
    logContinuityBlocked,
    resolveActiveProjectRuntime,
  } = deps;

  return async (_toolCallId: string, params: {
      query?: string;
      section?: string;
      from?: string;
      to?: string;
      limit?: number;
      include_milestones?: boolean;
      include_compacted?: boolean;
    }, _signal: AbortSignal, _onUpdate: unknown, ctx: any) => {
      const limit = typeof params.limit === "number"
        ? Math.max(1, Math.min(Math.floor(params.limit), 100))
        : 20;

      const sessionId = resolveSessionId(ctx);
      const previousNoisyQueryStreak = continuityQueryNoiseStreakBySession.get(sessionId) || 0;
      const querySection = params.section
        ? normalizeContinuitySection(params.section)
        : null;

      if (params.section && !querySection) {
        logContinuityBlocked({
          stage: "continuity_query",
          reason: "invalid-section",
          detail: String(params.section),
          ctx,
        });

        return buildTextToolResult({
          text: `continuity_query failed: invalid section '${params.section}'. Use one of: ${CONTINUITY_SECTION_VALUES.join(", ")}.`,
          details: {
            status: "error",
            reason: "invalid-section",
          },
        });
      }

      const activeProjectRuntime = await resolveActiveProjectRuntime(ctx);
      if (!activeProjectRuntime.ok) {
        continuityQueryNoiseStreakBySession.set(sessionId, 0);

        logContinuityBlocked({
          stage: "continuity_query",
          reason: "db-query-failed",
          detail: activeProjectRuntime.error,
          ctx,
        });

        return buildTextToolResult({
          text: `continuity_query failed: DB retrieval failed (${activeProjectRuntime.error}).`,
          details: {
            status: "error",
            reason: "db-query-failed",
            dbFallbackReason: activeProjectRuntime.error,
          },
        });
      }

      const core = createMemoryCore({
        projectIndexData: createSqliteProjectIndexDataAdapterForProjectMemoryDir({
          projectMemoryDir: activeProjectRuntime.projectMemoryDir,
          mode: activeProjectRuntime.mode,
          indexFreshnessSeconds: activeProjectRuntime.indexFreshnessSeconds,
          activeUserId: activeProjectRuntime.activeUserId,
        }),
        telemetry: createSqliteContinuityTelemetryProviderForDatabase({
          databasePath: activeProjectRuntime.databasePath,
        }),
      });

      const result = await core.continuityQuery({
        context: {
          projectRoot: ctx.cwd,
          userId: activeProjectRuntime.activeUserId,
        },
        query: params.query,
        section: querySection || undefined,
        from: params.from,
        to: params.to,
        limit,
        includeMilestones: params.include_milestones,
        includeCompacted: params.include_compacted,
        previousNoisyStreak: previousNoisyQueryStreak,
      });

      const compactionHint = result.diagnostics.compactionHint as { noisyStreak?: unknown } | null | undefined;
      const noisyStreak = typeof compactionHint?.noisyStreak === "number"
        ? compactionHint.noisyStreak
        : 0;
      continuityQueryNoiseStreakBySession.set(sessionId, noisyStreak);

      if (result.diagnostics.reason === "db-query-failed") {
        logContinuityBlocked({
          stage: "continuity_query",
          reason: "db-query-failed",
          detail: String(result.diagnostics.dbFallbackReason || result.warnings[0] || "unknown error"),
          ctx,
        });
      }

      return buildTextToolResult({
        text: result.text,
        details: {
          ...result.diagnostics,
          databasePath: activeProjectRuntime.databasePath,
          projectMemoryDir: activeProjectRuntime.projectMemoryDir,
        },
      });
  };
};
