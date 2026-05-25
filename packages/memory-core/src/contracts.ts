/**
 * File intent: define host-neutral memory-core application contracts.
 *
 * These types are deliberately independent from Pi, OpenCode, KiloCode, and any
 * other client host. Adapters translate host events/tool calls into these plain
 * request/result objects before invoking core behavior.
 */

/**
 * Stable status values shared by host-neutral core operations.
 */
export type MemoryCoreOperationStatus =
  | "ok"
  | "disabled"
  | "unavailable"
  | "unimplemented"
  | "error";

/**
 * Common request metadata supplied by any host adapter.
 */
export interface CoreRequestContext {
  /** Absolute project root resolved by the adapter. */
  projectRoot: string;
  /** Optional broader workspace root when different from project root. */
  workspaceRoot?: string;
  /** Active user/member id when known. */
  userId: string | null;
  /** Host-specific session id, normalized to a string by the adapter. */
  sessionId?: string;
  /** Host-specific request/prompt id when available. */
  requestId?: string;
  /** ISO timestamp supplied by adapter/clock; core can resolve one if omitted. */
  now?: string;
}

/**
 * Common result fields included in every core operation response.
 */
export interface MemoryCoreBaseResult {
  /** Operation status after core processing. */
  status: MemoryCoreOperationStatus;
  /** Human-readable warnings suitable for logs/status surfaces. */
  warnings: string[];
  /** Structured diagnostics for adapter-specific result metadata. */
  diagnostics: Record<string, unknown>;
}

/**
 * Request to build prompt-scoped memory/continuity briefing text.
 */
export interface PromptBriefingRequest {
  /** Host-normalized request context. */
  context: CoreRequestContext;
  /** Current user prompt text. */
  prompt: string;
  /** Whether continuity briefing should be included. */
  includeContinuity: boolean;
  /** Whether project-memory briefing should be included. */
  includeProjectMemory: boolean;
  /** Whether core should record telemetry for this briefing. */
  recordTelemetry?: boolean;
  /** Continuity briefing retrieval mode selected by adapter/config. */
  continuityMode?: "lexical" | "semantic";
  /** Adapter-provided telemetry source label for diagnostics. */
  telemetrySource?: string;
}

/**
 * Prompt briefing result returned by core and injected/rendered by adapters.
 */
export interface PromptBriefingResult extends MemoryCoreBaseResult {
  /** Text to inject/render, or null when briefing is disabled/unavailable. */
  briefingText: string | null;
}

/**
 * Request to store project/general memory through core routing rules.
 */
export interface MemorySaveRequest {
  /** Host-normalized request context. */
  context: CoreRequestContext;
  /** Optional provider project/name bucket selected by the adapter. */
  projectName?: string;
  /** Optional project-scoped content. */
  projectContent?: string;
  /** Optional reusable/global content. */
  generalContent?: string;
  /** Optional project topic. */
  projectTopic?: string;
  /** Optional reusable/global topic. */
  generalTopic?: string;
  /** Optional importance hint. */
  importance?: number;
}

/**
 * Request to search project + reusable user memory lanes.
 */
export interface MemorySearchRequest {
  /** Host-normalized request context. */
  context: CoreRequestContext;
  /** Optional provider project/name bucket selected by the adapter. */
  projectName?: string;
  /** Search query text. */
  query: string;
  /** Optional topic filter. */
  topic?: string;
  /** Maximum rows requested by the host. */
  limit?: number;
}

/**
 * Request to recall project + reusable user memory by metadata/recency.
 */
export interface MemoryRecallRequest {
  /** Host-normalized request context. */
  context: CoreRequestContext;
  /** Optional provider project/name bucket selected by the adapter. */
  projectName?: string;
  /** Optional topic filter. */
  topic?: string;
  /** Maximum rows requested by the host. */
  limit?: number;
}

/**
 * Generic text result for memory operations that adapters can map to tool output.
 */
export interface MemoryOperationResult extends MemoryCoreBaseResult {
  /** Human-readable result text. */
  text: string;
}

/**
 * Request to write one continuity entry.
 */
export interface ContinuityWriteRequest {
  /** Host-normalized request context. */
  context: CoreRequestContext;
  /** Continuity section label. */
  section: "PLANS" | "DECISIONS" | "PROGRESS" | "DISCOVERIES" | "OUTCOMES";
  /** Provenance label. */
  provenance: "USER" | "CODE" | "TOOL" | "ASSUMPTION";
  /** Certainty label. */
  certainty?: "CONFIRMED" | "UNCONFIRMED";
  /** Continuity content. */
  content: string;
  /** Optional evidence references supplied by adapter/user. */
  sourceRefs?: string[];
  /** Optional effective timestamp. */
  timestamp?: string;
}

/**
 * Request to query continuity entries/milestones.
 */
export interface ContinuityQueryRequest {
  /** Host-normalized request context. */
  context: CoreRequestContext;
  /** Optional lexical/semantic query text. */
  query?: string;
  /** Optional section filter. */
  section?: "PLANS" | "DECISIONS" | "PROGRESS" | "DISCOVERIES" | "OUTCOMES";
  /** Optional inclusive lower timestamp bound. */
  from?: string;
  /** Optional inclusive upper timestamp bound. */
  to?: string;
  /** Maximum rows requested by the host. */
  limit?: number;
  /** Whether milestone rows should be included. */
  includeMilestones?: boolean;
  /** Whether compacted/superseded continuity rows should be included. */
  includeCompacted?: boolean;
  /** Prior noisy-query streak supplied by the adapter/session state. */
  previousNoisyStreak?: number;
}

/**
 * Request to preview continuity compaction.
 */
export interface ContinuityCompactPreviewRequest {
  /** Host-normalized request context. */
  context: CoreRequestContext;
  /** Candidate source entry ids. */
  sourceEntryIds: string[];
  /** Proposed summary text. */
  summary: string;
  /** Optional request scope id for preview lifecycle tracking. */
  requestScopeId?: string;
}

/**
 * Request to apply an approved continuity compaction proposal.
 */
export interface ContinuityCompactApplyRequest {
  /** Host-normalized request context. */
  context: CoreRequestContext;
  /** Existing preview id to apply. */
  previewId: string;
}

/**
 * Request to read telemetry reports.
 */
export interface TelemetryReportRequest {
  /** Host-normalized request context. */
  context: CoreRequestContext;
  /** Optional report window in days. */
  windowDays?: number;
  /** Optional false-reject review sample limit. */
  sampleLimit?: number;
}

/**
 * Request to label one telemetry review candidate.
 */
export interface TelemetryReviewLabelRequest {
  /** Host-normalized request context. */
  context: CoreRequestContext;
  /** Telemetry event id returned by a report/queue. */
  eventId: string;
  /** Human/agent review label. */
  label: "valid_reject" | "false_reject" | "uncertain";
  /** Optional reviewer note. */
  note?: string;
}

/**
 * Request to read runtime/project status.
 */
export interface RuntimeStatusRequest {
  /** Host-normalized request context. */
  context: CoreRequestContext;
  /** Optional status surface requested by adapter. */
  scope?: "project" | "continuity" | "retrieval" | "cache" | "all";
}

/**
 * Generic text result for continuity/status/telemetry operations.
 */
export interface CoreTextResult extends MemoryCoreBaseResult {
  /** Human-readable result text. */
  text: string;
}
