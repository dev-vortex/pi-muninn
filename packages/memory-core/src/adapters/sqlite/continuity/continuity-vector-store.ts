/**
 * File intent: maintain the optional semantic index for continuity entries.
 *
 * This file holds sqlite-vec schema/bootstrap, fallback embedding storage,
 * backfill/status tracking, and vector search that maps semantic hits back to
 * canonical continuity entry ids. Persistence of the actual continuity records
 * remains in `continuity-store.ts`; this file only manages derived vector data.
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { readContinuityEntries } from "./continuity-store.js";
import {
  buildContinuityVectorEmbeddingText,
  CONTINUITY_VECTOR_EMBEDDING_DIMENSION,
  type ContinuityVectorEmbedder,
} from "./continuity-vector-embedder.js";

/**
 * Virtual-table name used for continuity vector index storage.
 */
export const CONTINUITY_VECTOR_TABLE_NAME = "vec_continuity_entries";

/**
 * Status-table name used to track indexing lifecycle per continuity entry.
 */
export const CONTINUITY_VECTOR_STATUS_TABLE_NAME = "continuity_vector_status";

/**
 * Fallback table for environments where sqlite-vec cannot be loaded.
 */
export const CONTINUITY_VECTOR_FALLBACK_TABLE_NAME = "continuity_vector_embeddings";

/**
 * Result envelope for continuity vector schema bootstrap.
 */
export interface EnsureContinuityVectorSchemaResult {
  status: "ready" | "error";
  vectorTableReady: boolean;
  warning: string | null;
}

interface ContinuityVectorDatabaseStatement {
  run: (...params: unknown[]) => unknown;
  get: (...params: unknown[]) => Record<string, unknown> | undefined;
  all?: (...params: unknown[]) => Array<Record<string, unknown>>;
}

/**
 * Minimal DB surface required by continuity vector schema/bootstrap operations.
 */
export interface ContinuityVectorSchemaDatabase {
  exec: (sql: string) => void;
  prepare?: (sql: string) => ContinuityVectorDatabaseStatement;
  close: () => void;
}

/**
 * Dependency bundle for opening DB and loading sqlite-vec.
 *
 * Injected in tests to avoid native-module coupling.
 */
export interface ContinuityVectorSchemaDependencies {
  openDatabase: (databasePath: string) => ContinuityVectorSchemaDatabase;
  loadVectorExtension: (database: ContinuityVectorSchemaDatabase) => void;
}

/**
 * Observability counters for continuity vector indexing status.
 */
export interface ContinuityVectorStatusCounts {
  status: "ok" | "error";
  totalTracked: number;
  indexedCount: number;
  failedCount: number;
  pendingCount: number;
  warning: string | null;
}

/**
 * Result envelope for one continuity vector backfill execution.
 */
export interface BackfillContinuityVectorIndexResult {
  status: "ok" | "error";
  scannedCount: number;
  indexedCount: number;
  unchangedCount: number;
  failedCount: number;
  pendingCount: number;
  warning: string | null;
}

/**
 * One vector-search hit mapped back to canonical continuity entry id.
 */
export interface ContinuityVectorSearchHit {
  entryId: string;
  distance: number;
  similarity: number;
}

/**
 * Result envelope for continuity vector semantic lookup.
 */
export interface SearchContinuityVectorEntriesResult {
  status: "ok" | "error";
  results: ContinuityVectorSearchHit[];
  warning: string | null;
}

/**
 * Input payload for indexing one continuity entry into vector tables.
 */
export interface IndexContinuityVectorEntryInput {
  databasePath: string;
  entry: {
    id: string;
    section: "PLANS" | "DECISIONS" | "PROGRESS" | "DISCOVERIES" | "OUTCOMES";
    provenance: "USER" | "CODE" | "TOOL" | "ASSUMPTION";
    certainty: "CONFIRMED" | "UNCONFIRMED";
    content: string;
  };
  embedder: ContinuityVectorEmbedder;
  dependencies?: ContinuityVectorSchemaDependencies;
  now?: string;
}

/**
 * Result envelope for one continuity-entry vector index upsert.
 */
export interface IndexContinuityVectorEntryResult {
  status: "indexed" | "unchanged" | "error";
  vectorRowId: number | null;
  payloadHash: string | null;
  warning: string | null;
}

