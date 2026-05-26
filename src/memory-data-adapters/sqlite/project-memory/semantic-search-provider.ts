/**
 * File intent: provide the concrete semantic project-memory search adapter.
 *
 * This file defines the semantic search provider port and the current sqlite-vec
 * implementation that reads existing per-user DB embeddings. Keep engine/vendor
 * details here so `hybrid-retrieval.ts` can depend on a domain-level provider
 * interface rather than directly owning sqlite-vec behavior.
 */

import { createRequire } from "node:module";
import path from "node:path";

import { deriveParallelEvidenceMarker } from "../../../../packages/memory-core/src/project-index/parallel-evidence.js";
import {
  type BetterSqliteDatabase,
  openBetterSqliteDatabase,
  sqliteTableExists,
} from "../common/better-sqlite3-adapter.js";
import { createContinuityVectorEmbedder } from "../continuity/continuity-vector-embedder.js";
import type { FanoutSearchHit } from "../project-index/fanout-retrieval.js";

const require = createRequire(import.meta.url);

/**
 * sqlite-vec loader contract kept local to this engine-specific implementation.
 */
interface SqliteVecModule {
  load: (database: BetterSqliteDatabase) => void;
}

/**
 * One semantic project-memory hit produced by the provider.
 */
export interface ProjectSemanticMemorySearchHit extends FanoutSearchHit {
  kind: "memory";
  semanticDistance: number;
  semanticSimilarity: number;
  retrievalSource: "semantic";
}

/**
 * Input contract for a domain-level semantic project-memory provider.
 */
export interface ProjectSemanticMemorySearchInput {
  query: string;
  databasePaths: string[];
  topK: number;
  perDbLimit: number;
}

/**
 * Result contract returned by a semantic project-memory provider.
 */
export interface ProjectSemanticMemorySearchResult {
  query: string;
  databaseCount: number;
  searchedDatabaseCount: number;
  results: ProjectSemanticMemorySearchHit[];
  errors: Array<{ databasePath: string; error: string }>;
}

/**
 * Domain-level port for semantic project-memory retrieval.
 */
export interface ProjectSemanticMemorySearchProvider {
  search: (input: ProjectSemanticMemorySearchInput) => Promise<ProjectSemanticMemorySearchResult>;
}

/**
 * Dependencies for the SQLite/sqlite-vec semantic provider implementation.
 */
export interface SqliteVecProjectSemanticMemorySearchProviderDependencies {
  openDatabase?: typeof openBetterSqliteDatabase;
  loadVectorExtension?: (database: BetterSqliteDatabase) => void;
  embedText?: (text: string) => Promise<Float32Array>;
}

interface VecSearchRow {
  rowid: number | bigint;
  distance: number;
}

/**
 * Normalize one lexical query token for exact-support scoring only.
 */
const normalizeQueryToken = (token: string): string =>
  token
    .trim()
    .toLowerCase()
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "");

/**
 * Parse query terms used for lightweight match-count metadata.
 */
const parseQueryTerms = (query: string): string[] =>
  query
    .trim()
    .split(/\s+/)
    .map(normalizeQueryToken)
    .filter((token) => token.length > 0);

/**
 * Count query terms in content/topic to preserve lexical observability metadata.
 */
const countTermMatches = (terms: string[], content: string, topic: string): number => {
  if (terms.length === 0) {
    return 0;
  }

  const haystack = `${content}\n${topic}`.toLowerCase();
  return terms.reduce((acc, term) => acc + (haystack.includes(term) ? 1 : 0), 0);
};

/**
 * Convert sqlite-vec L2 distance for normalized vectors into cosine-like similarity.
 */
const distanceToSimilarity = (distance: number): number => {
  const similarity = 1 - (distance * distance) / 2;
  return Math.round(similarity * 10000) / 10000;
};

/**
 * Lazily resolve the sqlite-vec extension loader.
 */
const loadDefaultSqliteVecModule = (): SqliteVecModule => {
  const loaded = require("sqlite-vec") as unknown;

  if (
    typeof loaded === "object"
    && loaded !== null
    && typeof (loaded as { load?: unknown }).load === "function"
  ) {
    return loaded as SqliteVecModule;
  }

  throw new Error("sqlite-vec module does not expose load(database)");
};

/**
 * Build the default query embedder aligned with upstream pi-mempalace vectors.
 */
const createDefaultQueryEmbedder = (): ((text: string) => Promise<Float32Array>) => {
  const embedder = createContinuityVectorEmbedder();
  return embedder.embedText;
};

/**
 * Normalize SQLite rowid values into safe numbers for IN-clause lookup.
 */
const normalizeRowid = (value: number | bigint): number =>
  typeof value === "bigint" ? Number(value) : value;

/**
 * Check whether one DB has the source and vector tables needed for semantic search.
 */
const hasSemanticTables = (db: BetterSqliteDatabase): boolean =>
  sqliteTableExists({ db, tableName: "memories" })
  && sqliteTableExists({ db, tableName: "vec_memories" });

/**
 * Read semantic memory hits from one upstream-compatible project user DB.
 */
