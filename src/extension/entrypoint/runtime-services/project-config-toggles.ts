/**
 * File intent: update project-memory config toggles from Pi command/tool flows.
 *
 * Keep command-facing enable/mode mutations separate from the session runtime
 * cache so callers can change config and then refresh runtime explicitly.
 */

import { updateProjectMemoryConfig } from "../../../project-memory/config.js";
import type { ProjectMemoryConfig, ProjectMemoryMode } from "../../../project-memory/types.js";

/**
 * Toggle project-memory mode in the project-local extension config.
 */
export const setProjectMemoryEnabled = async (input: {
  projectRoot: string;
  enabled: boolean;
}): Promise<ProjectMemoryConfig> =>
  updateProjectMemoryConfig({
    projectRoot: input.projectRoot,
    updater: (current) => ({
      ...current,
      projectMemoryEnabled: input.enabled,
    }),
  });

/**
 * Update project-memory retrieval mode in the project-local extension config.
 */
export const setProjectMemoryMode = async (input: {
  projectRoot: string;
  mode: ProjectMemoryMode;
}): Promise<ProjectMemoryConfig> =>
  updateProjectMemoryConfig({
    projectRoot: input.projectRoot,
    updater: (current) => ({
      ...current,
      mode: input.mode,
    }),
  });