/**
 * Input payload for deleting one continuity entry vector status/vector rows.
 */
export interface DeleteContinuityVectorEntryInput {
  databasePath: string;
  entryId: string;
  dependencies?: ContinuityVectorSchemaDependencies;
}

/**
 * Result envelope for one continuity-entry vector cleanup.
 */
export interface DeleteContinuityVectorEntryResult {
  status: "deleted" | "skipped" | "error";
  warning: string | null;
}

/**
 * Resolve default runtime dependencies (better-sqlite3 + sqlite-vec) lazily.
 */
const resolveDefaultContinuityVectorDependencies = (): ContinuityVectorSchemaDependencies => {
  const require = createRequire(import.meta.url);

  let BetterSqlite3: (new (databasePath: string) => ContinuityVectorSchemaDatabase) | null = null;
  try {
    BetterSqlite3 = require("better-sqlite3") as new (databasePath: string) => ContinuityVectorSchemaDatabase;
  } catch {
    BetterSqlite3 = null;
  }

  let sqliteVec: {
    load: (database: ContinuityVectorSchemaDatabase) => void;
  } | null = null;
  try {
    sqliteVec = require("sqlite-vec") as {
      load: (database: ContinuityVectorSchemaDatabase) => void;
    };
  } catch {
    sqliteVec = null;
  }

  return {
    openDatabase: (databasePath: string): ContinuityVectorSchemaDatabase => {
      if (!BetterSqlite3) {
        throw new Error("better-sqlite3 unavailable");
      }

      return new BetterSqlite3(databasePath);
    },
    loadVectorExtension: (database: ContinuityVectorSchemaDatabase): void => {
      if (!sqliteVec) {
        throw new Error("sqlite-vec unavailable");
      }

      sqliteVec.load(database);
    },
  };
};

/**
 * Resolve required `prepare` function from vector DB handle.
 */
const requirePrepare = (
  database: ContinuityVectorSchemaDatabase,
): ((sql: string) => ContinuityVectorDatabaseStatement) => {
  if (typeof database.prepare === "function") {
    return database.prepare.bind(database);
  }

  throw new Error("continuity vector database does not expose prepare() API");
};

/**
 * Try to run one ALTER TABLE add-column statement, ignoring duplicate-column errors.
 */
const tryAddColumn = (database: ContinuityVectorSchemaDatabase, sql: string): void => {
  try {
    database.exec(sql);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (!message.includes("duplicate column") && !message.includes("already exists")) {
      throw error;
    }
  }
};

/**
 * Ensure fallback embedding table exists for non-sqlite-vec runtimes.
 */
