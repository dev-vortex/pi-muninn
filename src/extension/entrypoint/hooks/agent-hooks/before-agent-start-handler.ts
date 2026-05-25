/**
 * File intent: create the before_agent_start lifecycle handler for runtime policy injection.
 *
 * This handler appends persistence-orchestration, continuity, and project-memory
 * policy snippets in the established order without changing prompt wording.
 */

import type { LifecycleEventHandler, LifecycleHookDependencies } from "../types.js";

/**
 * Build the before_agent_start handler with explicit lifecycle dependencies.
 */
export const createBeforeAgentStartHandler = (deps: LifecycleHookDependencies): LifecycleEventHandler => {
  const {
    state,
    snippets,
    runtime: runtimeDeps,
    policies,
  } = deps;

  return async (event: unknown, ctx: any) => {
    const sessionId = runtimeDeps.resolveSessionId(ctx);
    const configuredPrompt = typeof (event as { systemPrompt?: unknown })?.systemPrompt === "string"
      ? (event as { systemPrompt: string }).systemPrompt
      : "";

    let nextSystemPrompt = configuredPrompt.trimEnd();
    let updated = false;

    const appendSnippet = (snippet: string): void => {
      if (nextSystemPrompt.includes(snippet)) {
        return;
      }

      const separator = nextSystemPrompt.length > 0 ? "\n\n" : "";
      nextSystemPrompt = `${nextSystemPrompt}${separator}${snippet}`;
      updated = true;
    };

    const continuityRuntimePolicyEnabled = policies.isContinuityRuntimePolicyEnabled();
    const projectMemoryRuntimePolicyEnabled = policies.isProjectMemoryRuntimePolicyEnabled();
    const shouldResolveProjectRuntime = continuityRuntimePolicyEnabled || projectMemoryRuntimePolicyEnabled;
    const projectRuntime = shouldResolveProjectRuntime
      ? await runtimeDeps.resolveProjectRuntime(ctx)
      : null;
    const projectMemoryRuntimePolicyActive = Boolean(
      projectRuntime
      && projectRuntime.config.projectMemoryEnabled
      && projectRuntime.storePaths.activeScope === "project-enabled",
    );

    if (
      policies.isPersistenceOrchestrationRuntimePolicyEnabled()
      && (continuityRuntimePolicyEnabled || projectMemoryRuntimePolicyActive)
    ) {
      let persistenceOrchestrationSnippet = state.persistenceOrchestrationRuntimeSnippetBySession.get(sessionId);

      if (!persistenceOrchestrationSnippet) {
        await snippets.warmPersistenceOrchestrationRuntimeSnippet(ctx);
        persistenceOrchestrationSnippet = state.persistenceOrchestrationRuntimeSnippetBySession.get(sessionId);
      }

      if (persistenceOrchestrationSnippet) {
        appendSnippet(persistenceOrchestrationSnippet);
      }
    }

    if (continuityRuntimePolicyEnabled) {
      let continuitySnippet = state.continuityRuntimeSnippetBySession.get(sessionId);

      if (!continuitySnippet) {
        await snippets.warmContinuityRuntimeSnippet(ctx);
        continuitySnippet = state.continuityRuntimeSnippetBySession.get(sessionId);
      }

      if (continuitySnippet) {
        appendSnippet(continuitySnippet);
      }
    }

    if (projectMemoryRuntimePolicyActive) {
      if (projectRuntime) {
        let projectMemorySnippet = state.projectMemoryRuntimeSnippetBySession.get(sessionId);

        if (!projectMemorySnippet) {
          await snippets.warmProjectMemoryRuntimeSnippet(ctx);
          projectMemorySnippet = state.projectMemoryRuntimeSnippetBySession.get(sessionId);
        }

        if (projectMemorySnippet) {
          appendSnippet(projectMemorySnippet);
        }
      }
    }

    const debugShowBriefing = state.briefingDebugEnabledBySession.get(sessionId) === true
      && typeof ctx?.ui?.notify === "function"
      ? (briefing: string): void => {
        // Keep prompt visibility session-scoped and unreachable from release commands.
        ctx.ui.notify(`[Project briefing debug display]\n${briefing}`, "info");
      }
      : undefined;

    const briefingPrompt = await deps.promptBriefings.buildPromptBriefing({
      event,
      runtime: projectRuntime,
      includeContinuity: continuityRuntimePolicyEnabled,
      includeProjectMemory: projectMemoryRuntimePolicyActive,
      debugShowBriefing,
    });

    if (briefingPrompt) {
      // Inject once per user prompt; context hooks run again after tool results.
      appendSnippet(briefingPrompt);
    }

    if (!updated) {
      return undefined;
    }

    return {
      systemPrompt: nextSystemPrompt,
    };
  };
};
