/**
 * File intent: render release-profile `/memory project status` output.
 */

import { getProjectSessionRuntime } from "../../runtime-services/project-session-store.js";
import type { ExtensionCommandDependencies } from "../types.js";
import { notifyReleaseProjectNamespaceMessage, renderReleaseProjectMemoryNamespaceHelp } from "./help.release.js";

/**
 * Handle bare/status project namespace invocations in the release profile.
 */
export const handleReleaseProjectStatusCommand = async (input: {
  deps: ExtensionCommandDependencies;
  isProjectRootInvocation: boolean;
  ctx: any;
}): Promise<string> => {
  const { deps, isProjectRootInvocation, ctx } = input;
  const appendProjectNamespaceHelp = (text: string): string => (
    isProjectRootInvocation
      ? `${text}\n\n${renderReleaseProjectMemoryNamespaceHelp()}`
      : text
  );

  const runtime = getProjectSessionRuntime({
    ctx,
    store: deps.sessionStore,
  });

  if (!runtime) {
    const result = await deps.bootstrap(ctx);
    const bootstrapped = getProjectSessionRuntime({
      ctx,
      store: deps.sessionStore,
    });

    if (!bootstrapped) {
      if (!result.ok) {
        return notifyReleaseProjectNamespaceMessage(
          appendProjectNamespaceHelp(`Project memory status unavailable (bootstrap failed: ${result.error}).`),
          "warning",
        );
      }

      return notifyReleaseProjectNamespaceMessage(
        appendProjectNamespaceHelp("Project memory status unavailable (runtime not initialized)."),
        "warning",
      );
    }

    const projectStatus = deps.buildProjectRuntimeStatusSummary(bootstrapped);
    const retrievalStatus = deps.buildProjectRetrievalStatusSummary(ctx);
    const cacheStatus = await deps.buildProjectCacheStatusSummary(bootstrapped);
    const continuityStatus = deps.buildContinuityRuntimeStatusSummary(bootstrapped);
    const upstreamSummary = await deps.renderUpstreamRuntimeSummary(ctx);
    return notifyReleaseProjectNamespaceMessage(appendProjectNamespaceHelp(
      `Project memory: ${projectStatus.summary}; ${retrievalStatus.summary}; ${cacheStatus.summary}; ${continuityStatus.summary}; ${upstreamSummary}.`,
    ));
  }

  const projectStatus = deps.buildProjectRuntimeStatusSummary(runtime);
  const retrievalStatus = deps.buildProjectRetrievalStatusSummary(ctx);
  const cacheStatus = await deps.buildProjectCacheStatusSummary(runtime);
  const continuityStatus = deps.buildContinuityRuntimeStatusSummary(runtime);
  const upstreamSummary = await deps.renderUpstreamRuntimeSummary(ctx);
  return notifyReleaseProjectNamespaceMessage(appendProjectNamespaceHelp(
    `Project memory: ${projectStatus.summary}; ${retrievalStatus.summary}; ${cacheStatus.summary}; ${continuityStatus.summary}; ${upstreamSummary}.`,
  ));
};