const ensureFallbackEmbeddingTable = (database: ContinuityVectorSchemaDatabase): void => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS ${CONTINUITY_VECTOR_FALLBACK_TABLE_NAME} (
      rowid INTEGER PRIMARY KEY,
      embedding_json TEXT NOT NULL
    )
  `);
};

/**
 * Try to load sqlite-vec and return native availability status.
 */
const tryLoadVectorExtension = (
  database: ContinuityVectorSchemaDatabase,
  dependencies: ContinuityVectorSchemaDependencies,
): { nativeVecReady: boolean; warning: string | null } => {
  try {
    dependencies.loadVectorExtension(database);
    return {
      nativeVecReady: true,
      warning: null,
    };
  } catch (error: unknown) {
    ensureFallbackEmbeddingTable(database);

    return {
      nativeVecReady: false,
      warning: error instanceof Error ? error.message : String(error),
    };
  }
};

/**
 * Serialize embedding into deterministic JSON text for fallback table writes.
 */
const serializeFallbackEmbedding = (embedding: Float32Array): string =>
  JSON.stringify(Array.from(embedding));

/**
 * Parse fallback embedding JSON text into Float32Array.
 */
const parseFallbackEmbedding = (raw: unknown): Float32Array | null => {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;

    if (!Array.isArray(parsed)) {
      return null;
    }

    const values = parsed
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));

    if (values.length !== CONTINUITY_VECTOR_EMBEDDING_DIMENSION) {
      return null;
    }

    return Float32Array.from(values);
  } catch {
    return null;
  }
};

/**
 * Compute Euclidean distance for two vectors.
 */
const computeEuclideanDistance = (left: Float32Array, right: Float32Array): number => {
  if (left.length !== right.length) {
    return Number.POSITIVE_INFINITY;
  }

  let sum = 0;

  for (let index = 0; index < left.length; index += 1) {
    const delta = left[index] - right[index];
    sum += delta * delta;
  }

  return Math.sqrt(sum);
};

/**
 * Ensure continuity vector schema exists for one project-user DB.
 *
 * Decision:
 * - schema bootstrap is fail-soft (warning + continue) so continuity base path
 *   remains available even when vector dependencies are unavailable.
 */
export const ensureContinuityVectorSchema = (input: {
  databasePath: string;
  dependencies?: ContinuityVectorSchemaDependencies;
}): EnsureContinuityVectorSchemaResult => {
  let database: ContinuityVectorSchemaDatabase | null = null;

  try {
    mkdirSync(path.dirname(input.databasePath), { recursive: true });

    const dependencies = input.dependencies || resolveDefaultContinuityVectorDependencies();
    database = dependencies.openDatabase(input.databasePath);

    database.exec(`
      CREATE TABLE IF NOT EXISTS ${CONTINUITY_VECTOR_STATUS_TABLE_NAME} (
        entry_id TEXT PRIMARY KEY,
        index_state TEXT NOT NULL,
        indexed_at TEXT,
        last_error TEXT,
        vector_rowid INTEGER,
        payload_hash TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_${CONTINUITY_VECTOR_STATUS_TABLE_NAME}_state
        ON ${CONTINUITY_VECTOR_STATUS_TABLE_NAME}(index_state);
    `);

    // Forward-compatible column heals for pre-column versions.
    tryAddColumn(
      database,
      `ALTER TABLE ${CONTINUITY_VECTOR_STATUS_TABLE_NAME} ADD COLUMN vector_rowid INTEGER`,
    );
    tryAddColumn(
      database,
      `ALTER TABLE ${CONTINUITY_VECTOR_STATUS_TABLE_NAME} ADD COLUMN payload_hash TEXT`,
    );

    const vectorExtension = tryLoadVectorExtension(database, dependencies);

    if (vectorExtension.nativeVecReady) {
      try {
        database.exec(
          `CREATE VIRTUAL TABLE ${CONTINUITY_VECTOR_TABLE_NAME} USING vec0(embedding float[${CONTINUITY_VECTOR_EMBEDDING_DIMENSION}])`,
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        if (!message.toLowerCase().includes("already exists")) {
          throw error;
        }
      }
    } else {
      ensureFallbackEmbeddingTable(database);
    }

    return {
      status: "ready",
      vectorTableReady: vectorExtension.nativeVecReady,
      warning: vectorExtension.warning,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      status: "error",
      vectorTableReady: false,
      warning: message,
    };
  } finally {
    try {
      database?.close();
    } catch {
      // Intentionally ignore close errors in bootstrap path.
    }
  }
};

/**
 * Build deterministic vector row id from continuity entry id.
 *
 * Decision:
 * - avoid dependence on SQLite implicit rowid from continuity_entries,
 * - keep stable identity across upsert/replace operations.
 */
const buildDeterministicVectorRowId = (entryId: string): number => {
  const digest = createHash("sha256")
    .update(entryId, "utf8")
    .digest();

  // Keep vec rowids in signed 32-bit integer space.
  //
  // Why this bound exists:
  // - sqlite-vec enforces strict integer primary-key semantics on vec tables,
  // - some SQLite driver paths can bind very large JS numbers as REAL values,
  //   which then fail vec inserts with "Only integers ... for primary key".
  //
  // Bounding to int32 keeps deterministic IDs while avoiding cross-driver
  // numeric binding ambiguity.
  const SIGNED_INT32_MAX = 2_147_483_647;
  const unsigned32 = digest.readUInt32BE(0);

  return (unsigned32 % SIGNED_INT32_MAX) + 1;
};

/**
 * Convert one finite integer into SQL-bound bigint parameter.
 *
 * Why bigint:
 * - SQLite bindings may bind JS `number` values as REAL,
 * - sqlite-vec rowid path requires INTEGER-typed primary-key values.
 */
const toSqlIntegerParam = (value: number): bigint => {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`invalid-integer-rowid:${String(value)}`);
  }

  return BigInt(value);
};

/**
 * Build deterministic payload hash from embedding input text.
 */
const buildVectorPayloadHash = (embeddingText: string): string =>
  createHash("sha256")
    .update(embeddingText, "utf8")
    .digest("hex")
    .slice(0, 24);

/**
 * Convert sqlite-vec L2 distance to cosine-like similarity.
 *
 * Assumes normalized embeddings (`normalize=true` on extractor path).
 */
const distanceToSimilarity = (distance: number): number => {
  if (!Number.isFinite(distance)) {
    return 0;
  }

  const similarity = 1 - ((distance * distance) / 2);
  return Math.max(0, Math.min(1, similarity));
};

/**
 * Normalize unknown numeric SQL value into non-negative integer.
 */
const normalizeCount = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }

  return Math.floor(parsed);
};

/**
 * Read continuity vector indexing counters for observability.
 */
export const readContinuityVectorStatusCounts = (input: {
  databasePath: string;
  dependencies?: ContinuityVectorSchemaDependencies;
}): ContinuityVectorStatusCounts => {
  let database: ContinuityVectorSchemaDatabase | null = null;

  try {
    const schema = ensureContinuityVectorSchema({
      databasePath: input.databasePath,
      dependencies: input.dependencies,
    });

    if (schema.status === "error") {
      return {
        status: "error",
        totalTracked: 0,
        indexedCount: 0,
        failedCount: 0,
        pendingCount: 0,
        warning: schema.warning,
      };
    }

    const dependencies = input.dependencies || resolveDefaultContinuityVectorDependencies();
    database = dependencies.openDatabase(input.databasePath);

    const prepare = requirePrepare(database);

    const totalTracked = normalizeCount(
      prepare(`SELECT COUNT(*) AS cnt FROM ${CONTINUITY_VECTOR_STATUS_TABLE_NAME}`).get()?.cnt,
    );

    const indexedCount = normalizeCount(
      prepare(
        `SELECT COUNT(*) AS cnt FROM ${CONTINUITY_VECTOR_STATUS_TABLE_NAME} WHERE index_state = 'indexed'`,
      ).get()?.cnt,
    );

    const failedCount = normalizeCount(
      prepare(
        `SELECT COUNT(*) AS cnt FROM ${CONTINUITY_VECTOR_STATUS_TABLE_NAME} WHERE index_state = 'failed'`,
      ).get()?.cnt,
    );

    const pendingCount = Math.max(0, totalTracked - indexedCount - failedCount);

    return {
      status: "ok",
      totalTracked,
      indexedCount,
      failedCount,
      pendingCount,
      warning: null,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      status: "error",
      totalTracked: 0,
      indexedCount: 0,
      failedCount: 0,
      pendingCount: 0,
      warning: message,
    };
  } finally {
    try {
      database?.close();
    } catch {
      // Ignore close errors in observability read path.
    }
  }
};

/**
 * Execute semantic continuity search against vector index and map hits to entry ids.
 */
export const searchContinuityVectorEntries = async (input: {
  databasePath: string;
  embedder: ContinuityVectorEmbedder;
  queryText: string;
  limit?: number;
  dependencies?: ContinuityVectorSchemaDependencies;
}): Promise<SearchContinuityVectorEntriesResult> => {
  let database: ContinuityVectorSchemaDatabase | null = null;

  try {
    const queryText = input.queryText.trim();
    if (queryText.length === 0) {
      return {
        status: "ok",
        results: [],
        warning: null,
      };
    }

    const schema = ensureContinuityVectorSchema({
      databasePath: input.databasePath,
      dependencies: input.dependencies,
    });

    if (schema.status === "error") {
      return {
        status: "error",
        results: [],
        warning: schema.warning,
      };
    }

    const queryVector = await input.embedder.embedText(queryText);
    const limit = typeof input.limit === "number"
      ? Math.max(1, Math.floor(input.limit))
      : 50;

    const dependencies = input.dependencies || resolveDefaultContinuityVectorDependencies();
    database = dependencies.openDatabase(input.databasePath);

    const vectorExtension = tryLoadVectorExtension(database, dependencies);
    const prepare = requirePrepare(database);

    if (vectorExtension.nativeVecReady) {
      // sqlite-vec KNN queries require `k = ?` constraint in WHERE clause.
      const semanticQuery = prepare(`
        SELECT
          status.entry_id AS entry_id,
          vec.distance AS distance
        FROM ${CONTINUITY_VECTOR_TABLE_NAME} AS vec
        JOIN ${CONTINUITY_VECTOR_STATUS_TABLE_NAME} AS status
          ON status.vector_rowid = vec.rowid
        WHERE vec.embedding MATCH ?
          AND vec.k = ?
          AND status.index_state = 'indexed'
        ORDER BY vec.distance ASC
      `);

      if (typeof semanticQuery.all !== "function") {
        throw new Error("continuity vector database statement does not expose all() API");
      }

      const rows = semanticQuery.all(queryVector, limit);

      const results: ContinuityVectorSearchHit[] = rows
        .map((row) => {
          if (typeof row.entry_id !== "string") {
            return null;
          }

          const distance = Number(row.distance);
          if (!Number.isFinite(distance)) {
            return null;
          }

          return {
            entryId: row.entry_id,
            distance,
            similarity: distanceToSimilarity(distance),
          };
        })
        .filter((row): row is ContinuityVectorSearchHit => row !== null);

      return {
        status: "ok",
        results,
        warning: null,
      };
    }

    ensureFallbackEmbeddingTable(database);

    const fallbackQuery = prepare(`
      SELECT
        status.entry_id AS entry_id,
        fallback.embedding_json AS embedding_json
      FROM ${CONTINUITY_VECTOR_STATUS_TABLE_NAME} AS status
      JOIN ${CONTINUITY_VECTOR_FALLBACK_TABLE_NAME} AS fallback
        ON fallback.rowid = status.vector_rowid
      WHERE status.index_state = 'indexed'
      LIMIT ?
    `);

    if (typeof fallbackQuery.all !== "function") {
      throw new Error("continuity vector fallback statement does not expose all() API");
    }

    const fallbackLimit = Math.max(limit * 20, 200);
    const rows = fallbackQuery.all(fallbackLimit);

    const results = rows
      .map((row) => {
        if (typeof row.entry_id !== "string") {
          return null;
        }

        const embedding = parseFallbackEmbedding(row.embedding_json);
        if (!embedding) {
          return null;
        }

        const distance = computeEuclideanDistance(queryVector, embedding);
        if (!Number.isFinite(distance)) {
          return null;
        }

        return {
          entryId: row.entry_id,
          distance,
          similarity: distanceToSimilarity(distance),
        };
      })
      .filter((row): row is ContinuityVectorSearchHit => row !== null)
      .sort((left, right) => left.distance - right.distance)
      .slice(0, limit);

    return {
      status: "ok",
      results,
      warning: null,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      status: "error",
      results: [],
      warning: message,
    };
  } finally {
    try {
      database?.close();
    } catch {
      // Ignore close errors in semantic search path.
    }
  }
};

/**
 * Delete vector/status rows for one continuity entry id.
 */
export const deleteContinuityVectorEntry = (input: DeleteContinuityVectorEntryInput): DeleteContinuityVectorEntryResult => {
  let database: ContinuityVectorSchemaDatabase | null = null;

  try {
    const dependencies = input.dependencies || resolveDefaultContinuityVectorDependencies();
    database = dependencies.openDatabase(input.databasePath);

    const vectorExtension = tryLoadVectorExtension(database, dependencies);
    const prepare = requirePrepare(database);

    const selectStatus = prepare(`
      SELECT vector_rowid
      FROM ${CONTINUITY_VECTOR_STATUS_TABLE_NAME}
      WHERE entry_id = ?
    `);

    const statusRow = selectStatus.get(input.entryId) as {
      vector_rowid?: unknown;
    } | undefined;

    const existingVectorRowId = statusRow?.vector_rowid === undefined || statusRow?.vector_rowid === null
      ? null
      : Number(statusRow.vector_rowid);

    if (!Number.isFinite(existingVectorRowId) || existingVectorRowId === null || existingVectorRowId < 1) {
      prepare(`
        DELETE FROM ${CONTINUITY_VECTOR_STATUS_TABLE_NAME}
        WHERE entry_id = ?
      `).run(input.entryId);

      return {
        status: "skipped",
        warning: null,
      };
    }

    const vectorTableName = vectorExtension.nativeVecReady
      ? CONTINUITY_VECTOR_TABLE_NAME
      : CONTINUITY_VECTOR_FALLBACK_TABLE_NAME;

    prepare(`
      DELETE FROM ${vectorTableName}
      WHERE rowid = CAST(? AS INTEGER)
    `).run(toSqlIntegerParam(existingVectorRowId));

    prepare(`
      DELETE FROM ${CONTINUITY_VECTOR_STATUS_TABLE_NAME}
      WHERE entry_id = ?
    `).run(input.entryId);

    return {
      status: "deleted",
      warning: null,
    };
  } catch (error: unknown) {
    return {
      status: "error",
      warning: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      database?.close();
    } catch {
      // Ignore close errors in cleanup path.
    }
  }
};

/**
 * Upsert one continuity entry vector row and status row.
 *
 * Option A semantics support:
 * - caller can treat `status=error` as hard write failure,
 * - no silent fallback to lexical-only persistence for this entry.
 */
export const indexContinuityVectorEntry = async (
  input: IndexContinuityVectorEntryInput,
): Promise<IndexContinuityVectorEntryResult> => {
  let database: ContinuityVectorSchemaDatabase | null = null;

  try {
    const schema = ensureContinuityVectorSchema({
      databasePath: input.databasePath,
      dependencies: input.dependencies,
    });

    if (schema.status === "error") {
      return {
        status: "error",
        vectorRowId: null,
        payloadHash: null,
        warning: schema.warning,
      };
    }

    const dependencies = input.dependencies || resolveDefaultContinuityVectorDependencies();
    database = dependencies.openDatabase(input.databasePath);

    const vectorExtension = tryLoadVectorExtension(database, dependencies);
    const prepare = requirePrepare(database);

    const selectStatus = prepare(`
      SELECT entry_id, index_state, vector_rowid, payload_hash
      FROM ${CONTINUITY_VECTOR_STATUS_TABLE_NAME}
      WHERE entry_id = ?
    `);

    const selectCollision = prepare(`
      SELECT entry_id
      FROM ${CONTINUITY_VECTOR_STATUS_TABLE_NAME}
      WHERE vector_rowid = ? AND entry_id != ?
      LIMIT 1
    `);

    const insertOrReplaceVector = vectorExtension.nativeVecReady
      ? prepare(`
        INSERT OR REPLACE INTO ${CONTINUITY_VECTOR_TABLE_NAME} (rowid, embedding)
        VALUES (CAST(? AS INTEGER), ?)
      `)
      : prepare(`
        INSERT INTO ${CONTINUITY_VECTOR_FALLBACK_TABLE_NAME} (rowid, embedding_json)
        VALUES (CAST(? AS INTEGER), ?)
        ON CONFLICT(rowid) DO UPDATE SET
          embedding_json = excluded.embedding_json
      `);

    const deleteVector = vectorExtension.nativeVecReady
      ? prepare(`
        DELETE FROM ${CONTINUITY_VECTOR_TABLE_NAME}
        WHERE rowid = CAST(? AS INTEGER)
      `)
      : prepare(`
        DELETE FROM ${CONTINUITY_VECTOR_FALLBACK_TABLE_NAME}
        WHERE rowid = CAST(? AS INTEGER)
      `);

    const upsertStatus = prepare(`
      INSERT INTO ${CONTINUITY_VECTOR_STATUS_TABLE_NAME} (
        entry_id,
        index_state,
        indexed_at,
        last_error,
        vector_rowid,
        payload_hash
      )
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(entry_id) DO UPDATE SET
        index_state = excluded.index_state,
        indexed_at = excluded.indexed_at,
        last_error = excluded.last_error,
        vector_rowid = excluded.vector_rowid,
        payload_hash = excluded.payload_hash
    `);

    const vectorRowId = buildDeterministicVectorRowId(input.entry.id);
    const vectorRowIdParam = toSqlIntegerParam(vectorRowId);
    const embeddingText = buildContinuityVectorEmbeddingText({
      section: input.entry.section,
      provenance: input.entry.provenance,
      certainty: input.entry.certainty,
      content: input.entry.content,
    });
    const payloadHash = buildVectorPayloadHash(embeddingText);

    const statusRow = selectStatus.get(input.entry.id) as {
      entry_id?: string;
      index_state?: string;
      vector_rowid?: unknown;
      payload_hash?: unknown;
    } | undefined;

    const existingVectorRowId = statusRow?.vector_rowid === undefined || statusRow?.vector_rowid === null
      ? null
      : Number(statusRow.vector_rowid);

    const existingPayloadHash = typeof statusRow?.payload_hash === "string"
      ? statusRow.payload_hash
      : null;

    const unchanged =
      statusRow?.index_state === "indexed"
      && existingPayloadHash === payloadHash
      && existingVectorRowId === vectorRowId;

    if (unchanged) {
      return {
        status: "unchanged",
        vectorRowId,
        payloadHash,
        warning: null,
      };
    }

    const collision = selectCollision.get(vectorRowIdParam, input.entry.id) as {
      entry_id?: unknown;
    } | undefined;

    if (typeof collision?.entry_id === "string" && collision.entry_id.length > 0) {
      upsertStatus.run(
        input.entry.id,
        "failed",
        null,
        `vector-rowid-collision:${collision.entry_id}`,
        vectorRowIdParam,
        payloadHash,
      );

      return {
        status: "error",
        vectorRowId,
        payloadHash,
        warning: `vector-rowid-collision:${collision.entry_id}`,
      };
    }

    try {
      const embedding = await input.embedder.embedText(embeddingText);

      if (
        Number.isFinite(existingVectorRowId)
        && existingVectorRowId !== null
        && existingVectorRowId !== vectorRowId
        && existingVectorRowId >= 1
      ) {
        deleteVector.run(toSqlIntegerParam(existingVectorRowId));
      }

      const vectorPayload = vectorExtension.nativeVecReady
        ? embedding
        : serializeFallbackEmbedding(embedding);

      insertOrReplaceVector.run(vectorRowIdParam, vectorPayload);

      upsertStatus.run(
        input.entry.id,
        "indexed",
        input.now || new Date().toISOString(),
        null,
        vectorRowIdParam,
        payloadHash,
      );

      return {
        status: "indexed",
        vectorRowId,
        payloadHash,
        warning: null,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);

      upsertStatus.run(
        input.entry.id,
        "failed",
        null,
        message,
        vectorRowIdParam,
        payloadHash,
      );

      return {
        status: "error",
        vectorRowId,
        payloadHash,
        warning: message,
      };
    }
  } catch (error: unknown) {
    return {
      status: "error",
      vectorRowId: null,
      payloadHash: null,
      warning: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      database?.close();
    } catch {
      // Ignore close errors in index path.
    }
  }
};

/**
 * Backfill / refresh continuity vector index rows from canonical continuity entries.
 *
 * Decision:
 * - idempotent by payload hash + deterministic vector row id,
 * - fail-soft per entry (failed rows are tracked in status table).
 */
export const backfillContinuityVectorIndex = async (input: {
  databasePath: string;
  embedder: ContinuityVectorEmbedder;
  limit?: number;
  dependencies?: ContinuityVectorSchemaDependencies;
  now?: string;
}): Promise<BackfillContinuityVectorIndexResult> => {
  let database: ContinuityVectorSchemaDatabase | null = null;

  let scannedCount = 0;
  let indexedCount = 0;
  let unchangedCount = 0;
  let failedCount = 0;

  try {
    const schema = ensureContinuityVectorSchema({
      databasePath: input.databasePath,
      dependencies: input.dependencies,
    });

    if (schema.status === "error") {
      return {
        status: "error",
        scannedCount,
        indexedCount,
        unchangedCount,
        failedCount,
        pendingCount: 0,
        warning: schema.warning,
      };
    }

    const limit = typeof input.limit === "number"
      ? Math.max(1, Math.floor(input.limit))
      : 500;

    const entries = readContinuityEntries({
      databasePath: input.databasePath,
      limit,
    });

    const dependencies = input.dependencies || resolveDefaultContinuityVectorDependencies();
    database = dependencies.openDatabase(input.databasePath);
    dependencies.loadVectorExtension(database);

    const prepare = requirePrepare(database);

    const selectStatus = prepare(`
      SELECT entry_id, index_state, vector_rowid, payload_hash
      FROM ${CONTINUITY_VECTOR_STATUS_TABLE_NAME}
      WHERE entry_id = ?
    `);

    const selectCollision = prepare(`
      SELECT entry_id
      FROM ${CONTINUITY_VECTOR_STATUS_TABLE_NAME}
      WHERE vector_rowid = ? AND entry_id != ?
      LIMIT 1
    `);

    const insertOrReplaceVector = prepare(`
      INSERT OR REPLACE INTO ${CONTINUITY_VECTOR_TABLE_NAME} (rowid, embedding)
      VALUES (CAST(? AS INTEGER), ?)
    `);

    const deleteVector = prepare(`
      DELETE FROM ${CONTINUITY_VECTOR_TABLE_NAME}
      WHERE rowid = CAST(? AS INTEGER)
    `);

    const upsertStatus = prepare(`
      INSERT INTO ${CONTINUITY_VECTOR_STATUS_TABLE_NAME} (
        entry_id,
        index_state,
        indexed_at,
        last_error,
        vector_rowid,
        payload_hash
      )
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(entry_id) DO UPDATE SET
        index_state = excluded.index_state,
        indexed_at = excluded.indexed_at,
        last_error = excluded.last_error,
        vector_rowid = excluded.vector_rowid,
        payload_hash = excluded.payload_hash
    `);

    const now = input.now || new Date().toISOString();

    for (const entry of entries) {
      scannedCount += 1;

      const vectorRowId = buildDeterministicVectorRowId(entry.id);
      const vectorRowIdParam = toSqlIntegerParam(vectorRowId);
      const embeddingText = buildContinuityVectorEmbeddingText({
        section: entry.section,
        provenance: entry.provenance,
        certainty: entry.certainty,
        content: entry.content,
      });
      const payloadHash = buildVectorPayloadHash(embeddingText);

      const statusRow = selectStatus.get(entry.id) as {
        entry_id?: string;
        index_state?: string;
        vector_rowid?: unknown;
        payload_hash?: unknown;
      } | undefined;

      const existingVectorRowId = statusRow?.vector_rowid === undefined || statusRow?.vector_rowid === null
        ? null
        : Number(statusRow.vector_rowid);

      const existingPayloadHash = typeof statusRow?.payload_hash === "string"
        ? statusRow.payload_hash
        : null;

      const unchanged =
        statusRow?.index_state === "indexed"
        && existingPayloadHash === payloadHash
        && existingVectorRowId === vectorRowId;

      if (unchanged) {
        unchangedCount += 1;
        continue;
      }

      const collision = selectCollision.get(vectorRowIdParam, entry.id) as {
        entry_id?: unknown;
      } | undefined;

      if (typeof collision?.entry_id === "string" && collision.entry_id.length > 0) {
        failedCount += 1;
        upsertStatus.run(
          entry.id,
          "failed",
          null,
          `vector-rowid-collision:${collision.entry_id}`,
          vectorRowIdParam,
          payloadHash,
        );
        continue;
      }

      try {
        const embedding = await input.embedder.embedText(embeddingText);

        if (
          Number.isFinite(existingVectorRowId)
          && existingVectorRowId !== null
          && existingVectorRowId !== vectorRowId
          && existingVectorRowId >= 1
        ) {
          deleteVector.run(toSqlIntegerParam(existingVectorRowId));
        }

        insertOrReplaceVector.run(vectorRowIdParam, embedding);

        upsertStatus.run(
          entry.id,
          "indexed",
          now,
          null,
          vectorRowIdParam,
          payloadHash,
        );

        indexedCount += 1;
      } catch (error: unknown) {
        failedCount += 1;
        const message = error instanceof Error ? error.message : String(error);

        upsertStatus.run(
          entry.id,
          "failed",
          null,
          message,
          vectorRowIdParam,
          payloadHash,
        );
      }
    }

    const counts = readContinuityVectorStatusCounts({
      databasePath: input.databasePath,
      dependencies: input.dependencies,
    });

    return {
      status: counts.status === "ok" ? "ok" : "error",
      scannedCount,
      indexedCount,
      unchangedCount,
      failedCount,
      pendingCount: counts.pendingCount,
      warning: counts.warning,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      status: "error",
      scannedCount,
      indexedCount,
      unchangedCount,
      failedCount,
      pendingCount: 0,
      warning: message,
    };
  } finally {
    try {
      database?.close();
    } catch {
      // Ignore close errors in backfill path.
    }
  }
};
