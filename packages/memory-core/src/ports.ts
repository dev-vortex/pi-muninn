/**
 * File intent: define host-neutral provider ports for memory-core.
 *
 * Ports describe capabilities the core needs without committing to Pi, SQLite,
 * local files, or a specific vector backend. Slice 1 only defines contracts; the
 * first implementation provider remains SQLite/local filesystem later.
 */

import type {
  ContinuityCompactApplyRequest,
  ContinuityCompactPreviewRequest,
  ContinuityQueryRequest,
  ContinuityWriteRequest,
  CoreRequestContext,
  CoreTextResult,
  MemoryCoreBaseResult,
  MemoryOperationResult,
  MemoryRecallRequest,
  MemorySaveRequest,
  MemorySearchRequest,
  PromptBriefingRequest,
  PromptBriefingResult,
  RuntimeStatusRequest,
  TelemetryReportRequest,
  TelemetryReviewLabelRequest,
} from "./contracts.js";

/**
 * Project-memory configuration shape used at the core boundary.
 */
export interface CoreProjectMemoryConfig {
  /** Whether project-aware memory is enabled for the project. */
  projectMemoryEnabled: boolean;
  /** Retrieval mode name selected by config. */
  mode?: string;
  /** Optional active user id configured by the project. */
  myUserId?: string | null;
  /** Additional provider/adapter-specific config preserved during transitions. */
  [key: string]: unknown;
}

/**
 * Load/save project-level configuration without exposing file paths to core logic.
 */
export interface ConfigPort {
  /** Load project configuration for one project root. */
  loadProjectConfig(projectRoot: string): Promise<CoreProjectMemoryConfig>;
  /** Persist project configuration for one project root. */
  saveProjectConfig(projectRoot: string, config: CoreProjectMemoryConfig): Promise<void>;
}

/**
 * Resolve host-neutral runtime context into provider-specific paths/ids.
 */
export interface RuntimeContextPort {
  /** Resolve provider runtime details for one request. */
  resolveRuntimeContext(context: CoreRequestContext): Promise<Record<string, unknown>>;
}

/**
 * Logical memory lanes owned by core and persisted by memory providers.
 */
export type CoreMemoryLane = "project-member" | "global-curated";

/**
 * Core-owned memory write DTO consumed by memory providers.
 */
export interface CoreMemorySaveInput {
  /** Host-normalized request context. */
  context: CoreRequestContext;
  /** Logical memory lane selected by core routing policy. */
  lane: CoreMemoryLane;
  /** Memory content to persist. */
  content: string;
  /** Optional project/name bucket for provider metadata. */
  projectName?: string;
  /** Optional topic bucket for provider metadata. */
  topic?: string;
  /** Optional source marker for provider metadata. */
  source?: string;
  /** Optional ISO timestamp supplied by core/adapter clock. */
  timestamp?: string;
  /** Optional importance hint. */
  importance?: number;
}

/**
 * Core-owned memory save result normalized by memory providers.
 */
export interface CoreMemorySaveResult extends MemoryCoreBaseResult {
  /** Provider-generated memory id when available. */
  id: string | null;
  /** True when provider detected an existing equivalent memory. */
  duplicate: boolean;
}

/**
 * Core-owned memory search DTO consumed by memory providers.
 */
export interface CoreMemorySearchInput {
  /** Host-normalized request context. */
  context: CoreRequestContext;
  /** Search query text. */
  query: string;
  /** Logical lanes selected by core retrieval policy. */
  lanes: CoreMemoryLane[];
  /** Optional project/name bucket filter. */
  projectName?: string;
  /** Optional topic filter. */
  topic?: string;
  /** Maximum provider hits requested. */
  limit?: number;
}

/**
 * One normalized memory hit returned by any memory provider.
 */
