/**
 * File intent: maintain the derived project-memory index/cache database.
 *
 * This file owns cache schema bootstrap, source fingerprinting, deterministic
 * rebuilds from member DBs, index readiness checks, and indexed search across
 * memory plus continuity rows. The index is derived state only; canonical
 * project/user data remains in the per-user DBs read by fan-out retrieval.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  type BetterSqliteDatabase,
  openBetterSqliteDatabase,
} from "../common/better-sqlite3-adapter.js";
import { discoverProjectUserDatabases } from "./fanout-retrieval.js";
import type { FanoutSearchHit } from "./fanout-retrieval.js";
import { deriveParallelEvidenceMarker } from "../../../project-index/parallel-evidence.js";

/**
 * Current L2 cache DB filename under `${PROJECT}/.agent/memory`.
 */
export const PROJECT_INDEX_DATABASE_FILENAME = "cache.db";

/**
 * Legacy L2 DB filename kept only for migration compatibility checks.
 */
export const LEGACY_PROJECT_INDEX_DATABASE_FILENAME = "project.db";

/**
 * Schema version marker persisted in cache metadata.
 */
export const PROJECT_INDEX_SCHEMA_VERSION = 2;

/**
 * One memory row materialized from user DB `memories` table.
 */
interface IndexedMemoryRow {
  id: string;
  content: string;
  topic: string;
  source: string;
  timestamp: string;
}

/**
 * One continuity row materialized from user DB `continuity_entries` table.
 */
interface IndexedContinuityRow {
  id: string;
  content: string;
  timestamp: string;
  sectionCode: string;
  provenanceCode: string;
}

/**
 * Deterministic source-signature row used for cache invalidation/rebuild checks.
 */
export interface ProjectIndexSourceFingerprintRow {
  userId: string;
  databasePath: string;
  memoryCount: number;
  memoryLatestTimestamp: string | null;
  continuityCount: number;
  continuityLatestTimestamp: string | null;
}

/**
 * Source-fingerprint envelope for one active cache owner.
 */
export interface ProjectIndexSourceFingerprint {
  ownerUserId: string;
  sourceDatabaseCount: number;
  digest: string;
  rows: ProjectIndexSourceFingerprintRow[];
  errors: Array<{ databasePath: string; error: string }>;
}

/**
 * Index status values persisted in metadata table.
 */
export type ProjectIndexBuildStatus =
  | "missing"
  | "uninitialized"
  | "ready"
  | "partial"
  | "no-sources"
  | "error";

/**
 * Current project index metadata snapshot.
 */
export interface ProjectIndexStatus {
  indexDatabasePath: string;
  status: ProjectIndexBuildStatus;
  lastRebuildAt: string | null;
  sourceDatabaseCount: number;
  indexedRowCount: number;
  indexedMemoryRowCount: number;
  indexedContinuityRowCount: number;
  parallelEvidenceGroupCount: number;
  ownerUserId: string | null;
  sourceFingerprint: string | null;
  schemaVersion: number;
  lastDurationMs: number | null;
  lastError: string | null;
}

/**
 * Rebuild result envelope for project index.
 */
export interface ProjectIndexRebuildResult extends ProjectIndexStatus {
  startedAt: string;
  finishedAt: string;
  errors: Array<{ databasePath: string; error: string }>;
}

/**
 * Input for querying the derived project index database.
 */
export interface ProjectIndexSearchInput {
  projectMemoryDir: string;
  query: string;
  topK?: number;
  /** Active cache owner used to isolate member-local L2 rows. */
  activeUserId?: string;
}

/**
 * Project-index lexical search result envelope.
 */
export interface ProjectIndexSearchResult {
  query: string;
  indexDatabasePath: string;
  indexStatus: ProjectIndexBuildStatus;
  indexReady: boolean;
  sourceDatabaseCount: number;
  ownerUserId: string | null;
  results: FanoutSearchHit[];
  error: string | null;
}

