/**
 * File intent: create and type the shared mutable state for the extension entrypoint.
 *
 * The pi extension is registered once, but many lifecycle hooks, commands, and
 * tools need access to the same session-scoped maps. This file makes that state
 * explicit so future hook/tool/command modules can receive one runtime-state
 * object instead of closing over ad hoc maps in a giant entrypoint file.
 */

import type { ContinuityVectorEmbedder } from "../../memory-data-adapters/sqlite/continuity/index.js";
import { createContinuityVectorEmbedder } from "../../memory-data-adapters/sqlite/continuity/index.js";
import {
  createProjectSessionRuntimeStore,
  type ProjectSessionRuntimeStore,
} from "./runtime-services/project-session-store.js";
import type { RuntimeContextObservabilityTracker } from "../../memory-data-adapters/sqlite/runtime-context/index.js";
import type { RuntimeCheckpointTracker } from "../../memory-data-adapters/sqlite/runtime/index.js";

/**
 * Continuity compaction request profile selected for one request scope.
 */
export type ContinuityCompactionRequestProfile = "strict" | "long-request";

/**
 * Reason the continuity compaction request profile was selected.
 */
export type ContinuityCompactionProfileSelectionReason =
  | "default_strict"
  | "operator_override"
  | "auto_detect_threshold";

/**
 * Cached compaction profile decision for one request scope.
 */
export interface ContinuityCompactionProfileState {
  profile: ContinuityCompactionRequestProfile;
  profileSelectionReason: ContinuityCompactionProfileSelectionReason;
}

/**
 * Last known continuity vector index counters for status output.
 */
export interface ContinuityVectorCountsSnapshot {
  totalTracked: number;
  indexedCount: number;
  failedCount: number;
  pendingCount: number;
}

/**
 * Mutable continuity compliance counters tracked during one session/request flow.
 */
export interface ContinuityComplianceTracker {
  mutationToolWrites: number;
  explicitContinuityWrites: number;
  semanticContinuityWrites: number;
  semanticContinuitySignalWrites: number;
  semanticUserIntentSignalWrites: number;
  userProvenanceContinuityWrites: number;
  semanticContinuityWritesWithPathEvidence: number;
  semanticEvidenceRequiredWrites: number;
  semanticEvidenceRequiredWritesWithSourceRefs: number;
  semanticArtifactCoveragePaths: Set<string>;
  readSourcePaths: Set<string>;
  mutationArtifactPaths: Set<string>;
}

/**
 * Shared mutable state for the repo-controlled pi extension entrypoint.
 */
export interface MemoryExtensionRuntimeState {
  sessionStore: ProjectSessionRuntimeStore;
  observabilityBySession: Map<string, RuntimeContextObservabilityTracker>;
  checkpointBySession: Map<string, RuntimeCheckpointTracker>;
  continuityRuntimeSnippetBySession: Map<string, string>;
  projectMemoryRuntimeSnippetBySession: Map<string, string>;
  persistenceOrchestrationRuntimeSnippetBySession: Map<string, string>;
  continuityRuntimeRequestKeyBySession: Map<string, string>;
  continuityQueryNoiseStreakBySession: Map<string, number>;
  continuityCompactionProfileBySession: Map<string, Map<string, ContinuityCompactionProfileState>>;
  continuityVectorCountsBySession: Map<string, ContinuityVectorCountsSnapshot>;
  continuityComplianceBySession: Map<string, ContinuityComplianceTracker>;
  /** Session-only briefing display toggle; release profile does not expose the command that enables it. */
  briefingDebugEnabledBySession: Map<string, boolean>;
  continuityVectorEmbedder: ContinuityVectorEmbedder;
}

/**
 * Build a clean state bundle for one extension registration.
 */
export const createMemoryExtensionRuntimeState = (): MemoryExtensionRuntimeState => ({
  sessionStore: createProjectSessionRuntimeStore(),
  observabilityBySession: new Map(),
  checkpointBySession: new Map(),
  continuityRuntimeSnippetBySession: new Map(),
  projectMemoryRuntimeSnippetBySession: new Map(),
  persistenceOrchestrationRuntimeSnippetBySession: new Map(),
  continuityRuntimeRequestKeyBySession: new Map(),
  continuityQueryNoiseStreakBySession: new Map(),
  continuityCompactionProfileBySession: new Map(),
  continuityVectorCountsBySession: new Map(),
  continuityComplianceBySession: new Map(),
  briefingDebugEnabledBySession: new Map(),
  continuityVectorEmbedder: createContinuityVectorEmbedder(),
});
