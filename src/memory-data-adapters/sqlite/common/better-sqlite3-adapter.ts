/**
 * File intent: centralize the current better-sqlite3 engine boundary.
 *
 * This file holds the minimal database/statement types, lazy native-module
 * loading, open/close helpers, identifier quoting, schema inspection helpers,
 * additive column migration helper, and integrity diagnostics used by the
 * current SQLite-backed implementation. Do not turn this into a generic DB
 * abstraction; future backend portability should introduce domain capability
 * ports/adapters above this engine-specific layer.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * SQLite parameter values supported by better-sqlite3 prepared statements.
 */
export type BetterSqliteValue = string | number | bigint | Buffer | Float32Array | Uint8Array | null;

/**
 * Generic SQLite row shape returned by better-sqlite3 statements.
 */
export type BetterSqliteRow = Record<string, unknown>;

/**
 * Minimal statement surface used by project memory/continuity code.
 */
export interface BetterSqliteStatement {
  /** Execute statement and return all result rows. */
  all: (...params: BetterSqliteValue[]) => BetterSqliteRow[];
  /** Execute statement and return the first result row. */
  get: (...params: BetterSqliteValue[]) => BetterSqliteRow | undefined;
  /** Execute mutating statement and return better-sqlite3 run metadata. */
  run: (...params: Array<BetterSqliteValue | Record<string, BetterSqliteValue>>) => unknown;
}

/**
 * Minimal better-sqlite3 database surface used by runtime code.
 */
export interface BetterSqliteDatabase {
  /** Execute one or more SQL statements without bound parameters. */
  exec: (sql: string) => void;
  /** Prepare one SQL statement for repeated execution. */
  prepare: (sql: string) => BetterSqliteStatement;
  /** Execute a PRAGMA and optionally return results. */
  pragma?: (source: string, options?: { simple?: boolean }) => unknown;
  /** Close the native database handle. */
  close: () => void;
}

interface BetterSqliteConstructor {
  new (filename: string, options?: { readonly?: boolean; fileMustExist?: boolean }): BetterSqliteDatabase;
}

/**
 * Open options normalized across the project so we do not use multiple SQLite APIs.
 */
export interface OpenBetterSqliteDatabaseOptions {
  /** Open database read-only. */
  readOnly?: boolean;
  /** Require the DB file to already exist. */
  fileMustExist?: boolean;
}

/**
 * Lazy-load better-sqlite3 so source modules can be imported in environments where
 * native dependencies are checked separately before runtime DB access.
 */
const loadBetterSqliteConstructor = (): BetterSqliteConstructor => {
  const loaded = require("better-sqlite3") as unknown;
  const candidate = typeof loaded === "function"
    ? loaded
    : (loaded as { default?: unknown }).default;

  if (typeof candidate !== "function") {
    throw new Error("better-sqlite3 module did not export a Database constructor");
  }

  return candidate as BetterSqliteConstructor;
};

/**
 * Open a SQLite database using the single approved engine family.
 */
export const openBetterSqliteDatabase = (
  databasePath: string,
  options: OpenBetterSqliteDatabaseOptions = {},
): BetterSqliteDatabase => {
  const Database = loadBetterSqliteConstructor();

  return new Database(databasePath, {
    readonly: options.readOnly === true,
    fileMustExist: options.fileMustExist === true,
  });
};

/**
 * Execute work with a database handle and always close it afterward.
 */
export const withBetterSqliteDatabase = <T>(
  databasePath: string,
  options: OpenBetterSqliteDatabaseOptions,
  work: (db: BetterSqliteDatabase) => T,
): T => {
  const db = openBetterSqliteDatabase(databasePath, options);

  try {
    return work(db);
  } finally {
    db.close();
  }
};

/**
 * Normalize SQLite COUNT values into bounded non-negative integers.
 */
export const normalizeSqliteCountValue = (value: unknown): number => {
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
 * Quote SQLite identifiers when table names are intentionally dynamic.
 */
export const quoteSqliteIdentifier = (value: string): string =>
  `"${value.replace(/"/g, '""')}"`;

/**
 * Check whether a table exists in the selected schema.
 */
export const sqliteTableExists = (input: {
  db: BetterSqliteDatabase;
  tableName: string;
  schema?: "main" | "temp" | string;
}): boolean => {
  const schema = input.schema ? `${quoteSqliteIdentifier(input.schema)}.` : "";
  const row = input.db.prepare(`
    SELECT name
    FROM ${schema}sqlite_master
    WHERE type='table' AND name=?
  `).get(input.tableName);

  return !!row;
};

/**
 * Read column names for one table through PRAGMA metadata.
 */
export const readSqliteTableColumns = (input: {
  db: BetterSqliteDatabase;
  tableName: string;
  schema?: "main" | "temp" | string;
}): string[] => {
  const schema = input.schema ? `${quoteSqliteIdentifier(input.schema)}.` : "";
  const rows = input.db.prepare(
    `PRAGMA ${schema}table_info(${quoteSqliteIdentifier(input.tableName)})`,
  ).all();

  return rows
    .map((row) => (typeof row.name === "string" ? row.name : null))
    .filter((name): name is string => !!name);
};

/**
 * Add one missing table column using additive migration semantics only.
 */
export const ensureSqliteTableColumn = (input: {
  db: BetterSqliteDatabase;
  tableName: string;
  existingColumns: Set<string>;
  columnName: string;
  definitionSql: string;
}): void => {
  if (input.existingColumns.has(input.columnName)) {
    return;
  }

  input.db.exec(
    `ALTER TABLE ${quoteSqliteIdentifier(input.tableName)} ADD COLUMN ${input.definitionSql}`,
  );
  input.existingColumns.add(input.columnName);
};

/**
 * Return SQLite integrity_check output for diagnostics and regression tests.
 */
export const readSqliteIntegrityCheck = (databasePath: string): string =>
  withBetterSqliteDatabase(databasePath, { readOnly: true, fileMustExist: true }, (db) => {
    const row = db.prepare("PRAGMA integrity_check").get();
    const value = row ? Object.values(row)[0] : null;

    return typeof value === "string" ? value : String(value ?? "unknown");
  });