/**
 * Resolve project index DB path from project-memory dir.
 */
export const resolveProjectIndexDatabasePath = (projectMemoryDir: string): string =>
  path.join(projectMemoryDir, PROJECT_INDEX_DATABASE_FILENAME);

/**
 * Resolve legacy project index DB path (`project.db`).
 */
export const resolveLegacyProjectIndexDatabasePath = (projectMemoryDir: string): string =>
  path.join(projectMemoryDir, LEGACY_PROJECT_INDEX_DATABASE_FILENAME);

/**
 * Normalize one lexical query token.
 *
 * Decision:
 * - strip wrapping quote-like punctuation so phrase-style queries
 *   like `"preferred project stack"` map to stable lexical tokens.
 */
const normalizeQueryToken = (token: string): string =>
  token
    .trim()
    .toLowerCase()
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "");

/**
 * Parse and normalize query terms for lexical matching.
 */
const parseQueryTerms = (query: string): string[] =>
  query
    .trim()
    .split(/\s+/)
    .map(normalizeQueryToken)
    .filter((token) => token.length > 0);

/**
 * Count query term matches in content/topic text.
 */
const countTermMatches = (terms: string[], content: string, topic: string): number => {
  if (terms.length === 0) {
    return 0;
  }

  const haystack = `${content}\n${topic}`.toLowerCase();
  return terms.reduce((acc, term) => acc + (haystack.includes(term) ? 1 : 0), 0);
};

/**
 * Normalize SQLite COUNT results into safe non-negative integers.
 */
const normalizeSqliteCountValue = (value: unknown): number => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  }

  if (typeof value === "bigint") {
    const safe = value > BigInt(Number.MAX_SAFE_INTEGER)
      ? BigInt(Number.MAX_SAFE_INTEGER)
      : value;

    return Number(safe);
  }

  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
  }

  return 0;
};

/**
 * Ensure one table column exists (additive migration only).
 */
const ensureTableColumn = (input: {
  db: BetterSqliteDatabase;
  tableName: string;
  columnName: string;
  definition: string;
}): void => {
  const rows = input.db.prepare(`PRAGMA table_info(${input.tableName})`).all();

  const hasColumn = rows.some((row) => row.name === input.columnName);
  if (hasColumn) {
    return;
  }

  input.db.exec(`ALTER TABLE ${input.tableName} ADD COLUMN ${input.definition}`);
};

/**
 * Check whether one table exists in current DB.
 */
