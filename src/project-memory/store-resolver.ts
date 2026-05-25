/**
 * File intent: resolve runtime filesystem paths for global and project memory.
 *
 * This file translates project config plus resolved user identity into concrete
 * store paths for the official global memory DB, project user DB, project index,
 * and config files. Keep path topology here so callers do not duplicate path
 * construction or confuse global-only and project-enabled scopes.
 */

import path from "node:path";

import {
  resolveProjectMemoryConfigPath,
  resolveProjectMemoryDirectory,
} from "./config.js";
import type { ProjectMemoryConfig, ProjectMemoryStorePaths } from "./types.js";

/**
 * Resolve official pi-mempalace home directory from process environment.
 *
 * Parity note: upstream pi-mempalace uses `HOME || USERPROFILE || "~"`.
 * We intentionally mirror that behavior for global-only compatibility.
 */
export const resolveOfficialGlobalMemoryDirectory = (env: NodeJS.ProcessEnv = process.env): string => {
  const homeDirectory = env.HOME || env.USERPROFILE || "~";
  return path.join(homeDirectory, ".pi", "agent", "memory");
};

/**
 * Resolve project-memory store paths for global/project memory.
 *
 * Notes:
 * - Always resolves both global and project paths.
 * - `activeScope` indicates which paths should be used by runtime.
 * - If project mode is enabled, caller must provide `userId`.
 */
export const resolveProjectMemoryStorePaths = (input: {
  projectRoot: string;
  config: ProjectMemoryConfig;
  userId?: string;
  env?: NodeJS.ProcessEnv;
}): ProjectMemoryStorePaths => {
  const globalMemoryDir = resolveOfficialGlobalMemoryDirectory(input.env);
  const projectMemoryDir = resolveProjectMemoryDirectory(input.projectRoot);

  const activeScope = input.config.projectMemoryEnabled ? "project-enabled" : "global-only";

  if (activeScope === "project-enabled" && (!input.userId || input.userId.trim().length === 0)) {
    throw new Error(
      "Project memory is enabled, but no userId was provided. " +
      "Set config.myUserId (e.g. '/memory project user set <user>'), provide PI_MEMORY_USER_ID, " +
      "or configure repo-local git user.email/user.name (or EMAIL/USER_EMAIL/USER/USERNAME/LOGNAME).",
    );
  }

  const userId = input.userId?.trim() || "unresolved-user";

  return {
    activeScope,
    globalMemoryDir,
    globalConfigPath: path.join(globalMemoryDir, "config.json"),
    globalDatabasePath: path.join(globalMemoryDir, "memories.db"),
    projectMemoryDir,
    projectConfigPath: resolveProjectMemoryConfigPath(input.projectRoot),
    projectUserDatabasePath: path.join(projectMemoryDir, `${userId}.db`),
    projectIndexDatabasePath: path.join(projectMemoryDir, "cache.db"),
  };
};

