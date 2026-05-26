/**
 * File intent: read reusable related-user memory candidates for prompt briefings.
 *
 * The memory briefing uses project memory and general reusable user
 * memory as separate lanes. This module owns only the related-user DB read path.
 */

import { existsSync } from "node:fs";

import {
  openBetterSqliteDatabase,
  sqliteTableExists,
} from "../common/better-sqlite3-adapter.js";
import type { RelatedUserMemoryCandidate } from "./memory-briefing-types.js";
import { countTermMatches, rankRows } from "./memory-briefing-utils.js";

/**
 * Read related reusable user memories from the global upstream memory DB.
 */
export const readRelatedUserMemoryCandidates = (input: {
  globalDatabasePath: string;
  signalTokens: string[];
  candidateLimit: number;
}): { candidates: RelatedUserMemoryCandidate[]; note: string | null } => {
  if (!existsSync(input.globalDatabasePath)) {
    return {
      candidates: [],
      note: "related user memory unavailable: global memory DB not found",
    };
  }

  const db = openBetterSqliteDatabase(input.globalDatabasePath, {
    readOnly: true,
    fileMustExist: true,
  });

  try {
    if (!sqliteTableExists({ db, tableName: "memories" })) {
      return {
        candidates: [],
        note: "related user memory unavailable: memories table not found",
      };
    }

    const params: Array<string | number> = [];
    const clauses = ["project = 'general'"];

    if (input.signalTokens.length > 0) {
      const termClauses: string[] = [];
      for (const token of input.signalTokens) {
        termClauses.push("(content LIKE ? OR topic LIKE ?)");
        const pattern = `%${token}%`;
        params.push(pattern, pattern);
      }
      clauses.push(`(${termClauses.join(" OR ")})`);
    }

    params.push(input.candidateLimit);

    const rows = db.prepare(`
      SELECT id, content, topic, timestamp
      FROM memories
      WHERE ${clauses.join(" AND ")}
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(...params);

    const candidates = rows.map((row) => {
      const content = typeof row.content === "string" ? row.content : "";
      const topic = typeof row.topic === "string" ? row.topic : "general";

      return {
        id: typeof row.id === "string" ? row.id : "unknown-id",
        topic,
        timestamp: typeof row.timestamp === "string" ? row.timestamp : "",
        content,
        termMatches: countTermMatches(input.signalTokens, content, topic),
      };
    });

    return {
      candidates: rankRows(candidates),
      note: null,
    };
  } catch (error: unknown) {
    return {
      candidates: [],
      note: `related user memory unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    db.close();
  }
};