const tableExists = (input: {
  db: BetterSqliteDatabase;
  tableName: string;
}): boolean => {
  const row = input.db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type='table' AND name=?
  `).get(input.tableName);

  return !!row;
};

/**
 * Decode compact continuity section code into readable label.
 */
const decodeContinuitySectionCode = (code: unknown): string => {
  switch (code) {
    case "P":
      return "plans";
    case "D":
      return "decisions";
    case "R":
      return "progress";
    case "X":
      return "discoveries";
    case "O":
      return "outcomes";
    default:
      return "unknown";
  }
};

/**
 * Decode compact continuity provenance code into readable label.
 */
const decodeContinuityProvenanceCode = (code: unknown): string => {
  switch (code) {
    case "U":
      return "user";
    case "C":
      return "code";
    case "T":
      return "tool";
    case "A":
      return "assumption";
    default:
      return "unknown";
  }
};

/**
 * Ensure index schema exists and additive migration columns are present.
 */
const ensureIndexSchema = (db: BetterSqliteDatabase): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS indexed_memories (
      owner_user_id TEXT NOT NULL DEFAULT 'default-owner',
      user_id TEXT NOT NULL,
      source_db TEXT NOT NULL,
      id TEXT NOT NULL,
      record_kind TEXT NOT NULL DEFAULT 'memory',
      content TEXT NOT NULL,
      topic TEXT NOT NULL,
      source TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      subject_hint_key TEXT,
      group_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_indexed_memories_owner_timestamp
      ON indexed_memories(owner_user_id, timestamp DESC);

    CREATE INDEX IF NOT EXISTS idx_indexed_memories_owner_topic
      ON indexed_memories(owner_user_id, topic);

    CREATE INDEX IF NOT EXISTS idx_indexed_memories_owner_group
      ON indexed_memories(owner_user_id, group_id);

    CREATE TABLE IF NOT EXISTS index_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_rebuild_at TEXT,
      source_db_count INTEGER NOT NULL DEFAULT 0,
      indexed_row_count INTEGER NOT NULL DEFAULT 0,
      indexed_memory_row_count INTEGER NOT NULL DEFAULT 0,
      indexed_continuity_row_count INTEGER NOT NULL DEFAULT 0,
      parallel_group_count INTEGER NOT NULL DEFAULT 0,
      owner_user_id TEXT,
      source_fingerprint TEXT,
      schema_version INTEGER NOT NULL DEFAULT 2,
      last_duration_ms INTEGER,
      last_status TEXT NOT NULL DEFAULT 'uninitialized',
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS l2_parallel_evidence_markers (
      owner_user_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      subject_hint_key TEXT NOT NULL,
      distinct_user_count INTEGER NOT NULL,
      row_count INTEGER NOT NULL,
      latest_timestamp TEXT NOT NULL,
      PRIMARY KEY (owner_user_id, group_id)
    );

    CREATE INDEX IF NOT EXISTS idx_l2_parallel_markers_owner
      ON l2_parallel_evidence_markers(owner_user_id);
  `);

  // Additive migration coverage for older schema snapshots.
  ensureTableColumn({
    db,
    tableName: "indexed_memories",
    columnName: "owner_user_id",
    definition: "owner_user_id TEXT NOT NULL DEFAULT 'default-owner'",
  });
  ensureTableColumn({
    db,
    tableName: "indexed_memories",
    columnName: "record_kind",
    definition: "record_kind TEXT NOT NULL DEFAULT 'memory'",
  });
  ensureTableColumn({
    db,
    tableName: "indexed_memories",
    columnName: "subject_hint_key",
    definition: "subject_hint_key TEXT",
  });
  ensureTableColumn({
    db,
    tableName: "indexed_memories",
    columnName: "group_id",
    definition: "group_id TEXT",
  });

  ensureTableColumn({
    db,
    tableName: "index_meta",
    columnName: "indexed_memory_row_count",
    definition: "indexed_memory_row_count INTEGER NOT NULL DEFAULT 0",
  });
  ensureTableColumn({
    db,
    tableName: "index_meta",
    columnName: "indexed_continuity_row_count",
    definition: "indexed_continuity_row_count INTEGER NOT NULL DEFAULT 0",
  });
  ensureTableColumn({
    db,
    tableName: "index_meta",
    columnName: "parallel_group_count",
    definition: "parallel_group_count INTEGER NOT NULL DEFAULT 0",
  });
  ensureTableColumn({
    db,
    tableName: "index_meta",
    columnName: "owner_user_id",
    definition: "owner_user_id TEXT",
  });
  ensureTableColumn({
    db,
    tableName: "index_meta",
    columnName: "source_fingerprint",
    definition: "source_fingerprint TEXT",
  });
  ensureTableColumn({
    db,
    tableName: "index_meta",
    columnName: "schema_version",
    definition: "schema_version INTEGER NOT NULL DEFAULT 2",
  });
};

/**
 * Read all memory rows from one user DB.
 */
