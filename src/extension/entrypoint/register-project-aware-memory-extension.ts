/**
 * File intent: compose the project-aware memory extension from extracted entrypoint modules.
 *
 * This is the Slice 5 composition root: package index imports only this file,
 * while hooks, tools, commands, runtime services, and domain helpers live in
 * named modules below `src/extension/entrypoint/*`.
 */

import { getRuntimeContextObservabilitySnapshot } from "../../../packages/memory-core/src/adapters/sqlite/runtime-context/index.js";
import { recordRuntimeMemoryWrite, resolveCheckpointDatabasePaths, runPeriodicCheckpointIfNeeded, runShutdownCheckpointIfEnabled } from "../../../packages/memory-core/src/adapters/sqlite/runtime/index.js";
import { setProjectMemoryEnabled } from "./runtime-services/project-config-toggles.js";
import { loadProjectMemoryConfig } from "../../project-memory/config.js";
import { searchProjectMemoryByMode } from "../../../packages/memory-core/src/adapters/sqlite/project-memory/mode-selection.js";
import {
  clearContinuityEntriesCompactedInto,
  countContinuityCompactionPreviewsInScope,
  deleteContinuityEntry,
  deleteContinuityVectorEntry,
  indexContinuityVectorEntry,
  markContinuityEntriesCompactedInto,
  purgeContinuityCompactionPreviews,
  readContinuityActiveCounts,
  readContinuityCompactionPreview,
  readContinuityEntries,
  readContinuityEntriesByIds,
  readContinuityVectorStatusCounts,
  storeContinuityCompactionPreview,
  storeContinuityEntry,
  updateContinuityCompactionPreviewStatus,
} from "../../../packages/memory-core/src/adapters/sqlite/continuity/index.js";
import { isLowSignalSemanticOperationalTelemetryEntry } from "../../../packages/memory-core/src/continuity/continuity-quality-gate.js";
import { registerLifecycleHooks } from "./hooks/register-lifecycle-hooks.js";
import { createMemoryExtensionRuntimeState } from "./runtime-state.js";
import { registerExtensionTools } from "./tools/register-tools.js";
import * as constants from "./runtime-services/constants.js";
import { createBundledUpstreamCompatibilityServices } from "./runtime-services/upstream-compatibility-services.js";
import { createRuntimePolicyServices } from "./runtime-services/runtime-policy-services.js";
import {
  buildTextToolResult,
  createContinuityCompactionRequestServices,
  logContinuityBlocked,
  resolveSessionId,
} from "./runtime-services/common-runtime-services.js";
import { createContinuityComplianceServices } from "./runtime-services/continuity-compliance-services.js";
import {
  buildContinuityCompactionProposalFingerprint,
  buildContinuityCompactionSourceKeywordSet,
  buildContinuityQueryCompactionHint,
  computeContinuityCompactionLexicalCoverage,
  computeContinuityCompactionSemanticCoverage,
  rankContinuityCompactionProbeEntries,
} from "./runtime-services/continuity-compaction-analysis.js";
import {
  buildContinuityContentWithSourceRefs,
  addDaysToIsoTimestamp,
  addHoursToIsoTimestamp,
  normalizeContinuityCertainty,
  normalizeContinuityCompactionSectionHint,
  normalizeContinuityCompactionSourceEntryIds,
  normalizeContinuityContent,
  normalizeContinuityProvenance,
  normalizeContinuitySection,
  normalizeContinuitySourceRefs,
  normalizeContinuityTimestamp,
  readObjectStringField,
} from "./runtime-services/continuity-normalization.js";
import {
  continuityContentHasPathEvidence,
  continuityHasEmbeddedSourceRefs,
  continuityHasUserIntentEvidence,
  continuitySourceRefsHavePathEvidence,
  normalizeContinuityTrackedPath,
  recordContinuityArtifactCoverageFromContent,
  recordContinuityArtifactCoverageFromSourceRefs,
  recordContinuityEvidencePath,
  renderContinuityEvidenceSummary,
  resolveWorkspaceRoot,
} from "./runtime-services/continuity-evidence.js";
import {
  buildAutomaticContinuityContentFromToolResult,
  decodeContinuityWriteSignalFromToolInput,
} from "./runtime-services/continuity-quality.js";
import { createContinuityPersistenceServices } from "./runtime-services/continuity-persistence-services.js";
import { createProjectRuntimeServices } from "./runtime-services/project-runtime-services.js";
import { createSessionServices } from "./runtime-services/session-services.js";
import { createStatusSummaryServices } from "./runtime-services/status-summary-services.js";
import { createPromptBriefingServices } from "./runtime-services/prompt-briefing-services.js";
import {
  isContinuityBlockedVerboseEnabled,
  isContinuityMutationAutoJournalEnabled,
  isContinuityRuntimePolicyEnabled,
  isContinuitySessionSummaryEnabled,
  isContinuityVectorEnabled,
  isPersistenceOrchestrationRuntimePolicyEnabled,
  isProjectMemoryRuntimePolicyEnabled,
} from "./runtime-services/runtime-config.js";
import { hydrateCrossUserContinuityEntry, readCrossUserContinuityMilestones } from "./runtime-services/cross-user-continuity.js";
import type { PiExtensionCommandRegistrar, PiExtensionRegistrationOptions } from "./runtime-types.js";