export interface CoreMemoryHit {
  /** Provider/core memory id. */
  id: string;
  /** Logical memory lane represented by this hit. */
  lane: CoreMemoryLane;
  /** Memory content. */
  content: string;
  /** Provider project/name bucket when available. */
  projectName?: string;
  /** Provider topic bucket when available. */
  topic?: string;
  /** Provider source marker when available. */
  source?: string;
  /** ISO timestamp when available. */
  timestamp?: string;
  /** Provider lexical/vector score when available. */
  score?: number;
  /** Normalized semantic similarity in the 0..1 range when available. */
  semanticSimilarity?: number;
  /** Extra provider metadata after normalization; never vendor class instances. */
  metadata?: Record<string, unknown>;
}

/**
 * Core-owned memory search result normalized by memory providers.
 */
export interface CoreMemorySearchResult extends MemoryCoreBaseResult {
  /** Normalized memory hits. */
  hits: CoreMemoryHit[];
}

/**
 * Core-owned memory recall DTO consumed by memory providers.
 */
export interface CoreMemoryRecallInput {
  /** Host-normalized request context. */
  context: CoreRequestContext;
  /** Logical lanes selected by core recall policy. */
  lanes: CoreMemoryLane[];
  /** Optional project/name bucket filter. */
  projectName?: string;
  /** Optional topic filter. */
  topic?: string;
  /** Maximum provider hits requested. */
  limit?: number;
}

/**
 * Core-owned memory recall result normalized by memory providers.
 */
export interface CoreMemoryRecallResult extends MemoryCoreBaseResult {
  /** Normalized recalled memory rows. */
  hits: CoreMemoryHit[];
}

/**
 * Store/search/recall memory rows behind the L1/L3 memory provider boundary.
 */
export interface CoreMemoryProviderPort {
  /** Store memory content after core routing selected a logical lane. */
  save(input: CoreMemorySaveInput): Promise<CoreMemorySaveResult>;
  /** Search memory lanes selected by core retrieval policy. */
  search(input: CoreMemorySearchInput): Promise<CoreMemorySearchResult>;
  /** Recall memory lanes by metadata or recency. */
  recall(input: CoreMemoryRecallInput): Promise<CoreMemoryRecallResult>;
}

/**
 * Compatibility alias retained while older shell dependencies are renamed.
 */
export type MemoryStorePort = CoreMemoryProviderPort;

/**
 * One continuity row shape normalized by continuity data adapters.
 */
export interface CoreContinuityRecord {
  /** Provider/core continuity id. */
  id: string;
  /** Continuity section label. */
  section: ContinuityWriteRequest["section"];
  /** Provenance label. */
  provenance: ContinuityWriteRequest["provenance"];
  /** Certainty label. */
  certainty: NonNullable<ContinuityWriteRequest["certainty"]>;
  /** Continuity content. */
  content: string;
  /** ISO timestamp. */
  timestamp: string;
  /** Optional source references. */
  sourceRefs?: string[];
  /** True when this row has been compacted into a milestone. */
  compacted?: boolean;
}

/**
 * One continuity milestone shape normalized by continuity data adapters.
 */
export interface CoreContinuityMilestoneRecord {
  /** Provider/core milestone id. */
  id: string;
  /** Continuity section label. */
  section: ContinuityWriteRequest["section"];
  /** Provenance label. */
  provenance: ContinuityWriteRequest["provenance"];
  /** Certainty label. */
  certainty: NonNullable<ContinuityWriteRequest["certainty"]>;
  /** Milestone summary content. */
  summary: string;
  /** ISO timestamp. */
  timestamp: string;
  /** Number of source entries covered by this milestone. */
  sourceEntryCount: number;
  /** Covered lower timestamp bound when available. */
  coveredFromTimestamp?: string | null;
  /** Covered upper timestamp bound when available. */
  coveredToTimestamp?: string | null;
}

/**
 * Core-owned continuity persist DTO consumed by non-vendor data adapters.
 */
