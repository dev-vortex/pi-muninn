/**
 * File intent: bootstrap and resolve active project-memory runtime state.
 *
 * The service keeps lifecycle-safe runtime refresh behavior and continuity vector
 * schema bootstrap outside command/tool registration code.
 */

import { bootstrapProjectSessionRuntime, getProjectSessionRuntime } from "./project-session-store.js";
import { ensureContinuityVectorSchema, readContinuityVectorStatusCounts } from "../../../../packages/memory-core/src/adapters/sqlite/continuity/index.js";
import { ensureProjectUserMemoryDatabase } from "../../../memory-providers/pi-mempalace-compatible/project-memory/user-memory-ingest.js";
import type { MemoryExtensionRuntimeState } from "../runtime-state.js";
import { isContinuityVectorEnabled } from "./runtime-config.js";

/**
 * Build project runtime bootstrap/lookup services.
 */
export const createProjectRuntimeServices = (state: MemoryExtensionRuntimeState): {
  bootstrap: (ctx: any, options?: { explicitUserId?: string }) => Promise<{ ok: boolean; error?: string }>;
  resolveProjectRuntime: (ctx: any) => Promise<NonNullable<ReturnType<typeof getProjectSessionRuntime>> | null>;
  resolveActiveProjectRuntime: (ctx: any) => Promise<{
    ok: true;
    databasePath: string;
    projectMemoryDir: string;
    mode: "fanout" | "index-first";
    indexFreshnessSeconds?: number;
    activeUserId: string | null;
  } | { ok: false; error: string }>;
  resolveActiveContinuityDatabasePath: (ctx: any) => Promise<{ ok: true; databasePath: string } | { ok: false; error: string }>;
} => {
  const bootstrap = async (
    ctx: any,
    options?: { explicitUserId?: string },
  ): Promise<{ ok: boolean; error?: string }> => {
    try {
      const runtime = await bootstrapProjectSessionRuntime({
        ctx,
        store: state.sessionStore,
        explicitUserId: options?.explicitUserId,
        // Persist once when missing so DB path stays deterministic across sessions/machines.
        persistResolvedUserId: true,
      });

      if (runtime.config.projectMemoryEnabled && runtime.storePaths.activeScope === "project-enabled") {
        ensureProjectUserMemoryDatabase(runtime.storePaths.projectUserDatabasePath);

        if (isContinuityVectorEnabled()) {
          const vectorSchema = ensureContinuityVectorSchema({
            databasePath: runtime.storePaths.projectUserDatabasePath,
          });

          if (vectorSchema.status === "error") {
            // eslint-disable-next-line no-console
            console.warn(`[project-memory] continuity vector schema bootstrap failed: ${vectorSchema.warning || "unknown error"}`);
          } else {
            const sessionId = ctx?.sessionManager?.getSessionId?.() || "default-session";

            const counts = readContinuityVectorStatusCounts({
              databasePath: runtime.storePaths.projectUserDatabasePath,
            });

            if (counts.status === "ok") {
              state.continuityVectorCountsBySession.set(sessionId, {
                totalTracked: counts.totalTracked,
                indexedCount: counts.indexedCount,
                failedCount: counts.failedCount,
                pendingCount: counts.pendingCount,
              });
            } else {
              // eslint-disable-next-line no-console
              console.warn(`[project-memory] continuity vector counters unavailable: ${counts.warning || "unknown error"}`);
            }
          }
        }
      }

      return { ok: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  };

  const resolveProjectRuntime = async (ctx: any): Promise<NonNullable<ReturnType<typeof getProjectSessionRuntime>> | null> => {
    const current = getProjectSessionRuntime({
      ctx,
      store: state.sessionStore,
    });

    if (current) {
      return current;
    }

    const refreshed = await bootstrap(ctx);
    if (!refreshed.ok) {
      return null;
    }

    return getProjectSessionRuntime({
      ctx,
      store: state.sessionStore,
    });
  };

  const resolveActiveProjectRuntime = async (ctx: any): Promise<{
    ok: true;
    databasePath: string;
    projectMemoryDir: string;
    mode: "fanout" | "index-first";
    indexFreshnessSeconds?: number;
    activeUserId: string | null;
  } | { ok: false; error: string }> => {
    const hasActiveProjectScope = (): {
      ok: true;
      databasePath: string;
      projectMemoryDir: string;
      mode: "fanout" | "index-first";
      indexFreshnessSeconds?: number;
      activeUserId: string | null;
    } | null => {
      const runtime = getProjectSessionRuntime({ ctx, store: state.sessionStore });
      if (!runtime) {
        return null;
      }

      if (!runtime.config.projectMemoryEnabled || runtime.storePaths.activeScope !== "project-enabled") {
        return null;
      }

      return {
        ok: true,
        databasePath: runtime.storePaths.projectUserDatabasePath,
        projectMemoryDir: runtime.storePaths.projectMemoryDir,
        mode: runtime.config.mode,
        indexFreshnessSeconds: runtime.config.index.intervalSeconds,
        activeUserId: runtime.userId || runtime.config.myUserId || null,
      };
    };

    const current = hasActiveProjectScope();
    if (current) {
      return current;
    }

    const refreshed = await bootstrap(ctx);
    const afterRefresh = hasActiveProjectScope();

    if (afterRefresh) {
      return afterRefresh;
    }

    if (!refreshed.ok) {
      return {
        ok: false,
        error: `Project memory runtime bootstrap failed: ${refreshed.error || "unknown error"}. Enable project mode first via '/memory project on' or the project_memory_enable tool.`,
      };
    }

    return {
      ok: false,
      error: "Project memory is disabled. Enable it first via '/memory project on' or the project_memory_enable tool.",
    };
  };

  const resolveActiveContinuityDatabasePath = async (ctx: any): Promise<{ ok: true; databasePath: string } | {
    ok: false;
    error: string;
  }> => {
    const runtime = await resolveActiveProjectRuntime(ctx);

    if (!runtime.ok) {
      return runtime;
    }

    return {
      ok: true,
      databasePath: runtime.databasePath,
    };
  };

  return {
    bootstrap,
    resolveProjectRuntime,
    resolveActiveProjectRuntime,
    resolveActiveContinuityDatabasePath,
  };
};
