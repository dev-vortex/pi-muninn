/**
 * File intent: own the canonical SQLite persistence layer for continuity.
 *
 * This file holds schema creation, entry/milestone CRUD, compaction preview/apply
 * lifecycle state, telemetry counters, duplicate/quality checks, and low-level
 * query helpers for the continuity sidecar DB. Keep domain storage invariants
 * here so extension commands and runtime policy code do not hand-roll SQL.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import {
  type BetterSqliteDatabase,
  openBetterSqliteDatabase,
} from "../common/better-sqlite3-adapter.js";
import {
  encodeContinuityMetadata,
  type ContinuityMetadataLabels,
  type ContinuitySection,
} from "../../../continuity/continuity-codebook.js";

/**
 * Stored continuity entry decoded into human-readable labels.
 */
export interface ContinuityEntryRecord extends ContinuityMetadataLabels {
  id: string;
  timestamp: string;
  content: string;
}

/**
 * Continuity entry row with lifecycle-link columns used by compaction validation/apply.
 */
export interface ContinuityEntryLifecycleRecord extends ContinuityEntryRecord {
  supersededByEntryId: string | null;
  compactedIntoEntryId: string | null;
}

/**
 * Stored continuity milestone decoded into human-readable labels.
 */
export interface ContinuityMilestoneRecord extends ContinuityMetadataLabels {
  id: string;
  timestamp: string;
  summary: string;
  coveredFromTimestamp: string | null;
  coveredToTimestamp: string | null;
  sourceEntryCount: number;
}

/**
 * Supported status values for one persisted compaction preview.
 */
export type ContinuityCompactionPreviewStatus =
  | "approved"
  | "approved_with_advisories"
  | "rejected"
  | "applied"
  | "expired";

/**
 * Persisted compaction preview metadata used by preview/apply lifecycle controls.
 */
export interface ContinuityCompactionPreviewRecord {
  previewId: string;
  requestScopeId: string;
  requestProfile: "strict" | "long-request";
  basedOnPreviewId: string | null;
  revisionChainId: string;
  revisionNumber: number;
  proposalFingerprint: string;
  proposalJson: string;
  validationJson: string;
  status: ContinuityCompactionPreviewStatus;
  createdAt: string;
  expiresAt: string;
  appliedAt: string | null;
  purgeAfterAt: string;
}

/**
 * Input for storing one continuity entry.
 */
export interface StoreContinuityEntryInput extends ContinuityMetadataLabels {
  databasePath: string;
  id: string;
  timestamp: string;
  content: string;
}

/**
 * Input for storing one continuity milestone.
 */
export interface StoreContinuityMilestoneInput extends ContinuityMetadataLabels {
  databasePath: string;
  id: string;
  timestamp: string;
  summary: string;
  coveredFromTimestamp?: string;
  coveredToTimestamp?: string;
  sourceEntryCount?: number;
}

/**
 * Input for storing one immutable compaction preview row.
 */
export interface StoreContinuityCompactionPreviewInput {
  databasePath: string;
  previewId: string;
  requestScopeId: string;
  requestProfile: "strict" | "long-request";
  basedOnPreviewId?: string;
  revisionChainId: string;
  revisionNumber: number;
  proposalFingerprint: string;
  proposalJson: string;
  validationJson: string;
  status: ContinuityCompactionPreviewStatus;
  createdAt: string;
  expiresAt: string;
  appliedAt?: string;
  purgeAfterAt: string;
}

/**
 * Input for reading one persisted compaction preview by id.
 */
export interface ReadContinuityCompactionPreviewInput {
  databasePath: string;
  previewId: string;
}

/**
 * Input for counting persisted previews in one runtime request scope.
 */
export interface CountContinuityCompactionPreviewsInScopeInput {
  databasePath: string;
  requestScopeId: string;
  statusFilter?: ContinuityCompactionPreviewStatus[];
}

/**
 * Input for updating one compaction preview status.
 */
export interface UpdateContinuityCompactionPreviewStatusInput {
  databasePath: string;
  previewId: string;
  status: ContinuityCompactionPreviewStatus;
  appliedAt?: string;
  purgeAfterAt?: string;
}

/**
 * Input for purging expired/retention-completed compaction previews.
 */
export interface PurgeContinuityCompactionPreviewsInput {
  databasePath: string;
  nowTimestamp: string;
}

/**
 * Purge counters for compaction preview retention lifecycle.
 */
export interface PurgeContinuityCompactionPreviewsResult {
  expiredNonAppliedPurged: number;
  appliedRetentionPurged: number;
}

/**
 * Input for deleting one continuity entry by id.
 */
export interface DeleteContinuityEntryInput {
  databasePath: string;
  id: string;
}

/**
 * Input for reading continuity entries.
 */
export interface ReadContinuityEntriesInput {
  databasePath: string;
  limit?: number;
  sectionFilter?: ContinuitySection[];
  /** Include compacted rows whose `compacted_into_entry_id` is set. Default: false. */
  includeCompacted?: boolean;
}

/**
 * Input for reading one bounded set of continuity entries by explicit ids.
 */
export interface ReadContinuityEntriesByIdsInput {
  databasePath: string;
  entryIds: string[];
}

/**
 * Input for marking source continuity rows as compacted into one summary entry.
 */
export interface MarkContinuityEntriesCompactedIntoInput {
  databasePath: string;
  sourceEntryIds: string[];
  compactedIntoEntryId: string;
}

/**
 * Input for clearing compaction linkage from source continuity rows.
 */
export interface ClearContinuityEntriesCompactedIntoInput {
  databasePath: string;
  sourceEntryIds: string[];
  compactedIntoEntryId?: string;
}

/**
 * Input for reading continuity milestones.
 */
export interface ReadContinuityMilestonesInput {
  databasePath: string;
  limit?: number;
}

/**
 * Input for reading continuity status counters used by command/status surfaces.
 */
export interface ReadContinuityStatusCountsInput {
  databasePath: string;
}

/**
 * Aggregate continuity status counters for one project continuity DB.
 */
export interface ContinuityStatusCounts {
  status: "ok" | "no-db" | "error";
  entryCount: number;
  milestoneCount: number;
  semanticEntryCount: number;
  userProvenanceEntryCount: number;
  latestEntryTimestamp: string | null;
  latestEntrySection: ContinuitySection | null;
  latestEntryProvenance: ContinuityMetadataLabels["provenance"] | null;
  warning: string | null;
}

/**
 * Input for reading compaction-preview lifecycle counters.
 */
export interface ReadContinuityCompactionPreviewStatusCountsInput {
  databasePath: string;
}

/**
 * Aggregate compaction-preview counters for observability/status surfaces.
 */
export interface ContinuityCompactionPreviewStatusCounts {
  status: "ok" | "no-db" | "error";
  totalCount: number;
  approvedCount: number;
  approvedWithAdvisoriesCount: number;
  rejectedCount: number;
  appliedCount: number;
  expiredCount: number;
  latestCreatedAt: string | null;
  latestAppliedAt: string | null;
  warning: string | null;
}

/**
 * Supported continuity telemetry event types for KPI baseline reporting.
 */
export type ContinuityTelemetryEventType =
  | "continuity_turn_briefing"
  | "continuity_query"
  | "continuity_write_stored"
  | "continuity_write_skipped_duplicate"
  | "continuity_write_skipped_low_signal"
  | "continuity_compact_preview_result"
  | "continuity_compact_apply_result";

/**
 * Allowed review labels for one false-reject telemetry candidate.
 */
export type ContinuityTelemetryReviewLabel =
  | "valid_reject"
  | "false_reject"
  | "uncertain";

/**
 * Input for storing/updating one telemetry review label.
 */
export interface StoreContinuityTelemetryReviewLabelInput {
  databasePath: string;
  eventId: string;
  label: ContinuityTelemetryReviewLabel;
  reviewer?: string;
  note?: string;
  reviewedAt?: string;
}

/**
 * Result envelope for telemetry review label writes.
 */
export interface StoreContinuityTelemetryReviewLabelResult {
  status: "stored" | "event-not-found" | "event-not-review-eligible" | "error";
  warning: string | null;
}

/**
 * Input for storing one continuity telemetry event row.
 */
export interface StoreContinuityTelemetryEventInput {
  databasePath: string;
  eventType: ContinuityTelemetryEventType;
  timestamp?: string;
  valueA?: number;
  valueB?: number;
  valueText?: string;
  payloadJson?: string;
}

/**
 * Result envelope for continuity telemetry event writes.
 */
export interface StoreContinuityTelemetryEventResult {
  status: "stored" | "error";
  warning: string | null;
}

/**
 * Input for reading continuity KPI telemetry summary.
 */
export interface ReadContinuityTelemetrySummaryInput {
  databasePath: string;
}

/**
 * Aggregated continuity KPI telemetry summary for status/reporting surfaces.
 */
export interface ContinuityTelemetrySummary {
  status: "ok" | "no-db" | "error";
  totalEvents: number;
  turnBriefingSamples: number;
  turnBriefingAverageChars: number;
  turnBriefingMaxChars: number;
  queryHybridCount: number;
  queryHybridDegradedCount: number;
  queryLexicalOnlyCount: number;
  queryHybridDegradedRatio: number;
  continuityWriteStoredCount: number;
  continuityWriteSkippedDuplicateCount: number;
  continuityWriteSkippedLowSignalCount: number;
  continuityWriteSkipRate: number;
  compactionPreviewApprovedCount: number;
  compactionPreviewAdvisoryCount: number;
  compactionPreviewRejectedCount: number;
  compactionApplyAppliedCount: number;
  compactionApplyRejectedCount: number;
  falseRejectReviewCandidateCount: number;
  falseRejectReviewLabeledCount: number;
  falseRejectReviewPendingCount: number;
  falseRejectLabeledValidRejectCount: number;
  falseRejectLabeledFalseRejectCount: number;
  falseRejectLabeledUncertainCount: number;
  latestEventTimestamp: string | null;
  warning: string | null;
}

/**
 * Input for reading continuity telemetry trend reports.
 */
export interface ReadContinuityTelemetryTrendReportInput {
  databasePath: string;
  windowDays?: number;
  reviewSampleLimit?: number;
}

/**
 * One trend row for one UTC day in continuity telemetry report.
 */
export interface ContinuityTelemetryTrendDay {
  date: string;
  totalEvents: number;
  queryCount: number;
  queryHybridDegradedCount: number;
  continuityWriteStoredCount: number;
  continuityWriteSkippedCount: number;
  compactionPreviewRejectedCount: number;
  compactionApplyRejectedCount: number;
  falseRejectReviewCandidateCount: number;
}

/**
 * One sampled false-reject review candidate record.
 */
export interface ContinuityTelemetryFalseRejectReviewSample {
  eventId: string;
  timestamp: string;
  eventType: ContinuityTelemetryEventType;
  outcome: string | null;
  reasonCodes: string[];
  qualityReason: string | null;
  reviewLabel: ContinuityTelemetryReviewLabel | null;
  reviewedAt: string | null;
  reviewer: string | null;
}

/**
 * Long-horizon continuity telemetry trend report with review samples.
 */
