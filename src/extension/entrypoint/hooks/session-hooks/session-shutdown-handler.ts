/**
 * File intent: create the session_shutdown lifecycle handler.
 *
 * Session shutdown performs configured checkpointing, optional continuity session
 * summaries, lifecycle hygiene, and cleanup of all session-scoped extension maps.
 */

import {
  clearProjectSessionRuntime,
  getProjectSessionRuntime,
} from "../../runtime-services/project-session-store.js";
import type { LifecycleEventHandler, LifecycleHookDependencies } from "../types.js";

/**
 * Build the session_shutdown handler with explicit lifecycle dependencies.
 */
export const createSessionShutdownHandler = (deps: LifecycleHookDependencies): LifecycleEventHandler => {
  const {
    state,
    policies,
    runtime: runtimeDeps,
    checkpoint,
    continuity,
  } = deps;

  return async (_event: unknown, ctx: any) => {
    const sessionId = runtimeDeps.resolveSessionId(ctx);
    const runtime = getProjectSessionRuntime({
      ctx,
      store: state.sessionStore,
    });

    const tracker = checkpoint.getCheckpointTracker(ctx);

    if (runtime) {
      const pendingMemoryWrites = tracker.writesSinceLastCheckpoint;

      const checkpointOutcome = checkpoint.runShutdownCheckpointIfEnabled({
        policy: runtime.config.checkpoint,
        tracker,
        databasePaths: checkpoint.resolveCheckpointDatabasePaths({
          activeScope: runtime.storePaths.activeScope,
          globalDatabasePath: runtime.storePaths.globalDatabasePath,
          projectUserDatabasePath: runtime.storePaths.projectUserDatabasePath,
        }),
      });

      if (checkpointOutcome.ran && checkpointOutcome.result) {
        checkpoint.warnCheckpointFailures(checkpointOutcome.result.failures, "shutdown");
      }

      if (runtime.config.projectMemoryEnabled && runtime.storePaths.activeScope === "project-enabled") {
        if (policies.isContinuitySessionSummaryEnabled()) {
          await continuity.storeSessionContinuitySummary({
            ctx,
            runtime,
            pendingMemoryWrites,
          });
        }

        continuity.runContinuityCompactionLifecycleHygiene({
          runtime,
          trigger: "session_shutdown",
        });
      }
    }

    clearProjectSessionRuntime({
      ctx,
      store: state.sessionStore,
    });
    state.observabilityBySession.delete(sessionId);
    state.checkpointBySession.delete(sessionId);
    state.continuityRuntimeSnippetBySession.delete(sessionId);
    state.projectMemoryRuntimeSnippetBySession.delete(sessionId);
    state.persistenceOrchestrationRuntimeSnippetBySession.delete(sessionId);
    state.continuityRuntimeRequestKeyBySession.delete(sessionId);
    state.continuityQueryNoiseStreakBySession.delete(sessionId);
    state.continuityCompactionProfileBySession.delete(sessionId);
    state.continuityVectorCountsBySession.delete(sessionId);
    state.continuityComplianceBySession.delete(sessionId);
    state.briefingDebugEnabledBySession.delete(sessionId);
  };
};
