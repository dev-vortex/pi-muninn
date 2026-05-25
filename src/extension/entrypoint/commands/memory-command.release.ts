/**
 * File intent: build the release-profile `/memory` command handler.
 */

import { normalizeReleaseCommandArgs } from "../command-args.release.js";
import { notifyCommandOutput } from "../command-output.js";
import { handleReleaseProjectMemoryNamespaceCommand } from "./project-namespace/router.release.js";
import { handleUpstreamMemoryCommand } from "./upstream-memory-command.js";
import type { ExtensionCommandDependencies } from "./types.js";

/**
 * Create the executable release handler for the `/memory` command.
 */
export const createReleaseMemoryCommandHandler = (deps: ExtensionCommandDependencies) => async (
  args: unknown,
  ctx: any,
): Promise<string> => {
  await deps.initializeBundledUpstreamCompatibility();

  const normalizedArgs = normalizeReleaseCommandArgs(args);
  const requestedCommand = normalizedArgs.length > 0
    ? `/memory ${normalizedArgs.join(" ")}`
    : "/memory";
  const [namespace, ...namespaceArgs] = normalizedArgs;

  if (namespace !== "project") {
    return handleUpstreamMemoryCommand({
      deps,
      normalizedArgs,
      requestedCommand,
      ctx,
    });
  }

  const projectNamespaceOutput = await handleReleaseProjectMemoryNamespaceCommand({
    deps,
    namespaceArgs,
    ctx,
  });

  return notifyCommandOutput(ctx, projectNamespaceOutput);
};
