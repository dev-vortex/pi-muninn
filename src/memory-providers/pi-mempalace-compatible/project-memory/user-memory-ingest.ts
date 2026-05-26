/**
 * File intent: provide low-level project user-memory DB helpers and counters.
 *
 * This file owns vendor-compatible project user DB schema bootstrap, explicit row
 * insert helpers retained for controlled/internal use, legacy turn-capture helper
 * behavior, and status counters shown by `/memory project status`. Do not add new
 * implicit memory writes here; normal L1 writes must use the vendored MemoryStore
 * path enforced by the extension runtime.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import {
  normalizeSqliteCountValue,
  openBetterSqliteDatabase,
} from "../../../memory-data-adapters/sqlite/common/better-sqlite3-adapter.js";

const MIN_ASSISTANT_TEXT_LENGTH = 20;
const MIN_USER_TEXT_LENGTH = 10;
const MAX_CAPTURED_EXCHANGE_LENGTH = 2_000;

/**
 * Vendor-compatible short content hash for the canonical memories schema.
 */
const hashMemoryContent = (content: string): string =>
  createHash("sha256")
    .update(content, "utf-8")
    .digest("hex")
    .slice(0, 16);

/**
 * One captured project-memory row persisted in `${PROJECT}/.agent/memory/<user>.db`.
 */
export interface ProjectUserMemoryRowInput {
  /** Absolute user/project DB path. */
  databasePath: string;
  /** Unique memory id. */
  id: string;
  /** Captured memory content. */
  content: string;
  /** Topic classification (default: `general`). */
  topic?: string;
  /** Source marker (default: `auto-capture`). */
  source?: string;
  /** ISO timestamp for persistence order and traceability. */
  timestamp: string;
}

/**
 * Input payload for one turn-level auto-capture operation.
 */
export interface CaptureProjectTurnInput {
  /** Absolute user/project DB path. */
  databasePath: string;
  /** Unique id to use when persistence succeeds. */
  memoryId: string;
  /** Timestamp for persisted memory row. */
  timestamp: string;
  /** Assistant message content block(s) from turn-end event. */
  assistantMessageContent: unknown;
  /** Current session branch entries used to find latest user message. */
  branchEntries: unknown[];
}

/**
 * Capture outcome reasons for diagnostics and testability.
 */
export type CaptureProjectTurnReason =
  | "stored"
  | "assistant-too-short"
  | "missing-user-message"
  | "user-too-short"
  | "error";

/**
 * Result envelope for one project-turn auto-capture attempt.
 */
export interface CaptureProjectTurnResult {
  /** Whether one row was persisted. */
  stored: boolean;
  /** Deterministic outcome reason. */
  reason: CaptureProjectTurnReason;
  /** Optional failure detail when `reason=error`. */
  error?: string;
}

/**
 * Input payload for project user-memory status counters.
 */
export interface ReadProjectUserMemoryStatusCountsInput {
  /** Absolute user/project DB path. */
  databasePath: string;
}

/**
 * Aggregate project user-memory counters for status/reporting surfaces.
 */
export interface ProjectUserMemoryStatusCounts {
  status: "ok" | "no-db" | "error";
  memoryCount: number;
  distinctTopicCount: number;
  distinctSourceCount: number;
  latestMemoryTimestamp: string | null;
  latestMemoryTopic: string | null;
  latestMemorySource: string | null;
  warning: string | null;
}

/**
 * Extract plain text from pi message content formats.
 *
 * Supported inputs:
 * - raw string
 * - content block arrays (`[{ type: "text", text: "..." }]`)
 */
export const extractTextFromMessageContent = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const textParts: string[] = [];

  for (const block of content) {
    if (typeof block !== "object" || block === null) {
      continue;
    }

    const candidate = block as { type?: unknown; text?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string") {
      textParts.push(candidate.text);
    }
  }

  return textParts.join("\n");
};

/**
 * Locate latest user-message text from a session branch.
 */
const extractLatestUserMessageText = (branchEntries: unknown[]): string => {
  for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
    const entry = branchEntries[index];

    if (typeof entry !== "object" || entry === null) {
      continue;
    }

    const typedEntry = entry as {
      type?: unknown;
      message?: {
        role?: unknown;
        content?: unknown;
      };
    };

    if (typedEntry.type !== "message" || typedEntry.message?.role !== "user") {
      continue;
    }

    const text = extractTextFromMessageContent(typedEntry.message.content).trim();
    if (text.length > 0) {
      return text;
    }
  }

  return "";
};

/**
 * Build stored exchange text using upstream-compatible shape and truncation.
 */
const buildCapturedExchangeText = (input: {
  userText: string;
  assistantText: string;
}): string => {
  const exchange = `> ${input.userText}\n\n${input.assistantText}`;

  return exchange.length > MAX_CAPTURED_EXCHANGE_LENGTH
    ? `${exchange.slice(0, MAX_CAPTURED_EXCHANGE_LENGTH)}\n[truncated]`
    : exchange;
};

/**
 * Ensure project user-memory table/indexes exist.
 */
