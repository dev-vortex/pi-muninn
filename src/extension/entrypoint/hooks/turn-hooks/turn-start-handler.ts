/**
 * File intent: create the turn_start lifecycle handler.
 *
 * Turn start intentionally does not inject memory/continuity briefings.
 *
 * Decision: Pi can make multiple LLM calls inside one user prompt after tool
 * results. Dynamic briefings are injected once from before_agent_start instead
 * of per turn/context to avoid retrieval loops.
 */

import type { LifecycleEventHandler, LifecycleHookDependencies } from "../types.js";

/**
 * Build the turn_start handler with explicit lifecycle dependencies.
 */
export const createTurnStartHandler = (_deps: LifecycleHookDependencies): LifecycleEventHandler => {
  return async () => undefined;
};