export interface CoreContinuityDataPersistInput extends ContinuityWriteRequest {
  /** Normalized content after core source-reference handling. */
  content: string;
  /** Normalized certainty selected by core policy. */
  certainty: NonNullable<ContinuityWriteRequest["certainty"]>;
  /** Normalized timestamp selected by core policy. */
  timestamp: string;
}

/**
 * Core-owned continuity persist result normalized by data adapters.
 */
export interface CoreContinuityDataPersistResult extends MemoryCoreBaseResult {
  /** Persistence outcome after duplicate/quality gates. */
  outcome: "stored" | "skipped";
  /** Skip reason when outcome is skipped. */
  skipReason?: "duplicate" | "low-signal";
  /** Deterministic fingerprint when available. */
  fingerprint?: string;
  /** Stored/normalized timestamp. */
  timestamp?: string;
  /** Duplicate row timestamp when available. */
  duplicateTimestamp?: string;
  /** Low-signal quality reason when available. */
  qualityReason?: string;
}

/**
 * Core-owned continuity write DTO consumed by non-vendor data adapters.
 */
export interface CoreContinuityDataWriteInput extends ContinuityWriteRequest {}

/**
 * Core-owned continuity write result normalized by data adapters.
 */
export interface CoreContinuityDataWriteResult extends MemoryCoreBaseResult {
  /** Stored continuity id when available. */
  id: string | null;
  /** Stored normalized row when available. */
  record?: CoreContinuityRecord;
}

/**
 * Core-owned continuity query DTO consumed by non-vendor data adapters.
 */
export interface CoreContinuityDataQueryInput extends ContinuityQueryRequest {}

/**
 * Core-owned continuity query result normalized by data adapters.
 */
export interface CoreContinuityDataQueryResult extends MemoryCoreBaseResult {
  /** Matching continuity entries. */
  entries: CoreContinuityRecord[];
  /** Matching milestone rows when included by core policy. */
  milestones: CoreContinuityMilestoneRecord[];
}

/**
 * Continuity status result normalized by non-vendor data adapters.
 */
export interface CoreContinuityDataStatusResult extends MemoryCoreBaseResult {
  /** Active, non-compacted continuity row count. */
  activeCount: number;
  /** Compacted continuity row count when available. */
  compactedCount?: number;
  /** Milestone row count when available. */
  milestoneCount?: number;
}

/**
 * Section counts used by prompt briefing compaction-pressure rendering.
 */
export type CoreContinuitySectionCounts = Record<ContinuityWriteRequest["section"], number>;

/**
 * Continuity briefing state normalized by the L0 data adapter.
 */
export interface CoreContinuityBriefingStateResult extends MemoryCoreBaseResult {
  /** Active, non-compacted continuity row count. */
  activeEntryCount: number;
  /** Active row count by continuity section. */
  sectionCounts: CoreContinuitySectionCounts;
  /** Approved continuity compaction preview count awaiting apply/review. */
  pendingPreviewCount: number;
}

/**
 * One semantic continuity hit used only for prompt briefing selection.
 */
export interface CoreContinuityBriefingSemanticHit {
  /** Hydrated continuity row. */
  record: CoreContinuityRecord;
  /** Normalized vector similarity in the 0..1 range. */
  semanticSimilarity: number;
}

/**
 * Semantic continuity briefing result normalized by the L0 data adapter.
 */
export interface CoreContinuityBriefingSemanticResult extends MemoryCoreBaseResult {
  /** Semantic continuity candidates, ordered by adapter relevance when available. */
  hits: CoreContinuityBriefingSemanticHit[];
}

/**
 * Read/write continuity rows through the non-vendor L0 data-adapter boundary.
 */
