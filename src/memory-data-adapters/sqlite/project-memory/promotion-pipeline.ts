/**
 * File intent: curate durable project memories into global reusable memory.
 *
 * This file orchestrates promotion runs, legacy curated DB migration/cleanup,
 * and canonical global memory DB writes. Deterministic global promotion policy
 * lives in `packages/memory-core`; keep local-model scoring helpers in
 * `local-model-curation-gate.ts`.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_GLOBAL_PROMOTION_POLICY,
  evaluateGlobalPromotionCandidate,
} from "../../../../packages/memory-core/src/index.js";
import {
  type BetterSqliteDatabase,
  openBetterSqliteDatabase,
} from "../common/better-sqlite3-adapter.js";
import {
  readProjectIndexStatus,
  resolveProjectIndexDatabasePath,
  type ProjectIndexBuildStatus,
} from "../project-index/project-index.js";
import {
  evaluateLocalModelCurationCandidate,
  type LocalCurationEmbedText,
  type LocalModelCurationGateConfig,
} from "./local-model-curation-gate.js";

/**
 * Canonical global curated DB filename under the host-supplied global memory directory.
 *
 * Decision:
 * - align promotion storage with the intended 3-level topology using `memories.db`,
 * - keep legacy `master.db` as read/migration fallback only.
 */
export const GLOBAL_MASTER_DATABASE_FILENAME = "memories.db";

/**
 * Legacy promotion DB filename kept for backward-compatible reads/migration.
 */
export const LEGACY_GLOBAL_MASTER_DATABASE_FILENAME = "master.db";

/**
 * Default deterministic policy used for deterministic promotion decisions.
 */
export interface DeterministicPromotionPolicy {
  minimumContentLength: number;
  minimumScore: number;
  maxAcceptedPerRun: number;
  durableTopics: string[];
  blockedSources: string[];
  durableKeywords: string[];
  sensitiveKeywords: string[];
  hardBlockSensitive: boolean;
}

/**
 * Optional local-model gate used during promotion runs.
 */
export interface LocalModelPromotionGatePolicy extends LocalModelCurationGateConfig {
  /** Optional embedder injection used mainly for deterministic tests. */
  embedText?: LocalCurationEmbedText;
}

/**
 * Deterministic decision categories for promotion evaluation outcomes.
 */
export type PromotionDecisionCode =
  | "accepted"
  | "too-short"
  | "blocked-source"
  | "project-specific"
  | "sensitive-content"
  | "low-score"
  | "model-rejected";

/**
 * Candidate summary used in promotion run reporting.
 */
export interface PromotionCandidateSummary {
  candidateId: string;
  contentHash: string;
  content: string;
  topic: string;
  source: string;
  representativeUserId: string;
  occurrenceCount: number;
  distinctUserCount: number;
  score: number;
  rationale: string;
  decisionCode: PromotionDecisionCode;
}

/**
 * Promotion run result envelope.
 */
export interface PromotionRunResult {
  runId: string;
  mode: "dry-run" | "apply";
  globalMasterDatabasePath: string;
  projectIndexStatus: ProjectIndexBuildStatus;
  sourceRowCount: number;
  candidateCount: number;
  acceptedCount: number;
  rejectedCount: number;
  duplicateCount: number;
  policyUsed: DeterministicPromotionPolicy;
  localModelGateUsed: LocalModelPromotionGatePolicy;
  decisionCounts: Record<PromotionDecisionCode, number>;
  accepted: PromotionCandidateSummary[];
  rejected: PromotionCandidateSummary[];
  warnings: string[];
}

/**
 * Read-path mode used by global promotion storage resolution.
 *
 * Note:
 * - after 3-level cutover completion, read paths are canonical-only.
 */
export type PromotionStorageMode = "canonical" | "missing";

/**
 * Legacy promotion store diagnostics used for migration/cleanup visibility.
 */
export interface LegacyPromotionStoreStatus {
  path: string;
  exists: boolean;
  hasPromotionTables: boolean;
  promotedCount: number;
}

/**
 * Explicit migration result from legacy `master.db` into canonical `memories.db`.
 */
export interface LegacyPromotionMigrationResult {
  canonicalGlobalDatabasePath: string;
  legacyGlobalDatabasePath: string;
  legacyStoreBefore: LegacyPromotionStoreStatus;
  migratedPromotedRows: number;
  migratedRunRows: number;
  migratedRunItemRows: number;
  cleanupRequested: boolean;
  cleanupPerformed: boolean;
  status: "no-legacy" | "legacy-without-promotion-tables" | "already-synced" | "migrated";
  warnings: string[];
}

/**
 * Explicit cleanup result for legacy `master.db` after migration.
 */
export interface LegacyPromotionCleanupResult {
  canonicalGlobalDatabasePath: string;
  legacyGlobalDatabasePath: string;
  legacyStoreBefore: LegacyPromotionStoreStatus;
  canonicalReady: boolean;
  status: "no-legacy" | "blocked-canonical-not-ready" | "deleted" | "delete-failed";
  warning: string | null;
}

/**
 * Persisted promotion pipeline status summary.
 */
export interface PromotionPipelineStatus {
  globalMasterDatabasePath: string;
  canonicalGlobalDatabasePath: string;
  legacyGlobalDatabasePath: string;
  storageMode: PromotionStorageMode;
  exists: boolean;
  legacyStore: LegacyPromotionStoreStatus;
  promotedCount: number;
  lastPromotedAt: string | null;
  lastRun: {
    runId: string;
    evaluatedAt: string;
    acceptedCount: number;
    rejectedCount: number;
    duplicateCount: number;
    dryRun: boolean;
  } | null;
}

/**
 * One global master-memory hit used in runtime context assembly.
 */
export interface GlobalMasterMemoryHit {
  id: string;
  contentHash: string;
  content: string;
  topic: string;
  source: string;
  promotedAt: string;
  score: number;
  rationale: string;
  termMatches: number;
}

/**
 * Input for lexical search over global promoted master memory.
 */
export interface SearchGlobalMasterMemoryInput {
  globalMemoryDir: string;
  query: string;
  topK?: number;
  topicFilter?: string[];
}

/**
 * Result envelope for global master-memory lexical search.
 */
export interface SearchGlobalMasterMemoryResult {
  query: string;
  globalMasterDatabasePath: string;
  canonicalGlobalDatabasePath: string;
  legacyGlobalDatabasePath: string;
  storageMode: PromotionStorageMode;
  exists: boolean;
  legacyStore: LegacyPromotionStoreStatus;
  results: GlobalMasterMemoryHit[];
  error: string | null;
}

/**
 * Input for loading durable trait memories from master store.
 */