const ensureProjectUserMemorySchema = (db: {
  exec: (sql: string) => void;
}): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL UNIQUE,
      project TEXT NOT NULL DEFAULT 'general',
      topic TEXT NOT NULL DEFAULT 'general',
      source TEXT NOT NULL DEFAULT 'auto-capture',
      timestamp TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      importance REAL DEFAULT 0.5,
      chunk_index INTEGER DEFAULT 0,
      parent_id TEXT DEFAULT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
    CREATE INDEX IF NOT EXISTS idx_memories_topic ON memories(topic);
    CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp);
    CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash);
  `);
};

/**
 * Ensure project user-memory database file + schema exist with no content writes.
 */
export const ensureProjectUserMemoryDatabase = (databasePath: string): void => {
  mkdirSync(path.dirname(databasePath), { recursive: true });

  const db = openBetterSqliteDatabase(databasePath);

  try {
    ensureProjectUserMemorySchema(db);
  } finally {
    db.close();
  }
};

/**
 * Read project user-memory counters for status/reporting UX.
 */
export const readProjectUserMemoryStatusCounts = (
  input: ReadProjectUserMemoryStatusCountsInput,
): ProjectUserMemoryStatusCounts => {
  if (!existsSync(input.databasePath)) {
    return {
      status: "no-db",
      memoryCount: 0,
      distinctTopicCount: 0,
      distinctSourceCount: 0,
      latestMemoryTimestamp: null,
      latestMemoryTopic: null,
      latestMemorySource: null,
      warning: null,
    };
  }

  const db = openBetterSqliteDatabase(input.databasePath, {
    readOnly: true,
    fileMustExist: true,
  });

  try {
    const memoryCountRow = db.prepare(`
      SELECT COUNT(*) AS total
      FROM memories
    `).all()[0];

    const topicCountRow = db.prepare(`
      SELECT COUNT(DISTINCT topic) AS total
      FROM memories
    `).all()[0];

    const sourceCountRow = db.prepare(`
      SELECT COUNT(DISTINCT source) AS total
      FROM memories
    `).all()[0];

    const latestMemoryRow = db.prepare(`
      SELECT timestamp, topic, source
      FROM memories
      ORDER BY timestamp DESC
      LIMIT 1
    `).all()[0];

    return {
      status: "ok",
      memoryCount: normalizeSqliteCountValue(memoryCountRow?.total),
      distinctTopicCount: normalizeSqliteCountValue(topicCountRow?.total),
      distinctSourceCount: normalizeSqliteCountValue(sourceCountRow?.total),
      latestMemoryTimestamp: typeof latestMemoryRow?.timestamp === "string" ? latestMemoryRow.timestamp : null,
      latestMemoryTopic: typeof latestMemoryRow?.topic === "string" ? latestMemoryRow.topic : null,
      latestMemorySource: typeof latestMemoryRow?.source === "string" ? latestMemoryRow.source : null,
      warning: null,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    if (/no such table/i.test(message)) {
      return {
        status: "ok",
        memoryCount: 0,
        distinctTopicCount: 0,
        distinctSourceCount: 0,
        latestMemoryTimestamp: null,
        latestMemoryTopic: null,
        latestMemorySource: null,
        warning: "project-memory-schema-not-initialized",
      };
    }

    return {
      status: "error",
      memoryCount: 0,
      distinctTopicCount: 0,
      distinctSourceCount: 0,
      latestMemoryTimestamp: null,
      latestMemoryTopic: null,
      latestMemorySource: null,
      warning: message,
    };
  } finally {
    db.close();
  }
};

/**
 * Persist one project-memory row to `${PROJECT}/.agent/memory/<user>.db`.
 */
export const storeProjectUserMemoryRow = (input: ProjectUserMemoryRowInput): void => {
  ensureProjectUserMemoryDatabase(input.databasePath);

  const db = openBetterSqliteDatabase(input.databasePath);

  try {
    db.prepare(`
      INSERT INTO memories (
        id,
        content,
        content_hash,
        project,
        topic,
        source,
        timestamp,
        session_id,
        importance,
        chunk_index,
        parent_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.content,
      hashMemoryContent(input.content),
      "project",
      input.topic || "general",
      input.source || "auto-capture",
      input.timestamp,
      "",
      0.5,
      0,
      null,
    );
  } finally {
    db.close();
  }
};

/**
 * Capture one assistant turn into project user-memory when content is meaningful.
 *
 * Decision:
 * - project-first retention should avoid noisy/empty rows,
 * - keep thresholds aligned with upstream auto-capture heuristics.
 */
export const captureProjectTurnIntoUserMemory = (
  input: CaptureProjectTurnInput,
): CaptureProjectTurnResult => {
  const assistantText = extractTextFromMessageContent(input.assistantMessageContent).trim();
  if (assistantText.length < MIN_ASSISTANT_TEXT_LENGTH) {
    return {
      stored: false,
      reason: "assistant-too-short",
    };
  }

  const userText = extractLatestUserMessageText(input.branchEntries);
  if (userText.length === 0) {
    return {
      stored: false,
      reason: "missing-user-message",
    };
  }

  if (userText.length < MIN_USER_TEXT_LENGTH) {
    return {
      stored: false,
      reason: "user-too-short",
    };
  }

  try {
    storeProjectUserMemoryRow({
      databasePath: input.databasePath,
      id: input.memoryId,
      content: buildCapturedExchangeText({
        userText,
        assistantText,
      }),
      topic: "general",
      source: "auto-capture",
      timestamp: input.timestamp,
    });

    return {
      stored: true,
      reason: "stored",
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      stored: false,
      reason: "error",
      error: message,
    };
  }
};