const readSemanticHitsFromDatabase = (input: {
  db: BetterSqliteDatabase;
  databasePath: string;
  queryVector: Float32Array;
  terms: string[];
  limit: number;
}): ProjectSemanticMemorySearchHit[] => {
  const vecRows = input.db.prepare(`
    SELECT rowid, distance
    FROM vec_memories
    WHERE embedding MATCH ?
    ORDER BY distance
    LIMIT ?
  `).all(input.queryVector, input.limit) as unknown as VecSearchRow[];

  if (vecRows.length === 0) {
    return [];
  }

  const rowids = vecRows.map((row) => normalizeRowid(row.rowid));
  const distanceByRowid = new Map<number, number>(
    vecRows.map((row) => [normalizeRowid(row.rowid), row.distance]),
  );
  const placeholders = rowids.map(() => "?").join(",");
  const rows = input.db.prepare(`
    SELECT rowid, id, content, topic, source, timestamp
    FROM memories
    WHERE rowid IN (${placeholders})
  `).all(...rowids) as Array<Record<string, unknown>>;
  const userId = path.basename(input.databasePath, ".db");

  const hits = rows.map((row): ProjectSemanticMemorySearchHit => {
    const rowid = typeof row.rowid === "number"
      ? row.rowid
      : typeof row.rowid === "bigint"
        ? Number(row.rowid)
        : -1;
    const content = typeof row.content === "string" ? row.content : "";
    const topic = typeof row.topic === "string" ? row.topic : "general";
    const marker = deriveParallelEvidenceMarker({ content, topic });
    const distance = distanceByRowid.get(rowid) ?? Number.POSITIVE_INFINITY;

    return {
      userId,
      databasePath: input.databasePath,
      id: typeof row.id === "string" ? row.id : "unknown-id",
      kind: "memory",
      content,
      topic,
      source: typeof row.source === "string" ? row.source : "unknown",
      timestamp: typeof row.timestamp === "string" ? row.timestamp : "",
      subjectHintKey: marker.subjectHintKey,
      groupId: marker.groupId,
      termMatches: countTermMatches(input.terms, content, topic),
      semanticDistance: distance,
      semanticSimilarity: distanceToSimilarity(distance),
      retrievalSource: "semantic",
    };
  });

  hits.sort((left, right) => {
    if (right.semanticSimilarity !== left.semanticSimilarity) {
      return right.semanticSimilarity - left.semanticSimilarity;
    }

    if (right.termMatches !== left.termMatches) {
      return right.termMatches - left.termMatches;
    }

    return right.timestamp.localeCompare(left.timestamp);
  });

  return hits;
};

/**
 * Create the current SQLite/sqlite-vec semantic project-memory provider.
 */
export const createSqliteVecProjectSemanticMemorySearchProvider = (
  dependencies: SqliteVecProjectSemanticMemorySearchProviderDependencies = {},
): ProjectSemanticMemorySearchProvider => {
  const openDatabase = dependencies.openDatabase || openBetterSqliteDatabase;
  const embedText = dependencies.embedText || createDefaultQueryEmbedder();
  const loadVectorExtension = dependencies.loadVectorExtension || ((database: BetterSqliteDatabase): void => {
    loadDefaultSqliteVecModule().load(database);
  });

  return {
    search: async (input: ProjectSemanticMemorySearchInput): Promise<ProjectSemanticMemorySearchResult> => {
      const topK = Math.max(1, Math.min(input.topK, 200));
      const perDbLimit = Math.max(1, Math.min(input.perDbLimit, 50));
      const terms = parseQueryTerms(input.query);
      const errors: Array<{ databasePath: string; error: string }> = [];
      const searchableDatabasePaths: string[] = [];

      for (const databasePath of input.databasePaths) {
        const db = openDatabase(databasePath, { readOnly: true, fileMustExist: true });
        try {
          if (hasSemanticTables(db)) {
            searchableDatabasePaths.push(databasePath);
          } else {
            errors.push({
              databasePath,
              error: "semantic vector tables unavailable",
            });
          }
        } catch (error: unknown) {
          errors.push({
            databasePath,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          db.close();
        }
      }

      if (searchableDatabasePaths.length === 0) {
        return {
          query: input.query,
          databaseCount: input.databasePaths.length,
          searchedDatabaseCount: 0,
          results: [],
          errors,
        };
      }

      let queryVector: Float32Array;
      try {
        queryVector = await embedText(input.query.trim());
      } catch (error: unknown) {
        return {
          query: input.query,
          databaseCount: input.databasePaths.length,
          searchedDatabaseCount: 0,
          results: [],
          errors: [
            ...errors,
            {
              databasePath: "<query-embedding>",
              error: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }

      const allHits: ProjectSemanticMemorySearchHit[] = [];
      let searchedDatabaseCount = 0;

      for (const databasePath of searchableDatabasePaths) {
        const db = openDatabase(databasePath, { readOnly: true, fileMustExist: true });
        try {
          loadVectorExtension(db);
          const hits = readSemanticHitsFromDatabase({
            db,
            databasePath,
            queryVector,
            terms,
            limit: perDbLimit,
          });
          searchedDatabaseCount += 1;
          allHits.push(...hits);
        } catch (error: unknown) {
          errors.push({
            databasePath,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          db.close();
        }
      }

      allHits.sort((left, right) => {
        if (right.semanticSimilarity !== left.semanticSimilarity) {
          return right.semanticSimilarity - left.semanticSimilarity;
        }

        if (right.termMatches !== left.termMatches) {
          return right.termMatches - left.termMatches;
        }

        return right.timestamp.localeCompare(left.timestamp);
      });

      return {
        query: input.query,
        databaseCount: input.databasePaths.length,
        searchedDatabaseCount,
        results: allHits.slice(0, topK),
        errors,
      };
    },
  };
};
