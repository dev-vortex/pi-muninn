/**
 * File intent: create the session_start lifecycle handler.
 *
 * Session start initializes upstream compatibility, bootstraps project runtime,
 * warms runtime-policy snippets, and surfaces non-fatal startup warnings.
 */

import type { LifecycleEventHandler, LifecycleHookDependencies } from "../types.js";

/**
 * Build the session_start handler with explicit lifecycle dependencies.
 */
export const createSessionStartHandler = (deps: LifecycleHookDependencies): LifecycleEventHandler => {
  const {
    snippets,
    runtime: runtimeDeps,
    compatibility,
  } = deps;

  return async (_event: unknown, ctx: any) => {
    await compatibility.initializeBundledUpstreamCompatibility();

    const result = await runtimeDeps.bootstrap(ctx);
    if (!result.ok) {
      // Keep session alive; user can fix config/user-id and retry.
      // eslint-disable-next-line no-console
      console.warn(`[project-memory] bootstrap failed on session_start: ${result.error}`);

      if (ctx?.hasUI && typeof ctx?.ui?.notify === "function") {
        ctx.ui.notify(
          `Project-memory bootstrap failed on session start: ${result.error || "unknown error"}`,
          "warning",
        );
      }
    }

    await snippets.warmPersistenceOrchestrationRuntimeSnippet(ctx);
    await snippets.warmContinuityRuntimeSnippet(ctx);
    await snippets.warmProjectMemoryRuntimeSnippet(ctx);

    const bundledUpstream = compatibility.getBundledUpstream();
    if (
      (bundledUpstream.status === "skipped-conflict" || bundledUpstream.status === "skipped-load-error") &&
      bundledUpstream.warning &&
      ctx?.hasUI
    ) {
      ctx.ui.notify(bundledUpstream.warning, "warning");
    }
  };
};