export interface ContinuityTelemetryTrendReport {
  status: "ok" | "no-db" | "error";
  generatedAt: string;
  windowDays: number;
  startDate: string;
  endDate: string;
  daySeries: ContinuityTelemetryTrendDay[];
  falseRejectReviewCandidateCount: number;
  falseRejectReviewLabeledCount: number;
  falseRejectReviewPendingCount: number;
  falseRejectLabeledValidRejectCount: number;
  falseRejectLabeledFalseRejectCount: number;
  falseRejectLabeledUncertainCount: number;
  falseRejectReviewSample: ContinuityTelemetryFalseRejectReviewSample[];
  warning: string | null;
}

/**
 * Input for reading active (non-compacted) continuity counters.
 */
export interface ReadContinuityActiveCountsInput {
  databasePath: string;
}

/**
 * Active continuity counters and per-section distribution.
 */
export interface ContinuityActiveCounts {
  status: "ok" | "no-db" | "error";
  activeEntryCount: number;
  sectionCounts: Record<ContinuitySection, number>;
  warning: string | null;
}

/**
 * Continuity compaction policy bounds.
 */
export interface ContinuityCompactionPolicy {
  /** Trigger compaction only when entry count exceeds this value. */
  maxEntries: number;
  /** Keep this many newest entries after compaction. */
  retainRecentEntries: number;
  /** Require at least this many compacted rows to write a milestone. */
  minimumEntriesToCompact: number;
  /** Per-section highlight cap included in generated milestone summary. */
  maxHighlightsPerSection: number;
}

/**
 * Input for one compaction execution.
 */
export interface RunContinuityCompactionPolicyInput {
  databasePath: string;
  policy?: Partial<ContinuityCompactionPolicy>;
  timestamp?: string;
}

/**
 * Result envelope for one compaction execution.
 */
export interface ContinuityCompactionResult {
  status: "skipped-no-db" | "skipped-under-threshold" | "compacted" | "error";
  totalEntryCount: number;
  retainedEntryCount: number;
  compactedEntryCount: number;
  milestoneId: string | null;
  warning: string | null;
}

/**
 * Default continuity compaction policy.
 *
 * Decision:
 * - keep enough recent entries for near-term startup context,
 * - compact older tail in bounded batches to avoid unbounded growth.
 */
export const DEFAULT_CONTINUITY_COMPACTION_POLICY: ContinuityCompactionPolicy = {
  maxEntries: 120,
  retainRecentEntries: 80,
  minimumEntriesToCompact: 20,
  maxHighlightsPerSection: 2,
};

interface RawContinuityEntryRow {
  id: string;
  timestamp: string;
  sectionCode: string;
  provenanceCode: string;
  certaintyCode: number | string;
  content: string;
}

/**
 * Ensure continuity-entry migration columns exist on legacy schemas.
 */
const ensureContinuityEntryMigrationColumns = (db: {
  exec: (sql: string) => void;
  prepare: (sql: string) => {
    all: (...params: Array<string | number | null>) => Array<Record<string, unknown>>;
  };
}): void => {
  const tableInfoRows = db.prepare("PRAGMA table_info(continuity_entries)").all();
  const existingColumnNames = new Set(
    tableInfoRows
      .map((row) => (typeof row.name === "string" ? row.name : null))
      .filter((name): name is string => name !== null),
  );

  if (!existingColumnNames.has("superseded_by_entry_id")) {
    db.exec("ALTER TABLE continuity_entries ADD COLUMN superseded_by_entry_id TEXT");
  }

  if (!existingColumnNames.has("compacted_into_entry_id")) {
    db.exec("ALTER TABLE continuity_entries ADD COLUMN compacted_into_entry_id TEXT");
  }
};

/**
 * Create continuity persistence schema.
 *
 * Decision:
 * - continuity metadata is stored in compact codes, not human labels,
 * - decode to human labels only at read/render time,
 * - compaction preview lifecycle state lives in dedicated DB rows (not in-memory only).
 */
