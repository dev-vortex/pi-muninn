/**
 * File intent: perform direct fan-out retrieval across project member databases.
 *
 * This file discovers per-user project memory DBs, reads both memory and
 * continuity rows directly, ranks lexical matches, and returns merged hits with
 * source/user attribution. Use this path as the correctness fallback when the
 * derived project index is missing, stale, partial, or intentionally bypassed.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";

import {
  type BetterSqliteDatabase,
  openBetterSqliteDatabase,
  sqliteTableExists,
} from "../common/better-sqlite3-adapter.js";
import { deriveParallelEvidenceMarker } from "../../../project-index/parallel-evidence.js";

/**
 * Fan-out search input for project user-memory databases.
 */
export interface FanoutSearchInput {
  /** Project-local memory directory (`${PROJECT}/.agent/memory`). */
  projectMemoryDir: string;
  /** Natural-language or keyword query. */
  query: string;
  /** Maximum number of hits returned after global merge/sort. */
  topK?: number;
  /** Maximum hits fetched from each user DB source table. */
  perDbLimit?: number;
}

/**
 * One merged hit from fan-out retrieval.
 */
export interface FanoutSearchHit {
  /** User id inferred from `<userId>.db`. */
  userId: string;
  /** Source database path for traceability. */
  databasePath: string;
  /** Memory/continuity id (if available in DB). */
  id: string;
  /** Source kind included in this hit. */
  kind: "memory" | "continuity";
  /** Memory content text. */
  content: string;
  /** Topic metadata if available. */
  topic: string;
  /** Source metadata if available. */
  source: string;
  /** Timestamp metadata if available. */
  timestamp: string;
  /** Deterministic grouping hint used for parallel evidence surfaces. */
  subjectHintKey: string | null;
  /** Deterministic cross-user group id when subject hint exists. */
  groupId: string | null;
  /** Number of matched query terms in content/topic. */
  termMatches: number;
}

/**
 * Fan-out retrieval result envelope.
 */
export interface FanoutSearchResult {
  query: string;
  databaseCount: number;
  searchedDatabaseCount: number;
  results: FanoutSearchHit[];
  errors: Array<{ databasePath: string; error: string }>;
}

/**
 * Normalize one lexical query token.
 *
 * Decision:
 * - strip wrapping quote-like punctuation so inputs like
 *   `"preferred project stack"` don't degrade lexical matching.
 */
const normalizeQueryToken = (token: string): string =>
  token
    .trim()
    .toLowerCase()
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "");

/**
 * Parse and normalize query terms for matching.
 */
const parseQueryTerms = (query: string): string[] =>
  query
    .trim()
    .split(/\s+/)
    .map(normalizeQueryToken)
    .filter((token) => token.length > 0);

/**
 * Count how many query terms appear in content/topic.
 */
const countTermMatches = (terms: string[], content: string, topic: string): number => {
  if (terms.length === 0) {
    return 0;
  }

  const haystack = `${content}\n${topic}`.toLowerCase();
  return terms.reduce((acc, term) => acc + (haystack.includes(term) ? 1 : 0), 0);
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
 * Discover user DB files in `${PROJECT}/.agent/memory`.
 *
 * Excludes local derived/cache DB artifacts:
 * - `project.db` (legacy index DB name)
 * - `cache.db` (current index/cache DB name)
 */
export const discoverProjectUserDatabases = async (
  projectMemoryDir: string,
): Promise<string[]> => {
  let entries: Array<{ isFile: () => boolean; name: string }>;

  try {
    entries = await readdir(projectMemoryDir, {
      withFileTypes: true,
      encoding: "utf8",
    }) as Array<{ isFile: () => boolean; name: string }>;
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".db"))
    .filter((name) => name !== "project.db" && name !== "cache.db")
    .sort((a, b) => a.localeCompare(b))
    .map((name) => path.join(projectMemoryDir, name));
};

/**
 * Build SQL WHERE clause for lexical term filtering.
 */
const buildLexicalWhereClause = (terms: string[]): {
  clause: string;
  params: string[];
} => {
  if (terms.length === 0) {
    return {
      clause: "",
      params: [],
    };
  }

  const whereClauses: string[] = [];
  const params: string[] = [];

  for (const term of terms) {
    whereClauses.push("content LIKE ?");
    params.push(`%${term}%`);
  }

  return {
    clause: ` WHERE ${whereClauses.join(" OR ")}`,
    params,
  };
};

/**
 * Read lexical memory hits from one user DB.
 */
