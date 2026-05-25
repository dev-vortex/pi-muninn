/**
 * File intent: create the agent_end lifecycle handler for continuity compliance checks.
 *
 * Agent end emits non-blocking continuity warnings for missing or weak semantic
 * handoff evidence, runs lifecycle compaction hygiene, and resets request-scoped
 * compliance counters.
 */

import type { LifecycleEventHandler, LifecycleHookDependencies } from "../types.js";

/**
 * Build the agent_end handler with explicit lifecycle dependencies.
 */
export const createAgentEndHandler = (deps: LifecycleHookDependencies): LifecycleEventHandler => {
  const {
    runtime: runtimeDeps,
    continuity,
  } = deps;

  return async (_event: unknown, ctx: any) => {
    const complianceTracker = continuity.getContinuityComplianceTracker(ctx);
    const projectRuntime = await runtimeDeps.resolveProjectRuntime(ctx);

    if (!projectRuntime || projectRuntime.storePaths.activeScope !== "project-enabled") {
      continuity.resetContinuityComplianceTracker(ctx);
      return;
    }

    if (complianceTracker.mutationToolWrites > 0) {
      const sourcesSummary = continuity.renderContinuityEvidenceSummary({
        label: "sources",
        paths: complianceTracker.readSourcePaths,
      });

      const artifactsSummary = continuity.renderContinuityEvidenceSummary({
        label: "artifacts",
        paths: complianceTracker.mutationArtifactPaths,
      });

      const missingExplicitContinuity = complianceTracker.explicitContinuityWrites === 0;
      const missingSemanticContinuity = complianceTracker.semanticContinuityWrites === 0;
      const coarseSemanticGranularity =
        complianceTracker.mutationArtifactPaths.size > 1
        && complianceTracker.semanticContinuitySignalWrites < complianceTracker.mutationArtifactPaths.size
        && complianceTracker.semanticArtifactCoveragePaths.size < complianceTracker.mutationArtifactPaths.size;
      const missingUserProvenance =
        complianceTracker.userProvenanceContinuityWrites === 0
        && complianceTracker.semanticUserIntentSignalWrites === 0;
      const missingSourceRefsEvidence =
        complianceTracker.semanticEvidenceRequiredWrites > 0
        && complianceTracker.semanticEvidenceRequiredWritesWithSourceRefs < complianceTracker.semanticEvidenceRequiredWrites;
      const missingPathEvidence =
        complianceTracker.semanticContinuitySignalWrites > 0
        && complianceTracker.semanticContinuityWritesWithPathEvidence === 0
        && (complianceTracker.readSourcePaths.size > 0 || complianceTracker.mutationArtifactPaths.size > 0);

      if (missingExplicitContinuity) {
        const reminder =
          "Continuity reminder: workspace changes were made in this request without an explicit continuity update. " +
          "Task is only done after continuity is updated when changes materially affect goal/state/decisions.";

        // eslint-disable-next-line no-console
        console.warn(`[project-memory] ${reminder}`);

        if (ctx?.hasUI && typeof ctx?.ui?.notify === "function") {
          ctx.ui.notify(reminder, "warning");
        }
      } else if (missingSemanticContinuity) {
        const semanticReminder =
          "Continuity warning: explicit continuity updates were recorded, but only operational entries were detected. " +
          "Add semantic continuity (PLANS/DECISIONS/DISCOVERIES/OUTCOMES) so user intent/constraints are preserved.";

        // eslint-disable-next-line no-console
        console.warn(`[project-memory] ${semanticReminder}`);

        if (ctx?.hasUI && typeof ctx?.ui?.notify === "function") {
          ctx.ui.notify(semanticReminder, "warning");
        }
      } else if (coarseSemanticGranularity) {
        const granularityReminder =
          "Continuity warning: request changed multiple artifacts but semantic continuity entries are too coarse. " +
          `Create per-artifact semantic entries (semanticEntries=${complianceTracker.semanticContinuitySignalWrites}, coveredArtifacts=${complianceTracker.semanticArtifactCoveragePaths.size}, artifactCount=${complianceTracker.mutationArtifactPaths.size}; ${artifactsSummary}).`;

        // eslint-disable-next-line no-console
        console.warn(`[project-memory] ${granularityReminder}`);

        if (ctx?.hasUI && typeof ctx?.ui?.notify === "function") {
          ctx.ui.notify(granularityReminder, "warning");
        }
      } else if (missingUserProvenance) {
        const userIntentReminder =
          "Continuity warning: semantic updates were recorded without USER provenance or explicit user-intent evidence. " +
          `Capture user-request intent/constraints to reduce future drift or reversions (${sourcesSummary}; ${artifactsSummary}).`;

        // eslint-disable-next-line no-console
        console.warn(`[project-memory] ${userIntentReminder}`);

        if (ctx?.hasUI && typeof ctx?.ui?.notify === "function") {
          ctx.ui.notify(userIntentReminder, "warning");
        }
      } else if (missingSourceRefsEvidence) {
        const sourceRefReminder =
          "Continuity warning: DECISIONS/DISCOVERIES/OUTCOMES entries were recorded without explicit source_refs evidence. " +
          `Include source_refs in semantic continuity writes to preserve provenance (${sourcesSummary}; ${artifactsSummary}).`;

        // eslint-disable-next-line no-console
        console.warn(`[project-memory] ${sourceRefReminder}`);

        if (ctx?.hasUI && typeof ctx?.ui?.notify === "function") {
          ctx.ui.notify(sourceRefReminder, "warning");
        }
      } else if (missingPathEvidence) {
        const provenanceReminder =
          "Continuity warning: semantic continuity was recorded but it did not reference observed source/artifact paths. " +
          `Include explicit where/why evidence via content and/or source_refs (${sourcesSummary}; ${artifactsSummary}).`;

        // eslint-disable-next-line no-console
        console.warn(`[project-memory] ${provenanceReminder}`);

        if (ctx?.hasUI && typeof ctx?.ui?.notify === "function") {
          ctx.ui.notify(provenanceReminder, "warning");
        }
      }
    }

    continuity.runContinuityCompactionLifecycleHygiene({
      runtime: projectRuntime,
      trigger: "agent_end",
    });

    continuity.resetContinuityComplianceTracker(ctx);
  };
};
