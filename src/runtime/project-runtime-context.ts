/**
 * File intent: resolve and migrate project-memory runtime context for a session.
 *
 * This file combines config loading, workspace bootstrap, user-id resolution,
 * portable/random-local identity handling, store path resolution, and project DB
 * identity migration/merge behavior. Use this as the runtime boundary before
 * tools or lifecycle hooks touch project-memory files.
 */

import { existsSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import path from "node:path";

import {
  type BetterSqliteDatabase,
  openBetterSqliteDatabase,
} from "../memory-data-adapters/sqlite/common/better-sqlite3-adapter.js";
import {
  ensureProjectMemoryLocalGitignore,
  ensureProjectMemoryWorkspace,
  loadProjectMemoryConfig,
  resolveProjectMemoryDirectory,
  updateProjectMemoryConfig,
} from "../project-memory/config.js";
import { resolveProjectMemoryStorePaths } from "../project-memory/store-resolver.js";
import type { ProjectMemoryConfig, ProjectMemoryStorePaths } from "../project-memory/types.js";
import {
  isPortableUserIdResolutionSource,
  resolveProjectUserId,
  type ProjectUserIdResolutionSource,
} from "../project-memory/user-id.js";

const MIGRATION_COPY_TABLE_ORDER = [
  "memories",
  "continuity_entries",
  "continuity_milestones",
  "continuity_compaction_previews",
  "continuity_telemetry_events",
  "continuity_telemetry_review_labels",
] as const;

const quoteIdentifier = (value: string): string => `"${value.replace(/"/g, '""')}"`;

const rewriteCreateTableSqlForIfNotExists = (sql: string): string =>
  sql.replace(/^CREATE\s+TABLE\s+/i, "CREATE TABLE IF NOT EXISTS ");

const tableExistsInSchema = (input: {
  db: BetterSqliteDatabase;
  schema: "main" | "src";
  tableName: string;
}): boolean => {
  const row = input.db.prepare(`
    SELECT name
    FROM ${input.schema}.sqlite_master
    WHERE type='table' AND name=?
  `).get(input.tableName);

  return !!row;
};

const readTableColumns = (input: {
  db: BetterSqliteDatabase;
  schema: "main" | "src";
  tableName: string;
}): string[] => {
  const rows = input.db.prepare(`PRAGMA ${input.schema}.table_info(${quoteIdentifier(input.tableName)})`).all();

  return rows
    .map((row) => (typeof row.name === "string" ? row.name : null))
    .filter((name): name is string => !!name);
};

const mergeProjectUserDatabases = async (input: {
  sourceDatabasePath: string;
  targetDatabasePath: string;
}): Promise<void> => {
  const db = openBetterSqliteDatabase(input.targetDatabasePath);

  try {
    db.exec("PRAGMA foreign_keys=OFF;");
    db.prepare("ATTACH DATABASE ? AS src").run(input.sourceDatabasePath);

    for (const tableName of MIGRATION_COPY_TABLE_ORDER) {
      if (!tableExistsInSchema({ db, schema: "src", tableName })) {
        continue;
      }

      const createSqlRow = db.prepare(`
        SELECT sql
        FROM src.sqlite_master
        WHERE type='table' AND name=?
      `).get(tableName);

      if (typeof createSqlRow?.sql === "string" && createSqlRow.sql.trim().length > 0) {
        db.exec(rewriteCreateTableSqlForIfNotExists(createSqlRow.sql));
      }

      const sourceColumns = readTableColumns({
        db,
        schema: "src",
        tableName,
      });

      if (sourceColumns.length === 0) {
        continue;
      }

      const targetColumns = new Set(readTableColumns({
        db,
        schema: "main",
        tableName,
      }));

      const commonColumns = sourceColumns.filter((column) => targetColumns.has(column));
      if (commonColumns.length === 0) {
        continue;
      }

      const columnList = commonColumns.map((column) => quoteIdentifier(column)).join(", ");

      db.exec(`
        INSERT OR IGNORE INTO ${quoteIdentifier(tableName)} (${columnList})
        SELECT ${columnList}
        FROM src.${quoteIdentifier(tableName)}
      `);
    }

    db.exec("DETACH DATABASE src;");
    db.exec("PRAGMA foreign_keys=ON;");
  } finally {
    db.close();
  }
};

const moveSidecarIfExists = async (input: {
  fromPath: string;
  toPath: string;
}): Promise<void> => {
  if (!existsSync(input.fromPath)) {
    return;
  }

  if (existsSync(input.toPath)) {
    return;
  }

  await rename(input.fromPath, input.toPath);
};

const purgeDatabaseSidecars = async (databasePath: string): Promise<void> => {
  await rm(`${databasePath}-wal`, { force: true });
  await rm(`${databasePath}-shm`, { force: true });
  await rm(`${databasePath}-journal`, { force: true });
};

export const migrateProjectUserDatabaseIdentity = async (input: {
  projectRoot: string;
  fromUserId: string;
  toUserId: string;
}): Promise<{ status: "renamed" | "merged" | "skipped"; warning?: string }> => {
  if (input.fromUserId === input.toUserId) {
    return { status: "skipped" };
  }

  const memoryDir = resolveProjectMemoryDirectory(input.projectRoot);
  const sourceDatabasePath = path.join(memoryDir, `${input.fromUserId}.db`);
  const targetDatabasePath = path.join(memoryDir, `${input.toUserId}.db`);

  if (!existsSync(sourceDatabasePath)) {
    return { status: "skipped" };
  }

  if (!existsSync(targetDatabasePath)) {
    await rename(sourceDatabasePath, targetDatabasePath);
    await moveSidecarIfExists({
      fromPath: `${sourceDatabasePath}-wal`,
      toPath: `${targetDatabasePath}-wal`,
    });
    await moveSidecarIfExists({
      fromPath: `${sourceDatabasePath}-shm`,
      toPath: `${targetDatabasePath}-shm`,
    });
    await moveSidecarIfExists({
      fromPath: `${sourceDatabasePath}-journal`,
      toPath: `${targetDatabasePath}-journal`,
    });

    return { status: "renamed" };
  }

  await mergeProjectUserDatabases({
    sourceDatabasePath,
    targetDatabasePath,
  });

  await rm(sourceDatabasePath, { force: true });
  await purgeDatabaseSidecars(sourceDatabasePath);

  return {
    status: "merged",
    warning: "target user DB already existed; source rows were merged with INSERT OR IGNORE semantics",
  };
};

/**
 * Runtime integration input for project-runtime wiring.
 */
export interface ResolveProjectRuntimeContextInput {
  /** Absolute project root (workspace root). */
  projectRoot: string;
  /** Optional explicit user id to force for this runtime. */
  explicitUserId?: string;
  /** Environment map used for deterministic user-id and HOME resolution. */
  env?: NodeJS.ProcessEnv;
  /** Ensure `${PROJECT}/.agent/memory` and default config exist before resolving. */
  ensureWorkspace?: boolean;
  /** Default overrides applied only if config is created for the first time. */
  defaultProjectConfigOverrides?: Partial<ProjectMemoryConfig>;
  /**
   * Persist resolved user id back to project config when missing.
   *
   * Decision note: this is optional so the final user-id policy can be
   * finalized later without breaking current integration behavior.
   */
  persistResolvedUserId?: boolean;
}

/**
 * Runtime context produced by project-runtime integration wiring.
 */
export interface ProjectRuntimeContext {
  /** Effective project-memory config. */
  config: ProjectMemoryConfig;
  /** Resolved user id for project DB naming, when available. */
  userId: string | null;
  /** Source used to resolve user id for traceability/debugging. */
  userIdSource: ProjectUserIdResolutionSource;
  /** Resolved store paths consumed by extension runtime. */
  storePaths: ProjectMemoryStorePaths;
}

/**
 * Build the project runtime context consumed by the repo-controlled extension path.
 *
 * This function is the integration seam between:
 * - configuration management (`project-memory/config`),
 * - user-id strategy (`project-memory/user-id`), and
 * - storage path routing (`project-memory/store-resolver`).
 */
export const resolveProjectRuntimeContext = async (
  input: ResolveProjectRuntimeContextInput,
): Promise<ProjectRuntimeContext> => {
  const shouldEnsureWorkspace = input.ensureWorkspace ?? true;

  const config = shouldEnsureWorkspace
    ? (await ensureProjectMemoryWorkspace({
      projectRoot: input.projectRoot,
      defaultOverrides: input.defaultProjectConfigOverrides,
    })).config
    : await loadProjectMemoryConfig(input.projectRoot);

  const isProjectEnabled = config.projectMemoryEnabled;
  const shouldIgnoreConfiguredUserIdForAutoUpgrade =
    isProjectEnabled &&
    config.identity?.isRandomLocal === true;

  // Compatibility-first behavior: when project memory is disabled,
  // runtime must behave like official global-only pi-mempalace.
  let initialUserIdResolution = isProjectEnabled
    ? resolveProjectUserId({
      explicitUserId: input.explicitUserId,
      projectConfigUserId: shouldIgnoreConfiguredUserIdForAutoUpgrade
        ? undefined
        : config.myUserId,
      projectRoot: input.projectRoot,
      env: input.env,
      allowRandomLocalFallback: true,
    })
    : { userId: null, source: "unresolved" as const };

  if (
    shouldIgnoreConfiguredUserIdForAutoUpgrade
    && initialUserIdResolution.source === "random-local"
    && config.myUserId
  ) {
    initialUserIdResolution = {
      userId: config.myUserId,
      source: "random-local",
    };
  }

  const shouldPersistResolvedUserId =
    isProjectEnabled &&
    input.persistResolvedUserId === true &&
    !!initialUserIdResolution.userId;

  let effectiveConfig = config;

  if (shouldPersistResolvedUserId && initialUserIdResolution.userId) {
    const previousUserId = config.myUserId?.trim() || null;
    const nextUserId = initialUserIdResolution.userId;
    const nextIdentity = {
      source: initialUserIdResolution.source,
      ...(config.identity?.displayName ? { displayName: config.identity.displayName } : {}),
      ...(config.identity?.identityLabelHash ? { identityLabelHash: config.identity.identityLabelHash } : {}),
      isRandomLocal: initialUserIdResolution.source === "random-local",
      isPortable: isPortableUserIdResolutionSource(initialUserIdResolution.source),
    };

    const identityChanged =
      config.identity?.source !== nextIdentity.source
      || config.identity?.isRandomLocal !== nextIdentity.isRandomLocal
      || config.identity?.isPortable !== nextIdentity.isPortable;

    if (previousUserId !== nextUserId || identityChanged || !config.identity) {
      effectiveConfig = await updateProjectMemoryConfig({
        projectRoot: input.projectRoot,
        updater: (current) => ({
          ...current,
          myUserId: nextUserId,
          identity: nextIdentity,
        }),
      });

      if (previousUserId && previousUserId !== nextUserId) {
        try {
          await migrateProjectUserDatabaseIdentity({
            projectRoot: input.projectRoot,
            fromUserId: previousUserId,
            toUserId: nextUserId,
          });
        } catch {
          // Best-effort migration: preserve runtime availability even if merge/rename fails.
        }
      }
    }
  }

  const userIdResolution = !effectiveConfig.projectMemoryEnabled
    ? { userId: null, source: "unresolved" as const }
    : initialUserIdResolution;

  if (effectiveConfig.projectMemoryEnabled && !userIdResolution.userId) {
    throw new Error(
      "Project memory is enabled, but no userId could be resolved. " +
      "Set PI_MEMORY_USER_ID, configure myUserId, or run '/memory project user set <user>'.",
    );
  }

  const storePaths = resolveProjectMemoryStorePaths({
    projectRoot: input.projectRoot,
    config: effectiveConfig,
    userId: userIdResolution.userId ?? undefined,
    env: input.env,
  });

  if (effectiveConfig.projectMemoryEnabled) {
    try {
      const identityIsRandomLocal = effectiveConfig.identity?.isRandomLocal === true
        || userIdResolution.source === "random-local";

      await ensureProjectMemoryLocalGitignore({
        projectRoot: input.projectRoot,
        userId: userIdResolution.userId,
        allowUserDatabaseCommit: !identityIsRandomLocal,
      });
    } catch {
      // Best-effort only: local ignore generation must not block runtime bootstrap.
    }
  }

  return {
    config: effectiveConfig,
    userId: userIdResolution.userId,
    userIdSource: userIdResolution.source,
    storePaths,
  };
};