const ensureContinuitySchema = (db: {
  exec: (sql: string) => void;
  prepare: (sql: string) => {
    all: (...params: Array<string | number | null>) => Array<Record<string, unknown>>;
  };
}): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS continuity_entries (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      section_code TEXT NOT NULL,
      provenance_code TEXT NOT NULL,
      certainty_code INTEGER NOT NULL,
      content TEXT NOT NULL,
      superseded_by_entry_id TEXT,
      compacted_into_entry_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_continuity_entries_timestamp
      ON continuity_entries(timestamp DESC);

    CREATE INDEX IF NOT EXISTS idx_continuity_entries_section_code
      ON continuity_entries(section_code);

    CREATE INDEX IF NOT EXISTS idx_continuity_entries_superseded_by
      ON continuity_entries(superseded_by_entry_id);

    CREATE INDEX IF NOT EXISTS idx_continuity_entries_compacted_into
      ON continuity_entries(compacted_into_entry_id);

    CREATE TABLE IF NOT EXISTS continuity_milestones (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      section_code TEXT NOT NULL,
      provenance_code TEXT NOT NULL,
      certainty_code INTEGER NOT NULL,
      summary TEXT NOT NULL,
      covered_from_timestamp TEXT,
      covered_to_timestamp TEXT,
      source_entry_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_continuity_milestones_timestamp
      ON continuity_milestones(timestamp DESC);

    CREATE TABLE IF NOT EXISTS continuity_compaction_previews (
      preview_id TEXT PRIMARY KEY,
      request_scope_id TEXT NOT NULL,
      request_profile TEXT NOT NULL CHECK (request_profile IN ('strict', 'long-request')),
      based_on_preview_id TEXT,
      revision_chain_id TEXT NOT NULL,
      revision_number INTEGER NOT NULL,
      proposal_fingerprint TEXT NOT NULL,
      proposal_json TEXT NOT NULL,
      validation_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('approved', 'approved_with_advisories', 'rejected', 'applied', 'expired')
      ),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      applied_at TEXT,
      purge_after_at TEXT NOT NULL,
      FOREIGN KEY (based_on_preview_id)
        REFERENCES continuity_compaction_previews(preview_id)
    );

    CREATE INDEX IF NOT EXISTS idx_continuity_compaction_previews_request_scope
      ON continuity_compaction_previews(request_scope_id);

    CREATE INDEX IF NOT EXISTS idx_continuity_compaction_previews_status
      ON continuity_compaction_previews(status);

    CREATE INDEX IF NOT EXISTS idx_continuity_compaction_previews_expires_at
      ON continuity_compaction_previews(expires_at);

    CREATE INDEX IF NOT EXISTS idx_continuity_compaction_previews_purge_after_at
      ON continuity_compaction_previews(purge_after_at);

    CREATE INDEX IF NOT EXISTS idx_continuity_compaction_previews_based_on
      ON continuity_compaction_previews(based_on_preview_id);

    CREATE TABLE IF NOT EXISTS continuity_telemetry_events (
      event_id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL,
      value_a REAL,
      value_b REAL,
      value_text TEXT,
      payload_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_continuity_telemetry_events_timestamp
      ON continuity_telemetry_events(timestamp DESC);

    CREATE INDEX IF NOT EXISTS idx_continuity_telemetry_events_type_timestamp
      ON continuity_telemetry_events(event_type, timestamp DESC);

    CREATE TABLE IF NOT EXISTS continuity_telemetry_review_labels (
      review_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL CHECK (label IN ('valid_reject', 'false_reject', 'uncertain')),
      reviewer TEXT NOT NULL,
      note TEXT,
      reviewed_at TEXT NOT NULL,
      FOREIGN KEY (event_id)
        REFERENCES continuity_telemetry_events(event_id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_continuity_telemetry_review_labels_event
      ON continuity_telemetry_review_labels(event_id);

    CREATE INDEX IF NOT EXISTS idx_continuity_telemetry_review_labels_label
      ON continuity_telemetry_review_labels(label);

    CREATE INDEX IF NOT EXISTS idx_continuity_telemetry_review_labels_reviewed_at
      ON continuity_telemetry_review_labels(reviewed_at DESC);
  `);

  ensureContinuityEntryMigrationColumns(db);
};

/**
 * Open DB and ensure parent directory exists for writes.
 */
const openWriteDatabase = (databasePath: string): BetterSqliteDatabase => {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  return openBetterSqliteDatabase(databasePath);
};

/**
 * Store one continuity entry in canonical compact form.
 */
export const storeContinuityEntry = (input: StoreContinuityEntryInput): void => {
  const db = openWriteDatabase(input.databasePath);

  try {
    ensureContinuitySchema(db);

    const codes = encodeContinuityMetadata({
      section: input.section,
      provenance: input.provenance,
      certainty: input.certainty,
    });

    db.prepare(`
      INSERT OR REPLACE INTO continuity_entries (
        id,
        timestamp,
        section_code,
        provenance_code,
        certainty_code,
        content
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.timestamp,
      codes.sectionCode,
      codes.provenanceCode,
      codes.certaintyCode,
      input.content,
    );
  } finally {
    db.close();
  }
};

/**
 * Store one continuity milestone in canonical compact form.
 */
export const storeContinuityMilestone = (input: StoreContinuityMilestoneInput): void => {
  const db = openWriteDatabase(input.databasePath);

  try {
    ensureContinuitySchema(db);

    const codes = encodeContinuityMetadata({
      section: input.section,
      provenance: input.provenance,
      certainty: input.certainty,
    });

    db.prepare(`
      INSERT OR REPLACE INTO continuity_milestones (
        id,
        timestamp,
        section_code,
        provenance_code,
        certainty_code,
        summary,
        covered_from_timestamp,
        covered_to_timestamp,
        source_entry_count
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.timestamp,
      codes.sectionCode,
      codes.provenanceCode,
      codes.certaintyCode,
      input.summary,
      input.coveredFromTimestamp || null,
      input.coveredToTimestamp || null,
      Math.max(0, Math.floor(input.sourceEntryCount ?? 0)),
    );
  } finally {
    db.close();
  }
};

/**
 * Runtime validator for compaction-preview status values.
 */
const isContinuityCompactionPreviewStatus = (value: unknown): value is ContinuityCompactionPreviewStatus => (
  value === "approved"
  || value === "approved_with_advisories"
  || value === "rejected"
  || value === "applied"
  || value === "expired"
);

/**
 * Store one immutable continuity compaction preview row.
 */
export const storeContinuityCompactionPreview = (input: StoreContinuityCompactionPreviewInput): void => {
  const db = openWriteDatabase(input.databasePath);

  try {
    ensureContinuitySchema(db);

    db.prepare(`
      INSERT OR REPLACE INTO continuity_compaction_previews (
        preview_id,
        request_scope_id,
        request_profile,
        based_on_preview_id,
        revision_chain_id,
        revision_number,
        proposal_fingerprint,
        proposal_json,
        validation_json,
        status,
        created_at,
        expires_at,
        applied_at,
        purge_after_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.previewId,
      input.requestScopeId,
      input.requestProfile,
      input.basedOnPreviewId || null,
      input.revisionChainId,
      Math.max(0, Math.floor(input.revisionNumber)),
      input.proposalFingerprint,
      input.proposalJson,
      input.validationJson,
      input.status,
      input.createdAt,
      input.expiresAt,
      input.appliedAt || null,
      input.purgeAfterAt,
    );
  } finally {
    db.close();
  }
};

/**
 * Read one persisted continuity compaction preview row by id.
 */
export const readContinuityCompactionPreview = (
  input: ReadContinuityCompactionPreviewInput,
): ContinuityCompactionPreviewRecord | null => {
  if (!existsSync(input.databasePath)) {
    return null;
  }

  const db = openBetterSqliteDatabase(input.databasePath, {
    readOnly: true,
    fileMustExist: true,
  });

  try {
    const row = db.prepare(`
      SELECT
        preview_id AS previewId,
        request_scope_id AS requestScopeId,
        request_profile AS requestProfile,
        based_on_preview_id AS basedOnPreviewId,
        revision_chain_id AS revisionChainId,
        revision_number AS revisionNumber,
        proposal_fingerprint AS proposalFingerprint,
        proposal_json AS proposalJson,
        validation_json AS validationJson,
        status,
        created_at AS createdAt,
        expires_at AS expiresAt,
        applied_at AS appliedAt,
        purge_after_at AS purgeAfterAt
      FROM continuity_compaction_previews
      WHERE preview_id = ?
      LIMIT 1
    `).get(input.previewId);

    if (!row) {
      return null;
    }

    if (
      typeof row.previewId !== "string"
      || typeof row.requestScopeId !== "string"
      || (row.requestProfile !== "strict" && row.requestProfile !== "long-request")
      || (row.basedOnPreviewId !== null && typeof row.basedOnPreviewId !== "string")
      || typeof row.revisionChainId !== "string"
      || typeof row.revisionNumber !== "number"
      || typeof row.proposalFingerprint !== "string"
      || typeof row.proposalJson !== "string"
      || typeof row.validationJson !== "string"
      || !isContinuityCompactionPreviewStatus(row.status)
      || typeof row.createdAt !== "string"
      || typeof row.expiresAt !== "string"
      || (row.appliedAt !== null && typeof row.appliedAt !== "string")
      || typeof row.purgeAfterAt !== "string"
    ) {
      return null;
    }

    return {
      previewId: row.previewId,
      requestScopeId: row.requestScopeId,
      requestProfile: row.requestProfile,
      basedOnPreviewId: row.basedOnPreviewId,
      revisionChainId: row.revisionChainId,
      revisionNumber: row.revisionNumber,
      proposalFingerprint: row.proposalFingerprint,
      proposalJson: row.proposalJson,
      validationJson: row.validationJson,
      status: row.status,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      appliedAt: row.appliedAt,
      purgeAfterAt: row.purgeAfterAt,
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
};

/**
 * Count persisted compaction preview rows in one request scope.
 */
export const countContinuityCompactionPreviewsInScope = (
  input: CountContinuityCompactionPreviewsInScopeInput,
): number => {
  if (!existsSync(input.databasePath)) {
    return 0;
  }

  const db = openBetterSqliteDatabase(input.databasePath, {
    readOnly: true,
    fileMustExist: true,
  });

  try {
    let sql = `
      SELECT COUNT(*) AS total
      FROM continuity_compaction_previews
      WHERE request_scope_id = ?
    `;

    const params: Array<string | number | null> = [input.requestScopeId];

    if (input.statusFilter && input.statusFilter.length > 0) {
      const validStatuses = input.statusFilter.filter(isContinuityCompactionPreviewStatus);
      if (validStatuses.length === 0) {
        return 0;
      }

      sql += ` AND status IN (${validStatuses.map(() => "?").join(", ")})`;
      params.push(...validStatuses);
    }

    const row = db.prepare(sql).get(...params);
    return normalizeSqliteCountValue(row?.total);
  } catch {
    return 0;
  } finally {
    db.close();
  }
};

/**
 * Update status fields of one persisted compaction preview row.
 */
export const updateContinuityCompactionPreviewStatus = (
  input: UpdateContinuityCompactionPreviewStatusInput,
): number => {
  const db = openWriteDatabase(input.databasePath);

  try {
    ensureContinuitySchema(db);

    db.prepare(`
      UPDATE continuity_compaction_previews
      SET
        status = ?,
        applied_at = COALESCE(?, applied_at),
        purge_after_at = COALESCE(?, purge_after_at)
      WHERE preview_id = ?
    `).run(
      input.status,
      input.appliedAt || null,
      input.purgeAfterAt || null,
      input.previewId,
    );

    return normalizeSqliteCountValue(
      db.prepare("SELECT changes() AS total").get()?.total,
    );
  } finally {
    db.close();
  }
};

/**
 * Purge expired and retention-completed compaction preview rows.
 */
export const purgeContinuityCompactionPreviews = (
  input: PurgeContinuityCompactionPreviewsInput,
): PurgeContinuityCompactionPreviewsResult => {
  if (!existsSync(input.databasePath)) {
    return {
      expiredNonAppliedPurged: 0,
      appliedRetentionPurged: 0,
    };
  }

  const db = openWriteDatabase(input.databasePath);

  try {
    ensureContinuitySchema(db);

    db.exec("BEGIN IMMEDIATE TRANSACTION");

    db.prepare(`
      DELETE FROM continuity_compaction_previews
      WHERE status != 'applied'
        AND expires_at <= ?
    `).run(input.nowTimestamp);
    const expiredNonAppliedPurged = normalizeSqliteCountValue(
      db.prepare("SELECT changes() AS total").get()?.total,
    );

    db.prepare(`
      DELETE FROM continuity_compaction_previews
      WHERE status = 'applied'
        AND purge_after_at <= ?
    `).run(input.nowTimestamp);
    const appliedRetentionPurged = normalizeSqliteCountValue(
      db.prepare("SELECT changes() AS total").get()?.total,
    );

    db.exec("COMMIT");

    return {
      expiredNonAppliedPurged,
      appliedRetentionPurged,
    };
  } catch {
    try {
      db.exec("ROLLBACK");
    } catch {
      // No-op: rollback itself can fail if transaction was not opened.
    }

    return {
      expiredNonAppliedPurged: 0,
      appliedRetentionPurged: 0,
    };
  } finally {
    db.close();
  }
};

/**
 * Delete one continuity entry by id.
 */
export const deleteContinuityEntry = (input: DeleteContinuityEntryInput): void => {
  if (!existsSync(input.databasePath)) {
    return;
  }

  const db = openWriteDatabase(input.databasePath);

  try {
    ensureContinuitySchema(db);

    db.prepare(`
      DELETE FROM continuity_entries
      WHERE id = ?
    `).run(input.id);
  } finally {
    db.close();
  }
};

/**
 * Decode one raw row into continuity labels, returning null when row is invalid.
 */
const decodeContinuityRow = (row: {
  sectionCode: unknown;
  provenanceCode: unknown;
  certaintyCode: unknown;
}): ContinuityMetadataLabels | null => {
  if (
    typeof row.sectionCode !== "string"
    || typeof row.provenanceCode !== "string"
    || (typeof row.certaintyCode !== "number" && typeof row.certaintyCode !== "string")
  ) {
    return null;
  }

  if (
    row.sectionCode !== "P"
    && row.sectionCode !== "D"
    && row.sectionCode !== "R"
    && row.sectionCode !== "X"
    && row.sectionCode !== "O"
  ) {
    return null;
  }

  if (
    row.provenanceCode !== "U"
    && row.provenanceCode !== "C"
    && row.provenanceCode !== "T"
    && row.provenanceCode !== "A"
  ) {
    return null;
  }

  if (row.certaintyCode !== 0 && row.certaintyCode !== 1 && row.certaintyCode !== "0" && row.certaintyCode !== "1") {
    return null;
  }

  return {
    section:
      row.sectionCode === "P" ? "PLANS"
      : row.sectionCode === "D" ? "DECISIONS"
      : row.sectionCode === "R" ? "PROGRESS"
      : row.sectionCode === "X" ? "DISCOVERIES"
      : "OUTCOMES",
    provenance:
      row.provenanceCode === "U" ? "USER"
      : row.provenanceCode === "C" ? "CODE"
      : row.provenanceCode === "T" ? "TOOL"
      : "ASSUMPTION",
    certainty: row.certaintyCode === 1 || row.certaintyCode === "1" ? "UNCONFIRMED" : "CONFIRMED",
  };
};

/**
 * Decode raw continuity-entry rows while tolerating invalid compact metadata rows.
 */
const decodeContinuityEntryRows = (rows: Array<Record<string, unknown>>): ContinuityEntryRecord[] => rows
  .map((row): ContinuityEntryRecord | null => {
    if (
      typeof row.id !== "string"
      || typeof row.timestamp !== "string"
      || typeof row.content !== "string"
    ) {
      return null;
    }

    const labels = decodeContinuityRow({
      sectionCode: row.section_code,
      provenanceCode: row.provenance_code,
      certaintyCode: row.certainty_code,
    });

    if (!labels) {
      // Keep reader resilient to drift/corruption instead of hard-failing startup paths.
      return null;
    }

    return {
      id: row.id,
      timestamp: row.timestamp,
      content: row.content,
      ...labels,
    };
  })
  .filter((row): row is ContinuityEntryRecord => row !== null);

/**
 * Decode raw lifecycle-aware continuity rows.
 */
const decodeContinuityLifecycleEntryRows = (
  rows: Array<Record<string, unknown>>,
): ContinuityEntryLifecycleRecord[] => rows
  .map((row): ContinuityEntryLifecycleRecord | null => {
    if (
      typeof row.id !== "string"
      || typeof row.timestamp !== "string"
      || typeof row.content !== "string"
      || (row.superseded_by_entry_id !== null && typeof row.superseded_by_entry_id !== "string")
      || (row.compacted_into_entry_id !== null && typeof row.compacted_into_entry_id !== "string")
    ) {
      return null;
    }

    const labels = decodeContinuityRow({
      sectionCode: row.section_code,
      provenanceCode: row.provenance_code,
      certaintyCode: row.certainty_code,
    });

    if (!labels) {
      return null;
    }

    return {
      id: row.id,
      timestamp: row.timestamp,
      content: row.content,
      supersededByEntryId: row.superseded_by_entry_id,
      compactedIntoEntryId: row.compacted_into_entry_id,
      ...labels,
    };
  })
  .filter((row): row is ContinuityEntryLifecycleRecord => row !== null);

/**
 * Normalize COUNT(*) values from SQLite drivers into safe integers.
 */
const normalizeSqliteCountValue = (value: unknown): number => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  }

  if (typeof value === "bigint") {
    return Number(value > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : value);
  }

  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
  }

  return 0;
};

/**
 * Normalize SQLite numeric values to finite JS numbers.
 */
const normalizeSqliteNumberValue = (value: unknown): number => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
};

const CONTINUITY_TELEMETRY_TREND_MIN_DAYS = 7;
const CONTINUITY_TELEMETRY_TREND_DEFAULT_DAYS = 30;
const CONTINUITY_TELEMETRY_TREND_MAX_DAYS = 365;
const CONTINUITY_TELEMETRY_REVIEW_SAMPLE_DEFAULT_LIMIT = 12;
const CONTINUITY_TELEMETRY_REVIEW_SAMPLE_MAX_LIMIT = 50;
const CONTINUITY_TELEMETRY_FALSE_REJECT_SQL_FILTER = `
  event_type = 'continuity_write_skipped_low_signal'
  OR event_type = 'continuity_write_skipped_duplicate'
  OR (event_type = 'continuity_compact_preview_result' AND value_text = 'rejected')
  OR (event_type = 'continuity_compact_apply_result' AND value_text = 'rejected')
`;

/**
 * Check whether an unknown value is a supported telemetry event type.
 */
const isContinuityTelemetryEventType = (value: unknown): value is ContinuityTelemetryEventType => (
  value === "continuity_turn_briefing"
  || value === "continuity_query"
  || value === "continuity_write_stored"
  || value === "continuity_write_skipped_duplicate"
  || value === "continuity_write_skipped_low_signal"
  || value === "continuity_compact_preview_result"
  || value === "continuity_compact_apply_result"
);

/**
 * Check whether an unknown value is a supported telemetry review label.
 */
const isContinuityTelemetryReviewLabel = (value: unknown): value is ContinuityTelemetryReviewLabel => (
  value === "valid_reject"
  || value === "false_reject"
  || value === "uncertain"
);

/**
 * Merge warning suffixes into one compact warning text.
 */
const mergeWarningText = (base: string | null, extra: string | null): string | null => {
  if (!base && !extra) {
    return null;
  }

  if (!base) {
    return extra;
  }

  if (!extra) {
    return base;
  }

  return `${base}; ${extra}`;
};

/**
 * Clamp telemetry trend window to deterministic supported bounds.
 */
const normalizeTelemetryTrendWindowDays = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return CONTINUITY_TELEMETRY_TREND_DEFAULT_DAYS;
  }

  return Math.min(
    CONTINUITY_TELEMETRY_TREND_MAX_DAYS,
    Math.max(CONTINUITY_TELEMETRY_TREND_MIN_DAYS, Math.floor(value)),
  );
};

