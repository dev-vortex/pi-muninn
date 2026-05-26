/**
 * File intent: vendored project-user MemoryStore bridge for L1 project memory.
 *
 * Project-curation writes must go through the vendored MemoryStore. This module
 * owns lazy loading, schema compatibility checks, and per-database store caching.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ensureSqliteTableColumn as ensureBetterSqliteTableColumn,
  openBetterSqliteDatabase,
  readSqliteTableColumns as readBetterSqliteTableColumns,
  sqliteTableExists,
} from "../../memory-data-adapters/sqlite/common/better-sqlite3-adapter.js";

export interface ProjectUserVendorStoreLike {
  load: () => void;
  store: (input: {
    content: string;
    project?: string;
    topic?: string;
    source?: string;
    timestamp?: string;
    session_id?: string;
    importance?: number;
  }) => Promise<{ status: string; id: string }>;
  search?: (
    query: string,
    options?: { project?: string; topic?: string; n_results?: number },
  ) => Promise<{ results: Array<{ id: string; text: string; project?: string; topic?: string; source?: string; timestamp?: string; similarity?: number }> }>;
  recall?: (
    options?: { project?: string; topic?: string; n_results?: number },
  ) => { results: Array<{ id: string; text: string; project?: string; topic?: string; source?: string; timestamp?: string; similarity?: number }> };
}

const PROJECT_USER_VENDOR_STORE_BY_DB_PATH = new Map<string, ProjectUserVendorStoreLike>();
let projectUserVendorStoreCtor: (new (projectUserDatabasePath: string) => ProjectUserVendorStoreLike) | null = null;
let projectUserVendorStoreLoadError: string | null = null;

const resolveVendoredMemoryStoreUrl = (): string => {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const sourceGraphPackageRoot = path.resolve(moduleDir, "../../../");
  const sourceGraphMemoryStoreTs = path.join(
    sourceGraphPackageRoot,
    "vendor",
    "pi-mempalace",
    "extensions",
    "pi-mempalace",
    "memory_store.ts",
  );
  const candidates = [
    path.resolve(moduleDir, "../vendor/pi-mempalace/memory_store.js"),
    path.resolve(moduleDir, "vendor/pi-mempalace/memory_store.js"),
    // TS source-graph packages ship the vendored upstream files as original TS.
    ...(!existsSync(path.join(sourceGraphPackageRoot, ".git")) ? [sourceGraphMemoryStoreTs] : []),
    path.resolve(moduleDir, "../../../vendor/pi-mempalace/extensions/pi-mempalace/memory_store.js"),
  ];

  const resolved = candidates.find((candidate) => existsSync(candidate)) ?? candidates.at(-1)!;
  return pathToFileURL(resolved).href;
};

/**
 * Vendor-compatible short content hash used for legacy L1 backfill rows.
 */
export const hashMemoryContent = (content: string): string =>
  createHash("sha256")
    .update(content, "utf-8")
    .digest("hex")
    .slice(0, 16);

/**
 * Ensure existing project-user `memories` table is vendor-compatible for L1.
 *
 * Dev-cutover note:
 * - uses additive column/index migration only,
 * - no historical backfill guarantees required beyond hash defaults.
 */
