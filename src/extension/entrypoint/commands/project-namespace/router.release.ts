/**
 * File intent: route release-profile `/memory project ...` actions.
 */

import type { ExtensionCommandDependencies } from "../types.js";
import {
  handleReleaseProjectContinuityBriefingCommand,
  handleReleaseProjectModeCommand,
  handleReleaseProjectSetCommand,
  handleReleaseProjectToggleCommand,
  handleReleaseProjectUserCommand,
} from "./config-commands.release.js";
import {
  notifyReleaseProjectNamespaceMessage,
  RELEASE_PROJECT_MEMORY_ACTION_TOKENS,
  renderReleaseProjectMemoryNamespaceHelp,
} from "./help.release.js";
import { handleReleaseProjectPromoteCommand } from "./promote-command.release.js";
import {
  handleReleaseProjectIndexCommand,
  handleReleaseProjectSearchCommand,
} from "./search-index-commands.release.js";
import { handleReleaseProjectStatusCommand } from "./status-command.release.js";

/**
 * Route one release-profile `/memory project ...` command invocation.
 */
export const handleReleaseProjectMemoryNamespaceCommand = async (input: {
  deps: ExtensionCommandDependencies;
  namespaceArgs: string[];
  ctx: any;
}): Promise<string> => {
  const { deps, namespaceArgs, ctx } = input;
  const [action = "status", ...restArgs] = namespaceArgs;
  const isProjectRootInvocation = namespaceArgs.length === 0;

  if (!RELEASE_PROJECT_MEMORY_ACTION_TOKENS.has(action)) {
    return notifyReleaseProjectNamespaceMessage(
      `Project command '${action}' is not available in the release profile.\n\n${renderReleaseProjectMemoryNamespaceHelp()}`,
      "warning",
    );
  }

  if (action === "help") {
    return notifyReleaseProjectNamespaceMessage(renderReleaseProjectMemoryNamespaceHelp());
  }

  if (action === "set") {
    return handleReleaseProjectSetCommand({ deps, restArgs, ctx });
  }

  if (action === "user") {
    return handleReleaseProjectUserCommand({ deps, restArgs, ctx });
  }

  if (action === "on" || action === "off") {
    return handleReleaseProjectToggleCommand({ deps, action, ctx });
  }

  if (action === "mode") {
    return handleReleaseProjectModeCommand({ deps, restArgs, ctx });
  }

  if (action === "continuity-briefing") {
    return handleReleaseProjectContinuityBriefingCommand({ deps, restArgs, ctx });
  }

  if (action === "search") {
    return handleReleaseProjectSearchCommand({ deps, restArgs, ctx });
  }

  if (action === "index") {
    return handleReleaseProjectIndexCommand({ deps, restArgs, ctx });
  }

  if (action === "promote") {
    return handleReleaseProjectPromoteCommand({ deps, restArgs, ctx });
  }

  return handleReleaseProjectStatusCommand({
    deps,
    isProjectRootInvocation,
    ctx,
  });
};
