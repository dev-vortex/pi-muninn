/**
 * File intent: create the project_memory_status tool handler.
 *
 * The handler reports current project-memory runtime, continuity, and vector
 * status while preserving the original response text/details.
 */

import { getProjectSessionRuntime } from "../../runtime-services/project-session-store.js";
import type { ExtensionToolDependencies } from "../types.js";

/**
 * Build the project_memory_status execute handler.
 */
export const createProjectMemoryStatusTool = (deps: ExtensionToolDependencies) => {
  const {
    sessionStore,
    bootstrap,
    resolveWorkspaceRoot,
    loadProjectMemoryConfig,
    buildContinuityRuntimeStatusSummary,
    buildTextToolResult,
    isContinuityVectorEnabled,
    resolveSessionId,
    readContinuityVectorStatusCounts,
    continuityVectorCountsBySession,
  } = deps;

  return async (_toolCallId: string, _params: Record<string, never>, _signal: AbortSignal, _onUpdate: unknown, ctx: any) => {
    const bootstrapResult = await bootstrap(ctx);
    const runtime = getProjectSessionRuntime({
      ctx,
      store: sessionStore,
    });

    if (!runtime) {
      const projectRoot = resolveWorkspaceRoot(ctx);

      try {
        const config = await loadProjectMemoryConfig(projectRoot);
        const continuityStatus = buildContinuityRuntimeStatusSummary(null);

        return buildTextToolResult({
          text:
            `Project memory status (config): ${config.projectMemoryEnabled ? "enabled" : "disabled"}; ` +
            `mode=${config.mode}; checkpoint=${config.checkpoint.mode}/${config.checkpoint.pragmaMode}. ` +
            `Runtime bootstrap: ${bootstrapResult.ok ? "ok" : `failed (${bootstrapResult.error || "unknown error"})`}; ` +
            `${continuityStatus.summary}.`,
          details: {
            status: "ok",
            runtimeReady: false,
            projectMemoryEnabled: config.projectMemoryEnabled,
            mode: config.mode,
            continuity: continuityStatus.details,
          },
        });
      } catch (error: unknown) {
        return buildTextToolResult({
          text: `project_memory_status failed: ${error instanceof Error ? error.message : String(error)}`,
          details: {
            status: "error",
            reason: "status-read-failed",
          },
        });
      }
    }

    let continuityVectorSummary = "";
    let continuityVectorDetails: Record<string, unknown> | null = null;

    if (
      isContinuityVectorEnabled()
      && runtime.config.projectMemoryEnabled
      && runtime.storePaths.activeScope === "project-enabled"
    ) {
      const sessionId = resolveSessionId(ctx);

      const counts = readContinuityVectorStatusCounts({
        databasePath: runtime.storePaths.projectUserDatabasePath,
      });

      if (counts.status === "ok") {
        continuityVectorCountsBySession.set(sessionId, {
          totalTracked: counts.totalTracked,
          indexedCount: counts.indexedCount,
          failedCount: counts.failedCount,
          pendingCount: counts.pendingCount,
        });

        continuityVectorSummary =
          `; continuityVector=indexed:${counts.indexedCount}/tracked:${counts.totalTracked}/failed:${counts.failedCount}/pending:${counts.pendingCount}`;

        continuityVectorDetails = {
          enabled: true,
          totalTracked: counts.totalTracked,
          indexedCount: counts.indexedCount,
          failedCount: counts.failedCount,
          pendingCount: counts.pendingCount,
        };
      } else {
        continuityVectorSummary = `; continuityVector=error(${counts.warning || "unknown error"})`;
        continuityVectorDetails = {
          enabled: true,
          status: "error",
          warning: counts.warning,
        };
      }
    }

    const continuityStatus = buildContinuityRuntimeStatusSummary(runtime);

    return buildTextToolResult({
      text:
        `Project memory: ${runtime.config.projectMemoryEnabled ? "enabled" : "disabled"}; ` +
        `scope=${runtime.storePaths.activeScope}; mode=${runtime.config.mode}; ` +
        `checkpoint=${runtime.config.checkpoint.mode}/${runtime.config.checkpoint.pragmaMode}` +
        `${continuityVectorSummary}; ${continuityStatus.summary}.`,
      details: {
        status: "ok",
        runtimeReady: true,
        projectMemoryEnabled: runtime.config.projectMemoryEnabled,
        scope: runtime.storePaths.activeScope,
        mode: runtime.config.mode,
        continuity: continuityStatus.details,
        continuityVector: continuityVectorDetails,
      },
    });
  };
};
