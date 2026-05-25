/**
 * File intent: create the session_tree lifecycle handler.
 *
 * Session tree load follows startup bootstrap behavior when a saved session tree
 * is loaded, keeping project runtime and runtime-policy snippets warm.
 */

import type { LifecycleEventHandler, LifecycleHookDependencies } from "../types.js";

/**
 * Build the session_tree handler with explicit lifecycle dependencies.
 */
export const createSessionTreeHandler = (deps: LifecycleHookDependencies): LifecycleEventHandler => {
  const {
    snippets,
    runtime: runtimeDeps,
    compatibility,
  } = deps;

  return async (_event: unknown, ctx: any) => {
    await compatibility.initializeBundledUpstreamCompatibility();

    const result = await runtimeDeps.bootstrap(ctx);
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[project-memory] bootstrap failed on session_tree: ${result.error}`);

      if (ctx?.hasUI && typeof ctx?.ui?.notify === "function") {
        ctx.ui.notify(
          `Project-memory bootstrap failed on session tree load: ${result.error || "unknown error"}`,
          "warning",
        );
      }
    }

    await snippets.warmPersistenceOrchestrationRuntimeSnippet(ctx);
    await snippets.warmContinuityRuntimeSnippet(ctx);
    await snippets.warmProjectMemoryRuntimeSnippet(ctx);
  };
};
