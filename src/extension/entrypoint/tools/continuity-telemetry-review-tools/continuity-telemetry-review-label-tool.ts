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
 * Build the continuity_telemetry_review_label execute handler.
 */
export const createContinuityTelemetryReviewLabelTool = (deps: ExtensionToolDependencies) => {
  const {
    buildTextToolResult,
    resolveActiveContinuityDatabasePath,
  } = deps;

  return async (_toolCallId: string, params: {
    event_id: string;
    label: "valid_reject" | "false_reject" | "uncertain";
    note?: string;
  }, _signal: AbortSignal, _onUpdate: unknown, ctx: any) => {
    const activeDatabase = await resolveActiveContinuityDatabasePath(ctx);
    if (!activeDatabase.ok) {
      return buildTextToolResult({
        text: `continuity_telemetry_review_label failed: ${activeDatabase.error}`,
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

    const result = await core.labelTelemetryReview({
      context: {
        projectRoot: ctx.cwd,
        userId: null,
      },
      eventId: params.event_id,
      label: params.label,
      note: params.note,
    });

    return buildTextToolResult({
      text: result.text,
      details: result.diagnostics,
    });
  };
};
