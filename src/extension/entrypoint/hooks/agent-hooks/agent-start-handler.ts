/**
 * File intent: create the agent_start lifecycle handler.
 *
 * Agent start resets per-request continuity compliance counters so warnings at
 * agent_end reflect only the current request lifecycle.
 */

import type { LifecycleEventHandler, LifecycleHookDependencies } from "../types.js";

/**
 * Build the agent_start handler with explicit lifecycle dependencies.
 */
export const createAgentStartHandler = (deps: LifecycleHookDependencies): LifecycleEventHandler => {
  const { continuity } = deps;

  return async (_event: unknown, ctx: any) => {
    continuity.resetContinuityComplianceTracker(ctx);
  };
};