export interface ContinuityDataAdapterPort {
  /** Persist one continuity row through adapter-owned duplicate/vector gates. */
  persistWrite(input: CoreContinuityDataPersistInput): Promise<CoreContinuityDataPersistResult>;
  /** Store one continuity row without higher-level duplicate/vector gates. */
  write(input: CoreContinuityDataWriteInput): Promise<CoreContinuityDataWriteResult>;
  /** Query continuity rows/milestones. */
  query(input: CoreContinuityDataQueryInput): Promise<CoreContinuityDataQueryResult>;
  /** Read prompt-briefing state when exact active/preview counts are available. */
  readBriefingState?: (input: { context: CoreRequestContext }) => Promise<CoreContinuityBriefingStateResult>;
  /** Search semantic continuity candidates for prompt briefing when vectors are available. */
  searchBriefingEntries?: (input: {
    context: CoreRequestContext;
    queryText: string;
    limit?: number;
  }) => Promise<CoreContinuityBriefingSemanticResult>;
  /** Preview local continuity compaction when implemented by the data adapter. */
  previewCompaction?: (input: ContinuityCompactPreviewRequest) => Promise<CoreTextResult>;
  /** Apply local continuity compaction when implemented by the data adapter. */
  applyCompaction?: (input: ContinuityCompactApplyRequest) => Promise<CoreTextResult>;
  /** Read continuity status counts/details. */
  readStatus(input: RuntimeStatusRequest): Promise<CoreContinuityDataStatusResult>;
}

/**
 * Compatibility alias retained while older shell dependencies are renamed.
 */
export type ContinuityStorePort = ContinuityDataAdapterPort;

/**
 * Core-owned project index query DTO consumed by the L2 data adapter.
 */
export interface CoreProjectIndexSearchInput {
  /** Host-normalized request context. */
  context: CoreRequestContext;
  /** Query text. Empty query means recency/metadata retrieval when supported. */
  query: string;
  /** Source row kinds requested by core. */
  kindFilter?: Array<"memory" | "continuity">;
  /** Optional memory topic or continuity topic filter. */
  topic?: string;
  /** Optional continuity section filter. */
  section?: ContinuityWriteRequest["section"];
  /** Optional inclusive lower timestamp bound. */
  from?: string;
  /** Optional inclusive upper timestamp bound. */
  to?: string;
  /** Whether milestone rows should be included for continuity retrieval. */
  includeMilestones?: boolean;
  /** Whether compacted/superseded continuity rows should be included. */
  includeCompacted?: boolean;
  /** Maximum normalized hits returned to core. */
  limit?: number;
}

/**
 * One project-index hit normalized by the L2 data adapter.
 */
export interface CoreProjectIndexHit {
  /** L2/cache row id. */
  id: string;
  /** Canonical source row id when different from L2/cache id. */
  sourceId?: string;
  /** Source row kind. */
  kind: "memory" | "continuity";
  /** Source user/member id when available. */
  userId?: string;
  /** Source database path when available for diagnostics. */
  databasePath?: string;
  /** Hit text/content. */
  content: string;
  /** Memory topic or continuity topic label. */
  topic?: string;
  /** Source/provenance metadata. */
  source?: string;
  /** Timestamp when available. */
  timestamp?: string;
  /** Continuity section when this is a continuity row. */
  section?: ContinuityWriteRequest["section"];
  /** Continuity provenance when this is a continuity row. */
  provenance?: ContinuityWriteRequest["provenance"];
  /** Continuity certainty when this is a continuity row. */
  certainty?: NonNullable<ContinuityWriteRequest["certainty"]>;
  /** Compaction target id when this continuity row is compacted. */
  compactedIntoEntryId?: string | null;
  /** Supersession target id when this continuity row is superseded. */
  supersededByEntryId?: string | null;
  /** Lexical term match count when available. */
  termMatches?: number;
  /** Retrieval score when available. */
  score?: number;
  /** Normalized semantic similarity when available. */
  semanticSimilarity?: number;
  /** Adapter-specific metadata after normalization. */
  metadata?: Record<string, unknown>;
}

/**
 * One cross-user continuity milestone normalized by the L2 data adapter.
 */