const readUserMemoryRows = (databasePath: string): IndexedMemoryRow[] => {
  const db = openBetterSqliteDatabase(databasePath, {
    readOnly: true,
    fileMustExist: true,
  });

  try {
    if (!tableExists({ db, tableName: "memories" })) {
      return [];
    }

    const rows = db.prepare(`
      SELECT id, content, topic, source, timestamp
      FROM memories
      ORDER BY timestamp DESC
    `).all() as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: typeof row.id === "string" ? row.id : "unknown-id",
      content: typeof row.content === "string" ? row.content : "",
      topic: typeof row.topic === "string" ? row.topic : "general",
      source: typeof row.source === "string" ? row.source : "unknown",
      timestamp: typeof row.timestamp === "string" ? row.timestamp : "",
    }));
  } finally {
    db.close();
  }
};

/**
 * Read all continuity rows from one user DB when continuity table exists.
 */
const readUserContinuityRows = (databasePath: string): IndexedContinuityRow[] => {
  const db = openBetterSqliteDatabase(databasePath, {
    readOnly: true,
    fileMustExist: true,
  });

  try {
    if (!tableExists({ db, tableName: "continuity_entries" })) {
      return [];
    }

    const rows = db.prepare(`
      SELECT id, content, timestamp, section_code, provenance_code
      FROM continuity_entries
      ORDER BY timestamp DESC
    `).all() as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: typeof row.id === "string" ? row.id : "unknown-id",
      content: typeof row.content === "string" ? row.content : "",
      timestamp: typeof row.timestamp === "string" ? row.timestamp : "",
      sectionCode: typeof row.section_code === "string" ? row.section_code : "",
      provenanceCode: typeof row.provenance_code === "string" ? row.provenance_code : "",
    }));
  } finally {
    db.close();
  }
};

/**
 * Read memory + continuity aggregate counters for one user DB.
 */
const readFingerprintRow = (databasePath: string): ProjectIndexSourceFingerprintRow => {
  const db = openBetterSqliteDatabase(databasePath, {
    readOnly: true,
    fileMustExist: true,
  });

  try {
    const userId = path.basename(databasePath, ".db");

    const memoryAggregate = tableExists({ db, tableName: "memories" })
      ? db.prepare(`
        SELECT COUNT(*) AS total, MAX(timestamp) AS latest
        FROM memories
      `).get()
      : undefined;

    const continuityAggregate = tableExists({ db, tableName: "continuity_entries" })
      ? db.prepare(`
        SELECT COUNT(*) AS total, MAX(timestamp) AS latest
        FROM continuity_entries
      `).get()
      : undefined;

    return {
      userId,
      databasePath,
      memoryCount: normalizeSqliteCountValue(memoryAggregate?.total),
      memoryLatestTimestamp: typeof memoryAggregate?.latest === "string" ? memoryAggregate.latest : null,
      continuityCount: normalizeSqliteCountValue(continuityAggregate?.total),
      continuityLatestTimestamp: typeof continuityAggregate?.latest === "string" ? continuityAggregate.latest : null,
    };
  } finally {
    db.close();
  }
};

/**
 * Compute deterministic source fingerprint for cache invalidation/rebuild checks.
 */