export interface LoadGlobalTraitMemoriesInput {
  globalMemoryDir: string;
  topK?: number;
  traitTopics?: string[];
}

/**
 * Result envelope for trait-memory loading.
 */
export interface LoadGlobalTraitMemoriesResult {
  globalMasterDatabasePath: string;
  canonicalGlobalDatabasePath: string;
  legacyGlobalDatabasePath: string;
  storageMode: PromotionStorageMode;
  exists: boolean;
  legacyStore: LegacyPromotionStoreStatus;
  results: GlobalMasterMemoryHit[];
  error: string | null;
}

/**
 * Input for explicit migration of legacy promotion data.
 */
export interface MigrateLegacyPromotionStoreInput {
  globalMemoryDir: string;
  cleanupLegacy?: boolean;
}

/**
 * Input for explicit cleanup of legacy promotion store file.
 */
export interface CleanupLegacyPromotionStoreInput {
  globalMemoryDir: string;
  force?: boolean;
}

/**
 * Input for deterministic promotion pipeline execution.
 */
export interface RunDeterministicPromotionInput {
  projectMemoryDir: string;
  globalMemoryDir: string;
  projectId?: string;
  dryRun?: boolean;
  policy?: Partial<DeterministicPromotionPolicy>;
  /** Optional local-model gate applied before global promotion writes. */
  localModelGate?: Partial<LocalModelPromotionGatePolicy>;
}

interface IndexedMemoryCandidateRow {
  user_id: string;
  content: string;
  topic: string;
  source: string;
  timestamp: string;
}

interface CandidateDraft {
  candidateId: string;
  contentHash: string;
  content: string;
  topic: string;
  source: string;
  representativeUserId: string;
  representativeTimestamp: string;
  occurrenceCount: number;
  distinctUserCount: number;
}

interface EvaluatedCandidate extends CandidateDraft {
  accepted: boolean;
  score: number;
  rationale: string;
  decisionCode: PromotionDecisionCode;
}

/**
 * Baseline policy for deterministic promotion runs.
 *
 * Decisions:
 * - keep baseline conservative to avoid polluting master memory;
 * - prefer manual/high-signal memories over auto-captured conversation noise.
 */
export const DEFAULT_DETERMINISTIC_PROMOTION_POLICY: DeterministicPromotionPolicy = {
  minimumContentLength: DEFAULT_GLOBAL_PROMOTION_POLICY.minimumContentLength,
  minimumScore: DEFAULT_GLOBAL_PROMOTION_POLICY.minimumScore,
  maxAcceptedPerRun: 200,
  durableTopics: [...DEFAULT_GLOBAL_PROMOTION_POLICY.durableTopics],
  blockedSources: [...DEFAULT_GLOBAL_PROMOTION_POLICY.blockedSources],
  durableKeywords: [...DEFAULT_GLOBAL_PROMOTION_POLICY.durableKeywords],
  sensitiveKeywords: [...DEFAULT_GLOBAL_PROMOTION_POLICY.sensitiveKeywords],
  hardBlockSensitive: DEFAULT_GLOBAL_PROMOTION_POLICY.hardBlockSensitive,
};

/**
 * Baseline config for optional local-model promotion gate.
 */
export const DEFAULT_LOCAL_MODEL_PROMOTION_GATE_POLICY: LocalModelPromotionGatePolicy = {
  minimumContentLength: 40,
  minimumDurableSimilarity: 0.33,
  minimumCompositeScore: 0.06,
};

/**
 * Resolve canonical global curated DB path.
 */
export const resolveGlobalMasterDatabasePath = (globalMemoryDir: string): string =>
  path.join(globalMemoryDir, GLOBAL_MASTER_DATABASE_FILENAME);

/**
 * Resolve legacy master DB path used before 3-level realignment.
 */
export const resolveLegacyGlobalMasterDatabasePath = (globalMemoryDir: string): string =>
  path.join(globalMemoryDir, LEGACY_GLOBAL_MASTER_DATABASE_FILENAME);

/**
 * Check whether a DB contains the promotion table expected by this pipeline.
 */
const hasPromotedMemoriesTable = (databasePath: string): boolean => {
  if (!existsSync(databasePath)) {
    return false;
  }

  let db: BetterSqliteDatabase | null = null;

  try {
    db = openBetterSqliteDatabase(databasePath, {
      readOnly: true,
      fileMustExist: true,
    });

    const row = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'promoted_memories'
    `).get();

    return Boolean(row);
  } catch {
    return false;
  } finally {
    db?.close();
  }
};

/**
 * Read-path selection result for global promotion DB access.
 */
interface CanonicalGlobalMasterDatabaseSelection {
  globalMasterDatabasePath: string;
  canonicalGlobalDatabasePath: string;
  legacyGlobalDatabasePath: string;
  storageMode: PromotionStorageMode;
}

/**
 * Count promoted-memory rows in a DB that already carries promotion tables.
 */
const countPromotedRowsInDatabase = (databasePath: string): number => {
  let db: BetterSqliteDatabase | null = null;

  try {
    db = openBetterSqliteDatabase(databasePath, {
      readOnly: true,
      fileMustExist: true,
    });
    const row = db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM promoted_memories
    `).get();

    return typeof row?.cnt === "number" ? row.cnt : 0;
  } catch {
    return 0;
  } finally {
    db?.close();
  }
};

/**
 * Read legacy promotion-store diagnostics for migration/cleanup visibility.
 */
export const readLegacyPromotionStoreStatus = (input: {
  globalMemoryDir: string;
}): LegacyPromotionStoreStatus => {
  const legacyGlobalDatabasePath = resolveLegacyGlobalMasterDatabasePath(input.globalMemoryDir);

  if (!existsSync(legacyGlobalDatabasePath)) {
    return {
      path: legacyGlobalDatabasePath,
      exists: false,
      hasPromotionTables: false,
      promotedCount: 0,
    };
  }

  const hasPromotionTables = hasPromotedMemoriesTable(legacyGlobalDatabasePath);

  return {
    path: legacyGlobalDatabasePath,
    exists: true,
    hasPromotionTables,
    promotedCount: hasPromotionTables ? countPromotedRowsInDatabase(legacyGlobalDatabasePath) : 0,
  };
};

/**
 * Resolve canonical-only global promotion DB selection.
 *
 * Decision:
 * - cutover completion removes legacy read fallback,
 * - legacy is now migration/cleanup-only and never part of runtime reads.
 */
