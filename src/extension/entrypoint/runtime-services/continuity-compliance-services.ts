/**
 * File intent: create/reset per-session continuity compliance trackers.
 *
 * Lifecycle hooks use this tracker to detect missing semantic continuity after
 * workspace mutations; the data shape remains defined in runtime-state.
 */

import type { ContinuityComplianceTracker, MemoryExtensionRuntimeState } from "../runtime-state.js";
import { resolveSessionId } from "./common-runtime-services.js";

/**
 * Build compliance tracker services bound to extension runtime state.
 */
export const createContinuityComplianceServices = (state: MemoryExtensionRuntimeState): {
  getContinuityComplianceTracker: (ctx: any) => ContinuityComplianceTracker;
  resetContinuityComplianceTracker: (ctx: any) => void;
} => {
  const getContinuityComplianceTracker = (ctx: any): ContinuityComplianceTracker => {
    const sessionId = resolveSessionId(ctx);
    const existing = state.continuityComplianceBySession.get(sessionId);
    if (existing) {
      return existing;
    }

    const created: ContinuityComplianceTracker = {
      mutationToolWrites: 0,
      explicitContinuityWrites: 0,
      semanticContinuityWrites: 0,
      semanticContinuitySignalWrites: 0,
      semanticUserIntentSignalWrites: 0,
      userProvenanceContinuityWrites: 0,
      semanticContinuityWritesWithPathEvidence: 0,
      semanticEvidenceRequiredWrites: 0,
      semanticEvidenceRequiredWritesWithSourceRefs: 0,
      semanticArtifactCoveragePaths: new Set<string>(),
      readSourcePaths: new Set<string>(),
      mutationArtifactPaths: new Set<string>(),
    };

    state.continuityComplianceBySession.set(sessionId, created);
    return created;
  };

  const resetContinuityComplianceTracker = (ctx: any): void => {
    const sessionId = resolveSessionId(ctx);
    state.continuityComplianceBySession.set(sessionId, {
      mutationToolWrites: 0,
      explicitContinuityWrites: 0,
      semanticContinuityWrites: 0,
      semanticContinuitySignalWrites: 0,
      semanticUserIntentSignalWrites: 0,
      userProvenanceContinuityWrites: 0,
      semanticContinuityWritesWithPathEvidence: 0,
      semanticEvidenceRequiredWrites: 0,
      semanticEvidenceRequiredWritesWithSourceRefs: 0,
      semanticArtifactCoveragePaths: new Set<string>(),
      readSourcePaths: new Set<string>(),
      mutationArtifactPaths: new Set<string>(),
    });
  };

  return {
    getContinuityComplianceTracker,
    resetContinuityComplianceTracker,
  };
};