/**
 * Clamp false-reject review sample size to deterministic supported bounds.
 */
const normalizeTelemetryReviewSampleLimit = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return CONTINUITY_TELEMETRY_REVIEW_SAMPLE_DEFAULT_LIMIT;
  }

  return Math.min(
    CONTINUITY_TELEMETRY_REVIEW_SAMPLE_MAX_LIMIT,
    Math.max(1, Math.floor(value)),
  );
};

/**
 * Return one UTC YYYY-MM-DD key shifted by whole-day offset.
 */
const shiftUtcIsoDateKey = (baseIsoDateKey: string, dayOffset: number): string => {
  const shifted = new Date(`${baseIsoDateKey}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + dayOffset);
  return shifted.toISOString().slice(0, 10);
};

/**
 * Build continuous UTC date keys for one inclusive [start, end] range.
 */
const buildUtcDateKeyRange = (startIsoDateKey: string, endIsoDateKey: string): string[] => {
  const keys: string[] = [];
  let cursor = startIsoDateKey;

  while (cursor <= endIsoDateKey) {
    keys.push(cursor);
    cursor = shiftUtcIsoDateKey(cursor, 1);
  }

  return keys;
};

/**
 * Parse one telemetry payload for review-sample indicators.
 */
const parseContinuityTelemetryReviewPayload = (payloadJson: unknown): {
  reasonCodes: string[];
  qualityReason: string | null;
} => {
  if (typeof payloadJson !== "string" || payloadJson.trim().length === 0) {
    return {
      reasonCodes: [],
      qualityReason: null,
    };
  }

  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return {
        reasonCodes: [],
        qualityReason: null,
      };
    }

    const record = parsed as {
      reasonCodes?: unknown;
      qualityReason?: unknown;
      reason?: unknown;
    };

    const reasonCodes = Array.isArray(record.reasonCodes)
      ? record.reasonCodes
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          .map((item) => item.trim())
      : [];

    const qualityReason = typeof record.qualityReason === "string" && record.qualityReason.trim().length > 0
      ? record.qualityReason.trim()
      : typeof record.reason === "string" && record.reason.trim().length > 0
        ? record.reason.trim()
        : null;

    return {
      reasonCodes,
      qualityReason,
    };
  } catch {
    return {
      reasonCodes: [],
      qualityReason: null,
    };
  }
};

/**
 * Build zero-initialized per-section continuity counters.
 */
const buildEmptyContinuitySectionCountMap = (): Record<ContinuitySection, number> => ({
  PLANS: 0,
  DECISIONS: 0,
  PROGRESS: 0,
  DISCOVERIES: 0,
  OUTCOMES: 0,
});

/**
 * Read compact continuity counters for command/status observability surfaces.
 */
export const readContinuityStatusCounts = (input: ReadContinuityStatusCountsInput): ContinuityStatusCounts => {
  if (!existsSync(input.databasePath)) {
    return {
      status: "no-db",
      entryCount: 0,
      milestoneCount: 0,
      semanticEntryCount: 0,
      userProvenanceEntryCount: 0,
      latestEntryTimestamp: null,
      latestEntrySection: null,
      latestEntryProvenance: null,
      warning: null,
    };
  }

  const db = openBetterSqliteDatabase(input.databasePath, {
    readOnly: true,
    fileMustExist: true,
  });

  try {
    const entryCountRow = db.prepare(`
      SELECT COUNT(*) AS total
      FROM continuity_entries
    `).all()[0];

    const milestoneCountRow = db.prepare(`
      SELECT COUNT(*) AS total
      FROM continuity_milestones
    `).all()[0];

    const semanticEntryCountRow = db.prepare(`
      SELECT COUNT(*) AS total
      FROM continuity_entries
      WHERE section_code IN ('P', 'D', 'X', 'O')
    `).all()[0];

    const userProvenanceCountRow = db.prepare(`
      SELECT COUNT(*) AS total
      FROM continuity_entries
      WHERE provenance_code = 'U'
    `).all()[0];

    const latestEntryRow = db.prepare(`
      SELECT timestamp, section_code, provenance_code, certainty_code
      FROM continuity_entries
      ORDER BY timestamp DESC
      LIMIT 1
    `).all()[0];

    const latestLabels = latestEntryRow
      ? decodeContinuityRow({
        sectionCode: latestEntryRow.section_code,
        provenanceCode: latestEntryRow.provenance_code,
        certaintyCode: latestEntryRow.certainty_code,
      })
      : null;

    return {
      status: "ok",
      entryCount: normalizeSqliteCountValue(entryCountRow?.total),
      milestoneCount: normalizeSqliteCountValue(milestoneCountRow?.total),
      semanticEntryCount: normalizeSqliteCountValue(semanticEntryCountRow?.total),
      userProvenanceEntryCount: normalizeSqliteCountValue(userProvenanceCountRow?.total),
      latestEntryTimestamp: typeof latestEntryRow?.timestamp === "string" ? latestEntryRow.timestamp : null,
      latestEntrySection: latestLabels?.section || null,
      latestEntryProvenance: latestLabels?.provenance || null,
      warning: null,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    if (/no such table/i.test(message)) {
      return {
        status: "ok",
        entryCount: 0,
        milestoneCount: 0,
        semanticEntryCount: 0,
        userProvenanceEntryCount: 0,
        latestEntryTimestamp: null,
        latestEntrySection: null,
        latestEntryProvenance: null,
        warning: "continuity-schema-not-initialized",
      };
    }

    return {
      status: "error",
      entryCount: 0,
      milestoneCount: 0,
      semanticEntryCount: 0,
      userProvenanceEntryCount: 0,
      latestEntryTimestamp: null,
      latestEntrySection: null,
      latestEntryProvenance: null,
      warning: message,
    };
  } finally {
    db.close();
  }
};

/**
 * Read compact compaction-preview lifecycle counters for observability/status surfaces.
 */
export const readContinuityCompactionPreviewStatusCounts = (
  input: ReadContinuityCompactionPreviewStatusCountsInput,
): ContinuityCompactionPreviewStatusCounts => {
  if (!existsSync(input.databasePath)) {
    return {
      status: "no-db",
      totalCount: 0,
      approvedCount: 0,
      approvedWithAdvisoriesCount: 0,
      rejectedCount: 0,
      appliedCount: 0,
      expiredCount: 0,
      latestCreatedAt: null,
      latestAppliedAt: null,
      warning: null,
    };
  }

  const db = openBetterSqliteDatabase(input.databasePath, {
    readOnly: true,
    fileMustExist: true,
  });

  try {
    const row = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
        SUM(CASE WHEN status = 'approved_with_advisories' THEN 1 ELSE 0 END) AS approved_with_advisories,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
        SUM(CASE WHEN status = 'applied' THEN 1 ELSE 0 END) AS applied,
        SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) AS expired,
        MAX(created_at) AS latest_created_at,
        MAX(applied_at) AS latest_applied_at
      FROM continuity_compaction_previews
    `).get();

    return {
      status: "ok",
      totalCount: normalizeSqliteCountValue(row?.total),
      approvedCount: normalizeSqliteCountValue(row?.approved),
      approvedWithAdvisoriesCount: normalizeSqliteCountValue(row?.approved_with_advisories),
      rejectedCount: normalizeSqliteCountValue(row?.rejected),
      appliedCount: normalizeSqliteCountValue(row?.applied),
      expiredCount: normalizeSqliteCountValue(row?.expired),
      latestCreatedAt: typeof row?.latest_created_at === "string" ? row.latest_created_at : null,
      latestAppliedAt: typeof row?.latest_applied_at === "string" ? row.latest_applied_at : null,
      warning: null,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    if (/no such table/i.test(message)) {
      return {
        status: "ok",
        totalCount: 0,
        approvedCount: 0,
        approvedWithAdvisoriesCount: 0,
        rejectedCount: 0,
        appliedCount: 0,
        expiredCount: 0,
        latestCreatedAt: null,
        latestAppliedAt: null,
        warning: "continuity-compaction-preview-schema-not-initialized",
      };
    }

    return {
      status: "error",
      totalCount: 0,
      approvedCount: 0,
      approvedWithAdvisoriesCount: 0,
      rejectedCount: 0,
      appliedCount: 0,
      expiredCount: 0,
      latestCreatedAt: null,
      latestAppliedAt: null,
      warning: message,
    };
  } finally {
    db.close();
  }
};

/**
 * Store one continuity telemetry event row for KPI/history reporting.
 */