/**
 * Register the project-aware memory extension with pi.
 */
export const registerProjectAwareMemoryExtension = (
  pi: any,
  options: PiExtensionRegistrationOptions & { registerCommands: PiExtensionCommandRegistrar },
): void => {
  const profile = options.profile ?? "dev";
  const state = createMemoryExtensionRuntimeState();
  const upstream = createBundledUpstreamCompatibilityServices(pi);
  const policies = createRuntimePolicyServices(state);
  const projectRuntime = createProjectRuntimeServices(state);
  const persistence = createContinuityPersistenceServices({
    continuityVectorEmbedder: state.continuityVectorEmbedder,
  });
  const session = createSessionServices({
    state,
    storeContinuityEntryWithVectorConsistency: persistence.storeContinuityEntryWithVectorConsistency,
  });
  const status = createStatusSummaryServices({
    state,
    buildLastQuerySuffix: session.buildLastQuerySuffix,
    getRuntimeContextObservabilitySnapshot,
  });
  const compactionRequests = createContinuityCompactionRequestServices(state);
  const compliance = createContinuityComplianceServices(state);
  const promptBriefings = createPromptBriefingServices({
    continuityVectorEmbedder: state.continuityVectorEmbedder,
  });

  registerLifecycleHooks({
    pi,
    state,
    constants: {
      memoryWriteToolNames: constants.MEMORY_WRITE_TOOL_NAMES,
      continuityActivityToolNames: constants.CONTINUITY_ACTIVITY_TOOL_NAMES,
      continuityExplicitWriteToolNames: constants.CONTINUITY_EXPLICIT_WRITE_TOOL_NAMES,
      continuitySemanticSectionSet: constants.CONTINUITY_SEMANTIC_SECTION_SET,
      continuitySourceRefRequiredSectionSet: constants.CONTINUITY_SOURCE_REF_REQUIRED_SECTION_SET,
    },
    policies: {
      isContinuityRuntimePolicyEnabled,
      isProjectMemoryRuntimePolicyEnabled,
      isPersistenceOrchestrationRuntimePolicyEnabled,
      isContinuitySessionSummaryEnabled,
      isContinuityMutationAutoJournalEnabled,
      isContinuityBlockedVerboseEnabled,
    },
    snippets: policies,
    runtime: {
      bootstrap: projectRuntime.bootstrap,
      resolveProjectRuntime: projectRuntime.resolveProjectRuntime,
      resolveSessionId,
      resolveLatestUserRequestKey: promptBriefings.resolveLatestUserRequestKey,
    },
    compatibility: {
      initializeBundledUpstreamCompatibility: upstream.initializeBundledUpstreamCompatibility,
      getBundledUpstream: upstream.getBundledUpstreamRegistration,
    },
    promptBriefings,
    continuity: {
      ...compliance,
      renderContinuityEvidenceSummary,
      runContinuityCompactionLifecycleHygiene: session.runContinuityCompactionLifecycleHygiene,
      storeSessionContinuitySummary: session.storeSessionContinuitySummary,
      logContinuityBlocked,
      readObjectStringField,
      normalizeContinuityTrackedPath,
      recordContinuityEvidencePath,
      decodeContinuityWriteSignalFromToolInput,
      recordContinuityArtifactCoverageFromContent,
      recordContinuityArtifactCoverageFromSourceRefs,
      continuityContentHasPathEvidence,
      continuitySourceRefsHavePathEvidence,
      continuityHasUserIntentEvidence,
      buildAutomaticContinuityContentFromToolResult,
      persistAutomaticContinuityDualWrite: persistence.persistAutomaticContinuityDualWrite,
    },
    checkpoint: {
      getCheckpointTracker: session.getCheckpointTracker,
      recordRuntimeMemoryWrite,
      runPeriodicCheckpointIfNeeded,
      runShutdownCheckpointIfEnabled,
      resolveCheckpointDatabasePaths,
      warnCheckpointFailures: session.warnCheckpointFailures,
    },
  });

  registerExtensionTools({
    pi,
    sessionStore: state.sessionStore,
    bootstrap: projectRuntime.bootstrap,
    resolveWorkspaceRoot,
    loadProjectMemoryConfig,
    buildContinuityRuntimeStatusSummary: status.buildContinuityRuntimeStatusSummary,
    buildTextToolResult,
    isContinuityVectorEnabled,
    resolveSessionId,
    readContinuityVectorStatusCounts,
    continuityVectorCountsBySession: state.continuityVectorCountsBySession,
    setProjectMemoryEnabled,
    ...constants,
    resolveActiveContinuityDatabasePath: projectRuntime.resolveActiveContinuityDatabasePath,
    logContinuityBlocked,
    normalizeContinuitySection,
    normalizeContinuityProvenance,
    normalizeContinuityCertainty,
    normalizeContinuityTimestamp,
    normalizeContinuitySourceRefs,
    buildContinuityContentWithSourceRefs,
    persistAutomaticContinuityDualWrite: persistence.persistAutomaticContinuityDualWrite,
    recordContinuityTelemetry: promptBriefings.recordContinuityTelemetry,
    normalizeContinuityContent,
    continuityQueryNoiseStreakBySession: state.continuityQueryNoiseStreakBySession,
    resolveActiveProjectRuntime: projectRuntime.resolveActiveProjectRuntime,
    searchProjectMemoryByMode,
    hydrateCrossUserContinuityEntry,
    readCrossUserContinuityMilestones,
    buildContinuityQueryCompactionHint,
    normalizeContinuityCompactionSourceEntryIds,
    normalizeContinuityCompactionSectionHint,
    ...compactionRequests,
    addHoursToIsoTimestamp,
    addDaysToIsoTimestamp,
    purgeContinuityCompactionPreviews,
    countContinuityCompactionPreviewsInScope,
    readContinuityCompactionPreview,
    readContinuityEntriesByIds,
    readContinuityActiveCounts,
    readContinuityEntries,
    computeContinuityCompactionLexicalCoverage,
    computeContinuityCompactionSemanticCoverage,
    buildContinuityCompactionSourceKeywordSet,
    buildContinuityCompactionProposalFingerprint,
    rankContinuityCompactionProbeEntries,
    continuityHasEmbeddedSourceRefs,
    isLowSignalSemanticOperationalTelemetryEntry,
    storeContinuityCompactionPreview,
    storeContinuityEntry,
    storeContinuityEntryWithVectorConsistency: persistence.storeContinuityEntryWithVectorConsistency,
    markContinuityEntriesCompactedInto,
    updateContinuityCompactionPreviewStatus,
    deleteContinuityEntry,
    clearContinuityEntriesCompactedInto,
    indexContinuityVectorEntry,
    deleteContinuityVectorEntry,
    continuityVectorEmbedder: state.continuityVectorEmbedder,
  });

  options.registerCommands({
    pi,
    profile,
    sessionStore: state.sessionStore,
    bootstrap: projectRuntime.bootstrap,
    initializeBundledUpstreamCompatibility: upstream.initializeBundledUpstreamCompatibility,
    getBundledUpstreamMemoryCommand: upstream.getBundledUpstreamMemoryCommand,
    renderUpstreamRuntimeSummary: upstream.renderUpstreamRuntimeSummary,
    resolveProjectRuntime: projectRuntime.resolveProjectRuntime,
    buildPromptBriefing: promptBriefings.buildPromptBriefing,
    isContinuityRuntimePolicyEnabled,
    isProjectMemoryRuntimePolicyEnabled,
    isBriefingDebugEnabled: (ctx: any): boolean => state.briefingDebugEnabledBySession.get(resolveSessionId(ctx)) === true,
    setBriefingDebugEnabled: (ctx: any, enabled: boolean): void => {
      const sessionId = resolveSessionId(ctx);
      if (enabled) {
        state.briefingDebugEnabledBySession.set(sessionId, true);
      } else {
        state.briefingDebugEnabledBySession.delete(sessionId);
      }
    },
    buildProjectRuntimeStatusSummary: status.buildProjectRuntimeStatusSummary,
    buildContinuityRuntimeStatusSummary: status.buildContinuityRuntimeStatusSummary,
    buildProjectRetrievalStatusSummary: status.buildProjectRetrievalStatusSummary,
    buildProjectCacheStatusSummary: status.buildProjectCacheStatusSummary,
    getObservabilityTracker: session.getObservabilityTracker,
  });
};
