/**
 * File intent: manage session-scoped observability, checkpoints, and hygiene.
 *
 * These services are lifecycle support code, not command/tool registration, and
 * are kept small so the extension entrypoint can remain a thin composition root.
 */

import { randomUUID } from "node:crypto";

import { purgeContinuityCompactionPreviews } from "../../../../packages/memory-core/src/adapters/sqlite/continuity/index.js";
import type { RuntimeCheckpointTracker } from "../../../../packages/memory-core/src/adapters/sqlite/runtime/index.js";
import { createRuntimeCheckpointTracker } from "../../../../packages/memory-core/src/adapters/sqlite/runtime/index.js";
import type { RuntimeContextObservabilityTracker } from "../../../../packages/memory-core/src/adapters/sqlite/runtime-context/index.js";
import { createRuntimeContextObservabilityTracker, getRuntimeContextObservabilitySnapshot } from "../../../../packages/memory-core/src/adapters/sqlite/runtime-context/index.js";
import type { MemoryExtensionRuntimeState } from "../runtime-state.js";
import { resolveSessionId } from "./common-runtime-services.js";

/**
 * Build session helper services around shared runtime state.
 */
export const createSessionServices = (input: {
  state: MemoryExtensionRuntimeState;
  storeContinuityEntryWithVectorConsistency: (entry: {
    databasePath: string;
    id: string;
    timestamp: string;
    section: "PROGRESS";
    provenance: "TOOL";
    certainty: "CONFIRMED";
    content: string;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
}): {
  getObservabilityTracker: (ctx: any) => RuntimeContextObservabilityTracker;
  getCheckpointTracker: (ctx: any) => RuntimeCheckpointTracker;
  warnCheckpointFailures: (failures: string[], reason: "periodic" | "shutdown") => void;
  buildLastQuerySuffix: (query: string | undefined) => string;
  storeSessionContinuitySummary: (input: { ctx: any; runtime: any; pendingMemoryWrites: number }) => Promise<void>;
  runContinuityCompactionLifecycleHygiene: (input: { runtime: any; trigger: "agent_end" | "session_shutdown" }) => void;
} => {
  const getObservabilityTracker = (ctx: any): RuntimeContextObservabilityTracker => {
    const sessionId = resolveSessionId(ctx);
    const existing = input.state.observabilityBySession.get(sessionId);
    if (existing) {
      return existing;
    }

    const created = createRuntimeContextObservabilityTracker(200);
    input.state.observabilityBySession.set(sessionId, created);
    return created;
  };

  const getCheckpointTracker = (ctx: any): RuntimeCheckpointTracker => {
    const sessionId = resolveSessionId(ctx);
    const existing = input.state.checkpointBySession.get(sessionId);
    if (existing) {
      return existing;
    }

    const created = createRuntimeCheckpointTracker();
    input.state.checkpointBySession.set(sessionId, created);
    return created;
  };

  const warnCheckpointFailures = (failures: string[], reason: "periodic" | "shutdown") => {
    if (failures.length === 0) {
      return;
    }

    // eslint-disable-next-line no-console
    console.warn(`[project-memory] ${reason} checkpoint completed with ${failures.length} failure(s): ${failures.join(" | ")}`);
  };

  const buildLastQuerySuffix = (query: string | undefined): string => {
    if (!query) {
      return "";
    }

    const normalized = query.trim().replace(/\s+/g, " ");
    if (normalized.length === 0) {
      return "";
    }

    const maxLength = 80;
    const clipped = normalized.length <= maxLength
      ? normalized
      : `${normalized.slice(0, maxLength - 1).trimEnd()}…`;

    return `, lastQuery="${clipped}"`;
  };

  const storeSessionContinuitySummary = async (summaryInput: {
    ctx: any;
    runtime: any;
    pendingMemoryWrites: number;
  }): Promise<void> => {
    const tracker = input.state.observabilityBySession.get(resolveSessionId(summaryInput.ctx));

    const snapshot = tracker
      ? getRuntimeContextObservabilitySnapshot(tracker)
      : {
        totalAssemblies: 0,
        degradedAssemblies: 0,
        degradedRate: 0,
        fallbackCount: 0,
        fallbackRate: 0,
        avgTotalLatencyMs: 0,
        p95TotalLatencyMs: 0,
        recent: [],
      };

    if (snapshot.totalAssemblies === 0 && summaryInput.pendingMemoryWrites === 0) {
      return;
    }

    const lastQuerySuffix = buildLastQuerySuffix(snapshot.recent.at(-1)?.query);

    const content =
      `Session summary: assemblies=${snapshot.totalAssemblies}, ` +
      `degraded=${snapshot.degradedAssemblies}, ` +
      `fallback=${snapshot.fallbackCount}, ` +
      `avgLatencyMs=${snapshot.avgTotalLatencyMs}, ` +
      `p95LatencyMs=${snapshot.p95TotalLatencyMs}, ` +
      `pendingMemoryWrites=${summaryInput.pendingMemoryWrites}, ` +
      `mode=${summaryInput.runtime.config.mode}, ` +
      `scope=${summaryInput.runtime.storePaths.activeScope}` +
      `${lastQuerySuffix}.`;

    const writeResult = await input.storeContinuityEntryWithVectorConsistency({
      databasePath: summaryInput.runtime.storePaths.projectUserDatabasePath,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      section: "PROGRESS",
      provenance: "TOOL",
      certainty: "CONFIRMED",
      content,
    });

    if (!writeResult.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[project-memory] continuity session summary write failed: ${writeResult.error}`);
    }
  };

  const runContinuityCompactionLifecycleHygiene = (hygieneInput: {
    runtime: any;
    trigger: "agent_end" | "session_shutdown";
  }): void => {
    if (!hygieneInput.runtime.config.projectMemoryEnabled || hygieneInput.runtime.storePaths.activeScope !== "project-enabled") {
      return;
    }

    const purge = purgeContinuityCompactionPreviews({
      databasePath: hygieneInput.runtime.storePaths.projectUserDatabasePath,
      nowTimestamp: new Date().toISOString(),
    });

    if (purge.expiredNonAppliedPurged > 0 || purge.appliedRetentionPurged > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[project-memory] continuity compaction preview hygiene on ${hygieneInput.trigger}: ` +
        `expiredNonAppliedPurged=${purge.expiredNonAppliedPurged}, appliedRetentionPurged=${purge.appliedRetentionPurged}.`,
      );
    }
  };

  return {
    getObservabilityTracker,
    getCheckpointTracker,
    warnCheckpointFailures,
    buildLastQuerySuffix,
    storeSessionContinuitySummary,
    runContinuityCompactionLifecycleHygiene,
  };
};
