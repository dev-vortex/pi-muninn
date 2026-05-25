/**
 * File intent: create the continuity_compact_apply tool handler.
 *
 * The handler performs non-destructive compaction from an approved preview and
 * preserves rollback/integrity diagnostics from the original entrypoint.
 */

import {
  applyContinuityCompactionProposalGroups,
  createContinuityCompactionApplyRollbackController,
} from "./continuity-compaction-apply-execution.js";
import {
  renderContinuityCompactionReasonLine,
  type ContinuityCompactionProposalPayload,
  type ContinuityCompactionValidationReason,
} from "../continuity-compaction-shared.js";
import type { ExtensionToolDependencies } from "../types.js";

/**
 * Build the continuity_compact_apply execute handler.
 */
export const createContinuityCompactionApplyTool = (deps: ExtensionToolDependencies) => {
  const {
    CONTINUITY_COMPACTION_APPLIED_RETENTION_DAYS,
    CONTINUITY_COMPACTION_APPLIED_RETENTION_MIN_DAYS,
    CONTINUITY_COMPACTION_APPLIED_RETENTION_MAX_DAYS,
    buildTextToolResult,
    resolveActiveContinuityDatabasePath,
    resolveContinuityCompactionRequestScope,
    resolveContinuityCompactionRequestProfile,
    countContinuityCompactionPreviewsInScope,
    readContinuityCompactionPreview,
    purgeContinuityCompactionPreviews,
    updateContinuityCompactionPreviewStatus,
    recordContinuityTelemetry,
    addDaysToIsoTimestamp,
  } = deps;

  return async (_toolCallId: string, params: {
      preview_id: string;
    }, _signal: AbortSignal, _onUpdate: unknown, ctx: any) => {
      const activeDatabase = await resolveActiveContinuityDatabasePath(ctx);
      if (!activeDatabase.ok) {
        return buildTextToolResult({
          text: `continuity_compact_apply failed: ${activeDatabase.error}`,
          details: {
            status: "error",
            reason: "project-memory-disabled",
          },
        });
      }
  
      const nowTimestamp = new Date().toISOString();
      const purge = purgeContinuityCompactionPreviews({
        databasePath: activeDatabase.databasePath,
        nowTimestamp,
      });
  
      const requestScope = resolveContinuityCompactionRequestScope(ctx);
  
      const previewId = params.preview_id.trim();
      const preview = readContinuityCompactionPreview({
        databasePath: activeDatabase.databasePath,
        previewId,
      });
  
      const profile = resolveContinuityCompactionRequestProfile({
        ctx,
        requestScopeId: requestScope.requestScopeId,
        preferredProfile: preview?.requestProfile,
      });
  
      const applyCountInScope = countContinuityCompactionPreviewsInScope({
        databasePath: activeDatabase.databasePath,
        requestScopeId: requestScope.requestScopeId,
        statusFilter: ["applied"],
      });
  
      const reasons: ContinuityCompactionValidationReason[] = [];
  
      if (applyCountInScope >= profile.maxAppliesPerRequest) {
        reasons.push({
          code: "veto.preview.request_apply_budget",
          gate_id: "G022",
          severity: "error",
          message: "Request apply budget is exhausted for this request scope.",
          observed: String(applyCountInScope),
          expected: `<=${profile.maxAppliesPerRequest}`,
        });
      }
  
      if (!preview) {
        reasons.push({
          code: "veto.preview.not_found",
          gate_id: "G000",
          severity: "error",
          message: "Compaction preview id was not found.",
        });
      }
  
      if (preview && preview.requestScopeId !== requestScope.requestScopeId) {
        reasons.push({
          code: "veto.preview.request_scope_mismatch",
          gate_id: "G020",
          severity: "error",
          message: "Preview request scope does not match active request scope.",
        });
      }
  
      if (preview && preview.status !== "approved" && preview.status !== "approved_with_advisories") {
        reasons.push({
          code: "veto.preview.not_approved",
          gate_id: "G000",
          severity: "error",
          message: `Preview status '${preview.status}' is not apply-eligible.`,
        });
      }
  
      if (preview && Date.parse(preview.expiresAt) <= Date.parse(nowTimestamp)) {
        updateContinuityCompactionPreviewStatus({
          databasePath: activeDatabase.databasePath,
          previewId: preview.previewId,
          status: "expired",
        });
  
        reasons.push({
          code: "veto.preview.expired",
          gate_id: "G000",
          severity: "error",
          message: "Preview is expired and cannot be applied.",
        });
      }
  
      if (preview && (preview.status === "applied" || preview.appliedAt)) {
        reasons.push({
          code: "veto.preview.already_applied",
          gate_id: "G000",
          severity: "error",
          message: "Preview was already applied (apply-once semantics).",
        });
      }
  
      let proposal: ContinuityCompactionProposalPayload | null = null;
      let previewValidationPayload: Record<string, unknown> | null = null;
  
      if (preview) {
        try {
          proposal = JSON.parse(preview.proposalJson) as ContinuityCompactionProposalPayload;
        } catch {
          proposal = null;
        }
  
        try {
          const parsed = JSON.parse(preview.validationJson) as unknown;
          previewValidationPayload = typeof parsed === "object" && parsed !== null
            ? (parsed as Record<string, unknown>)
            : null;
        } catch {
          previewValidationPayload = null;
        }
  
        if (!proposal || !Array.isArray(proposal.groups) || proposal.groups.length === 0) {
          reasons.push({
            code: "veto.schema.invalid",
            gate_id: "G001",
            severity: "error",
            message: "Persisted proposal payload is invalid or empty.",
          });
        }
      }
  
      const rollback = createContinuityCompactionApplyRollbackController({
        deps,
        activeDatabase,
        reasons,
      });
      const { appliedGroups, rollbackFailureDiagnostics } = rollback;
  
      if (proposal && reasons.length === 0) {
        await applyContinuityCompactionProposalGroups({
          deps,
          activeDatabase,
          proposal,
          reasons,
          nowTimestamp,
          rollback,
        });
      }
  
      if (reasons.some((reason) => reason.severity === "error")) {
        recordContinuityTelemetry({
          databasePath: activeDatabase.databasePath,
          eventType: "continuity_compact_apply_result",
          valueText: "rejected",
          valueA: reasons.length,
          valueB: appliedGroups.length,
          payloadJson: JSON.stringify({
            requestScopeId: requestScope.requestScopeId,
            reasonCodes: reasons.map((reason) => reason.code).slice(0, 12),
            rollbackFailureCount: rollbackFailureDiagnostics.length,
            rollbackFailures: rollbackFailureDiagnostics.slice(0, 8),
          }),
        });
  
        return buildTextToolResult({
          text: [
            "continuity_compact_apply rejected.",
            ...reasons.map(renderContinuityCompactionReasonLine),
          ].join("\n"),
          details: {
            status: "rejected",
            preview_id: params.preview_id,
            request_scope: {
              id: requestScope.requestScopeId,
              profile: profile.profile,
              profile_selection_reason: profile.profileSelectionReason,
              apply_count_in_scope: applyCountInScope,
              apply_budget: profile.maxAppliesPerRequest,
            },
            reasons,
            rollback_failures: rollbackFailureDiagnostics,
            purge,
          },
        });
      }
  
      const appliedAt = nowTimestamp;
      const retentionDays = Math.min(
        CONTINUITY_COMPACTION_APPLIED_RETENTION_MAX_DAYS,
        Math.max(
          CONTINUITY_COMPACTION_APPLIED_RETENTION_MIN_DAYS,
          CONTINUITY_COMPACTION_APPLIED_RETENTION_DAYS,
        ),
      );
      const purgeAfterAt = addDaysToIsoTimestamp(appliedAt, retentionDays);
  
      let previewStatusUpdatedRows = 0;
      let previewStatusPersistFailed = false;
  
      try {
        previewStatusUpdatedRows = updateContinuityCompactionPreviewStatus({
          databasePath: activeDatabase.databasePath,
          previewId: params.preview_id,
          status: "applied",
          appliedAt,
          purgeAfterAt,
        });
      } catch (error: unknown) {
        previewStatusPersistFailed = true;
        const rollbackFailures = await rollback.rollbackAppliedGroups();
  
        reasons.push({
          code: "veto.apply.transaction_failed",
          gate_id: "G017",
          severity: "error",
          message: "Failed to persist applied status for compaction preview.",
          observed: error instanceof Error ? error.message : String(error),
          expected: "preview status update succeeds",
        });
        rollback.appendRollbackFailureReason(
          rollbackFailures,
          "Rollback restoration failed after preview-status persistence error.",
        );
      }
  
      if (!previewStatusPersistFailed && previewStatusUpdatedRows !== 1) {
        const rollbackFailures = await rollback.rollbackAppliedGroups();
  
        reasons.push({
          code: "veto.apply.transaction_failed",
          gate_id: "G017",
          severity: "error",
          message: "Compaction preview status update did not affect exactly one preview row.",
          observed: String(previewStatusUpdatedRows),
          expected: "1",
        });
        rollback.appendRollbackFailureReason(
          rollbackFailures,
          "Rollback restoration failed after unexpected preview-status row count.",
        );
      }
  
      if (reasons.some((reason) => reason.severity === "error")) {
        recordContinuityTelemetry({
          databasePath: activeDatabase.databasePath,
          eventType: "continuity_compact_apply_result",
          valueText: "rejected",
          valueA: reasons.length,
          valueB: appliedGroups.length,
          payloadJson: JSON.stringify({
            requestScopeId: requestScope.requestScopeId,
            reasonCodes: reasons.map((reason) => reason.code).slice(0, 12),
            rollbackFailureCount: rollbackFailureDiagnostics.length,
            rollbackFailures: rollbackFailureDiagnostics.slice(0, 8),
          }),
        });
  
        return buildTextToolResult({
          text: [
            "continuity_compact_apply rejected.",
            ...reasons.map(renderContinuityCompactionReasonLine),
          ].join("\n"),
          details: {
            status: "rejected",
            preview_id: params.preview_id,
            request_scope: {
              id: requestScope.requestScopeId,
              profile: profile.profile,
              profile_selection_reason: profile.profileSelectionReason,
              apply_count_in_scope: applyCountInScope,
              apply_budget: profile.maxAppliesPerRequest,
            },
            reasons,
            rollback_failures: rollbackFailureDiagnostics,
            purge,
          },
        });
      }
  
      const advisoryReasons = previewValidationPayload && Array.isArray(previewValidationPayload.reasons)
        ? (previewValidationPayload.reasons as unknown[])
            .filter((candidate): candidate is ContinuityCompactionValidationReason =>
              typeof candidate === "object"
              && candidate !== null
              && (candidate as { severity?: unknown }).severity === "warning"
              && typeof (candidate as { code?: unknown }).code === "string"
              && typeof (candidate as { gate_id?: unknown }).gate_id === "string"
              && typeof (candidate as { message?: unknown }).message === "string")
        : [];
  
      const rawAdvisorySummary = previewValidationPayload && typeof previewValidationPayload.advisory_summary === "object"
        && previewValidationPayload.advisory_summary !== null
        ? (previewValidationPayload.advisory_summary as Record<string, unknown>)
        : null;
  
      const advisorySummary = {
        count: advisoryReasons.length,
        requires_llm_review: rawAdvisorySummary
          ? Boolean(rawAdvisorySummary.requires_llm_review)
          : false,
        review_state: rawAdvisorySummary && rawAdvisorySummary.review_state === "terminal"
          ? "terminal"
          : "revisable",
        revision_number: rawAdvisorySummary && Number.isFinite(Number(rawAdvisorySummary.revision_number))
          ? Number(rawAdvisorySummary.revision_number)
          : 0,
        max_revisions: rawAdvisorySummary && Number.isFinite(Number(rawAdvisorySummary.max_revisions))
          ? Number(rawAdvisorySummary.max_revisions)
          : profile.maxPreviewRevisionsPerRequest,
        remaining_revisions: rawAdvisorySummary && Number.isFinite(Number(rawAdvisorySummary.remaining_revisions))
          ? Number(rawAdvisorySummary.remaining_revisions)
          : 0,
      };
  
      const advisoryLines = advisoryReasons.map(renderContinuityCompactionReasonLine);
  
      recordContinuityTelemetry({
        databasePath: activeDatabase.databasePath,
        eventType: "continuity_compact_apply_result",
        valueText: "applied",
        valueA: advisoryReasons.length,
        valueB: appliedGroups.reduce((sum, group) => sum + group.sourceEntries.length, 0),
        payloadJson: JSON.stringify({
          requestScopeId: requestScope.requestScopeId,
          appliedGroupCount: appliedGroups.length,
        }),
      });
  
      return buildTextToolResult({
        text: [
          `continuity_compact_apply applied preview ${params.preview_id}: groups=${appliedGroups.length}; compactedEntries=${appliedGroups.reduce((sum, group) => sum + group.sourceEntries.length, 0)}.`,
          advisoryReasons.length > 0
            ? `apply_advisories: review_state=${advisorySummary.review_state}; requires_llm_review=${advisorySummary.requires_llm_review}; remaining_revisions=${advisorySummary.remaining_revisions}.`
            : "",
          ...advisoryLines,
        ].filter((line) => line.length > 0).join("\n"),
        details: {
          status: "applied",
          preview_id: params.preview_id,
          applied_at: appliedAt,
          purge_after_at: purgeAfterAt,
          request_scope: {
            id: requestScope.requestScopeId,
            profile: profile.profile,
            profile_selection_reason: profile.profileSelectionReason,
            apply_count_in_scope: applyCountInScope + 1,
            apply_budget: profile.maxAppliesPerRequest,
          },
          applied_groups: appliedGroups.map((group) => ({
            summary_entry_id: group.summaryEntryId,
            source_entry_count: group.sourceEntries.length,
            source_entry_ids: group.sourceEntries.map((entry) => entry.id),
          })),
          advisory_count: advisoryReasons.length,
          advisory_summary: advisorySummary,
          purge,
        },
      });
  };
};
