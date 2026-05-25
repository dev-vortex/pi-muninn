/**
 * File intent: create the context lifecycle handler for request-key tracking.
 *
 * The context handler records the latest user-request key for continuity
 * query-noise tracking without injecting briefings.
 *
 * Decision: `context` fires before every LLM call, including after tool results;
 * dynamic memory/continuity context belongs in before_agent_start to avoid
 * repeated retrieval loops.
 */

import type { LifecycleEventHandler, LifecycleHookDependencies } from "../types.js";

/**
 * Build the context handler with explicit lifecycle dependencies.
 */
export const createContextHandler = (deps: LifecycleHookDependencies): LifecycleEventHandler => {
  const {
    state,
    policies,
    runtime: runtimeDeps,
  } = deps;

  return async (event: unknown, ctx: any) => {
    const continuityEnabled = policies.isContinuityRuntimePolicyEnabled();
    const projectMemoryBriefingEnabled = policies.isProjectMemoryRuntimePolicyEnabled();

    if (!continuityEnabled && !projectMemoryBriefingEnabled) {
      return undefined;
    }

    const eventMessages = (event as { messages?: unknown })?.messages;
    if (!Array.isArray(eventMessages)) {
      return undefined;
    }

    const sessionId = runtimeDeps.resolveSessionId(ctx);
    const requestKey = runtimeDeps.resolveLatestUserRequestKey(eventMessages);
    state.continuityRuntimeRequestKeyBySession.set(sessionId, requestKey);

    return undefined;
  };
};
