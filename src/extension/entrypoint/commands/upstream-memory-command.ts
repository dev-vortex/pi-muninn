/**
 * File intent: handle top-level `/memory ...` delegation to bundled upstream.
 *
 * Project namespace commands are handled separately. This file preserves the
 * upstream-compatible status/stats fallback and UI notification behavior.
 */

import { notifyCommandOutput } from "../command-output.js";
import type { ExtensionCommandDependencies } from "./types.js";

/**
 * Delegate non-project `/memory` invocations to bundled upstream when possible.
 */
export const handleUpstreamMemoryCommand = async (input: {
  deps: ExtensionCommandDependencies;
  normalizedArgs: string[];
  requestedCommand: string;
  ctx: any;
}): Promise<string> => {
  const { deps, normalizedArgs, requestedCommand, ctx } = input;
  const bundledUpstreamMemoryCommand = deps.getBundledUpstreamMemoryCommand();

  if (bundledUpstreamMemoryCommand) {
    const delegatedArgs = normalizedArgs.join(" ");
    const delegatedSubcommand = (normalizedArgs[0] || "status").toLowerCase();
    const delegated = await bundledUpstreamMemoryCommand.handler(delegatedArgs, ctx);

    if (delegatedSubcommand === "status" || delegatedSubcommand === "stats") {
      const runtime = await deps.resolveProjectRuntime(ctx);
      const projectStatus = deps.buildProjectRuntimeStatusSummary(runtime);
      const continuityStatus = deps.buildContinuityRuntimeStatusSummary(runtime);
      const upstreamSummary = await deps.renderUpstreamRuntimeSummary(ctx);
      const behaviorHint = delegatedSubcommand === "status"
        ? "emits a UI notification"
        : "opens a UI stats overlay/notification";

      if (ctx?.ui && typeof ctx.ui.notify === "function") {
        ctx.ui.notify(
          `Project memory status: ${projectStatus.summary}; ${continuityStatus.summary}.`,
          "info",
        );
      }

      const delegatedMessage = typeof delegated === "string" && delegated.trim().length > 0
        ? delegated.trim()
        : `Executed '/memory ${delegatedSubcommand}' (upstream ${behaviorHint}).`;

      return notifyCommandOutput(ctx, `${delegatedMessage} ${projectStatus.summary}; ${continuityStatus.summary}. ${upstreamSummary}.`);
    }

    if (typeof delegated === "string" && delegated.trim().length > 0) {
      return notifyCommandOutput(ctx, delegated);
    }

    const upstreamSummary = await deps.renderUpstreamRuntimeSummary(ctx);
    return notifyCommandOutput(ctx, `Executed '${requestedCommand}' via upstream compatibility. ${upstreamSummary}.`);
  }

  const upstreamSummary = await deps.renderUpstreamRuntimeSummary(ctx);
  const delegatedSubcommand = (normalizedArgs[0] || "status").toLowerCase();

  if (delegatedSubcommand === "status" || delegatedSubcommand === "stats") {
    const runtime = await deps.resolveProjectRuntime(ctx);
    const projectStatus = deps.buildProjectRuntimeStatusSummary(runtime);
    const continuityStatus = deps.buildContinuityRuntimeStatusSummary(runtime);

    if (ctx?.ui && typeof ctx.ui.notify === "function") {
      ctx.ui.notify(
        `Project memory status: ${projectStatus.summary}; ${continuityStatus.summary}.`,
        "info",
      );
    }

    return notifyCommandOutput(ctx, `Upstream /memory compatibility is unavailable (${upstreamSummary}); ${projectStatus.summary}; ${continuityStatus.summary}. Use '/memory project status' for project-aware runtime state.`, "warning");
  }

  return notifyCommandOutput(ctx, `Upstream /memory compatibility is unavailable (${upstreamSummary}). Use '/memory project <...>' for project-aware operations.`, "warning");
};
