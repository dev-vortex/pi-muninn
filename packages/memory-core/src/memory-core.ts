/**
 * File intent: expose the host-neutral memory-core application shell.
 *
 * The facade composes host-neutral L0/L1/L2/L3 services from provider ports
 * while concrete hosts stay responsible for binding data/provider adapters.
 */

import type {
  ContinuityCompactApplyRequest,
  ContinuityCompactPreviewRequest,
  ContinuityQueryRequest,
  ContinuityWriteRequest,
  CoreTextResult,
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
import { createContinuityCompactionService } from "./continuity/continuity-compaction.js";
import { createContinuityReadService } from "./continuity/continuity-read.js";
import { createContinuityTelemetryService } from "./continuity/continuity-telemetry.js";
import { createContinuityWriteService } from "./continuity/continuity-write.js";
import { createMemorySaveRoutingService } from "./memory-routing/memory-save-routing.js";
import { createPromptBriefingService } from "./prompt-briefing/prompt-briefing.js";
import { createProjectIndexRetrievalService } from "./project-index/project-index-retrieval.js";
import { createProjectMemberMemoryService } from "./project-memory/project-member-memory.js";
import type {
  ClockPort,
  ConfigPort,
  ContinuityDataAdapterPort,
  CoreMemoryProviderPort,
  EmbeddingPort,
  LoggerPort,
  ProjectIndexDataAdapterPort,
  PromptBriefingPort,
  RuntimeContextPort,
  TelemetryPort,
  VectorSearchPort,
} from "./ports.js";

/**
 * Dependency bundle supplied by a concrete host/provider composition root.
 */
export interface MemoryCoreDependencies {
  /** Project config provider. */
  config?: ConfigPort;
  /** Provider runtime context resolver. */
  runtimeContext?: RuntimeContextPort;
  /** L1/L3 memory storage/retrieval provider. */
  memoryProvider?: CoreMemoryProviderPort;
  /** Non-vendor L0 continuity data adapter. */
  continuityData?: ContinuityDataAdapterPort;
  /** Non-vendor L2 project-index data adapter. */
  projectIndexData?: ProjectIndexDataAdapterPort;
  /** Optional prompt briefing provider used once behavior moves behind core. */
  promptBriefing?: PromptBriefingPort;
  /** Optional vector search provider. */
  vectorSearch?: VectorSearchPort;
  /** Optional embedding provider. */
  embedding?: EmbeddingPort;
  /** Optional telemetry provider. */
  telemetry?: TelemetryPort;
  /** Optional deterministic clock. */
  clock?: ClockPort;
  /** Optional host-neutral logger. */
  logger?: LoggerPort;
}

/**
 * Host-neutral application API implemented by memory-core.
 */
export interface MemoryCore {
  /** Build prompt-scoped briefing text. */
  buildPromptBriefing(input: PromptBriefingRequest): Promise<PromptBriefingResult>;
  /** Store project/general memory content. */
  memorySave(input: MemorySaveRequest): Promise<MemoryOperationResult>;
  /** Search memory lanes. */
  memorySearch(input: MemorySearchRequest): Promise<MemoryOperationResult>;
  /** Recall memory lanes by metadata/recency. */
  memoryRecall(input: MemoryRecallRequest): Promise<MemoryOperationResult>;
  /** Store one continuity entry. */
  continuityWrite(input: ContinuityWriteRequest): Promise<CoreTextResult>;
  /** Query continuity entries/milestones. */
  continuityQuery(input: ContinuityQueryRequest): Promise<CoreTextResult>;
  /** Preview continuity compaction. */
  continuityCompactPreview(input: ContinuityCompactPreviewRequest): Promise<CoreTextResult>;
  /** Apply continuity compaction. */
  continuityCompactApply(input: ContinuityCompactApplyRequest): Promise<CoreTextResult>;
  /** Read telemetry report/review queue. */
  readTelemetryReport(input: TelemetryReportRequest): Promise<CoreTextResult>;
  /** Label one telemetry review candidate. */
  labelTelemetryReview(input: TelemetryReviewLabelRequest): Promise<CoreTextResult>;
  /** Read runtime status. */
  readStatus(input: RuntimeStatusRequest): Promise<CoreTextResult>;
}

/**
 * Build a deterministic unimplemented text result for Slice 1 shell methods.
 */
const buildUnimplementedTextResult = (operation: string): CoreTextResult => ({
  status: "unimplemented",
  text: `${operation} is not implemented in memory-core Slice 1.`,
  warnings: ["memory-core-slice-1-shell"],
  diagnostics: {
    operation,
    implementation: "shell",
  },
});

/**
 * Build a deterministic unimplemented prompt briefing result for Slice 1.
 */
const buildUnimplementedPromptBriefingResult = (): PromptBriefingResult => ({
  status: "unimplemented",
  briefingText: null,
  warnings: ["memory-core-slice-1-shell"],
  diagnostics: {
    operation: "buildPromptBriefing",
    implementation: "shell",
  },
});

/**
 * Create the host-neutral memory-core API surface.
 *
 * Slice 3 invokes the continuity data adapter only for `continuityWrite` when
 * supplied by the host/provider composition root. All other operations remain
 * behavior-preserving shells.
 */
export const createMemoryCore = (dependencies: MemoryCoreDependencies = {}): MemoryCore => ({
  buildPromptBriefing: async (input) => (
    dependencies.continuityData || dependencies.projectIndexData || dependencies.memoryProvider || dependencies.telemetry
  )
    ? createPromptBriefingService({
      continuityData: dependencies.continuityData,
      projectIndexData: dependencies.projectIndexData,
      memoryProvider: dependencies.memoryProvider,
      telemetry: dependencies.telemetry,
    }).build(input)
    : dependencies.promptBriefing
      ? dependencies.promptBriefing.buildPromptBriefing(input)
      : buildUnimplementedPromptBriefingResult(),
  memorySave: async (input) => dependencies.memoryProvider
    ? createMemorySaveRoutingService({
      memoryProvider: dependencies.memoryProvider,
    }).save(input)
    : buildUnimplementedTextResult("memorySave"),
  memorySearch: async (input) => dependencies.projectIndexData
    ? createProjectIndexRetrievalService({
      projectIndexData: dependencies.projectIndexData,
      telemetry: dependencies.telemetry,
    }).memorySearch(input)
    : dependencies.memoryProvider
      ? createProjectMemberMemoryService({
        memoryProvider: dependencies.memoryProvider,
      }).search(input)
      : buildUnimplementedTextResult("memorySearch"),
  memoryRecall: async (input) => dependencies.projectIndexData
    ? createProjectIndexRetrievalService({
      projectIndexData: dependencies.projectIndexData,
      telemetry: dependencies.telemetry,
    }).memoryRecall(input)
    : dependencies.memoryProvider
      ? createProjectMemberMemoryService({
        memoryProvider: dependencies.memoryProvider,
      }).recall(input)
      : buildUnimplementedTextResult("memoryRecall"),
  continuityWrite: async (input) => dependencies.continuityData
    ? createContinuityWriteService({
      continuityData: dependencies.continuityData,
      telemetry: dependencies.telemetry,
    }).write(input)
    : buildUnimplementedTextResult("continuityWrite"),
  continuityQuery: async (input) => dependencies.projectIndexData
    ? createProjectIndexRetrievalService({
      projectIndexData: dependencies.projectIndexData,
      telemetry: dependencies.telemetry,
    }).continuityQuery(input)
    : dependencies.continuityData
      ? createContinuityReadService({
        continuityData: dependencies.continuityData,
      }).query(input)
      : buildUnimplementedTextResult("continuityQuery"),
  continuityCompactPreview: async (input) => dependencies.continuityData
    ? createContinuityCompactionService({
      continuityData: dependencies.continuityData,
    }).preview(input)
    : buildUnimplementedTextResult("continuityCompactPreview"),
  continuityCompactApply: async (input) => dependencies.continuityData
    ? createContinuityCompactionService({
      continuityData: dependencies.continuityData,
    }).apply(input)
    : buildUnimplementedTextResult("continuityCompactApply"),
  readTelemetryReport: async (input) => dependencies.telemetry
    ? createContinuityTelemetryService({
      telemetry: dependencies.telemetry,
    }).readReport(input)
    : buildUnimplementedTextResult("readTelemetryReport"),
  labelTelemetryReview: async (input) => dependencies.telemetry
    ? createContinuityTelemetryService({
      telemetry: dependencies.telemetry,
    }).labelReview(input)
    : buildUnimplementedTextResult("labelTelemetryReview"),
  readStatus: async (input) => dependencies.projectIndexData && (input.scope === "cache" || input.scope === "retrieval")
    ? dependencies.projectIndexData.readStatus(input)
    : dependencies.continuityData && (!input.scope || input.scope === "continuity" || input.scope === "all")
      ? createContinuityReadService({
        continuityData: dependencies.continuityData,
      }).readStatus(input)
      : buildUnimplementedTextResult("readStatus"),
});