const resolveCanonicalGlobalMasterDatabaseSelection = (
  globalMemoryDir: string,
): CanonicalGlobalMasterDatabaseSelection => {
  const canonicalGlobalDatabasePath = resolveGlobalMasterDatabasePath(globalMemoryDir);
  const legacyGlobalDatabasePath = resolveLegacyGlobalMasterDatabasePath(globalMemoryDir);

  return {
    globalMasterDatabasePath: canonicalGlobalDatabasePath,
    canonicalGlobalDatabasePath,
    legacyGlobalDatabasePath,
    storageMode: existsSync(canonicalGlobalDatabasePath) ? "canonical" : "missing",
  };
};

/**
 * Merge legacy promotion tables into canonical curated DB using INSERT OR IGNORE.
 */
const mergeLegacyPromotionDataIntoCanonical = (input: {
  globalMemoryDir: string;
  db: BetterSqliteDatabase;
}): {
  legacyPath: string | null;
  migratedPromotedRows: number;
  migratedRunRows: number;
  migratedRunItemRows: number;
} => {
  const legacyPath = resolveLegacyGlobalMasterDatabasePath(input.globalMemoryDir);

  if (!existsSync(legacyPath)) {
    return {
      legacyPath: null,
      migratedPromotedRows: 0,
      migratedRunRows: 0,
      migratedRunItemRows: 0,
    };
  }

  const countRows = (tableName: "promoted_memories" | "promotion_runs" | "promotion_run_items"): number => {
    const row = input.db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM ${tableName}
    `).get();

    return typeof row?.cnt === "number" ? row.cnt : 0;
  };

  const hasLegacyTable = (tableName: "promoted_memories" | "promotion_runs" | "promotion_run_items"): boolean => {
    const row = input.db.prepare(`
      SELECT name
      FROM legacy_master.sqlite_master
      WHERE type = 'table' AND name = ?
    `).get(tableName);

    return Boolean(row);
  };

  const escapedLegacyPath = legacyPath.replace(/'/g, "''");
  let attached = false;

  try {
    input.db.exec(`ATTACH DATABASE '${escapedLegacyPath}' AS legacy_master`);
    attached = true;

    const legacyHasPromotedRows = hasLegacyTable("promoted_memories");
    const legacyHasRunRows = hasLegacyTable("promotion_runs");
    const legacyHasRunItemRows = hasLegacyTable("promotion_run_items");

    if (!legacyHasPromotedRows && !legacyHasRunRows && !legacyHasRunItemRows) {
      return {
        legacyPath,
        migratedPromotedRows: 0,
        migratedRunRows: 0,
        migratedRunItemRows: 0,
      };
    }

    const promotedBefore = countRows("promoted_memories");
    const runsBefore = countRows("promotion_runs");
    const runItemsBefore = countRows("promotion_run_items");

    if (legacyHasPromotedRows) {
      input.db.exec(`
        INSERT OR IGNORE INTO promoted_memories (
          id,
          content_hash,
          content,
          topic,
          source,
          first_seen_at,
          promoted_at,
          promoted_from_project,
          representative_user_id,
          occurrence_count,
          distinct_user_count,
          score,
          rationale
        )
        SELECT
          id,
          content_hash,
          content,
          topic,
          source,
          first_seen_at,
          promoted_at,
          promoted_from_project,
          representative_user_id,
          occurrence_count,
          distinct_user_count,
          score,
          rationale
        FROM legacy_master.promoted_memories
      `);
    }

    if (legacyHasRunRows) {
      input.db.exec(`
        INSERT OR IGNORE INTO promotion_runs (
          run_id,
          project_memory_dir,
          evaluated_at,
          source_row_count,
          candidate_count,
          accepted_count,
          rejected_count,
          duplicate_count,
          dry_run,
          policy_json
        )
        SELECT
          run_id,
          project_memory_dir,
          evaluated_at,
          source_row_count,
          candidate_count,
          accepted_count,
          rejected_count,
          duplicate_count,
          dry_run,
          policy_json
        FROM legacy_master.promotion_runs
      `);
    }

    if (legacyHasRunItemRows) {
      input.db.exec(`
        INSERT OR IGNORE INTO promotion_run_items (
          run_id,
          candidate_id,
          outcome,
          score,
          rationale,
          content_hash
        )
        SELECT
          run_id,
          candidate_id,
          outcome,
          score,
          rationale,
          content_hash
        FROM legacy_master.promotion_run_items
      `);
    }

    const promotedAfter = countRows("promoted_memories");
    const runsAfter = countRows("promotion_runs");
    const runItemsAfter = countRows("promotion_run_items");

    return {
      legacyPath,
      migratedPromotedRows: Math.max(0, promotedAfter - promotedBefore),
      migratedRunRows: Math.max(0, runsAfter - runsBefore),
      migratedRunItemRows: Math.max(0, runItemsAfter - runItemsBefore),
    };
  } finally {
    if (attached) {
      try {
        input.db.exec("DETACH DATABASE legacy_master");
      } catch {
        // Keep runtime resilient even if SQLite cannot detach during edge-case lock windows.
      }
    }
  }
};

/**
 * Explicitly migrate legacy `master.db` promotion data into canonical `memories.db`.
 *
 * Decision:
 * - migration is now an explicit operator action,
 * - normal read/write paths do not depend on legacy fallback.
 */
export const migrateLegacyPromotionStore = async (
  input: MigrateLegacyPromotionStoreInput,
): Promise<LegacyPromotionMigrationResult> => {
  const selection = resolveCanonicalGlobalMasterDatabaseSelection(input.globalMemoryDir);
  const legacyStoreBefore = readLegacyPromotionStoreStatus({
    globalMemoryDir: input.globalMemoryDir,
  });

  if (!legacyStoreBefore.exists) {
    return {
      canonicalGlobalDatabasePath: selection.canonicalGlobalDatabasePath,
      legacyGlobalDatabasePath: selection.legacyGlobalDatabasePath,
      legacyStoreBefore,
      migratedPromotedRows: 0,
      migratedRunRows: 0,
      migratedRunItemRows: 0,
      cleanupRequested: Boolean(input.cleanupLegacy),
      cleanupPerformed: false,
      status: "no-legacy",
      warnings: [],
    };
  }

  await mkdir(input.globalMemoryDir, { recursive: true });

  const db = openBetterSqliteDatabase(selection.globalMasterDatabasePath);
  let migration = {
    legacyPath: null as string | null,
    migratedPromotedRows: 0,
    migratedRunRows: 0,
    migratedRunItemRows: 0,
  };

  try {
    ensureMasterSchema(db);
    migration = mergeLegacyPromotionDataIntoCanonical({
      globalMemoryDir: input.globalMemoryDir,
      db,
    });
  } finally {
    db.close();
  }

  const status: LegacyPromotionMigrationResult["status"] = !legacyStoreBefore.hasPromotionTables
    ? "legacy-without-promotion-tables"
    : migration.migratedPromotedRows > 0 || migration.migratedRunRows > 0 || migration.migratedRunItemRows > 0
    ? "migrated"
    : "already-synced";

  const warnings: string[] = [];
  let cleanupPerformed = false;

  if (input.cleanupLegacy) {
    const cleanupResult = await cleanupLegacyPromotionStore({
      globalMemoryDir: input.globalMemoryDir,
    });

    cleanupPerformed = cleanupResult.status === "deleted";

    if (cleanupResult.warning) {
      warnings.push(cleanupResult.warning);
    }
  }

  return {
    canonicalGlobalDatabasePath: selection.canonicalGlobalDatabasePath,
    legacyGlobalDatabasePath: selection.legacyGlobalDatabasePath,
    legacyStoreBefore,
    migratedPromotedRows: migration.migratedPromotedRows,
    migratedRunRows: migration.migratedRunRows,
    migratedRunItemRows: migration.migratedRunItemRows,
    cleanupRequested: Boolean(input.cleanupLegacy),
    cleanupPerformed,
    status,
    warnings,
  };
};

/**
 * Remove legacy `master.db` once canonical promotion tables are available.
 */
export const cleanupLegacyPromotionStore = async (
  input: CleanupLegacyPromotionStoreInput,
): Promise<LegacyPromotionCleanupResult> => {
  const selection = resolveCanonicalGlobalMasterDatabaseSelection(input.globalMemoryDir);
  const legacyStoreBefore = readLegacyPromotionStoreStatus({
    globalMemoryDir: input.globalMemoryDir,
  });

  const canonicalReady = hasPromotedMemoriesTable(selection.canonicalGlobalDatabasePath);

  if (!legacyStoreBefore.exists) {
    return {
      canonicalGlobalDatabasePath: selection.canonicalGlobalDatabasePath,
      legacyGlobalDatabasePath: selection.legacyGlobalDatabasePath,
      legacyStoreBefore,
      canonicalReady,
      status: "no-legacy",
      warning: null,
    };
  }

  if (!canonicalReady && !input.force) {
    return {
      canonicalGlobalDatabasePath: selection.canonicalGlobalDatabasePath,
      legacyGlobalDatabasePath: selection.legacyGlobalDatabasePath,
      legacyStoreBefore,
      canonicalReady,
      status: "blocked-canonical-not-ready",
      warning:
        `Cleanup blocked: canonical curated DB '${selection.canonicalGlobalDatabasePath}' has no promotion tables. ` +
        "Run legacy promotion migration first, or request forced legacy cleanup only after confirming no migration is needed.",
    };
  }

  try {
    await rm(selection.legacyGlobalDatabasePath, { force: true });

    return {
      canonicalGlobalDatabasePath: selection.canonicalGlobalDatabasePath,
      legacyGlobalDatabasePath: selection.legacyGlobalDatabasePath,
      legacyStoreBefore,
      canonicalReady,
      status: "deleted",
      warning: null,
    };
  } catch (error: unknown) {
    return {
      canonicalGlobalDatabasePath: selection.canonicalGlobalDatabasePath,
      legacyGlobalDatabasePath: selection.legacyGlobalDatabasePath,
      legacyStoreBefore,
      canonicalReady,
      status: "delete-failed",
      warning: `Cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

/**
 * Normalize content for deterministic hashing.
 */
const normalizeContent = (content: string): string =>
  content
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

/**
 * Build short deterministic hash for content identity.
 */
const shortHash = (value: string): string =>
  createHash("sha256")
    .update(value, "utf-8")
    .digest("hex")
    .slice(0, 16);

/**
 * Build stable candidate id from normalized content.
 */
const buildCandidateId = (normalizedContent: string): string =>
  `prm_${shortHash(normalizedContent)}`;

/**
 * Normalize a configurable string list to lowercase unique values.
 */
const normalizeStringList = (input: string[]): string[] =>
  [...new Set(input.map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0))];

/**
 * Normalize policy object to deterministic bounds and casing.
 */
const normalizePolicy = (policy: DeterministicPromotionPolicy): DeterministicPromotionPolicy => ({
  minimumContentLength: Math.max(1, Math.floor(policy.minimumContentLength)),
  minimumScore: Math.max(0, Math.min(1, policy.minimumScore)),
  maxAcceptedPerRun: Math.max(1, Math.floor(policy.maxAcceptedPerRun)),
  durableTopics: normalizeStringList(policy.durableTopics),
  blockedSources: normalizeStringList(policy.blockedSources),
  durableKeywords: normalizeStringList(policy.durableKeywords),
  sensitiveKeywords: normalizeStringList(policy.sensitiveKeywords),
  hardBlockSensitive: policy.hardBlockSensitive,
});

/**
 * Normalize optional local-model gate config.
 */
const normalizeLocalModelGatePolicy = (
  policy?: Partial<LocalModelPromotionGatePolicy>,
): LocalModelPromotionGatePolicy => ({
  minimumContentLength: typeof policy?.minimumContentLength === "number" && policy.minimumContentLength >= 1
    ? Math.floor(policy.minimumContentLength)
    : DEFAULT_LOCAL_MODEL_PROMOTION_GATE_POLICY.minimumContentLength,
  minimumDurableSimilarity: typeof policy?.minimumDurableSimilarity === "number"
    ? Math.max(-1, Math.min(1, policy.minimumDurableSimilarity))
    : DEFAULT_LOCAL_MODEL_PROMOTION_GATE_POLICY.minimumDurableSimilarity,
  minimumCompositeScore: typeof policy?.minimumCompositeScore === "number"
    ? Math.max(-1, Math.min(1, policy.minimumCompositeScore))
    : DEFAULT_LOCAL_MODEL_PROMOTION_GATE_POLICY.minimumCompositeScore,
  ...(policy?.embedText ? { embedText: policy.embedText } : {}),
});

/**
 * Apply local-model gate to candidates already accepted by deterministic policy.
 */
const applyLocalModelGate = async (input: {
  evaluatedCandidates: EvaluatedCandidate[];
  gatePolicy: LocalModelPromotionGatePolicy;
  warnings: string[];
}): Promise<EvaluatedCandidate[]> => {
  const updated: EvaluatedCandidate[] = [];

  for (const candidate of input.evaluatedCandidates) {
    if (!candidate.accepted) {
      updated.push(candidate);
      continue;
    }

    try {
      const modelDecision = await evaluateLocalModelCurationCandidate({
        content: candidate.content,
        topic: candidate.topic,
        source: candidate.source,
        config: {
          minimumContentLength: input.gatePolicy.minimumContentLength,
          minimumDurableSimilarity: input.gatePolicy.minimumDurableSimilarity,
          minimumCompositeScore: input.gatePolicy.minimumCompositeScore,
        },
        ...(input.gatePolicy.embedText ? { embedText: input.gatePolicy.embedText } : {}),
      });

      if (modelDecision.promoteGlobal) {
        updated.push(candidate);
        continue;
      }

      updated.push({
        ...candidate,
        accepted: false,
        decisionCode: "model-rejected",
        rationale: `${candidate.rationale}; local-model rejected (${modelDecision.rationale})`,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      input.warnings.push(`local-model gate failed for candidate ${candidate.candidateId}; keeping project-only (${message})`);

      updated.push({
        ...candidate,
        accepted: false,
        decisionCode: "model-rejected",
        rationale: `${candidate.rationale}; local-model evaluation failed (${message})`,
      });
    }
  }

  return updated;
};

/**
 * Create initialized decision counter object.
 */
const createDecisionCounts = (): Record<PromotionDecisionCode, number> => ({
  accepted: 0,
  "too-short": 0,
  "blocked-source": 0,
  "project-specific": 0,
  "sensitive-content": 0,
  "low-score": 0,
  "model-rejected": 0,
});

/**
 * Parse query terms used by lexical matching in master-memory reads.
 */
const parseQueryTerms = (query: string): string[] =>
  query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);

/**
 * Count query term matches in content/topic text.
 */
const countTermMatches = (terms: string[], content: string, topic: string): number => {
  if (terms.length === 0) {
    return 0;
  }

  const haystack = `${content}\n${topic}`.toLowerCase();
  return terms.reduce((acc, term) => acc + (haystack.includes(term) ? 1 : 0), 0);
};

/**
 * Ensure master promotion schema exists.
 */
const ensureMasterSchema = (db: {
  exec: (sql: string) => void;
}): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS promoted_memories (
      id TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      topic TEXT NOT NULL,
      source TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      promoted_at TEXT NOT NULL,
      promoted_from_project TEXT NOT NULL,
      representative_user_id TEXT NOT NULL,
      occurrence_count INTEGER NOT NULL,
      distinct_user_count INTEGER NOT NULL,
      score REAL NOT NULL,
      rationale TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_promoted_memories_promoted_at
      ON promoted_memories(promoted_at);

    CREATE INDEX IF NOT EXISTS idx_promoted_memories_topic
      ON promoted_memories(topic);

    CREATE TABLE IF NOT EXISTS promotion_runs (
      run_id TEXT PRIMARY KEY,
      project_memory_dir TEXT NOT NULL,
      evaluated_at TEXT NOT NULL,
      source_row_count INTEGER NOT NULL,
      candidate_count INTEGER NOT NULL,
      accepted_count INTEGER NOT NULL,
      rejected_count INTEGER NOT NULL,
      duplicate_count INTEGER NOT NULL,
      dry_run INTEGER NOT NULL,
      policy_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS promotion_run_items (
      run_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      score REAL NOT NULL,
      rationale TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      PRIMARY KEY (run_id, candidate_id)
    );
  `);
};

/**
 * Read indexed memory rows from project cache DB (`cache.db`).
 */
const readIndexedRows = (input: {
  projectMemoryDir: string;
  ownerUserId?: string | null;
}): IndexedMemoryCandidateRow[] => {
  const projectIndexPath = resolveProjectIndexDatabasePath(input.projectMemoryDir);

  if (!existsSync(projectIndexPath)) {
    return [];
  }

  const db = openBetterSqliteDatabase(projectIndexPath, {
    readOnly: true,
    fileMustExist: true,
  });

  try {
    const tableExists = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'indexed_memories'
    `).get();

    if (!tableExists) {
      return [];
    }

    const ownerUserId = input.ownerUserId?.trim() || null;

    const rows = ownerUserId
      ? db.prepare(`
        SELECT user_id, content, topic, source, timestamp
        FROM indexed_memories
        WHERE owner_user_id = ?
          AND record_kind = 'memory'
        ORDER BY timestamp DESC
      `).all(ownerUserId)
      : db.prepare(`
        SELECT user_id, content, topic, source, timestamp
        FROM indexed_memories
        WHERE record_kind = 'memory'
        ORDER BY timestamp DESC
      `).all();

    return (rows as Array<Record<string, unknown>>).map((row) => ({
      user_id: typeof row.user_id === "string" ? row.user_id : "unknown-user",
      content: typeof row.content === "string" ? row.content : "",
      topic: typeof row.topic === "string" ? row.topic : "general",
      source: typeof row.source === "string" ? row.source : "unknown",
      timestamp: typeof row.timestamp === "string" ? row.timestamp : "",
    }));
  } finally {
    db.close();
  }
};

/**
 * Build deduplicated candidate drafts from indexed rows.
 */
const buildCandidateDrafts = (rows: IndexedMemoryCandidateRow[]): CandidateDraft[] => {
  const grouped = new Map<string, {
    representative: IndexedMemoryCandidateRow;
    occurrenceCount: number;
    users: Set<string>;
  }>();

  for (const row of rows) {
    const normalized = normalizeContent(row.content);
    if (!normalized) {
      continue;
    }

    const hash = shortHash(normalized);
    const current = grouped.get(hash);

    if (!current) {
      grouped.set(hash, {
        representative: row,
        occurrenceCount: 1,
        users: new Set([row.user_id]),
      });
      continue;
    }

    current.occurrenceCount += 1;
    current.users.add(row.user_id);

    if (row.timestamp > current.representative.timestamp) {
      current.representative = row;
    }
  }

  return [...grouped.entries()].map(([contentHash, state]) => {
    const normalized = normalizeContent(state.representative.content);

    return {
      candidateId: buildCandidateId(normalized),
      contentHash,
      content: state.representative.content,
      topic: state.representative.topic,
      source: state.representative.source,
      representativeUserId: state.representative.user_id,
      representativeTimestamp: state.representative.timestamp,
      occurrenceCount: state.occurrenceCount,
      distinctUserCount: state.users.size,
    };
  });
};

/**
 * Evaluate a candidate against deterministic promotion policy.
 */
const evaluateCandidate = (
  draft: CandidateDraft,
  policy: DeterministicPromotionPolicy,
): EvaluatedCandidate => {
  const evaluation = evaluateGlobalPromotionCandidate({
    content: draft.content,
    topic: draft.topic,
    source: draft.source,
    occurrenceCount: draft.occurrenceCount,
    distinctUserCount: draft.distinctUserCount,
  }, {
    minimumContentLength: policy.minimumContentLength,
    minimumScore: policy.minimumScore,
    durableTopics: policy.durableTopics,
    blockedSources: policy.blockedSources,
    durableKeywords: policy.durableKeywords,
    sensitiveKeywords: policy.sensitiveKeywords,
    hardBlockSensitive: policy.hardBlockSensitive,
  });

  return {
    ...draft,
    accepted: evaluation.accepted,
    score: evaluation.score,
    rationale: evaluation.rationale,
    decisionCode: evaluation.decisionCode,
  };
};

/**
 * Persist one promotion run report.
 */
const persistPromotionRun = (input: {
  db: {
    prepare: (sql: string) => {
      run: (...params: Array<string | number>) => unknown;
    };
  };
  runId: string;
  projectMemoryDir: string;
  evaluatedAt: string;
  sourceRowCount: number;
  candidateCount: number;
  acceptedCount: number;
  rejectedCount: number;
  duplicateCount: number;
  dryRun: boolean;
  policy: DeterministicPromotionPolicy;
  accepted: EvaluatedCandidate[];
  rejected: EvaluatedCandidate[];
}): void => {
  input.db.prepare(`
    INSERT INTO promotion_runs (run_id, project_memory_dir, evaluated_at, source_row_count, candidate_count, accepted_count, rejected_count, duplicate_count, dry_run, policy_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.runId,
    input.projectMemoryDir,
    input.evaluatedAt,
    input.sourceRowCount,
    input.candidateCount,
    input.acceptedCount,
    input.rejectedCount,
    input.duplicateCount,
    input.dryRun ? 1 : 0,
    JSON.stringify(input.policy),
  );

  const insertRunItem = input.db.prepare(`
    INSERT INTO promotion_run_items (run_id, candidate_id, outcome, score, rationale, content_hash)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const candidate of input.accepted) {
    insertRunItem.run(
      input.runId,
      candidate.candidateId,
      candidate.decisionCode,
      candidate.score,
      candidate.rationale,
      candidate.contentHash,
    );
  }

  for (const candidate of input.rejected) {
    insertRunItem.run(
      input.runId,
      candidate.candidateId,
      candidate.decisionCode,
      candidate.score,
      candidate.rationale,
      candidate.contentHash,
    );
  }
};

/**
 * Execute deterministic promotion pipeline from project index into master memory.
 */
export const runDeterministicPromotionPipeline = async (
  input: RunDeterministicPromotionInput,
): Promise<PromotionRunResult> => {
  const projectIndexStatus = await readProjectIndexStatus({
    projectMemoryDir: input.projectMemoryDir,
  });

  const policy = normalizePolicy({
    ...DEFAULT_DETERMINISTIC_PROMOTION_POLICY,
    ...input.policy,
    durableTopics: input.policy?.durableTopics ?? DEFAULT_DETERMINISTIC_PROMOTION_POLICY.durableTopics,
    blockedSources: input.policy?.blockedSources ?? DEFAULT_DETERMINISTIC_PROMOTION_POLICY.blockedSources,
    durableKeywords: input.policy?.durableKeywords ?? DEFAULT_DETERMINISTIC_PROMOTION_POLICY.durableKeywords,
    sensitiveKeywords: input.policy?.sensitiveKeywords ?? DEFAULT_DETERMINISTIC_PROMOTION_POLICY.sensitiveKeywords,
    hardBlockSensitive: input.policy?.hardBlockSensitive ?? DEFAULT_DETERMINISTIC_PROMOTION_POLICY.hardBlockSensitive,
  });

  const localModelGatePolicy = normalizeLocalModelGatePolicy(input.localModelGate);

  const runId = `prun_${Date.now()}_${shortHash(`${input.projectMemoryDir}:${Math.random()}`)}`;
  const mode = input.dryRun ? "dry-run" : "apply";
  const globalMasterDatabasePath = resolveGlobalMasterDatabasePath(input.globalMemoryDir);

  const warnings: string[] = [];

  if (projectIndexStatus.status !== "ready" && projectIndexStatus.status !== "partial") {
    warnings.push(`index status is '${projectIndexStatus.status}'; run '/memory project index rebuild' first`);

    return {
      runId,
      mode,
      globalMasterDatabasePath,
      projectIndexStatus: projectIndexStatus.status,
      sourceRowCount: 0,
      candidateCount: 0,
      acceptedCount: 0,
      rejectedCount: 0,
      duplicateCount: 0,
      policyUsed: policy,
      localModelGateUsed: localModelGatePolicy,
      decisionCounts: createDecisionCounts(),
      accepted: [],
      rejected: [],
      warnings,
    };
  }

  const indexedRows = readIndexedRows({
    projectMemoryDir: input.projectMemoryDir,
    ownerUserId: projectIndexStatus.ownerUserId,
  });
  const drafts = buildCandidateDrafts(indexedRows);

  let evaluated = drafts
    .map((candidate) => evaluateCandidate(candidate, policy))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return b.representativeTimestamp.localeCompare(a.representativeTimestamp);
    });

  evaluated = await applyLocalModelGate({
    evaluatedCandidates: evaluated,
    gatePolicy: localModelGatePolicy,
    warnings,
  });

  const decisionCounts = createDecisionCounts();
  for (const candidate of evaluated) {
    decisionCounts[candidate.decisionCode] += 1;
  }

  const acceptedCandidates = evaluated
    .filter((candidate) => candidate.accepted)
    .slice(0, policy.maxAcceptedPerRun);

  const rejectedCandidates = evaluated.filter((candidate) => !candidate.accepted);

  if (input.dryRun) {
    return {
      runId,
      mode,
      globalMasterDatabasePath,
      projectIndexStatus: projectIndexStatus.status,
      sourceRowCount: indexedRows.length,
      candidateCount: drafts.length,
      acceptedCount: acceptedCandidates.length,
      rejectedCount: rejectedCandidates.length,
      duplicateCount: 0,
      policyUsed: policy,
      localModelGateUsed: localModelGatePolicy,
      decisionCounts,
      accepted: acceptedCandidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        contentHash: candidate.contentHash,
        content: candidate.content,
        topic: candidate.topic,
        source: candidate.source,
        representativeUserId: candidate.representativeUserId,
        occurrenceCount: candidate.occurrenceCount,
        distinctUserCount: candidate.distinctUserCount,
        score: candidate.score,
        rationale: candidate.rationale,
        decisionCode: candidate.decisionCode,
      })),
      rejected: rejectedCandidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        contentHash: candidate.contentHash,
        content: candidate.content,
        topic: candidate.topic,
        source: candidate.source,
        representativeUserId: candidate.representativeUserId,
        occurrenceCount: candidate.occurrenceCount,
        distinctUserCount: candidate.distinctUserCount,
        score: candidate.score,
        rationale: candidate.rationale,
        decisionCode: candidate.decisionCode,
      })),
      warnings,
    };
  }

  await mkdir(input.globalMemoryDir, { recursive: true });

  const db = openBetterSqliteDatabase(globalMasterDatabasePath);
  let duplicateCount = 0;

  try {
    ensureMasterSchema(db);

    // Legacy migration/cleanup is an explicit operator action so normal promotion
    // runs stay deterministic and canonical-only.

    const findByHash = db.prepare(`
      SELECT id
      FROM promoted_memories
      WHERE content_hash = ?
      LIMIT 1
    `);

    const insertPromotion = db.prepare(`
      INSERT INTO promoted_memories (
        id,
        content_hash,
        content,
        topic,
        source,
        first_seen_at,
        promoted_at,
        promoted_from_project,
        representative_user_id,
        occurrence_count,
        distinct_user_count,
        score,
        rationale
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const promotedAt = new Date().toISOString();
    const promotedProject = input.projectId || path.basename(path.resolve(input.projectMemoryDir, "..", ".."));

    const actuallyAccepted: EvaluatedCandidate[] = [];

    for (const candidate of acceptedCandidates) {
      const existing = findByHash.get(candidate.contentHash);
      if (existing) {
        duplicateCount += 1;
        continue;
      }

      insertPromotion.run(
        candidate.candidateId,
        candidate.contentHash,
        candidate.content,
        candidate.topic,
        candidate.source,
        candidate.representativeTimestamp || promotedAt,
        promotedAt,
        promotedProject,
        candidate.representativeUserId,
        candidate.occurrenceCount,
        candidate.distinctUserCount,
        candidate.score,
        candidate.rationale,
      );

      actuallyAccepted.push(candidate);
    }

    persistPromotionRun({
      db,
      runId,
      projectMemoryDir: input.projectMemoryDir,
      evaluatedAt: promotedAt,
      sourceRowCount: indexedRows.length,
      candidateCount: drafts.length,
      acceptedCount: actuallyAccepted.length,
      rejectedCount: rejectedCandidates.length,
      duplicateCount,
      dryRun: false,
      policy,
      accepted: actuallyAccepted,
      rejected: rejectedCandidates,
    });

    return {
      runId,
      mode,
      globalMasterDatabasePath,
      projectIndexStatus: projectIndexStatus.status,
      sourceRowCount: indexedRows.length,
      candidateCount: drafts.length,
      acceptedCount: actuallyAccepted.length,
      rejectedCount: rejectedCandidates.length,
      duplicateCount,
      policyUsed: policy,
      localModelGateUsed: localModelGatePolicy,
      decisionCounts,
      accepted: actuallyAccepted.map((candidate) => ({
        candidateId: candidate.candidateId,
        contentHash: candidate.contentHash,
        content: candidate.content,
        topic: candidate.topic,
        source: candidate.source,
        representativeUserId: candidate.representativeUserId,
        occurrenceCount: candidate.occurrenceCount,
        distinctUserCount: candidate.distinctUserCount,
        score: candidate.score,
        rationale: candidate.rationale,
        decisionCode: candidate.decisionCode,
      })),
      rejected: rejectedCandidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        contentHash: candidate.contentHash,
        content: candidate.content,
        topic: candidate.topic,
        source: candidate.source,
        representativeUserId: candidate.representativeUserId,
        occurrenceCount: candidate.occurrenceCount,
        distinctUserCount: candidate.distinctUserCount,
        score: candidate.score,
        rationale: candidate.rationale,
        decisionCode: candidate.decisionCode,
      })),
      warnings,
    };
  } finally {
    db.close();
  }
};

/**
 * Read promoted-memory rows from master DB with optional lexical/topic filters.
 */
const readPromotedRows = (input: {
  db: {
    prepare: (sql: string) => {
      all: (...params: Array<string | number>) => Array<Record<string, unknown>>;
      get: (...params: Array<string | number>) => Record<string, unknown> | undefined;
    };
  };
  query: string;
  topK: number;
  topicFilter?: string[];
}): GlobalMasterMemoryHit[] => {
  const terms = parseQueryTerms(input.query);
  const params: Array<string | number> = [];
  const whereClauses: string[] = [];

  const topicFilter = (input.topicFilter ?? []).map((topic) => topic.trim().toLowerCase()).filter(Boolean);
  if (topicFilter.length > 0) {
    const placeholders = topicFilter.map(() => "?").join(",");
    whereClauses.push(`LOWER(topic) IN (${placeholders})`);
    params.push(...topicFilter);
  }

  if (terms.length > 0) {
    const termClauses: string[] = [];
    for (const term of terms) {
      termClauses.push("(content LIKE ? OR topic LIKE ?)");
      const pattern = `%${term}%`;
      params.push(pattern, pattern);
    }
    whereClauses.push(`(${termClauses.join(" OR ")})`);
  }

  let sql = `
    SELECT id, content_hash, content, topic, source, promoted_at, score, rationale
    FROM promoted_memories
  `;

  if (whereClauses.length > 0) {
    sql += ` WHERE ${whereClauses.join(" AND ")}`;
  }

  sql += " ORDER BY promoted_at DESC LIMIT ?";
  params.push(terms.length > 0 ? Math.max(input.topK * 4, input.topK) : input.topK);

  const rows = input.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

  const hits: GlobalMasterMemoryHit[] = rows.map((row) => {
    const content = typeof row.content === "string" ? row.content : "";
    const topic = typeof row.topic === "string" ? row.topic : "general";

    return {
      id: typeof row.id === "string" ? row.id : "unknown-id",
      contentHash: typeof row.content_hash === "string" ? row.content_hash : "unknown-hash",
      content,
      topic,
      source: typeof row.source === "string" ? row.source : "unknown",
      promotedAt: typeof row.promoted_at === "string" ? row.promoted_at : "",
      score: typeof row.score === "number" ? row.score : 0,
      rationale: typeof row.rationale === "string" ? row.rationale : "",
      termMatches: countTermMatches(terms, content, topic),
    };
  });

  hits.sort((a, b) => {
    if (b.termMatches !== a.termMatches) {
      return b.termMatches - a.termMatches;
    }
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return b.promotedAt.localeCompare(a.promotedAt);
  });

  return hits.slice(0, input.topK);
};

/**
 * Search global promoted master memory with lexical filtering.
 */
export const searchGlobalMasterMemory = async (
  input: SearchGlobalMasterMemoryInput,
): Promise<SearchGlobalMasterMemoryResult> => {
  const topK = Math.max(1, Math.min(input.topK ?? 20, 200));
  const selection = resolveCanonicalGlobalMasterDatabaseSelection(input.globalMemoryDir);
  const legacyStore = readLegacyPromotionStoreStatus({
    globalMemoryDir: input.globalMemoryDir,
  });

  if (!existsSync(selection.globalMasterDatabasePath)) {
    return {
      query: input.query,
      globalMasterDatabasePath: selection.globalMasterDatabasePath,
      canonicalGlobalDatabasePath: selection.canonicalGlobalDatabasePath,
      legacyGlobalDatabasePath: selection.legacyGlobalDatabasePath,
      storageMode: selection.storageMode,
      exists: false,
      legacyStore,
      results: [],
      error: null,
    };
  }

  const db = openBetterSqliteDatabase(selection.globalMasterDatabasePath, {
    readOnly: true,
    fileMustExist: true,
  });

  try {
    const tableExists = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'promoted_memories'
    `).get();

    if (!tableExists) {
      return {
        query: input.query,
        globalMasterDatabasePath: selection.globalMasterDatabasePath,
        canonicalGlobalDatabasePath: selection.canonicalGlobalDatabasePath,
        legacyGlobalDatabasePath: selection.legacyGlobalDatabasePath,
        storageMode: selection.storageMode,
        exists: true,
        legacyStore,
        results: [],
        error: "promoted_memories table not found",
      };
    }

    const results = readPromotedRows({
      db,
      query: input.query,
      topK,
      topicFilter: input.topicFilter,
    });

    return {
      query: input.query,
      globalMasterDatabasePath: selection.globalMasterDatabasePath,
      canonicalGlobalDatabasePath: selection.canonicalGlobalDatabasePath,
      legacyGlobalDatabasePath: selection.legacyGlobalDatabasePath,
      storageMode: selection.storageMode,
      exists: true,
      legacyStore,
      results,
      error: null,
    };
  } catch (error: unknown) {
    return {
      query: input.query,
      globalMasterDatabasePath: selection.globalMasterDatabasePath,
      canonicalGlobalDatabasePath: selection.canonicalGlobalDatabasePath,
      legacyGlobalDatabasePath: selection.legacyGlobalDatabasePath,
      storageMode: selection.storageMode,
      exists: true,
      legacyStore,
      results: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db.close();
  }
};

