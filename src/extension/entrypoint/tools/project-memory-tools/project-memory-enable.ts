/**
 * File intent: create the project_memory_enable tool handler.
 *
 * The handler toggles project memory for the current workspace and refreshes
 * runtime state while preserving the original response text/details.
 */

import { getProjectSessionRuntime } from "../../runtime-services/project-session-store.js";
import type { ExtensionToolDependencies } from "../types.js";

/**
 * Build the project_memory_enable execute handler.
 */
export const createProjectMemoryEnableTool = (deps: ExtensionToolDependencies) => {
  const {
    sessionStore,
    bootstrap,
    resolveWorkspaceRoot,
    buildTextToolResult,
    setProjectMemoryEnabled,
  } = deps;

  return async (_toolCallId: string, params: { enabled?: boolean }, _signal: AbortSignal, _onUpdate: unknown, ctx: any) => {
    const enabled = params.enabled ?? true;
    const projectRoot = resolveWorkspaceRoot(ctx);

    try {
      const updated = await setProjectMemoryEnabled({
        projectRoot,
        enabled,
      });

      const bootstrapResult = await bootstrap(ctx);
      const runtime = getProjectSessionRuntime({
        ctx,
        store: sessionStore,
      });

      const scope = runtime?.storePaths.activeScope || (updated.projectMemoryEnabled ? "project-enabled" : "global-only");
      const checkpointSummary = `${updated.checkpoint.mode}/${updated.checkpoint.pragmaMode}`;

      if (!bootstrapResult.ok) {
        return buildTextToolResult({
          text:
            `Project memory is now ${updated.projectMemoryEnabled ? "enabled" : "disabled"} ` +
            `(mode=${updated.mode}; scope=${scope}; checkpoint=${checkpointSummary}), ` +
            `but runtime bootstrap failed: ${bootstrapResult.error || "unknown error"}.`,
          details: {
            status: "warning",
            projectMemoryEnabled: updated.projectMemoryEnabled,
            mode: updated.mode,
            scope,
            bootstrapOk: false,
          },
        });
      }

      return buildTextToolResult({
        text:
          `Project memory is now ${updated.projectMemoryEnabled ? "enabled" : "disabled"} ` +
          `(mode=${updated.mode}; scope=${scope}; checkpoint=${checkpointSummary}).`,
        details: {
          status: "ok",
          projectMemoryEnabled: updated.projectMemoryEnabled,
          mode: updated.mode,
          scope,
          bootstrapOk: true,
        },
      });
    } catch (error: unknown) {
      return buildTextToolResult({
        text: `project_memory_enable failed: ${error instanceof Error ? error.message : String(error)}`,
        details: {
          status: "error",
          reason: "toggle-failed",
        },
      });
    }
  };
};