const readMemoryHits = (input: {
  db: BetterSqliteDatabase;
  terms: string[];
  databasePath: string;
  userId: string;
  limit: number;
}): FanoutSearchHit[] => {
  const lexical = buildLexicalWhereClause(input.terms);

  const rows = input.db.prepare(`
    SELECT id, content, topic, source, timestamp
    FROM memories
    ${lexical.clause}
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(...lexical.params, input.limit) as Array<Record<string, unknown>>;

  return rows.map((row) => {
    const content = typeof row.content === "string" ? row.content : "";
    const topic = typeof row.topic === "string" ? row.topic : "general";
    const marker = deriveParallelEvidenceMarker({
      content,
      topic,
    });

    return {
      userId: input.userId,
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
    };
  });
};

/**
 * Read lexical continuity hits from one user DB.
 */
const readContinuityHits = (input: {
  db: BetterSqliteDatabase;
  terms: string[];
  databasePath: string;
  userId: string;
  limit: number;
}): FanoutSearchHit[] => {
  const lexical = buildLexicalWhereClause(input.terms);

  const rows = input.db.prepare(`
    SELECT id, content, timestamp, section_code, provenance_code
    FROM continuity_entries
    ${lexical.clause}
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(...lexical.params, input.limit) as Array<Record<string, unknown>>;

  return rows.map((row) => {
    const content = typeof row.content === "string" ? row.content : "";
    const section = decodeContinuitySectionCode(row.section_code);
    const provenance = decodeContinuityProvenanceCode(row.provenance_code);
    const topic = `continuity/${section}`;
    const source = `continuity::${provenance}`;

    const marker = deriveParallelEvidenceMarker({
      content,
      topic,
    });

    return {
      userId: input.userId,
      databasePath: input.databasePath,
      id: typeof row.id === "string" ? `cont:${row.id}` : "cont:unknown-id",
      kind: "continuity",
      content,
      topic,
      source,
      timestamp: typeof row.timestamp === "string" ? row.timestamp : "",
      subjectHintKey: marker.subjectHintKey,
      groupId: marker.groupId,
      termMatches: countTermMatches(input.terms, content, topic),
    };
  });
};

/**
 * Query one user DB with lexical filtering for both memory and continuity rows.
 *
 * Decision:
 * - include both L1 (`memories`) and L0 (`continuity_entries`) rows so fallback
 *   retrieval keeps the same multi-member read scope expected from L2.
 */
const querySingleUserDatabase = (input: {
  databasePath: string;
  query: string;
  perDbLimit: number;
}): FanoutSearchHit[] => {
  const db = openBetterSqliteDatabase(input.databasePath, {
    readOnly: true,
    fileMustExist: true,
  });

  try {
    const terms = parseQueryTerms(input.query);
    const userId = path.basename(input.databasePath, ".db");

    const memoryHits = sqliteTableExists({ db, tableName: "memories" })
      ? readMemoryHits({
        db,
        terms,
        databasePath: input.databasePath,
        userId,
        limit: input.perDbLimit,
      })
      : [];

    const continuityHits = sqliteTableExists({ db, tableName: "continuity_entries" })
      ? readContinuityHits({
        db,
        terms,
        databasePath: input.databasePath,
        userId,
        limit: input.perDbLimit,
      })
      : [];

    const combined = [...memoryHits, ...continuityHits];

    combined.sort((left, right) => {
      if (right.termMatches !== left.termMatches) {
        return right.termMatches - left.termMatches;
      }

      return right.timestamp.localeCompare(left.timestamp);
    });

    return combined.slice(0, Math.max(input.perDbLimit * 2, input.perDbLimit));
  } finally {
    db.close();
  }
};

/**
 * Fan-out query across all discovered user DBs and merge results.
 */
export const fanoutProjectMemorySearch = async (
  input: FanoutSearchInput,
): Promise<FanoutSearchResult> => {
  const topK = Math.max(1, Math.min(input.topK ?? 20, 200));
  const perDbLimit = Math.max(1, Math.min(input.perDbLimit ?? 10, 100));

  const databasePaths = await discoverProjectUserDatabases(input.projectMemoryDir);

  const allHits: FanoutSearchHit[] = [];
  const errors: Array<{ databasePath: string; error: string }> = [];

  for (const databasePath of databasePaths) {
    try {
      const hits = querySingleUserDatabase({
        databasePath,
        query: input.query,
        perDbLimit,
      });
      allHits.push(...hits);
    } catch (error: unknown) {
      errors.push({
        databasePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  allHits.sort((left, right) => {
    if (right.termMatches !== left.termMatches) {
      return right.termMatches - left.termMatches;
    }

    return right.timestamp.localeCompare(left.timestamp);
  });

  return {
    query: input.query,
    databaseCount: databasePaths.length,
    searchedDatabaseCount: databasePaths.length - errors.length,
    results: allHits.slice(0, topK),
    errors,
  };
};
