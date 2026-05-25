/**
 * File intent: implement runtime WAL checkpoint trigger policy for SQLite DBs.
 *
 * This file tracks observed memory writes, decides when periodic or shutdown
 * checkpointing should run, and executes bounded `wal_checkpoint` operations
 * against configured database paths. Keep live checkpoint mechanics here; keep
 * benchmarking/calibration in `checkpoint-benchmark.ts`.
 */

import { existsSync } from "node:fs";

import { openBetterSqliteDatabase } from "../common/better-sqlite3-adapter.js";

/**
 * Runtime SQLite checkpoint trigger mode.
 */
export type RuntimeCheckpointMode = "off" | "shutdown" | "periodic" | "periodic+shutdown";

/**
 * SQLite checkpoint pragma modes supported by runtime checkpoint execution.
 */
export type RuntimeCheckpointPragmaMode = "PASSIVE" | "RESTART";

/**
 * Runtime SQLite checkpoint policy used to control WAL checkpoint behavior.
 */
export interface RuntimeCheckpointPolicy {
  /** Runtime checkpoint trigger mode. */
  mode: RuntimeCheckpointMode;
  /** Minimum interval between periodic checkpoints. */
  intervalSeconds: number;
  /** Minimum observed memory-write events before periodic checkpointing. */
  minimumWrites: number;
  /** SQLite checkpoint pragma mode. */
  pragmaMode: RuntimeCheckpointPragmaMode;
}

/**
 * Mutable tracker used to gate runtime checkpoint frequency.
 */
export interface RuntimeCheckpointTracker {
  /** Number of observed memory-write events since last checkpoint run. */
  writesSinceLastCheckpoint: number;
  /** Timestamp of the last checkpoint attempt. */
  lastCheckpointAtMs?: number;
}

/**
 * Result summary for one runtime checkpoint execution.
 */
export interface RuntimeCheckpointExecutionResult {
  /** Number of database paths inspected for checkpointing. */
  attemptedCount: number;
  /** Number of databases successfully checkpointed. */
  completedCount: number;
  /** Number of paths skipped because file does not exist. */
  skippedCount: number;
  /** Collected failure descriptions for visibility/debugging. */
  failures: string[];
}

/**
 * Result envelope for conditional checkpoint triggers.
 */
export interface RuntimeCheckpointRunOutcome {
  /** Whether checkpoint execution was triggered. */
  ran: boolean;
  /** Execution result when triggered. */
  result?: RuntimeCheckpointExecutionResult;
}

/**
 * Build a clean runtime checkpoint tracker.
 */
export const createRuntimeCheckpointTracker = (): RuntimeCheckpointTracker => ({
  writesSinceLastCheckpoint: 0,
});

/**
 * Record one memory-write event into the tracker.
 */
export const recordRuntimeMemoryWrite = (tracker: RuntimeCheckpointTracker): void => {
  tracker.writesSinceLastCheckpoint += 1;
};

/**
 * Reset runtime checkpoint counters after a checkpoint attempt.
 */
export const resetRuntimeCheckpointTracker = (input: {
  tracker: RuntimeCheckpointTracker;
  nowMs: number;
}): void => {
  input.tracker.writesSinceLastCheckpoint = 0;
  input.tracker.lastCheckpointAtMs = input.nowMs;
};

/**
 * Determine whether periodic checkpointing is enabled for policy mode.
 */
const isPeriodicMode = (mode: RuntimeCheckpointPolicy["mode"]): boolean =>
  mode === "periodic" || mode === "periodic+shutdown";

/**
 * Determine whether shutdown checkpointing is enabled for policy mode.
 */
const isShutdownMode = (mode: RuntimeCheckpointPolicy["mode"]): boolean =>
  mode === "shutdown" || mode === "periodic+shutdown";

/**
 * Determine if periodic checkpoint should run now.
 */