export const computeProjectIndexSourceFingerprint = async (input: {
  projectMemoryDir: string;
  activeUserId?: string;
}): Promise<ProjectIndexSourceFingerprint> => {
  const ownerUserId = input.activeUserId?.trim() || "default-owner";
  const databasePaths = await discoverProjectUserDatabases(input.projectMemoryDir);

  const rows: ProjectIndexSourceFingerprintRow[] = [];
  const errors: Array<{ databasePath: string; error: string }> = [];

  for (const databasePath of databasePaths) {
    try {
      rows.push(readFingerprintRow(databasePath));
    } catch (error: unknown) {
      errors.push({
        databasePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  rows.sort((left, right) => left.databasePath.localeCompare(right.databasePath));

  const digestPayload = [
    `schema=${PROJECT_INDEX_SCHEMA_VERSION}`,
    `owner=${ownerUserId}`,
    ...rows.map((row) => [
      row.userId,
      row.databasePath,
      `m=${row.memoryCount}`,
      `mt=${row.memoryLatestTimestamp || ""}`,
      `c=${row.continuityCount}`,
      `ct=${row.continuityLatestTimestamp || ""}`,
    ].join("|")),
    ...errors
      .sort((left, right) => left.databasePath.localeCompare(right.databasePath))
      .map((errorRow) => `err=${errorRow.databasePath}|${errorRow.error}`),
  ].join("||");

  const digest = createHash("sha1")
    .update(digestPayload, "utf-8")
    .digest("hex");

  return {
    ownerUserId,
    sourceDatabaseCount: databasePaths.length,
    digest,
    rows,
    errors,
  };
};

/**
 * Read persisted project index status metadata.
 */
export const readProjectIndexStatus = async (input: {
  projectMemoryDir: string;
}): Promise<ProjectIndexStatus> => {
  const indexDatabasePath = resolveProjectIndexDatabasePath(input.projectMemoryDir);

  if (!existsSync(indexDatabasePath)) {
    return {
      indexDatabasePath,
      status: "missing",
      lastRebuildAt: null,
      sourceDatabaseCount: 0,
      indexedRowCount: 0,
      indexedMemoryRowCount: 0,
      indexedContinuityRowCount: 0,
      parallelEvidenceGroupCount: 0,
      ownerUserId: null,
      sourceFingerprint: null,
      schemaVersion: PROJECT_INDEX_SCHEMA_VERSION,
      lastDurationMs: null,
      lastError: null,
    };
  }

  const db = openBetterSqliteDatabase(indexDatabasePath, {
    readOnly: true,
    fileMustExist: true,
  });

  try {
    const row = db.prepare(`
      SELECT
        last_rebuild_at,
        source_db_count,
        indexed_row_count,
        indexed_memory_row_count,
        indexed_continuity_row_count,
        parallel_group_count,
        owner_user_id,
        source_fingerprint,
        schema_version,
        last_duration_ms,
        last_status,
        last_error
      FROM index_meta
      WHERE id = 1
    `).get();

    if (!row) {
      return {
        indexDatabasePath,
        status: "uninitialized",
        lastRebuildAt: null,
        sourceDatabaseCount: 0,
        indexedRowCount: 0,
        indexedMemoryRowCount: 0,
        indexedContinuityRowCount: 0,
        parallelEvidenceGroupCount: 0,
        ownerUserId: null,
        sourceFingerprint: null,
        schemaVersion: PROJECT_INDEX_SCHEMA_VERSION,
        lastDurationMs: null,
        lastError: null,
      };
    }

    const status = typeof row.last_status === "string"
      ? row.last_status
      : "uninitialized";

    return {
      indexDatabasePath,
      status: ["ready", "partial", "no-sources", "error", "uninitialized"].includes(status)
        ? (status as ProjectIndexBuildStatus)
        : "error",
      lastRebuildAt: typeof row.last_rebuild_at === "string" ? row.last_rebuild_at : null,
      sourceDatabaseCount: normalizeSqliteCountValue(row.source_db_count),
      indexedRowCount: normalizeSqliteCountValue(row.indexed_row_count),
      indexedMemoryRowCount: normalizeSqliteCountValue(row.indexed_memory_row_count),
      indexedContinuityRowCount: normalizeSqliteCountValue(row.indexed_continuity_row_count),
      parallelEvidenceGroupCount: normalizeSqliteCountValue(row.parallel_group_count),
      ownerUserId: typeof row.owner_user_id === "string" ? row.owner_user_id : null,
      sourceFingerprint: typeof row.source_fingerprint === "string" ? row.source_fingerprint : null,
      schemaVersion: typeof row.schema_version === "number"
        ? row.schema_version
        : PROJECT_INDEX_SCHEMA_VERSION,
      lastDurationMs: typeof row.last_duration_ms === "number" ? row.last_duration_ms : null,
      lastError: typeof row.last_error === "string" ? row.last_error : null,
    };
  } finally {
    db.close();
  }
};

/**
 * Query the derived project index DB using lexical term matching.
 */
export const searchProjectIndex = async (
  input: ProjectIndexSearchInput,
): Promise<ProjectIndexSearchResult> => {
  const topK = Math.max(1, Math.min(input.topK ?? 20, 200));
  const status = await readProjectIndexStatus({ projectMemoryDir: input.projectMemoryDir });

  const indexReady = status.status === "ready" || status.status === "partial";
  if (!indexReady) {
    return {
      query: input.query,
      indexDatabasePath: status.indexDatabasePath,
      indexStatus: status.status,
      indexReady: false,
      sourceDatabaseCount: status.sourceDatabaseCount,
      ownerUserId: status.ownerUserId,
      results: [],
      error: status.lastError,
    };
  }

  const ownerUserId = input.activeUserId?.trim() || status.ownerUserId || "default-owner";
  if (status.ownerUserId && input.activeUserId && status.ownerUserId !== input.activeUserId) {
    return {
      query: input.query,
      indexDatabasePath: status.indexDatabasePath,
      indexStatus: "error",
      indexReady: false,
      sourceDatabaseCount: status.sourceDatabaseCount,
      ownerUserId: status.ownerUserId,
      results: [],
      error: `index cache owner mismatch (cache=${status.ownerUserId}, active=${input.activeUserId})`,
    };
  }

  const db = openBetterSqliteDatabase(status.indexDatabasePath, {
    readOnly: true,
    fileMustExist: true,
  });

  try {
    const terms = parseQueryTerms(input.query);

    let sql = `
      SELECT user_id, source_db, id, record_kind, content, topic, source, timestamp, subject_hint_key, group_id
      FROM indexed_memories
      WHERE owner_user_id = ?
    `;

    const params: Array<string | number> = [ownerUserId];

    if (terms.length > 0) {
      const whereClauses: string[] = [];
      for (const term of terms) {
        whereClauses.push("(content LIKE ? OR topic LIKE ?)");
        const pattern = `%${term}%`;
        params.push(pattern, pattern);
      }
      sql += ` AND (${whereClauses.join(" OR ")})`;
    }

    sql += " ORDER BY timestamp DESC LIMIT ?";
    // Fetch wider lexical candidate set, then rerank by term count.
    params.push(Math.max(topK * 3, topK));

    const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

    const hits: FanoutSearchHit[] = rows.map((row) => {
      const content = typeof row.content === "string" ? row.content : "";
      const topic = typeof row.topic === "string" ? row.topic : "general";

      return {
        userId: typeof row.user_id === "string" ? row.user_id : "unknown-user",
        databasePath: typeof row.source_db === "string" ? row.source_db : status.indexDatabasePath,
        id: typeof row.id === "string" ? row.id : "unknown-id",
        kind: row.record_kind === "continuity" ? "continuity" : "memory",
        content,
        topic,
        source: typeof row.source === "string" ? row.source : "unknown",
        timestamp: typeof row.timestamp === "string" ? row.timestamp : "",
        subjectHintKey: typeof row.subject_hint_key === "string" ? row.subject_hint_key : null,
        groupId: typeof row.group_id === "string" ? row.group_id : null,
        termMatches: countTermMatches(terms, content, topic),
      };
    });

    hits.sort((left, right) => {
      if (right.termMatches !== left.termMatches) {
        return right.termMatches - left.termMatches;
      }
      return right.timestamp.localeCompare(left.timestamp);
    });

    return {
      query: input.query,
      indexDatabasePath: status.indexDatabasePath,
      indexStatus: status.status,
      indexReady: true,
      sourceDatabaseCount: status.sourceDatabaseCount,
      ownerUserId,
      results: hits.slice(0, topK),
      error: null,
    };
  } catch (error: unknown) {
    return {
      query: input.query,
      indexDatabasePath: status.indexDatabasePath,
      indexStatus: "error",
      indexReady: false,
      sourceDatabaseCount: status.sourceDatabaseCount,
      ownerUserId,
      results: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db.close();
  }
};

/**
 * Rebuild project index from all discovered user DB files.
 */
export const rebuildProjectIndex = async (input: {
  projectMemoryDir: string;
  activeUserId?: string;
}): Promise<ProjectIndexRebuildResult> => {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();

  await mkdir(input.projectMemoryDir, { recursive: true });

  const fingerprint = await computeProjectIndexSourceFingerprint({
    projectMemoryDir: input.projectMemoryDir,
    activeUserId: input.activeUserId,
  });

  const ownerUserId = fingerprint.ownerUserId;
  const indexDatabasePath = resolveProjectIndexDatabasePath(input.projectMemoryDir);

  const db = openBetterSqliteDatabase(indexDatabasePath);

  const errors: Array<{ databasePath: string; error: string }> = [...fingerprint.errors];
  let indexedMemoryRowCount = 0;
  let indexedContinuityRowCount = 0;

  try {
    ensureIndexSchema(db);

    db.prepare("DELETE FROM indexed_memories WHERE owner_user_id = ?").run(ownerUserId);
    db.prepare("DELETE FROM l2_parallel_evidence_markers WHERE owner_user_id = ?").run(ownerUserId);

    const insertRow = db.prepare(`
      INSERT INTO indexed_memories (
        owner_user_id,
        user_id,
        source_db,
        id,
        record_kind,
        content,
        topic,
        source,
        timestamp,
        subject_hint_key,
        group_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const sourceRow of fingerprint.rows) {
      try {
        const memoryRows = readUserMemoryRows(sourceRow.databasePath);

        for (const row of memoryRows) {
          const marker = deriveParallelEvidenceMarker({
            content: row.content,
            topic: row.topic,
          });

          insertRow.run(
            ownerUserId,
            sourceRow.userId,
            sourceRow.databasePath,
            row.id,
            "memory",
            row.content,
            row.topic,
            row.source,
            row.timestamp,
            marker.subjectHintKey,
            marker.groupId,
          );

          indexedMemoryRowCount += 1;
        }

        const continuityRows = readUserContinuityRows(sourceRow.databasePath);
        for (const row of continuityRows) {
          const topic = `continuity/${decodeContinuitySectionCode(row.sectionCode)}`;
          const source = `continuity::${decodeContinuityProvenanceCode(row.provenanceCode)}`;
          const marker = deriveParallelEvidenceMarker({
            content: row.content,
            topic,
          });

          insertRow.run(
            ownerUserId,
            sourceRow.userId,
            sourceRow.databasePath,
            `cont:${row.id}`,
            "continuity",
            row.content,
            topic,
            source,
            row.timestamp,
            marker.subjectHintKey,
            marker.groupId,
          );

          indexedContinuityRowCount += 1;
        }
      } catch (error: unknown) {
        errors.push({
          databasePath: sourceRow.databasePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const groupedParallelRows = db.prepare(`
      SELECT
        group_id,
        subject_hint_key,
        COUNT(*) AS row_count,
        COUNT(DISTINCT user_id) AS distinct_user_count,
        MAX(timestamp) AS latest_timestamp
      FROM indexed_memories
      WHERE owner_user_id = ?
        AND group_id IS NOT NULL
      GROUP BY group_id, subject_hint_key
      HAVING COUNT(DISTINCT user_id) >= 2
    `).all(ownerUserId) as Array<Record<string, unknown>>;

    const insertParallelMarker = db.prepare(`
      INSERT INTO l2_parallel_evidence_markers (
        owner_user_id,
        group_id,
        subject_hint_key,
        distinct_user_count,
        row_count,
        latest_timestamp
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const markerRow of groupedParallelRows) {
      if (typeof markerRow.group_id !== "string" || typeof markerRow.subject_hint_key !== "string") {
        continue;
      }

      insertParallelMarker.run(
        ownerUserId,
        markerRow.group_id,
        markerRow.subject_hint_key,
        normalizeSqliteCountValue(markerRow.distinct_user_count),
        normalizeSqliteCountValue(markerRow.row_count),
        typeof markerRow.latest_timestamp === "string" ? markerRow.latest_timestamp : "",
      );
    }

    const durationMs = Date.now() - startedMs;
    const finishedAt = new Date().toISOString();

    const sourceDatabaseCount = fingerprint.sourceDatabaseCount;
    const indexedRowCount = indexedMemoryRowCount + indexedContinuityRowCount;

    const finalStatus: ProjectIndexBuildStatus =
      sourceDatabaseCount === 0
        ? "no-sources"
        : errors.length > 0
          ? "partial"
          : "ready";

    db.prepare(`
      INSERT INTO index_meta (
        id,
        last_rebuild_at,
        source_db_count,
        indexed_row_count,
        indexed_memory_row_count,
        indexed_continuity_row_count,
        parallel_group_count,
        owner_user_id,
        source_fingerprint,
        schema_version,
        last_duration_ms,
        last_status,
        last_error
      )
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        last_rebuild_at = excluded.last_rebuild_at,
        source_db_count = excluded.source_db_count,
        indexed_row_count = excluded.indexed_row_count,
        indexed_memory_row_count = excluded.indexed_memory_row_count,
        indexed_continuity_row_count = excluded.indexed_continuity_row_count,
        parallel_group_count = excluded.parallel_group_count,
        owner_user_id = excluded.owner_user_id,
        source_fingerprint = excluded.source_fingerprint,
        schema_version = excluded.schema_version,
        last_duration_ms = excluded.last_duration_ms,
        last_status = excluded.last_status,
        last_error = excluded.last_error
    `).run(
      finishedAt,
      sourceDatabaseCount,
      indexedRowCount,
      indexedMemoryRowCount,
      indexedContinuityRowCount,
      groupedParallelRows.length,
      ownerUserId,
      fingerprint.digest,
      PROJECT_INDEX_SCHEMA_VERSION,
      durationMs,
      finalStatus,
      errors.length > 0 ? errors[0].error : null,
    );

    return {
      indexDatabasePath,
      status: finalStatus,
      lastRebuildAt: finishedAt,
      sourceDatabaseCount,
      indexedRowCount,
      indexedMemoryRowCount,
      indexedContinuityRowCount,
      parallelEvidenceGroupCount: groupedParallelRows.length,
      ownerUserId,
      sourceFingerprint: fingerprint.digest,
      schemaVersion: PROJECT_INDEX_SCHEMA_VERSION,
      lastDurationMs: durationMs,
      lastError: errors.length > 0 ? errors[0].error : null,
      startedAt,
      finishedAt,
      errors,
    };
  } catch (error: unknown) {
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - startedMs;
    const message = error instanceof Error ? error.message : String(error);

    return {
      indexDatabasePath,
      status: "error",
      lastRebuildAt: finishedAt,
      sourceDatabaseCount: fingerprint.sourceDatabaseCount,
      indexedRowCount: indexedMemoryRowCount + indexedContinuityRowCount,
      indexedMemoryRowCount,
      indexedContinuityRowCount,
      parallelEvidenceGroupCount: 0,
      ownerUserId,
      sourceFingerprint: fingerprint.digest,
      schemaVersion: PROJECT_INDEX_SCHEMA_VERSION,
      lastDurationMs: durationMs,
      lastError: message,
      startedAt,
      finishedAt,
      errors: [
        ...errors,
        {
          databasePath: indexDatabasePath,
          error: message,
        },
      ],
    };
  } finally {
    db.close();
  }
};