export interface CoreProjectIndexContinuityMilestoneHit {
  /** Canonical milestone id. */
  id: string;
  /** Source user/member id. */
  userId: string;
  /** Source database path when available for diagnostics. */
  databasePath?: string;
  /** Continuity section represented by the milestone. */
  section: ContinuityWriteRequest["section"];
  /** Continuity provenance represented by the milestone. */
  provenance: ContinuityWriteRequest["provenance"];
  /** Continuity certainty represented by the milestone. */
  certainty: NonNullable<ContinuityWriteRequest["certainty"]>;
  /** Milestone summary text. */
  summary: string;
  /** Milestone timestamp. */
  timestamp: string;
  /** Number of source entries covered by the milestone. */
  sourceEntryCount: number;
}

/**
 * Core-owned project index result normalized by the L2 data adapter.
 */
export interface CoreProjectIndexSearchResult extends MemoryCoreBaseResult {
  /** Normalized index hits. */
  hits: CoreProjectIndexHit[];
  /** Normalized continuity milestones when requested. */
  milestones?: CoreProjectIndexContinuityMilestoneHit[];
  /** Requested retrieval mode when known. */
  requestedMode?: string;
  /** Effective retrieval mode when known. */
  effectiveMode?: string;
  /** Degradation reason when the adapter fell back. */
  degradedReason?: string | null;
  /** Number of source databases discovered. */
  databaseCount?: number;
  /** Number of source databases searched. */
  searchedDatabaseCount?: number;
}

/**
 * Project index/cache data adapter for L2 retrieval support.
 */
export interface ProjectIndexDataAdapterPort {
  /** Search the derived project index/cache. */
  search(input: CoreProjectIndexSearchInput): Promise<CoreProjectIndexSearchResult>;
  /** Read project index/cache status. */
  readStatus(input: RuntimeStatusRequest): Promise<CoreTextResult>;
}

/**
 * Build prompt briefings from memory/continuity sources.
 */
export interface PromptBriefingPort {
  /** Build prompt-scoped briefing text. */
  buildPromptBriefing(input: PromptBriefingRequest): Promise<PromptBriefingResult>;
}

/**
 * Vector retrieval provider for semantic memory/continuity features.
 */
export interface VectorSearchPort {
  /** Search vector-capable rows by query text. */
  search(input: {
    context: CoreRequestContext;
    query: string;
    limit?: number;
    scope?: "memory" | "continuity";
  }): Promise<{
    status: "ok" | "unavailable" | "error";
    results: Array<Record<string, unknown>>;
    warning?: string | null;
  }>;
}

/**
 * Text embedding provider used by vector search/indexing implementations.
 */
export interface EmbeddingPort {
  /** Name/version of the active embedding model. */
  modelName: string;
  /** Output vector dimensions. */
  embeddingDimension: number;
  /** Embed arbitrary text. */
  embedText(text: string): Promise<Float32Array>;
}

/**
 * Telemetry provider for reports and review labels.
 */
/**
 * One UTC day bucket in a continuity telemetry trend report.
 */
export interface CoreTelemetryTrendDay {
  /** UTC YYYY-MM-DD day key. */
  date: string;
  /** Number of telemetry events recorded that day. */
  totalEvents: number;
  /** Number of continuity query events. */
  queryCount: number;
  /** Number of continuity queries that degraded from hybrid retrieval. */
  queryHybridDegradedCount: number;
  /** Number of stored continuity write events. */
  continuityWriteStoredCount: number;
  /** Number of skipped continuity write events. */
  continuityWriteSkippedCount: number;
  /** Number of rejected compaction preview events. */
  compactionPreviewRejectedCount: number;
  /** Number of rejected compaction apply events. */
  compactionApplyRejectedCount: number;
  /** Number of events eligible for false-reject review. */
  falseRejectReviewCandidateCount: number;
}

/**
 * One sampled false-reject review candidate from telemetry history.
 */