export const storeContinuityTelemetryEvent = (
  input: StoreContinuityTelemetryEventInput,
): StoreContinuityTelemetryEventResult => {
  const db = openWriteDatabase(input.databasePath);

  try {
    ensureContinuitySchema(db);

    db.prepare(`
      INSERT INTO continuity_telemetry_events (
        event_id,
        timestamp,
        event_type,
        value_a,
        value_b,
        value_text,
        payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      input.timestamp || new Date().toISOString(),
      input.eventType,
      typeof input.valueA === "number" && Number.isFinite(input.valueA) ? input.valueA : null,
      typeof input.valueB === "number" && Number.isFinite(input.valueB) ? input.valueB : null,
      typeof input.valueText === "string" ? input.valueText : null,
      typeof input.payloadJson === "string" ? input.payloadJson : null,
    );

    return {
      status: "stored",
      warning: null,
    };
  } catch (error: unknown) {
    return {
      status: "error",
      warning: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db.close();
  }
};

/**
 * Store/update one review label for a false-reject telemetry candidate event.
 */
export const storeContinuityTelemetryReviewLabel = (
  input: StoreContinuityTelemetryReviewLabelInput,
): StoreContinuityTelemetryReviewLabelResult => {
  const db = openWriteDatabase(input.databasePath);

  try {
    ensureContinuitySchema(db);

    if (!isContinuityTelemetryReviewLabel(input.label)) {
      return {
        status: "error",
        warning: "invalid-review-label",
      };
    }

    const eventRow = db.prepare(`
      SELECT event_id, event_type, value_text
      FROM continuity_telemetry_events
      WHERE event_id = ?
      LIMIT 1
    `).get(input.eventId);

    if (!eventRow || typeof eventRow.event_id !== "string") {
      return {
        status: "event-not-found",
        warning: null,
      };
    }

    const reviewEligible = db.prepare(`
      SELECT event_id
      FROM continuity_telemetry_events
      WHERE event_id = ?
        AND (${CONTINUITY_TELEMETRY_FALSE_REJECT_SQL_FILTER})
      LIMIT 1
    `).get(input.eventId);

    if (!reviewEligible || typeof reviewEligible.event_id !== "string") {
      return {
        status: "event-not-review-eligible",
        warning: null,
      };
    }

    const reviewer = typeof input.reviewer === "string" && input.reviewer.trim().length > 0
      ? input.reviewer.trim()
      : "agent";

    const note = typeof input.note === "string" && input.note.trim().length > 0
      ? input.note.trim()
      : null;

    db.prepare(`
      INSERT INTO continuity_telemetry_review_labels (
        review_id,
        event_id,
        label,
        reviewer,
        note,
        reviewed_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id)
      DO UPDATE SET
        label = excluded.label,
        reviewer = excluded.reviewer,
        note = excluded.note,
        reviewed_at = excluded.reviewed_at
    `).run(
      randomUUID(),
      input.eventId,
      input.label,
      reviewer,
      note,
      input.reviewedAt || new Date().toISOString(),
    );

    return {
      status: "stored",
      warning: null,
    };
  } catch (error: unknown) {
    return {
      status: "error",
      warning: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db.close();
  }
};

/**
 * Read aggregated continuity KPI telemetry summary from persisted event history.
 */
export const readContinuityTelemetrySummary = (
  input: ReadContinuityTelemetrySummaryInput,
): ContinuityTelemetrySummary => {
  if (!existsSync(input.databasePath)) {
    return {
      status: "no-db",
      totalEvents: 0,
      turnBriefingSamples: 0,
      turnBriefingAverageChars: 0,
      turnBriefingMaxChars: 0,
      queryHybridCount: 0,
      queryHybridDegradedCount: 0,
      queryLexicalOnlyCount: 0,
      queryHybridDegradedRatio: 0,
      continuityWriteStoredCount: 0,
      continuityWriteSkippedDuplicateCount: 0,
      continuityWriteSkippedLowSignalCount: 0,
      continuityWriteSkipRate: 0,
      compactionPreviewApprovedCount: 0,
      compactionPreviewAdvisoryCount: 0,
      compactionPreviewRejectedCount: 0,
      compactionApplyAppliedCount: 0,
      compactionApplyRejectedCount: 0,
      falseRejectReviewCandidateCount: 0,
      falseRejectReviewLabeledCount: 0,
      falseRejectReviewPendingCount: 0,
      falseRejectLabeledValidRejectCount: 0,
      falseRejectLabeledFalseRejectCount: 0,
      falseRejectLabeledUncertainCount: 0,
      latestEventTimestamp: null,
      warning: null,
    };
  }

  const db = openBetterSqliteDatabase(input.databasePath, {
    readOnly: true,
    fileMustExist: true,
  });

  try {
    const row = db.prepare(`
      SELECT
        COUNT(*) AS total_events,
        MAX(timestamp) AS latest_event_timestamp,
        SUM(CASE WHEN event_type = 'continuity_turn_briefing' THEN 1 ELSE 0 END) AS turn_briefing_samples,
        AVG(CASE WHEN event_type = 'continuity_turn_briefing' THEN value_a END) AS turn_briefing_avg_chars,
        MAX(CASE WHEN event_type = 'continuity_turn_briefing' THEN value_a END) AS turn_briefing_max_chars,
        SUM(CASE WHEN event_type = 'continuity_query' AND value_text = 'hybrid' THEN 1 ELSE 0 END) AS query_hybrid_count,
        SUM(CASE WHEN event_type = 'continuity_query' AND value_text = 'hybrid_degraded' THEN 1 ELSE 0 END) AS query_hybrid_degraded_count,
        SUM(CASE WHEN event_type = 'continuity_query' AND value_text IN ('lexical_only', 'l2_lexical') THEN 1 ELSE 0 END) AS query_lexical_only_count,
        SUM(CASE WHEN event_type = 'continuity_write_stored' THEN 1 ELSE 0 END) AS write_stored_count,
        SUM(CASE WHEN event_type = 'continuity_write_skipped_duplicate' THEN 1 ELSE 0 END) AS write_skipped_duplicate_count,
        SUM(CASE WHEN event_type = 'continuity_write_skipped_low_signal' THEN 1 ELSE 0 END) AS write_skipped_low_signal_count,
        SUM(CASE WHEN event_type = 'continuity_compact_preview_result' AND value_text = 'approved' THEN 1 ELSE 0 END) AS preview_approved_count,
        SUM(CASE WHEN event_type = 'continuity_compact_preview_result' AND value_text = 'approved_with_advisories' THEN 1 ELSE 0 END) AS preview_advisory_count,
        SUM(CASE WHEN event_type = 'continuity_compact_preview_result' AND value_text = 'rejected' THEN 1 ELSE 0 END) AS preview_rejected_count,
        SUM(CASE WHEN event_type = 'continuity_compact_apply_result' AND value_text = 'applied' THEN 1 ELSE 0 END) AS apply_applied_count,
        SUM(CASE WHEN event_type = 'continuity_compact_apply_result' AND value_text = 'rejected' THEN 1 ELSE 0 END) AS apply_rejected_count,
        SUM(CASE WHEN event_type IN ('continuity_write_skipped_low_signal', 'continuity_write_skipped_duplicate') THEN 1 ELSE 0 END)
        + SUM(CASE WHEN event_type = 'continuity_compact_preview_result' AND value_text = 'rejected' THEN 1 ELSE 0 END)
        + SUM(CASE WHEN event_type = 'continuity_compact_apply_result' AND value_text = 'rejected' THEN 1 ELSE 0 END)
        AS false_reject_review_candidate_count
      FROM continuity_telemetry_events
    `).get();

    const queryHybridCount = normalizeSqliteCountValue(row?.query_hybrid_count);
    const queryHybridDegradedCount = normalizeSqliteCountValue(row?.query_hybrid_degraded_count);
    const queryLexicalOnlyCount = normalizeSqliteCountValue(row?.query_lexical_only_count);
    const queryTotal = queryHybridCount + queryHybridDegradedCount + queryLexicalOnlyCount;

    const continuityWriteStoredCount = normalizeSqliteCountValue(row?.write_stored_count);
    const continuityWriteSkippedDuplicateCount = normalizeSqliteCountValue(row?.write_skipped_duplicate_count);
    const continuityWriteSkippedLowSignalCount = normalizeSqliteCountValue(row?.write_skipped_low_signal_count);
    const continuityWriteTotal =
      continuityWriteStoredCount
      + continuityWriteSkippedDuplicateCount
      + continuityWriteSkippedLowSignalCount;

    const falseRejectReviewCandidateCount = normalizeSqliteCountValue(row?.false_reject_review_candidate_count);
    let falseRejectReviewLabeledCount = 0;
    let falseRejectLabeledValidRejectCount = 0;
    let falseRejectLabeledFalseRejectCount = 0;
    let falseRejectLabeledUncertainCount = 0;
    let reviewLabelWarning: string | null = null;

    try {
      const reviewRow = db.prepare(`
        SELECT
          SUM(CASE WHEN r.label = 'valid_reject' THEN 1 ELSE 0 END) AS labeled_valid_reject_count,
          SUM(CASE WHEN r.label = 'false_reject' THEN 1 ELSE 0 END) AS labeled_false_reject_count,
          SUM(CASE WHEN r.label = 'uncertain' THEN 1 ELSE 0 END) AS labeled_uncertain_count,
          COUNT(r.event_id) AS labeled_total
        FROM continuity_telemetry_events e
        LEFT JOIN continuity_telemetry_review_labels r
          ON r.event_id = e.event_id
        WHERE ${CONTINUITY_TELEMETRY_FALSE_REJECT_SQL_FILTER}
      `).get();

      falseRejectReviewLabeledCount = normalizeSqliteCountValue(reviewRow?.labeled_total);
      falseRejectLabeledValidRejectCount = normalizeSqliteCountValue(reviewRow?.labeled_valid_reject_count);
      falseRejectLabeledFalseRejectCount = normalizeSqliteCountValue(reviewRow?.labeled_false_reject_count);
      falseRejectLabeledUncertainCount = normalizeSqliteCountValue(reviewRow?.labeled_uncertain_count);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no such table/i.test(message)) {
        reviewLabelWarning = "continuity-telemetry-review-schema-not-initialized";
      } else {
        reviewLabelWarning = `continuity-telemetry-review-read-failed:${message}`;
      }
    }

    return {
      status: "ok",
      totalEvents: normalizeSqliteCountValue(row?.total_events),
      turnBriefingSamples: normalizeSqliteCountValue(row?.turn_briefing_samples),
      turnBriefingAverageChars: normalizeSqliteNumberValue(row?.turn_briefing_avg_chars),
      turnBriefingMaxChars: normalizeSqliteNumberValue(row?.turn_briefing_max_chars),
      queryHybridCount,
      queryHybridDegradedCount,
      queryLexicalOnlyCount,
      queryHybridDegradedRatio: queryTotal > 0 ? queryHybridDegradedCount / queryTotal : 0,
      continuityWriteStoredCount,
      continuityWriteSkippedDuplicateCount,
      continuityWriteSkippedLowSignalCount,
      continuityWriteSkipRate: continuityWriteTotal > 0
        ? (continuityWriteSkippedDuplicateCount + continuityWriteSkippedLowSignalCount) / continuityWriteTotal
        : 0,
      compactionPreviewApprovedCount: normalizeSqliteCountValue(row?.preview_approved_count),
      compactionPreviewAdvisoryCount: normalizeSqliteCountValue(row?.preview_advisory_count),
      compactionPreviewRejectedCount: normalizeSqliteCountValue(row?.preview_rejected_count),
      compactionApplyAppliedCount: normalizeSqliteCountValue(row?.apply_applied_count),
      compactionApplyRejectedCount: normalizeSqliteCountValue(row?.apply_rejected_count),
      falseRejectReviewCandidateCount,
      falseRejectReviewLabeledCount,
      falseRejectReviewPendingCount: Math.max(0, falseRejectReviewCandidateCount - falseRejectReviewLabeledCount),
      falseRejectLabeledValidRejectCount,
      falseRejectLabeledFalseRejectCount,
      falseRejectLabeledUncertainCount,
      latestEventTimestamp: typeof row?.latest_event_timestamp === "string" ? row.latest_event_timestamp : null,
      warning: reviewLabelWarning,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    if (/no such table/i.test(message)) {
      return {
        status: "ok",
        totalEvents: 0,
        turnBriefingSamples: 0,
        turnBriefingAverageChars: 0,
        turnBriefingMaxChars: 0,
        queryHybridCount: 0,
        queryHybridDegradedCount: 0,
        queryLexicalOnlyCount: 0,
        queryHybridDegradedRatio: 0,
        continuityWriteStoredCount: 0,
        continuityWriteSkippedDuplicateCount: 0,
        continuityWriteSkippedLowSignalCount: 0,
        continuityWriteSkipRate: 0,
        compactionPreviewApprovedCount: 0,
        compactionPreviewAdvisoryCount: 0,
        compactionPreviewRejectedCount: 0,
        compactionApplyAppliedCount: 0,
        compactionApplyRejectedCount: 0,
        falseRejectReviewCandidateCount: 0,
        falseRejectReviewLabeledCount: 0,
        falseRejectReviewPendingCount: 0,
        falseRejectLabeledValidRejectCount: 0,
        falseRejectLabeledFalseRejectCount: 0,
        falseRejectLabeledUncertainCount: 0,
        latestEventTimestamp: null,
        warning: "continuity-telemetry-schema-not-initialized",
      };
    }

    return {
      status: "error",
      totalEvents: 0,
      turnBriefingSamples: 0,
      turnBriefingAverageChars: 0,
      turnBriefingMaxChars: 0,
      queryHybridCount: 0,
      queryHybridDegradedCount: 0,
      queryLexicalOnlyCount: 0,
      queryHybridDegradedRatio: 0,
      continuityWriteStoredCount: 0,
      continuityWriteSkippedDuplicateCount: 0,
      continuityWriteSkippedLowSignalCount: 0,
      continuityWriteSkipRate: 0,
      compactionPreviewApprovedCount: 0,
      compactionPreviewAdvisoryCount: 0,
      compactionPreviewRejectedCount: 0,
      compactionApplyAppliedCount: 0,
      compactionApplyRejectedCount: 0,
      falseRejectReviewCandidateCount: 0,
      falseRejectReviewLabeledCount: 0,
      falseRejectReviewPendingCount: 0,
      falseRejectLabeledValidRejectCount: 0,
      falseRejectLabeledFalseRejectCount: 0,
      falseRejectLabeledUncertainCount: 0,
      latestEventTimestamp: null,
      warning: message,
    };
  } finally {
    db.close();
  }
};

/**
 * Read long-horizon continuity telemetry trend report with review samples.
 */
export const readContinuityTelemetryTrendReport = (
  input: ReadContinuityTelemetryTrendReportInput,
): ContinuityTelemetryTrendReport => {
  const generatedAt = new Date().toISOString();
  const windowDays = normalizeTelemetryTrendWindowDays(input.windowDays);
  const reviewSampleLimit = normalizeTelemetryReviewSampleLimit(input.reviewSampleLimit);
  const endDate = generatedAt.slice(0, 10);
  const startDate = shiftUtcIsoDateKey(endDate, -(windowDays - 1));
  const dayKeys = buildUtcDateKeyRange(startDate, endDate);
  const startTimestamp = `${startDate}T00:00:00.000Z`;
  const endTimestamp = `${endDate}T23:59:59.999Z`;

  const buildEmptyDaySeries = (): ContinuityTelemetryTrendDay[] => dayKeys.map((date) => ({
    date,
    totalEvents: 0,
    queryCount: 0,
    queryHybridDegradedCount: 0,
    continuityWriteStoredCount: 0,
    continuityWriteSkippedCount: 0,
    compactionPreviewRejectedCount: 0,
    compactionApplyRejectedCount: 0,
    falseRejectReviewCandidateCount: 0,
  }));

  if (!existsSync(input.databasePath)) {
    return {
      status: "no-db",
      generatedAt,
      windowDays,
      startDate,
      endDate,
      daySeries: buildEmptyDaySeries(),
      falseRejectReviewCandidateCount: 0,
      falseRejectReviewLabeledCount: 0,
      falseRejectReviewPendingCount: 0,
      falseRejectLabeledValidRejectCount: 0,
      falseRejectLabeledFalseRejectCount: 0,
      falseRejectLabeledUncertainCount: 0,
      falseRejectReviewSample: [],
      warning: null,
    };
  }

  const db = openBetterSqliteDatabase(input.databasePath, {
    readOnly: true,
    fileMustExist: true,
  });

  try {
    const daySeries = buildEmptyDaySeries();
    const dayIndexByKey = new Map(daySeries.map((item, index) => [item.date, index]));

    const rows = db.prepare(`
      SELECT
        substr(timestamp, 1, 10) AS day_key,
        COUNT(*) AS total_events,
        SUM(CASE WHEN event_type = 'continuity_query' THEN 1 ELSE 0 END) AS query_count,
        SUM(CASE WHEN event_type = 'continuity_query' AND value_text = 'hybrid_degraded' THEN 1 ELSE 0 END) AS query_hybrid_degraded_count,
        SUM(CASE WHEN event_type = 'continuity_write_stored' THEN 1 ELSE 0 END) AS write_stored_count,
        SUM(CASE WHEN event_type IN ('continuity_write_skipped_duplicate', 'continuity_write_skipped_low_signal') THEN 1 ELSE 0 END) AS write_skipped_count,
        SUM(CASE WHEN event_type = 'continuity_compact_preview_result' AND value_text = 'rejected' THEN 1 ELSE 0 END) AS preview_rejected_count,
        SUM(CASE WHEN event_type = 'continuity_compact_apply_result' AND value_text = 'rejected' THEN 1 ELSE 0 END) AS apply_rejected_count,
        SUM(CASE WHEN ${CONTINUITY_TELEMETRY_FALSE_REJECT_SQL_FILTER} THEN 1 ELSE 0 END) AS false_reject_candidate_count
      FROM continuity_telemetry_events
      WHERE timestamp BETWEEN ? AND ?
      GROUP BY substr(timestamp, 1, 10)
      ORDER BY day_key ASC
    `).all(startTimestamp, endTimestamp) as Array<Record<string, unknown>>;

    for (const row of rows) {
      const dayKey = typeof row.day_key === "string" ? row.day_key : "";
      const dayIndex = dayIndexByKey.get(dayKey);
      if (typeof dayIndex !== "number") {
        continue;
      }

      daySeries[dayIndex] = {
        date: dayKey,
        totalEvents: normalizeSqliteCountValue(row.total_events),
        queryCount: normalizeSqliteCountValue(row.query_count),
        queryHybridDegradedCount: normalizeSqliteCountValue(row.query_hybrid_degraded_count),
        continuityWriteStoredCount: normalizeSqliteCountValue(row.write_stored_count),
        continuityWriteSkippedCount: normalizeSqliteCountValue(row.write_skipped_count),
        compactionPreviewRejectedCount: normalizeSqliteCountValue(row.preview_rejected_count),
        compactionApplyRejectedCount: normalizeSqliteCountValue(row.apply_rejected_count),
        falseRejectReviewCandidateCount: normalizeSqliteCountValue(row.false_reject_candidate_count),
      };
    }

    const candidateRow = db.prepare(`
      SELECT COUNT(*) AS total
      FROM continuity_telemetry_events
      WHERE timestamp BETWEEN ? AND ?
        AND (${CONTINUITY_TELEMETRY_FALSE_REJECT_SQL_FILTER})
    `).get(startTimestamp, endTimestamp) as Record<string, unknown> | undefined;

    const sampleRows = db.prepare(`
      SELECT event_id, timestamp, event_type, value_text, payload_json
      FROM continuity_telemetry_events
      WHERE timestamp BETWEEN ? AND ?
        AND (${CONTINUITY_TELEMETRY_FALSE_REJECT_SQL_FILTER})
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(startTimestamp, endTimestamp, reviewSampleLimit) as Array<Record<string, unknown>>;

    const sampleEventIds = sampleRows
      .map((row) => (typeof row.event_id === "string" ? row.event_id : null))
      .filter((eventId): eventId is string => eventId !== null);

    let reviewLabelWarning: string | null = null;
    const reviewLabelByEventId = new Map<string, {
      label: ContinuityTelemetryReviewLabel;
      reviewedAt: string | null;
      reviewer: string | null;
    }>();

    if (sampleEventIds.length > 0) {
      try {
        const placeholders = sampleEventIds.map(() => "?").join(", ");
        const reviewRows = db.prepare(`
          SELECT event_id, label, reviewed_at, reviewer
          FROM continuity_telemetry_review_labels
          WHERE event_id IN (${placeholders})
        `).all(...sampleEventIds) as Array<Record<string, unknown>>;

        for (const reviewRow of reviewRows) {
          if (typeof reviewRow.event_id !== "string" || !isContinuityTelemetryReviewLabel(reviewRow.label)) {
            continue;
          }

          reviewLabelByEventId.set(reviewRow.event_id, {
            label: reviewRow.label,
            reviewedAt: typeof reviewRow.reviewed_at === "string" ? reviewRow.reviewed_at : null,
            reviewer: typeof reviewRow.reviewer === "string" ? reviewRow.reviewer : null,
          });
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (/no such table/i.test(message)) {
          reviewLabelWarning = "continuity-telemetry-review-schema-not-initialized";
        } else {
          reviewLabelWarning = `continuity-telemetry-review-read-failed:${message}`;
        }
      }
    }

    let falseRejectReviewLabeledCount = 0;
    let falseRejectLabeledValidRejectCount = 0;
    let falseRejectLabeledFalseRejectCount = 0;
    let falseRejectLabeledUncertainCount = 0;

    try {
      const reviewCountsRow = db.prepare(`
        SELECT
          COUNT(r.event_id) AS labeled_total,
          SUM(CASE WHEN r.label = 'valid_reject' THEN 1 ELSE 0 END) AS labeled_valid_reject_count,
          SUM(CASE WHEN r.label = 'false_reject' THEN 1 ELSE 0 END) AS labeled_false_reject_count,
          SUM(CASE WHEN r.label = 'uncertain' THEN 1 ELSE 0 END) AS labeled_uncertain_count
        FROM continuity_telemetry_events e
        LEFT JOIN continuity_telemetry_review_labels r
          ON r.event_id = e.event_id
        WHERE e.timestamp BETWEEN ? AND ?
          AND (${CONTINUITY_TELEMETRY_FALSE_REJECT_SQL_FILTER})
      `).get(startTimestamp, endTimestamp) as Record<string, unknown> | undefined;

      falseRejectReviewLabeledCount = normalizeSqliteCountValue(reviewCountsRow?.labeled_total);
      falseRejectLabeledValidRejectCount = normalizeSqliteCountValue(reviewCountsRow?.labeled_valid_reject_count);
      falseRejectLabeledFalseRejectCount = normalizeSqliteCountValue(reviewCountsRow?.labeled_false_reject_count);
      falseRejectLabeledUncertainCount = normalizeSqliteCountValue(reviewCountsRow?.labeled_uncertain_count);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no such table/i.test(message)) {
        reviewLabelWarning = mergeWarningText(reviewLabelWarning, "continuity-telemetry-review-schema-not-initialized");
      } else {
        reviewLabelWarning = mergeWarningText(reviewLabelWarning, `continuity-telemetry-review-read-failed:${message}`);
      }
    }

    const falseRejectReviewSample = sampleRows
      .map((row): ContinuityTelemetryFalseRejectReviewSample | null => {
        if (
          typeof row.event_id !== "string"
          || !isContinuityTelemetryEventType(row.event_type)
          || typeof row.timestamp !== "string"
        ) {
          return null;
        }

        const payload = parseContinuityTelemetryReviewPayload(row.payload_json);
        const reviewLabel = reviewLabelByEventId.get(row.event_id);

        return {
          eventId: row.event_id,
          timestamp: row.timestamp,
          eventType: row.event_type,
          outcome: typeof row.value_text === "string" ? row.value_text : null,
          reasonCodes: payload.reasonCodes,
          qualityReason: payload.qualityReason,
          reviewLabel: reviewLabel?.label || null,
          reviewedAt: reviewLabel?.reviewedAt || null,
          reviewer: reviewLabel?.reviewer || null,
        };
      })
      .filter((item): item is ContinuityTelemetryFalseRejectReviewSample => item !== null);

    const falseRejectReviewCandidateCount = normalizeSqliteCountValue(candidateRow?.total);

    return {
      status: "ok",
      generatedAt,
      windowDays,
      startDate,
      endDate,
      daySeries,
      falseRejectReviewCandidateCount,
      falseRejectReviewLabeledCount,
      falseRejectReviewPendingCount: Math.max(0, falseRejectReviewCandidateCount - falseRejectReviewLabeledCount),
      falseRejectLabeledValidRejectCount,
      falseRejectLabeledFalseRejectCount,
      falseRejectLabeledUncertainCount,
      falseRejectReviewSample,
      warning: reviewLabelWarning,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    if (/no such table/i.test(message)) {
      return {
        status: "ok",
        generatedAt,
        windowDays,
        startDate,
        endDate,
        daySeries: buildEmptyDaySeries(),
        falseRejectReviewCandidateCount: 0,
        falseRejectReviewLabeledCount: 0,
        falseRejectReviewPendingCount: 0,
        falseRejectLabeledValidRejectCount: 0,
        falseRejectLabeledFalseRejectCount: 0,
        falseRejectLabeledUncertainCount: 0,
        falseRejectReviewSample: [],
        warning: "continuity-telemetry-schema-not-initialized",
      };
    }

    return {
      status: "error",
      generatedAt,
      windowDays,
      startDate,
      endDate,
      daySeries: buildEmptyDaySeries(),
      falseRejectReviewCandidateCount: 0,
      falseRejectReviewLabeledCount: 0,
      falseRejectReviewPendingCount: 0,
      falseRejectLabeledValidRejectCount: 0,
      falseRejectLabeledFalseRejectCount: 0,
      falseRejectLabeledUncertainCount: 0,
      falseRejectReviewSample: [],
      warning: message,
    };
  } finally {
    db.close();
  }
};

/**
 * Read active (non-compacted) continuity counters and per-section distribution.
 */
export const readContinuityActiveCounts = (
  input: ReadContinuityActiveCountsInput,
): ContinuityActiveCounts => {
  if (!existsSync(input.databasePath)) {
    return {
      status: "no-db",
      activeEntryCount: 0,
      sectionCounts: buildEmptyContinuitySectionCountMap(),
      warning: null,
    };
  }

  const db = openBetterSqliteDatabase(input.databasePath, {
    readOnly: true,
    fileMustExist: true,
  });

  try {
    const activeCountRow = db.prepare(`
      SELECT COUNT(*) AS total
      FROM continuity_entries
      WHERE compacted_into_entry_id IS NULL
    `).get();

    const sectionRows = db.prepare(`
      SELECT section_code, COUNT(*) AS total
      FROM continuity_entries
      WHERE compacted_into_entry_id IS NULL
      GROUP BY section_code
    `).all();

    const sectionCounts = buildEmptyContinuitySectionCountMap();

    for (const row of sectionRows) {
      const labels = decodeContinuityRow({
        sectionCode: row.section_code,
        provenanceCode: "C",
        certaintyCode: 0,
      });

      if (!labels) {
        continue;
      }

      sectionCounts[labels.section] = normalizeSqliteCountValue(row.total);
    }

    return {
      status: "ok",
      activeEntryCount: normalizeSqliteCountValue(activeCountRow?.total),
      sectionCounts,
      warning: null,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    if (/no such column: compacted_into_entry_id/i.test(message)) {
      // Legacy DB fallback: treat all continuity rows as active when link column is missing.
      try {
        const legacyCountRow = db.prepare(`
          SELECT COUNT(*) AS total
          FROM continuity_entries
        `).get();

        const legacySectionRows = db.prepare(`
          SELECT section_code, COUNT(*) AS total
          FROM continuity_entries
          GROUP BY section_code
        `).all();

        const sectionCounts = buildEmptyContinuitySectionCountMap();

        for (const row of legacySectionRows) {
          const labels = decodeContinuityRow({
            sectionCode: row.section_code,
            provenanceCode: "C",
            certaintyCode: 0,
          });

          if (!labels) {
            continue;
          }

          sectionCounts[labels.section] = normalizeSqliteCountValue(row.total);
        }

        return {
          status: "ok",
          activeEntryCount: normalizeSqliteCountValue(legacyCountRow?.total),
          sectionCounts,
          warning: "continuity-active-counts-legacy-schema",
        };
      } catch {
        return {
          status: "error",
          activeEntryCount: 0,
          sectionCounts: buildEmptyContinuitySectionCountMap(),
          warning: message,
        };
      }
    }

    return {
      status: "error",
      activeEntryCount: 0,
      sectionCounts: buildEmptyContinuitySectionCountMap(),
      warning: message,
    };
  } finally {
    db.close();
  }
};

/**
 * Read continuity entries and decode compact metadata into labels.
 */
export const readContinuityEntries = (input: ReadContinuityEntriesInput): ContinuityEntryRecord[] => {
  if (!existsSync(input.databasePath)) {
    return [];
  }

  const limit = Math.max(1, Math.min(input.limit ?? 200, 1_000));
  const db = openBetterSqliteDatabase(input.databasePath, {
    readOnly: true,
    fileMustExist: true,
  });

  try {
    let sql = `
      SELECT id, timestamp, section_code, provenance_code, certainty_code, content
      FROM continuity_entries
    `;

    const params: Array<string | number | null> = [];
    const whereClauses: string[] = [];

    if (!input.includeCompacted) {
      // Keep default retrieval focused on active continuity rows only.
      whereClauses.push("compacted_into_entry_id IS NULL");
    }

    if (input.sectionFilter && input.sectionFilter.length > 0) {
      const sectionCodes = input.sectionFilter.map((section) =>
        encodeContinuityMetadata({
          section,
          provenance: "CODE",
          certainty: "CONFIRMED",
        }).sectionCode);

      const placeholders = sectionCodes.map(() => "?").join(", ");
      whereClauses.push(`section_code IN (${placeholders})`);
      params.push(...sectionCodes);
    }

    if (whereClauses.length > 0) {
      sql += ` WHERE ${whereClauses.join(" AND ")}`;
    }

    sql += " ORDER BY timestamp DESC LIMIT ?";
    params.push(limit);

    const rows = db.prepare(sql).all(...params);
    return decodeContinuityEntryRows(rows);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    if (!input.includeCompacted && /no such column: compacted_into_entry_id/i.test(message)) {
      // Legacy DB fallback: tolerate old schemas before migration columns were added.
      try {
        let legacySql = `
          SELECT id, timestamp, section_code, provenance_code, certainty_code, content
          FROM continuity_entries
        `;
        const legacyParams: Array<string | number | null> = [];

        if (input.sectionFilter && input.sectionFilter.length > 0) {
          const sectionCodes = input.sectionFilter.map((section) =>
            encodeContinuityMetadata({
              section,
              provenance: "CODE",
              certainty: "CONFIRMED",
            }).sectionCode);

          legacySql += ` WHERE section_code IN (${sectionCodes.map(() => "?").join(", ")})`;
          legacyParams.push(...sectionCodes);
        }

        legacySql += " ORDER BY timestamp DESC LIMIT ?";
        legacyParams.push(limit);

        const legacyRows = db.prepare(legacySql).all(...legacyParams);
        return decodeContinuityEntryRows(legacyRows);
      } catch {
        return [];
      }
    }

    return [];
  } finally {
    db.close();
  }
};

/**
 * Read one bounded set of continuity entries by explicit ids.
 */
export const readContinuityEntriesByIds = (
  input: ReadContinuityEntriesByIdsInput,
): ContinuityEntryLifecycleRecord[] => {
  if (!existsSync(input.databasePath) || input.entryIds.length === 0) {
    return [];
  }

  const uniqueIds = Array.from(new Set(
    input.entryIds
      .map((entryId) => entryId.trim())
      .filter((entryId) => entryId.length > 0),
  ));

  if (uniqueIds.length === 0) {
    return [];
  }

  const db = openBetterSqliteDatabase(input.databasePath, {
    readOnly: true,
    fileMustExist: true,
  });

  try {
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const rows = db.prepare(`
      SELECT
        id,
        timestamp,
        section_code,
        provenance_code,
        certainty_code,
        content,
        superseded_by_entry_id,
        compacted_into_entry_id
      FROM continuity_entries
      WHERE id IN (${placeholders})
    `).all(...uniqueIds);

    return decodeContinuityLifecycleEntryRows(rows);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    if (/no such column: (superseded_by_entry_id|compacted_into_entry_id)/i.test(message)) {
      // Legacy DB fallback: treat rows as active when migration columns are absent.
      try {
        const placeholders = uniqueIds.map(() => "?").join(", ");
        const legacyRows = db.prepare(`
          SELECT
            id,
            timestamp,
            section_code,
            provenance_code,
            certainty_code,
            content,
            NULL AS superseded_by_entry_id,
            NULL AS compacted_into_entry_id
          FROM continuity_entries
          WHERE id IN (${placeholders})
        `).all(...uniqueIds);

        return decodeContinuityLifecycleEntryRows(legacyRows);
      } catch {
        return [];
      }
    }

    return [];
  } finally {
    db.close();
  }
};

/**
 * Mark active source entries as compacted into one summary entry.
 */
export const markContinuityEntriesCompactedInto = (
  input: MarkContinuityEntriesCompactedIntoInput,
): number => {
  if (input.sourceEntryIds.length === 0) {
    return 0;
  }

  const uniqueIds = Array.from(new Set(
    input.sourceEntryIds
      .map((entryId) => entryId.trim())
      .filter((entryId) => entryId.length > 0),
  ));

  if (uniqueIds.length === 0) {
    return 0;
  }

  const db = openWriteDatabase(input.databasePath);

  try {
    ensureContinuitySchema(db);

    const placeholders = uniqueIds.map(() => "?").join(", ");

    db.prepare(`
      UPDATE continuity_entries
      SET compacted_into_entry_id = ?
      WHERE id IN (${placeholders})
        AND superseded_by_entry_id IS NULL
        AND compacted_into_entry_id IS NULL
    `).run(
      input.compactedIntoEntryId,
      ...uniqueIds,
    );

    return normalizeSqliteCountValue(
      db.prepare("SELECT changes() AS total").get()?.total,
    );
  } finally {
    db.close();
  }
};

/**
 * Clear compaction linkage from one bounded source-entry set.
 */
export const clearContinuityEntriesCompactedInto = (
  input: ClearContinuityEntriesCompactedIntoInput,
): number => {
  if (input.sourceEntryIds.length === 0) {
    return 0;
  }

  const uniqueIds = Array.from(new Set(
    input.sourceEntryIds
      .map((entryId) => entryId.trim())
      .filter((entryId) => entryId.length > 0),
  ));

  if (uniqueIds.length === 0) {
    return 0;
  }

  const db = openWriteDatabase(input.databasePath);

  try {
    ensureContinuitySchema(db);

    const placeholders = uniqueIds.map(() => "?").join(", ");
    let sql = `
      UPDATE continuity_entries
      SET compacted_into_entry_id = NULL
      WHERE id IN (${placeholders})
    `;

    const params: Array<string | number | null> = [...uniqueIds];

    if (input.compactedIntoEntryId) {
      sql += " AND compacted_into_entry_id = ?";
      params.push(input.compactedIntoEntryId);
    }

    db.prepare(sql).run(...params);

    return normalizeSqliteCountValue(
      db.prepare("SELECT changes() AS total").get()?.total,
    );
  } finally {
    db.close();
  }
};

/**
 * Read continuity milestones and decode compact metadata into labels.
 */
export const readContinuityMilestones = (
  input: ReadContinuityMilestonesInput,
): ContinuityMilestoneRecord[] => {
  if (!existsSync(input.databasePath)) {
    return [];
  }

  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  const db = openBetterSqliteDatabase(input.databasePath, {
    readOnly: true,
    fileMustExist: true,
  });

  try {
    const rows = db.prepare(`
      SELECT
        id,
        timestamp,
        section_code,
        provenance_code,
        certainty_code,
        summary,
        covered_from_timestamp,
        covered_to_timestamp,
        source_entry_count
      FROM continuity_milestones
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit);

    return rows
      .map((row): ContinuityMilestoneRecord | null => {
        if (
          typeof row.id !== "string"
          || typeof row.timestamp !== "string"
          || typeof row.summary !== "string"
        ) {
          return null;
        }

        const labels = decodeContinuityRow({
          sectionCode: row.section_code,
          provenanceCode: row.provenance_code,
          certaintyCode: row.certainty_code,
        });

        if (!labels) {
          return null;
        }

        return {
          id: row.id,
          timestamp: row.timestamp,
          summary: row.summary,
          coveredFromTimestamp: typeof row.covered_from_timestamp === "string" ? row.covered_from_timestamp : null,
          coveredToTimestamp: typeof row.covered_to_timestamp === "string" ? row.covered_to_timestamp : null,
          sourceEntryCount: typeof row.source_entry_count === "number" ? row.source_entry_count : 0,
          ...labels,
        };
      })
      .filter((row): row is ContinuityMilestoneRecord => row !== null);
  } catch {
    return [];
  } finally {
    db.close();
  }
};

/**
 * Normalize one partial compaction policy into safe deterministic bounds.
 */
const normalizeContinuityCompactionPolicy = (
  policy?: Partial<ContinuityCompactionPolicy>,
): ContinuityCompactionPolicy => {
  const maxEntries = typeof policy?.maxEntries === "number"
    ? Math.max(10, Math.floor(policy.maxEntries))
    : DEFAULT_CONTINUITY_COMPACTION_POLICY.maxEntries;

  const retainRecentEntries = typeof policy?.retainRecentEntries === "number"
    ? Math.max(1, Math.min(Math.floor(policy.retainRecentEntries), maxEntries - 1))
    : Math.min(DEFAULT_CONTINUITY_COMPACTION_POLICY.retainRecentEntries, maxEntries - 1);

  const minimumEntriesToCompact = typeof policy?.minimumEntriesToCompact === "number"
    ? Math.max(1, Math.floor(policy.minimumEntriesToCompact))
    : DEFAULT_CONTINUITY_COMPACTION_POLICY.minimumEntriesToCompact;

  const maxHighlightsPerSection = typeof policy?.maxHighlightsPerSection === "number"
    ? Math.max(1, Math.floor(policy.maxHighlightsPerSection))
    : DEFAULT_CONTINUITY_COMPACTION_POLICY.maxHighlightsPerSection;

  return {
    maxEntries,
    retainRecentEntries,
    minimumEntriesToCompact,
    maxHighlightsPerSection,
  };
};

/**
 * Normalize one snippet included in generated milestone summaries.
 */
const normalizeCompactionSnippet = (content: string): string => {
  const normalized = content.trim().replace(/\s+/g, " ");
  if (normalized.length <= 96) {
    return normalized;
  }

  return `${normalized.slice(0, 95).trimEnd()}…`;
};

/**
 * Build one compact milestone summary from compacted rows.
 */
const buildContinuityCompactionSummary = (input: {
  compactedRows: RawContinuityEntryRow[];
  maxHighlightsPerSection: number;
}): string => {
  const decodedRows = input.compactedRows
    .map((row) => {
      const labels = decodeContinuityRow({
        sectionCode: row.sectionCode,
        provenanceCode: row.provenanceCode,
        certaintyCode: row.certaintyCode,
      });

      if (!labels) {
        return null;
      }

      return {
        ...labels,
        content: row.content,
      };
    })
    .filter((row): row is ContinuityMetadataLabels & { content: string } => row !== null);

  if (decodedRows.length === 0) {
    return `Compacted ${input.compactedRows.length} continuity entries with undecodable metadata.`;
  }

  const orderedSections: ContinuitySection[] = [
    "DECISIONS",
    "PLANS",
    "OUTCOMES",
    "PROGRESS",
    "DISCOVERIES",
  ];

  const sectionCounts = new Map<ContinuitySection, number>();
  const sectionHighlights = new Map<ContinuitySection, string[]>();

  for (const row of decodedRows) {
    sectionCounts.set(row.section, (sectionCounts.get(row.section) ?? 0) + 1);

    const highlights = sectionHighlights.get(row.section) ?? [];
    if (highlights.length < input.maxHighlightsPerSection) {
      highlights.push(normalizeCompactionSnippet(row.content));
      sectionHighlights.set(row.section, highlights);
    }
  }

  const countSummary = orderedSections
    .filter((section) => sectionCounts.has(section))
    .map((section) => `${section}=${sectionCounts.get(section)}`)
    .join(", ");

  const highlightSummary = orderedSections
    .filter((section) => (sectionHighlights.get(section)?.length ?? 0) > 0)
    .map((section) => `${section}: ${sectionHighlights.get(section)?.join(" | ")}`)
    .join(" || ");

  return `Compacted ${input.compactedRows.length} continuity entries (${countSummary}). Highlights: ${highlightSummary}`;
};

/**
 * Run bounded continuity compaction on one user-scoped continuity store.
 *
 * Decision:
 * - compact only when entry volume exceeds threshold,
 * - preserve newest entries for short-term startup context,
 * - collapse compacted tail into one OUTCOMES/CODE milestone for traceability.
 */
export const runContinuityCompactionPolicy = (
  input: RunContinuityCompactionPolicyInput,
): ContinuityCompactionResult => {
  const policy = normalizeContinuityCompactionPolicy(input.policy);

  if (!existsSync(input.databasePath)) {
    return {
      status: "skipped-no-db",
      totalEntryCount: 0,
      retainedEntryCount: 0,
      compactedEntryCount: 0,
      milestoneId: null,
      warning: null,
    };
  }

  const db = openWriteDatabase(input.databasePath);

  try {
    ensureContinuitySchema(db);

    const rows = db.prepare(`
      SELECT id, timestamp, section_code, provenance_code, certainty_code, content
      FROM continuity_entries
      ORDER BY timestamp DESC
    `).all().map((row): RawContinuityEntryRow | null => {
      if (
        typeof row.id !== "string"
        || typeof row.timestamp !== "string"
        || typeof row.section_code !== "string"
        || typeof row.provenance_code !== "string"
        || (typeof row.certainty_code !== "number" && typeof row.certainty_code !== "string")
        || typeof row.content !== "string"
      ) {
        return null;
      }

      return {
        id: row.id,
        timestamp: row.timestamp,
        sectionCode: row.section_code,
        provenanceCode: row.provenance_code,
        certaintyCode: row.certainty_code,
        content: row.content,
      };
    }).filter((row): row is RawContinuityEntryRow => row !== null);

    if (rows.length <= policy.maxEntries) {
      return {
        status: "skipped-under-threshold",
        totalEntryCount: rows.length,
        retainedEntryCount: rows.length,
        compactedEntryCount: 0,
        milestoneId: null,
        warning: null,
      };
    }

    const retainedEntryCount = Math.max(1, Math.min(policy.retainRecentEntries, rows.length - 1));
    const compactedRows = rows.slice(retainedEntryCount);

    if (compactedRows.length < policy.minimumEntriesToCompact) {
      return {
        status: "skipped-under-threshold",
        totalEntryCount: rows.length,
        retainedEntryCount: rows.length,
        compactedEntryCount: 0,
        milestoneId: null,
        warning: `Compaction tail (${compactedRows.length}) is below minimumEntriesToCompact=${policy.minimumEntriesToCompact}`,
      };
    }

    const coveredToTimestamp = compactedRows[0]?.timestamp || null;
    const coveredFromTimestamp = compactedRows.at(-1)?.timestamp || null;
    const milestoneId = `cm_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const milestoneTimestamp = input.timestamp || new Date().toISOString();

    const milestoneCodes = encodeContinuityMetadata({
      section: "OUTCOMES",
      provenance: "CODE",
      certainty: "CONFIRMED",
    });

    const summary = buildContinuityCompactionSummary({
      compactedRows,
      maxHighlightsPerSection: policy.maxHighlightsPerSection,
    });

    db.exec("BEGIN IMMEDIATE TRANSACTION");

    db.prepare(`
      INSERT OR REPLACE INTO continuity_milestones (
        id,
        timestamp,
        section_code,
        provenance_code,
        certainty_code,
        summary,
        covered_from_timestamp,
        covered_to_timestamp,
        source_entry_count
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      milestoneId,
      milestoneTimestamp,
      milestoneCodes.sectionCode,
      milestoneCodes.provenanceCode,
      milestoneCodes.certaintyCode,
      summary,
      coveredFromTimestamp,
      coveredToTimestamp,
      compactedRows.length,
    );

    const deleteStatement = db.prepare(`
      DELETE FROM continuity_entries
      WHERE id = ?
    `);

    for (const row of compactedRows) {
      deleteStatement.run(row.id);
    }

    db.exec("COMMIT");

    return {
      status: "compacted",
      totalEntryCount: rows.length,
      retainedEntryCount,
      compactedEntryCount: compactedRows.length,
      milestoneId,
      warning: null,
    };
  } catch (error: unknown) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // No-op: rollback itself can fail if transaction was not opened.
    }

    return {
      status: "error",
      totalEntryCount: 0,
      retainedEntryCount: 0,
      compactedEntryCount: 0,
      milestoneId: null,
      warning: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db.close();
  }
};
