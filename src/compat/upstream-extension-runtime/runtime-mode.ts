/**
 * File intent: resolve bundled upstream runtime mode for one workspace.
 *
 * The compatibility layer fails closed into project-curation when project config
 * cannot be read so upstream global writers cannot bypass curation policy.
 */

import { loadProjectMemoryConfig } from "../../project-memory/config.js";
import {
  detectUpstreamPiMempalaceConflict,
} from "../upstream-package-conflict.js";
import { resolveHomeDirectory } from "./environment.js";
import type { BundledUpstreamRuntimeModeStatus } from "./types.js";

export const resolveBundledUpstreamRuntimeMode = async (input: {
  cwd: string;
  homeDirectory?: string;
}): Promise<BundledUpstreamRuntimeModeStatus> => {
  const conflict = detectUpstreamPiMempalaceConflict({
    cwd: input.cwd,
    homeDirectory: input.homeDirectory || resolveHomeDirectory(),
  });

  if (conflict.detected) {
    return {
      mode: "standalone-conflict",
      allowGlobalLifecycleHooks: false,
      reason: "standalone-upstream-configured",
      conflictSources: conflict.sources,
    };
  }

  try {
    const projectConfig = await loadProjectMemoryConfig(input.cwd);

    if (projectConfig.projectMemoryEnabled) {
      return {
        mode: "project-curation",
        allowGlobalLifecycleHooks: false,
        reason: "project-memory-enabled",
        conflictSources: [],
      };
    }

    return {
      mode: "compatibility",
      allowGlobalLifecycleHooks: true,
      reason: "project-memory-disabled",
      conflictSources: [],
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      mode: "project-curation",
      allowGlobalLifecycleHooks: false,
      reason: `project-config-unavailable:${message}`,
      conflictSources: [],
    };
  }
};

/**
 * Create a proxy API for vendored upstream extension registration.
 *
 * Decision:
 * - keep bundled upstream tools available,
 * - capture upstream `/memory` command so this package can expose one unified
 *   command surface,
 * - gate upstream auto-write/injection lifecycle hooks in project-curation mode,
 * - keep payload-routed memory_save as the only project-curation write entrypoint,
 * - block other upstream global-write tools in project-curation mode,
 * - enrich memory_search/memory_recall in project-curation mode with project
 *   memory lane (memory rows only) plus upstream general lane output,
 * - map memory_graph/memory_tunnel in project-curation mode to user-topic
 *   project-memory relations while preserving vendor names.
 */
