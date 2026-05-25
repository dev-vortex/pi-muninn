/**
 * File intent: create the tool_result lifecycle handler for checkpoint and continuity accounting.
 *
 * The handler preserves memory-write checkpoint behavior, continuity compliance
 * counters, evidence tracking, blocked diagnostics, and optional mutation
 * auto-journaling while keeping hook registration readable elsewhere.
 */

import type { LifecycleEventHandler, LifecycleHookDependencies } from "../types.js";

/**
 * Build the tool_result handler with explicit lifecycle dependencies.
 */
export const createToolResultHandler = (deps: LifecycleHookDependencies): LifecycleEventHandler => {
  const {
    constants,
    policies,
    runtime: runtimeDeps,
    checkpoint,
    continuity,
  } = deps;

  return async (event: unknown, ctx: any) => {
    const toolName = typeof (event as { toolName?: unknown })?.toolName === "string"
      ? (event as { toolName: string }).toolName
      : "";

    const isMemoryWriteTool = constants.memoryWriteToolNames.has(toolName);
    const isContinuityActivityTool = constants.continuityActivityToolNames.has(toolName);
    const isExplicitContinuityWriteTool = constants.continuityExplicitWriteToolNames.has(toolName);
    const isReadTool = toolName === "read";

    const toolInput = (event as { input?: unknown })?.input;
    const toolIsError = (event as { isError?: unknown })?.isError === true;

    if (!isMemoryWriteTool && !isContinuityActivityTool && !isExplicitContinuityWriteTool && !isReadTool) {
      return;
    }

    const projectRuntime = await runtimeDeps.resolveProjectRuntime(ctx);

    if (!projectRuntime) {
      if (isContinuityActivityTool || isExplicitContinuityWriteTool) {
        continuity.logContinuityBlocked({
          stage: "tool_result",
          reason: "runtime-unavailable",
          detail: `tool=${toolName}`,
          ctx,
        });
      }

      return;
    }

    if (isMemoryWriteTool) {
      const tracker = checkpoint.getCheckpointTracker(ctx);
      checkpoint.recordRuntimeMemoryWrite(tracker);

      const checkpointOutcome = checkpoint.runPeriodicCheckpointIfNeeded({
        policy: projectRuntime.config.checkpoint,
        tracker,
        databasePaths: checkpoint.resolveCheckpointDatabasePaths({
          activeScope: projectRuntime.storePaths.activeScope,
          globalDatabasePath: projectRuntime.storePaths.globalDatabasePath,
          projectUserDatabasePath: projectRuntime.storePaths.projectUserDatabasePath,
        }),
      });

      if (checkpointOutcome.ran && checkpointOutcome.result) {
        checkpoint.warnCheckpointFailures(checkpointOutcome.result.failures, "periodic");
      }
    }

    const projectContinuityEnabled =
      projectRuntime.config.projectMemoryEnabled &&
      projectRuntime.storePaths.activeScope === "project-enabled";

    const continuityComplianceTracker = continuity.getContinuityComplianceTracker(ctx);

    const trackedToolPathRaw = continuity.readObjectStringField(toolInput, "path");
    const trackedToolPath = trackedToolPathRaw
      ? continuity.normalizeContinuityTrackedPath({
        ctx,
        rawPath: trackedToolPathRaw,
      })
      : null;

    if (projectContinuityEnabled && !toolIsError) {
      if (isReadTool) {
        continuity.recordContinuityEvidencePath({
          target: continuityComplianceTracker.readSourcePaths,
          pathValue: trackedToolPath,
        });
      }

      if (isContinuityActivityTool) {
        continuityComplianceTracker.mutationToolWrites += 1;

        continuity.recordContinuityEvidencePath({
          target: continuityComplianceTracker.mutationArtifactPaths,
          pathValue: trackedToolPath,
        });
      }

      if (isExplicitContinuityWriteTool) {
        continuityComplianceTracker.explicitContinuityWrites += 1;

        // Count semantic/provenance evidence on canonical continuity_write only.
        if (toolName === "continuity_write") {
          const continuitySignal = continuity.decodeContinuityWriteSignalFromToolInput({
            ctx,
            toolInput,
          });

          if (!continuitySignal) {
            continuity.logContinuityBlocked({
              stage: "tool_result",
              reason: "explicit-write-signal-unavailable",
              detail: `tool=${toolName}`,
              ctx,
            });
          } else {
            const continuityContent = continuity.readObjectStringField(toolInput, "content") || "";

            if (constants.continuitySemanticSectionSet.has(continuitySignal.section)) {
              continuityComplianceTracker.semanticContinuityWrites += 1;
              continuityComplianceTracker.semanticContinuitySignalWrites += 1;

              continuity.recordContinuityArtifactCoverageFromContent({
                content: continuityContent,
                artifactPaths: continuityComplianceTracker.mutationArtifactPaths,
                coverageTarget: continuityComplianceTracker.semanticArtifactCoveragePaths,
              });

              continuity.recordContinuityArtifactCoverageFromSourceRefs({
                sourceRefs: continuitySignal.sourceRefs,
                artifactPaths: continuityComplianceTracker.mutationArtifactPaths,
                coverageTarget: continuityComplianceTracker.semanticArtifactCoveragePaths,
              });

              const hasSourcePathEvidence = continuity.continuityContentHasPathEvidence({
                content: continuityContent,
                paths: continuityComplianceTracker.readSourcePaths,
              }) || continuity.continuityContentHasPathEvidence({
                content: continuityContent,
                paths: continuityComplianceTracker.mutationArtifactPaths,
              }) || continuity.continuitySourceRefsHavePathEvidence({
                sourceRefs: continuitySignal.sourceRefs,
                paths: continuityComplianceTracker.readSourcePaths,
              }) || continuity.continuitySourceRefsHavePathEvidence({
                sourceRefs: continuitySignal.sourceRefs,
                paths: continuityComplianceTracker.mutationArtifactPaths,
              });

              if (hasSourcePathEvidence) {
                continuityComplianceTracker.semanticContinuityWritesWithPathEvidence += 1;
              }

              if (continuity.continuityHasUserIntentEvidence({
                content: continuityContent,
                sourceRefs: continuitySignal.sourceRefs,
              })) {
                continuityComplianceTracker.semanticUserIntentSignalWrites += 1;
              }

              if (constants.continuitySourceRefRequiredSectionSet.has(continuitySignal.section)) {
                continuityComplianceTracker.semanticEvidenceRequiredWrites += 1;

                if (continuitySignal.sourceRefs.length > 0) {
                  continuityComplianceTracker.semanticEvidenceRequiredWritesWithSourceRefs += 1;
                }
              }
            }

            if (continuitySignal.provenance === "USER") {
              continuityComplianceTracker.userProvenanceContinuityWrites += 1;
            }
          }
        }
      }
    }

    if ((isContinuityActivityTool || isExplicitContinuityWriteTool) && !projectContinuityEnabled && !toolIsError) {
      continuity.logContinuityBlocked({
        stage: "tool_result",
        reason: "project-continuity-disabled",
        detail: `tool=${toolName}`,
        ctx,
      });
    }

    if (isContinuityActivityTool && toolIsError) {
      continuity.logContinuityBlocked({
        stage: "tool_result",
        reason: "mutation-tool-error",
        detail: `tool=${toolName}`,
        ctx,
      });
    }

    const canAttemptMutationAutoJournal =
      isContinuityActivityTool &&
      !toolIsError &&
      projectContinuityEnabled;

    if (
      canAttemptMutationAutoJournal
      && !policies.isContinuityMutationAutoJournalEnabled()
      && policies.isContinuityBlockedVerboseEnabled()
    ) {
      continuity.logContinuityBlocked({
        stage: "tool_result",
        reason: "mutation-auto-journal-disabled",
        detail: `tool=${toolName}`,
        ctx,
      });
    }

    if (canAttemptMutationAutoJournal && policies.isContinuityMutationAutoJournalEnabled()) {
      const continuityContent = continuity.buildAutomaticContinuityContentFromToolResult({
        toolName,
        toolInput,
      });

      if (!continuityContent) {
        continuity.logContinuityBlocked({
          stage: "tool_result",
          reason: "mutation-auto-journal-empty-content",
          detail: `tool=${toolName}`,
          ctx,
        });
        return;
      }

      const continuityWrite = await continuity.persistAutomaticContinuityDualWrite({
        databasePath: projectRuntime.storePaths.projectUserDatabasePath,
        section: "PROGRESS",
        provenance: "TOOL",
        certainty: "CONFIRMED",
        content: continuityContent,
      });

      if (!continuityWrite.ok) {
        // eslint-disable-next-line no-console
        console.warn(`[project-memory] automatic continuity write failed for tool '${toolName}': ${continuityWrite.error}`);
      } else if (continuityWrite.status === "stored") {
        continuityComplianceTracker.explicitContinuityWrites += 1;
      } else if (policies.isContinuityBlockedVerboseEnabled()) {
        continuity.logContinuityBlocked({
          stage: "tool_result",
          reason: continuityWrite.skipReason === "duplicate"
            ? "mutation-auto-journal-duplicate"
            : "mutation-auto-journal-low-signal",
          detail: `tool=${toolName}`,
          ctx,
        });
      }
    }
  };
};
