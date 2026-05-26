/**
 * File intent: read-only SQLite models used by upstream compatibility routes.
 *
 * These helpers intentionally avoid writes. They support project-user graph,
 * tunnel, recall, and deterministic fallback search behavior.
 */

import { existsSync } from "node:fs";
import path from "node:path";

import {
  type BetterSqliteDatabase,
  openBetterSqliteDatabase,
  sqliteTableExists,
} from "../../memory-data-adapters/sqlite/common/better-sqlite3-adapter.js";
import { discoverProjectUserDatabases } from "../../memory-data-adapters/sqlite/project-index/fanout-retrieval.js";
import { resolveProjectMemoryDirectory } from "../../project-memory/config.js";
import { MEMORY_SEARCH_STOP_WORDS } from "./constants.js";

export const readUserIdFromDatabasePath = (databasePath: string): string =>
  path.basename(databasePath, ".db");

/**
 * Parse non-negative count values from SQLite rows.
 */
export const normalizeSqlCount = (value: unknown): number => {
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? Math.max(0, Math.floor(value))
      : 0;
  }

  if (typeof value === "bigint") {
    return Number(value > BigInt(Number.MAX_SAFE_INTEGER)
      ? BigInt(Number.MAX_SAFE_INTEGER)
      : value);
  }

  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed)
      ? Math.max(0, Math.floor(parsed))
      : 0;
  }

  return 0;
};

/**
 * Parse one user-memory row from SQLite to a normalized shape.
 */
export const readUserMemoryRows = (input: {
  databasePath: string;
  topic?: string | null;
  limit: number;
}): Array<{
  userId: string;
  topic: string;
  content: string;
  timestamp: string;
}> => {
  let db: BetterSqliteDatabase | null = null;

  try {
    db = openBetterSqliteDatabase(input.databasePath, {
      readOnly: true,
      fileMustExist: true,
    });

    const hasTopicFilter = typeof input.topic === "string" && input.topic.trim().length > 0;
    const rows = hasTopicFilter
      ? db.prepare(`
        SELECT topic, content, timestamp
        FROM memories
        WHERE topic = ?
        ORDER BY timestamp DESC
        LIMIT ?
      `).all(input.topic?.trim() || "", input.limit)
      : db.prepare(`
        SELECT topic, content, timestamp
        FROM memories
        ORDER BY timestamp DESC
        LIMIT ?
      `).all(input.limit);

    return rows.map((row) => ({
      userId: readUserIdFromDatabasePath(input.databasePath),
      topic: typeof row.topic === "string" ? row.topic : "general",
      content: typeof row.content === "string" ? row.content : "",
      timestamp: typeof row.timestamp === "string" ? row.timestamp : "",
    }));
  } catch {
    return [];
  } finally {
    db?.close();
  }
};

/**
 * Parse one user-memory topic histogram from SQLite.
 */
export const readUserTopicCounts = (databasePath: string): Array<{ topic: string; count: number }> => {
  let db: BetterSqliteDatabase | null = null;

  try {
    db = openBetterSqliteDatabase(databasePath, {
      readOnly: true,
      fileMustExist: true,
    });

    const rows = db.prepare(`
      SELECT topic, COUNT(*) AS count
      FROM memories
      GROUP BY topic
      ORDER BY count DESC
    `).all();

    return rows.map((row) => ({
      topic: typeof row.topic === "string" ? row.topic : "general",
      count: normalizeSqlCount(row.count),
    }));
  } catch {
    return [];
  } finally {
    db?.close();
  }
};

/**
 * Parse one user-memory total count from SQLite.
 */
export const readUserMemoryCount = (databasePath: string): number => {
  let db: BetterSqliteDatabase | null = null;

  try {
    db = openBetterSqliteDatabase(databasePath, {
      readOnly: true,
      fileMustExist: true,
    });

    const row = db.prepare(`
      SELECT COUNT(*) AS total
      FROM memories
    `).get();

    return normalizeSqlCount(row?.total);
  } catch {
    return 0;
  } finally {
    db?.close();
  }
};

/**
 * Parse one list of user DB paths for current project memory directory.
 */
export const readProjectUserDatabasePaths = async (projectRoot: string): Promise<string[]> => {
  const projectMemoryDir = resolveProjectMemoryDirectory(projectRoot);
  return discoverProjectUserDatabases(projectMemoryDir);
};

