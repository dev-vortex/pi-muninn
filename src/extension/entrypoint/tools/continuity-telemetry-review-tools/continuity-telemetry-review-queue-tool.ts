/**
 * File intent: create continuity telemetry review tool handlers.
 *
 * These handlers expose false-reject review queue and labeling behavior without
 * changing existing payload semantics or responses.
 */

import { createMemoryCore } from "../../../../../packages/memory-core/src/index.js";
import { createSqliteContinuityTelemetryProviderForDatabase } from "../../../../../packages/memory-core/src/adapters/sqlite/index.js";
import type { ExtensionToolDependencies } from "./../types.js";

/**
 * Build the continuity_telemetry_review_queue execute handler.
 */
export const createContinuityTelemetryReviewQueueTool = (deps: ExtensionToolDependencies) => {
  const {
    buildTextToolResult,
    resolveActiveContinuityDatabasePath,
  } = deps;

  return async (_toolCallId: string, params: {
    window_days?: number;
    sample_limit?: number;
  }, _signal: AbortSignal, _onUpdate: unknown, ctx: any) => {
    const activeDatabase = await resolveActiveContinuityDatabasePath(ctx);
    if (!activeDatabase.ok) {
      return buildTextToolResult({
        text: `continuity_telemetry_review_queue failed: ${activeDatabase.error}`,
        details: {
          status: "error",
          reason: "project-memory-disabled",
        },
      });
    }

    const core = createMemoryCore({
      telemetry: createSqliteContinuityTelemetryProviderForDatabase({
        databasePath: activeDatabase.databasePath,
      }),
    });

    const result = await core.readTelemetryReport({
      context: {
        projectRoot: ctx.cwd,
        userId: null,
      },
      windowDays: params.window_days,
      sampleLimit: params.sample_limit,
    });

    return buildTextToolResult({
      text: result.text,
      details: result.diagnostics,
    });
  };
};
