/**
 * File intent: register release-profile extension command definitions.
 *
 * The release registrar keeps the public `/memory` command surface on the
 * approved stable allowlist while excluding development-only project commands.
 */

import { buildReleaseMemoryCommandCompletions } from "../command-args.release.js";
import { createReleaseMemoryCommandHandler } from "./memory-command.release.js";
import type { ExtensionCommandDependencies } from "./types.js";

/**
 * Register release-profile extension-owned commands.
 */
export const registerReleaseExtensionCommands = (deps: ExtensionCommandDependencies): void => {
  if (typeof deps.pi?.registerCommand !== "function") {
    return;
  }

  // Warm upstream capture early so completion metadata is available sooner.
  void deps.initializeBundledUpstreamCompatibility();

  deps.pi.registerCommand("memory", {
    description: "Manage personal and project memory: status, search, project setup, identity, index refresh, and promotion.",
    handler: createReleaseMemoryCommandHandler(deps),
    getArgumentCompletions: (prefix: string) => buildReleaseMemoryCommandCompletions({
      prefix,
      upstreamCommand: deps.getBundledUpstreamMemoryCommand(),
    }),
  });
};