export interface CoreTelemetryFalseRejectReviewSample {
  /** Telemetry event id to label. */
  eventId: string;
  /** Event timestamp. */
  timestamp: string;
  /** Provider/core event type. */
  eventType: string;
  /** Event outcome text when available. */
  outcome: string | null;
  /** Runtime reason codes extracted from event payload. */
  reasonCodes: string[];
  /** Quality-gate reason extracted from event payload. */
  qualityReason: string | null;
  /** Existing review label when available. */
  reviewLabel: TelemetryReviewLabelRequest["label"] | null;
  /** Review timestamp when available. */
  reviewedAt: string | null;
  /** Reviewer id/name when available. */
  reviewer: string | null;
}

/**
 * Structured continuity telemetry report normalized by telemetry providers.
 */
export interface CoreTelemetryReport {
  /** Provider read status. */
  status: "ok" | "no-db" | "error";
  /** Report generation timestamp. */
  generatedAt: string;
  /** Window size after provider/core bounds. */
  windowDays: number;
  /** Inclusive UTC start date. */
  startDate: string;
  /** Inclusive UTC end date. */
  endDate: string;
  /** Trend day buckets. */
  daySeries: CoreTelemetryTrendDay[];
  /** Total false-reject review candidates in the window. */
  falseRejectReviewCandidateCount: number;
  /** Number of candidates already labeled. */
  falseRejectReviewLabeledCount: number;
  /** Number of candidates still pending label review. */
  falseRejectReviewPendingCount: number;
  /** Count labeled as valid runtime rejection. */
  falseRejectLabeledValidRejectCount: number;
  /** Count labeled as runtime false rejection. */
  falseRejectLabeledFalseRejectCount: number;
  /** Count labeled uncertain. */
  falseRejectLabeledUncertainCount: number;
  /** Sampled review candidates for operator/admin QA. */
  falseRejectReviewSample: CoreTelemetryFalseRejectReviewSample[];
  /** Provider warning when report is degraded. */
  warning: string | null;
}

/**
 * Telemetry report result normalized by telemetry providers.
 */
export interface CoreTelemetryReportResult extends MemoryCoreBaseResult {
  /** Structured continuity telemetry report. */
  report: CoreTelemetryReport;
}

/**
 * Telemetry review-label write result normalized by telemetry providers.
 */
export interface CoreTelemetryReviewLabelResult extends MemoryCoreBaseResult {
  /** Provider label persistence status. */
  labelStatus: "stored" | "event-not-found" | "event-not-review-eligible" | "error";
  /** Normalized event id that was labeled/requested. */
  eventId: string;
  /** Label value when supplied. */
  label?: TelemetryReviewLabelRequest["label"];
  /** Provider warning when label persistence failed. */
  warning: string | null;
}

/**
 * Telemetry provider for reports and review labels.
 */
export interface TelemetryPort {
  /** Record one provider-specific telemetry event. */
  record(event: {
    context: CoreRequestContext;
    eventType: string;
    valueA?: number;
    valueB?: number;
    valueText?: string;
    payloadJson?: string;
  }): Promise<void>;
  /** Read telemetry report/queue details. */
  report?: (input: TelemetryReportRequest) => Promise<CoreTelemetryReportResult>;
  /** Label one telemetry review candidate. */
  label?: (input: TelemetryReviewLabelRequest) => Promise<CoreTelemetryReviewLabelResult>;
}

/**
 * Clock abstraction for deterministic tests and host-provided timestamps.
 */
export interface ClockPort {
  /** Return current time as ISO-8601 string. */
  nowIso(): string;
}

/**
 * Minimal logger abstraction so core never depends on host UI APIs.
 */
export interface LoggerPort {
  /** Debug-level diagnostic message. */
  debug(message: string, details?: Record<string, unknown>): void;
  /** Warning-level diagnostic message. */
  warn(message: string, details?: Record<string, unknown>): void;
  /** Error-level diagnostic message. */
  error(message: string, details?: Record<string, unknown>): void;
}