/**
 * Load durable trait memories from global master store.
 */
export const loadGlobalTraitMemories = async (
  input: LoadGlobalTraitMemoriesInput,
): Promise<LoadGlobalTraitMemoriesResult> => {
  const topK = Math.max(1, Math.min(input.topK ?? 10, 100));
  const traitTopics = input.traitTopics ?? [
    "trait",
    "traits",
    "preference",
    "preferences",
    "principle",
    "principles",
    "standard",
    "standards",
    "identity",
    "process",
  ];

  const search = await searchGlobalMasterMemory({
    globalMemoryDir: input.globalMemoryDir,
    query: "",
    topK,
    topicFilter: traitTopics,
  });

  return {
    globalMasterDatabasePath: search.globalMasterDatabasePath,
    canonicalGlobalDatabasePath: search.canonicalGlobalDatabasePath,
    legacyGlobalDatabasePath: search.legacyGlobalDatabasePath,
    storageMode: search.storageMode,
    exists: search.exists,
    legacyStore: search.legacyStore,
    results: search.results,
    error: search.error,
  };
};

/**
 * Read current promotion pipeline status from master DB.
 */
export const readPromotionPipelineStatus = async (input: {
  globalMemoryDir: string;
}): Promise<PromotionPipelineStatus> => {
  const selection = resolveCanonicalGlobalMasterDatabaseSelection(input.globalMemoryDir);
  const legacyStore = readLegacyPromotionStoreStatus({
    globalMemoryDir: input.globalMemoryDir,
  });

  if (!existsSync(selection.globalMasterDatabasePath)) {
    return {
      globalMasterDatabasePath: selection.globalMasterDatabasePath,
      canonicalGlobalDatabasePath: selection.canonicalGlobalDatabasePath,
      legacyGlobalDatabasePath: selection.legacyGlobalDatabasePath,
      storageMode: selection.storageMode,
      exists: false,
      legacyStore,
      promotedCount: 0,
      lastPromotedAt: null,
      lastRun: null,
    };
  }

  const db = openBetterSqliteDatabase(selection.globalMasterDatabasePath, {
    readOnly: true,
    fileMustExist: true,
  });

  try {
    const promotedCountRow = db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM promoted_memories
    `).get();

    const lastPromotedRow = db.prepare(`
      SELECT MAX(promoted_at) AS ts
      FROM promoted_memories
    `).get();

    const lastRunRow = db.prepare(`
      SELECT run_id, evaluated_at, accepted_count, rejected_count, duplicate_count, dry_run
      FROM promotion_runs
      ORDER BY evaluated_at DESC
      LIMIT 1
    `).get();

    return {
      globalMasterDatabasePath: selection.globalMasterDatabasePath,
      canonicalGlobalDatabasePath: selection.canonicalGlobalDatabasePath,
      legacyGlobalDatabasePath: selection.legacyGlobalDatabasePath,
      storageMode: selection.storageMode,
      exists: true,
      legacyStore,
      promotedCount: typeof promotedCountRow?.cnt === "number" ? promotedCountRow.cnt : 0,
      lastPromotedAt: typeof lastPromotedRow?.ts === "string" ? lastPromotedRow.ts : null,
      lastRun: lastRunRow
        ? {
          runId: typeof lastRunRow.run_id === "string" ? lastRunRow.run_id : "unknown-run",
          evaluatedAt: typeof lastRunRow.evaluated_at === "string" ? lastRunRow.evaluated_at : "",
          acceptedCount: typeof lastRunRow.accepted_count === "number" ? lastRunRow.accepted_count : 0,
          rejectedCount: typeof lastRunRow.rejected_count === "number" ? lastRunRow.rejected_count : 0,
          duplicateCount: typeof lastRunRow.duplicate_count === "number" ? lastRunRow.duplicate_count : 0,
          dryRun: lastRunRow.dry_run === 1,
        }
        : null,
    };
  } catch {
    return {
      globalMasterDatabasePath: selection.globalMasterDatabasePath,
      canonicalGlobalDatabasePath: selection.canonicalGlobalDatabasePath,
      legacyGlobalDatabasePath: selection.legacyGlobalDatabasePath,
      storageMode: selection.storageMode,
      exists: true,
      legacyStore,
      promotedCount: 0,
      lastPromotedAt: null,
      lastRun: null,
    };
  } finally {
    db.close();
  }
};