/**
 * Normalize user query terms for deterministic lexical fallback search.
 */
export const normalizeMemorySearchTerms = (query: string): string[] => {
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9_+.#-]+/g, " ")
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && !MEMORY_SEARCH_STOP_WORDS.has(term));

  return [...new Set(terms)];
};

/**
 * Create small morphology variants so `preferred` can match `preference`/`prefer`.
 */
export const buildMemorySearchTermVariants = (term: string): string[] => {
  const variants = new Set([term]);

  if (term === "preferred" || term === "prefers" || term === "preference" || term === "preferences") {
    variants.add("prefer");
    variants.add("preference");
  }

  if (term.endsWith("s") && term.length > 3) {
    variants.add(term.slice(0, -1));
  }

  if (term.endsWith("ed") && term.length > 4) {
    variants.add(term.slice(0, -2));
  }

  if (term.endsWith("ing") && term.length > 5) {
    variants.add(term.slice(0, -3));
  }

  return [...variants].filter((variant) => variant.length >= 2);
};

/**
 * Count query-term matches in one content/topic blob for fallback ranking.
 */
export const countMemorySearchTermMatches = (input: {
  terms: string[];
  topic: string;
  content: string;
}): number => {
  const haystack = `${input.topic}\n${input.content}`.toLowerCase();
  let matches = 0;

  for (const term of input.terms) {
    const variants = buildMemorySearchTermVariants(term);
    if (variants.some((variant) => haystack.includes(variant))) {
      matches += 1;
    }
  }

  return matches;
};

/**
 * Resolve the official upstream memory DB path for a specific home directory.
 */
export const resolveGlobalMemoryDatabasePath = (homeDirectory: string): string =>
  path.join(homeDirectory, ".pi", "agent", "memory", "memories.db");

/**
 * Detect upstream no-hit text so a deterministic DB fallback can recover rows.
 */
export const isNoMemoryResultText = (text: string | null): boolean =>
  !text || /^No memories found\b/i.test(text.trim());

/**
 * Read reusable user-memory rows directly from the upstream global memory DB.
 *
 * This is a fallback for upstream vector search post-filter misses: upstream
 * searches a bounded vector candidate set before applying `project='general'`,
 * so valid reusable rows can be missed under broad project-memory corpora.
 */
export const readGeneralMemoryLexicalFallbackHits = (input: {
  databasePath: string;
  query: string;
  topicFilter: string | null;
  limit: number;
}): Array<{
  topic: string;
  timestamp: string;
  content: string;
  termMatches: number;
}> => {
  if (!existsSync(input.databasePath)) {
    return [];
  }

  let db: BetterSqliteDatabase | null = null;

  try {
    db = openBetterSqliteDatabase(input.databasePath, {
      readOnly: true,
      fileMustExist: true,
    });

    if (!sqliteTableExists({ db, tableName: "memories" })) {
      return [];
    }

    const fetchLimit = Math.max(input.limit * 20, 100);
    const rows = input.topicFilter
      ? db.prepare(`
        SELECT topic, content, timestamp
        FROM memories
        WHERE project = 'general' AND lower(topic) = lower(?)
        ORDER BY timestamp DESC
        LIMIT ?
      `).all(input.topicFilter, fetchLimit)
      : db.prepare(`
        SELECT topic, content, timestamp
        FROM memories
        WHERE project = 'general'
        ORDER BY timestamp DESC
        LIMIT ?
      `).all(fetchLimit);

    const terms = normalizeMemorySearchTerms(input.query);
    const ranked = rows
      .map((row) => {
        const topic = typeof row.topic === "string" ? row.topic : "general";
        const content = typeof row.content === "string" ? row.content : "";

        return {
          topic,
          content,
          timestamp: typeof row.timestamp === "string" ? row.timestamp : "",
          termMatches: countMemorySearchTermMatches({
            terms,
            topic,
            content,
          }),
        };
      })
      .filter((row) => row.content.trim().length > 0)
      .sort((a, b) => (
        b.termMatches - a.termMatches
        || b.timestamp.localeCompare(a.timestamp)
      ));

    const positiveMatches = ranked.filter((row) => row.termMatches > 0);
    const candidates = positiveMatches.length > 0 ? positiveMatches : ranked;

    return candidates.slice(0, input.limit);
  } catch {
    return [];
  } finally {
    db?.close();
  }
};