export const shouldRunPeriodicCheckpoint = (input: {
  policy: RuntimeCheckpointPolicy;
  tracker: RuntimeCheckpointTracker;
  nowMs: number;
}): boolean => {
  if (!isPeriodicMode(input.policy.mode)) {
    return false;
  }

  if (input.tracker.writesSinceLastCheckpoint < input.policy.minimumWrites) {
    return false;
  }

  if (input.tracker.lastCheckpointAtMs === undefined) {
    return true;
  }

  const elapsedMs = input.nowMs - input.tracker.lastCheckpointAtMs;
  return elapsedMs >= input.policy.intervalSeconds * 1000;
};

/**
 * Determine if shutdown checkpoint should run now.
 */
export const shouldRunShutdownCheckpoint = (input: {
  policy: RuntimeCheckpointPolicy;
  tracker: RuntimeCheckpointTracker;
}): boolean => {
  if (!isShutdownMode(input.policy.mode)) {
    return false;
  }

  return input.tracker.writesSinceLastCheckpoint > 0;
};

/**
 * Resolve checkpoint database targets from active memory scope.
 *
 * Decision: always include global DB, and include project user DB only when
 * project scope is active. De-dup keeps output stable if paths collide.
 */
export const resolveCheckpointDatabasePaths = (input: {
  activeScope: "global-only" | "project-enabled";
  globalDatabasePath: string;
  projectUserDatabasePath: string;
}): string[] => {
  const paths = [input.globalDatabasePath];

  if (input.activeScope === "project-enabled") {
    paths.push(input.projectUserDatabasePath);
  }

  return [...new Set(paths)];
};

/**
 * Execute `PRAGMA wal_checkpoint(...)` for each provided database path.
 */
export const executeRuntimeCheckpoint = (input: {
  databasePaths: string[];
  pragmaMode: RuntimeCheckpointPolicy["pragmaMode"];
}): RuntimeCheckpointExecutionResult => {
  let completedCount = 0;
  let skippedCount = 0;
  const failures: string[] = [];

  for (const dbPath of input.databasePaths) {
    if (!existsSync(dbPath)) {
      skippedCount += 1;
      continue;
    }

    try {
      const db = openBetterSqliteDatabase(dbPath);

      try {
        db.exec(`PRAGMA wal_checkpoint(${input.pragmaMode});`);
        completedCount += 1;
      } finally {
        db.close();
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${dbPath}: ${message}`);
    }
  }

  return {
    attemptedCount: input.databasePaths.length,
    completedCount,
    skippedCount,
    failures,
  };
};

/**
 * Run periodic checkpoint when policy/threshold/interval conditions are met.
 */
export const runPeriodicCheckpointIfNeeded = (input: {
  policy: RuntimeCheckpointPolicy;
  tracker: RuntimeCheckpointTracker;
  databasePaths: string[];
  nowMs?: number;
}): RuntimeCheckpointRunOutcome => {
  const nowMs = input.nowMs ?? Date.now();

  if (!shouldRunPeriodicCheckpoint({
    policy: input.policy,
    tracker: input.tracker,
    nowMs,
  })) {
    return { ran: false };
  }

  const result = executeRuntimeCheckpoint({
    databasePaths: input.databasePaths,
    pragmaMode: input.policy.pragmaMode,
  });

  resetRuntimeCheckpointTracker({
    tracker: input.tracker,
    nowMs,
  });

  return {
    ran: true,
    result,
  };
};

/**
 * Run shutdown checkpoint when policy enables it and writes are pending.
 */
export const runShutdownCheckpointIfEnabled = (input: {
  policy: RuntimeCheckpointPolicy;
  tracker: RuntimeCheckpointTracker;
  databasePaths: string[];
  nowMs?: number;
}): RuntimeCheckpointRunOutcome => {
  if (!shouldRunShutdownCheckpoint({
    policy: input.policy,
    tracker: input.tracker,
  })) {
    return { ran: false };
  }

  const nowMs = input.nowMs ?? Date.now();
  const result = executeRuntimeCheckpoint({
    databasePaths: input.databasePaths,
    pragmaMode: input.policy.pragmaMode,
  });

  resetRuntimeCheckpointTracker({
    tracker: input.tracker,
    nowMs,
  });

  return {
    ran: true,
    result,
  };
};
