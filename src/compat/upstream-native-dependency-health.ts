/**
 * File intent: probe optional native dependencies required by upstream compatibility.
 *
 * This file performs a small better-sqlite3 + sqlite-vec health check so bundled
 * upstream compatibility can fail early with a clear warning instead of surfacing
 * native binding errors during command/tool execution. Keep probe-only dependency
 * loading here to avoid hard startup coupling elsewhere.
 */

import { createRequire } from "node:module";

/**
 * Minimal database contract required for native dependency health probing.
 */
interface ProbeDatabase {
  prepare?: (query: string) => {
    get?: () => unknown;
  };
  close?: () => void;
}

/**
 * Minimal constructor contract required from better-sqlite3.
 */
interface ProbeDatabaseConstructor {
  new (databasePath: string): ProbeDatabase;
}

/**
 * Minimal sqlite-vec module surface required by upstream runtime.
 */
interface ProbeSqliteVecModule {
  load?: (database: ProbeDatabase) => unknown;
}

/**
 * Optional loader overrides used by tests to keep probe deterministic.
 */
export interface UpstreamNativeDependencyHealthCheckOptions {
  loadBetterSqlite3?: () => ProbeDatabaseConstructor;
  loadSqliteVec?: () => ProbeSqliteVecModule;
}

/**
 * Result payload for optional native dependency health checks.
 */
export interface UpstreamNativeDependencyHealthCheckResult {
  healthy: boolean;
  warning: string | null;
}

const runtimeRequire = createRequire(import.meta.url);

/**
 * Load better-sqlite3 lazily to avoid hard startup coupling.
 */
const defaultLoadBetterSqlite3 = (): ProbeDatabaseConstructor =>
  runtimeRequire("better-sqlite3") as ProbeDatabaseConstructor;

/**
 * Load sqlite-vec lazily so probe can fail closed with a clear warning.
 */
const defaultLoadSqliteVec = (): ProbeSqliteVecModule =>
  runtimeRequire("sqlite-vec") as ProbeSqliteVecModule;

/**
 * Build one deterministic warning message for degraded compatibility mode.
 */
const buildNativeDependencyWarning = (reason: string): string =>
  "Bundled upstream compatibility was disabled because optional native dependencies "
  + `could not be initialized (${reason}).`;

/**
 * Check whether bundled upstream optional native dependencies are usable.
 *
 * This probe intentionally performs one real in-memory DB open + sqlite-vec load
 * so runtime can fail early with deterministic fallback behavior instead of
 * surfacing intermittent command-time native binding failures.
 */
export const checkBundledUpstreamNativeDependencyHealth = (
  input: UpstreamNativeDependencyHealthCheckOptions = {},
): UpstreamNativeDependencyHealthCheckResult => {
  const loadBetterSqlite3 = input.loadBetterSqlite3 || defaultLoadBetterSqlite3;
  const loadSqliteVec = input.loadSqliteVec || defaultLoadSqliteVec;

  let database: ProbeDatabase | null = null;

  try {
    const BetterSqlite3 = loadBetterSqlite3();
    database = new BetterSqlite3(":memory:");

    // Run one minimal query to ensure the native binding is executable.
    database.prepare?.("SELECT 1 AS health_check").get?.();

    const sqliteVec = loadSqliteVec();
    if (!sqliteVec || typeof sqliteVec.load !== "function") {
      throw new Error("sqlite-vec module does not expose load(database)");
    }

    sqliteVec.load(database);

    return {
      healthy: true,
      warning: null,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      healthy: false,
      warning: buildNativeDependencyWarning(message),
    };
  } finally {
    try {
      database?.close?.();
    } catch {
      // Ignore close failures in probe-only flow.
    }
  }
};