export const ensureVendorCompatibleProjectUserMemorySchema = (databasePath: string): void => {
  mkdirSync(path.dirname(databasePath), { recursive: true });

  // Let vendored MemoryStore create the canonical schema for clean first-use DBs.
  // Only existing DBs need additive compatibility checks before vendor load.
  if (!existsSync(databasePath)) {
    return;
  }

  const db = openBetterSqliteDatabase(databasePath);

  try {
    if (!sqliteTableExists({ db, tableName: "memories" })) {
      return;
    }

    const columns = new Set(readBetterSqliteTableColumns({
      db,
      tableName: "memories",
    }));

    ensureBetterSqliteTableColumn({
      db,
      tableName: "memories",
      existingColumns: columns,
      columnName: "content_hash",
      definitionSql: "content_hash TEXT",
    });
    ensureBetterSqliteTableColumn({
      db,
      tableName: "memories",
      existingColumns: columns,
      columnName: "project",
      definitionSql: "project TEXT NOT NULL DEFAULT 'general'",
    });
    ensureBetterSqliteTableColumn({
      db,
      tableName: "memories",
      existingColumns: columns,
      columnName: "session_id",
      definitionSql: "session_id TEXT NOT NULL DEFAULT ''",
    });
    ensureBetterSqliteTableColumn({
      db,
      tableName: "memories",
      existingColumns: columns,
      columnName: "importance",
      definitionSql: "importance REAL DEFAULT 0.5",
    });
    ensureBetterSqliteTableColumn({
      db,
      tableName: "memories",
      existingColumns: columns,
      columnName: "chunk_index",
      definitionSql: "chunk_index INTEGER DEFAULT 0",
    });
    ensureBetterSqliteTableColumn({
      db,
      tableName: "memories",
      existingColumns: columns,
      columnName: "parent_id",
      definitionSql: "parent_id TEXT DEFAULT NULL",
    });

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
      CREATE INDEX IF NOT EXISTS idx_memories_topic ON memories(topic);
      CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp);
      CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash);
    `);

    const rows = db.prepare(`
      SELECT rowid, content
      FROM memories
      WHERE content_hash IS NULL OR trim(content_hash) = ''
      LIMIT 5000
    `).all();

    const updateStmt = db.prepare(`
      UPDATE memories
      SET content_hash = ?
      WHERE rowid = ?
    `);

    for (const row of rows) {
      const content = typeof row.content === "string" ? row.content : "";
      const hash = hashMemoryContent(content);
      updateStmt.run(hash, typeof row.rowid === "number" ? row.rowid : Number(row.rowid || 0));
    }
  } finally {
    db.close();
  }
};

/**
 * Resolve cached vendor-backed L1 store for one project-user DB.
 *
 * NOTE:
 * - lazy-load vendor MemoryStore to avoid hard extension-load dependency on
 *   `better-sqlite3` in environments where upstream compatibility is present
 *   but optional native modules are unavailable.
 */
export const resolveProjectUserVendorStore = async (projectUserDatabasePath: string): Promise<
  { ok: true; store: ProjectUserVendorStoreLike }
  | { ok: false; error: string }
> => {
  const cached = PROJECT_USER_VENDOR_STORE_BY_DB_PATH.get(projectUserDatabasePath);
  if (cached) {
    return { ok: true, store: cached };
  }

  if (!projectUserVendorStoreCtor && !projectUserVendorStoreLoadError) {
    try {
      const module = await import(resolveVendoredMemoryStoreUrl());
      const UpstreamMemoryStore = (module as { MemoryStore?: unknown }).MemoryStore;

      if (typeof UpstreamMemoryStore !== "function") {
        throw new Error("MemoryStore export not found in vendored upstream memory_store module");
      }

      projectUserVendorStoreCtor = class extends (UpstreamMemoryStore as new (memoryDir?: string) => ProjectUserVendorStoreLike) {
        private readonly projectUserDatabasePath: string;

        constructor(projectUserDatabasePath: string) {
          super(path.dirname(projectUserDatabasePath));
          this.projectUserDatabasePath = projectUserDatabasePath;
        }

        get dbPath(): string {
          return this.projectUserDatabasePath;
        }
      };
    } catch (error: unknown) {
      projectUserVendorStoreLoadError = error instanceof Error
        ? error.message
        : String(error);
    }
  }

  if (!projectUserVendorStoreCtor) {
    return {
      ok: false,
      error: projectUserVendorStoreLoadError || "vendor project memory store unavailable",
    };
  }

  try {
    const store = new projectUserVendorStoreCtor(projectUserDatabasePath);
    PROJECT_USER_VENDOR_STORE_BY_DB_PATH.set(projectUserDatabasePath, store);

    return {
      ok: true,
      store,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

/**
 * Resolve user home directory with upstream-compatible fallback semantics.
 */
