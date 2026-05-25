/**
 * File intent: create the continuity_compact_preview tool handler.
 *
 * The handler validates and persists non-destructive compaction proposals,
 * preserving deterministic gates and advisory text from the original entrypoint.
 */

import { randomUUID } from "node:crypto";

import { buildContinuityCompactionPreviewValidation } from "./continuity-compaction-preview-validation.js";
import {
  normalizeContinuityCompactionProposalPayload,
  renderContinuityCompactionReasonLine,
  type ContinuityCompactionValidationReason,
} from "../continuity-compaction-shared.js";
import type { ExtensionToolDependencies } from "../types.js";

/**
 * Build the continuity_compact_preview execute handler.
 */
export const createContinuityCompactionPreviewTool = (deps: ExtensionToolDependencies) => {
  const {
    CONTINUITY_COMPACTION_PREVIEW_TTL_MAX_HOURS,
    CONTINUITY_COMPACTION_PREVIEW_TTL_HOURS,
    buildTextToolResult,
    resolveActiveContinuityDatabasePath,
    normalizeContinuityTimestamp,
    normalizeContinuityCompactionSourceEntryIds,
    normalizeContinuityContent,
    normalizeContinuityCompactionSectionHint,
    resolveContinuityCompactionRequestScope,
    resolveContinuityCompactionRequestProfile,
    addHoursToIsoTimestamp,
    purgeContinuityCompactionPreviews,
    countContinuityCompactionPreviewsInScope,
    recordContinuityTelemetry,
    storeContinuityCompactionPreview,
  } = deps;

  return async (_toolCallId: string, params: {
      proposal_id: string;
      based_on_preview_id?: string;
      generated_at?: string;
      groups: Array<{
        group_id: string;
        source_entry_ids: string[];
        summary: string;
        section_hint?: string;
      }>;
    }, _signal: AbortSignal, _onUpdate: unknown, ctx: any) => {
      const activeDatabase = await resolveActiveContinuityDatabasePath(ctx);
      if (!activeDatabase.ok) {
        return buildTextToolResult({
          text: `continuity_compact_preview failed: ${activeDatabase.error}`,
          details: {
            status: "error",
            reason: "project-memory-disabled",
          },
        });
      }
  
      const proposal = normalizeContinuityCompactionProposalPayload({
        params,
        normalizeContinuityTimestamp,
        normalizeContinuityCompactionSourceEntryIds,
        normalizeContinuityContent,
        normalizeContinuityCompactionSectionHint,
      });
      const requestScope = resolveContinuityCompactionRequestScope(ctx);
      const candidateSourceEntryCount = new Set(
        proposal.groups.flatMap((group) => group.source_entry_ids),
      ).size;
      const profile = resolveContinuityCompactionRequestProfile({
        ctx,
        requestScopeId: requestScope.requestScopeId,
        candidateSourceEntryCount,
        candidateGroupCount: proposal.groups.length,
      });
      const nowTimestamp = new Date().toISOString();
      const ttlHours = Math.min(
        CONTINUITY_COMPACTION_PREVIEW_TTL_MAX_HOURS,
        Math.max(1, CONTINUITY_COMPACTION_PREVIEW_TTL_HOURS),
      );
      const expiresAt = addHoursToIsoTimestamp(nowTimestamp, ttlHours);
  
      const purge = purgeContinuityCompactionPreviews({
        databasePath: activeDatabase.databasePath,
        nowTimestamp,
      });
  
      const previewCountInScope = countContinuityCompactionPreviewsInScope({
        databasePath: activeDatabase.databasePath,
        requestScopeId: requestScope.requestScopeId,
      });
  
      const applyCountInScope = countContinuityCompactionPreviewsInScope({
        databasePath: activeDatabase.databasePath,
        requestScopeId: requestScope.requestScopeId,
        statusFilter: ["applied"],
      });
  
      if (previewCountInScope >= profile.maxPreviewsPerRequest) {
        const reasons: ContinuityCompactionValidationReason[] = [{
          code: "veto.preview.request_preview_budget",
          gate_id: "G021",
          severity: "error",
          message: "Request preview budget is exhausted for this request scope.",
          observed: String(previewCountInScope),
          expected: `<=${profile.maxPreviewsPerRequest}`,
        }];
  
        recordContinuityTelemetry({
          databasePath: activeDatabase.databasePath,
          eventType: "continuity_compact_preview_result",
          valueText: "rejected",
          valueA: 0,
          valueB: proposal.groups.length,
          payloadJson: JSON.stringify({
            requestScopeId: requestScope.requestScopeId,
            reasonCodes: reasons.map((reason) => reason.code),
          }),
        });
  
        return buildTextToolResult({
          text: [
            "continuity_compact_preview rejected: preview budget exhausted for current request scope.",
            ...reasons.map(renderContinuityCompactionReasonLine),
          ].join("\n"),
          details: {
            status: "rejected",
            proposal_id: proposal.proposal_id,
            preview_id: null,
            expires_at: null,
            request_scope: {
              id: requestScope.requestScopeId,
              profile: profile.profile,
              profile_selection_reason: profile.profileSelectionReason,
              preview_count_in_scope: previewCountInScope,
              preview_budget: profile.maxPreviewsPerRequest,
              apply_count_in_scope: applyCountInScope,
              apply_budget: profile.maxAppliesPerRequest,
            },
            reasons,
            advisory_summary: {
              count: 0,
              requires_llm_review: false,
              review_state: "terminal",
              revision_number: 0,
              max_revisions: profile.maxPreviewRevisionsPerRequest,
              remaining_revisions: 0,
            },
            stats: {
              candidate_entries: 0,
              approved_groups: 0,
              rejected_groups: proposal.groups.length,
            },
            purge,
          },
        });
      }
  
      const {
        reasons,
        sourceEntryIdList,
        revisionChainId,
        revisionNumber,
        proposalFingerprint,
      } = buildContinuityCompactionPreviewValidation({
        deps,
        proposal,
        activeDatabase,
        requestScope,
        profile,
        candidateSourceEntryCount,
        nowTimestamp,
      });
  
      const hasHardError = reasons.some((reason) => reason.severity === "error");
      const advisoryCount = reasons.filter((reason) => reason.severity === "warning").length;
  
      const status = hasHardError
        ? "rejected"
        : advisoryCount > 0
          ? "approved_with_advisories"
          : "approved";
  
      const remainingRevisions = Math.max(0, profile.maxPreviewRevisionsPerRequest - revisionNumber);
      const requiresLlmReview = status === "approved_with_advisories" && remainingRevisions > 0;
      const reviewState = status === "approved_with_advisories" && !requiresLlmReview
        ? "terminal"
        : "revisable";
  
      if (status === "approved_with_advisories" && !requiresLlmReview) {
        reasons.push({
          code: "advisory.loop.terminal_review_state",
          gate_id: "G018",
          severity: "warning",
          message: "Advisories remain but revision budget is exhausted for this request scope.",
        });
      }
  
      const previewId = randomUUID();
  
      const validationResult = {
        status,
        proposal_id: proposal.proposal_id,
        preview_id: previewId,
        expires_at: expiresAt,
        request_scope: {
          id: requestScope.requestScopeId,
          profile: profile.profile,
          profile_selection_reason: profile.profileSelectionReason,
          preview_count_in_scope: previewCountInScope + 1,
          preview_budget: profile.maxPreviewsPerRequest,
          apply_count_in_scope: applyCountInScope,
          apply_budget: profile.maxAppliesPerRequest,
        },
        reasons,
        advisory_summary: {
          count: advisoryCount,
          requires_llm_review: requiresLlmReview,
          review_state: reviewState,
          revision_number: revisionNumber,
          max_revisions: profile.maxPreviewRevisionsPerRequest,
          remaining_revisions: remainingRevisions,
        },
        stats: {
          candidate_entries: sourceEntryIdList.length,
          approved_groups: hasHardError ? 0 : proposal.groups.length,
          rejected_groups: hasHardError ? proposal.groups.length : 0,
        },
        purge,
      };
  
      storeContinuityCompactionPreview({
        databasePath: activeDatabase.databasePath,
        previewId,
        requestScopeId: requestScope.requestScopeId,
        requestProfile: profile.profile,
        basedOnPreviewId: proposal.based_on_preview_id,
        revisionChainId,
        revisionNumber,
        proposalFingerprint,
        proposalJson: JSON.stringify(proposal),
        validationJson: JSON.stringify(validationResult),
        status,
        createdAt: nowTimestamp,
        expiresAt,
        purgeAfterAt: expiresAt,
      });
  
      recordContinuityTelemetry({
        databasePath: activeDatabase.databasePath,
        eventType: "continuity_compact_preview_result",
        valueText: status,
        valueA: advisoryCount,
        valueB: sourceEntryIdList.length,
        payloadJson: JSON.stringify({
          requestScopeId: requestScope.requestScopeId,
          profile: profile.profile,
          reviewState,
          requiresLlmReview,
        }),
      });
  
      const reasonLines = reasons.map(renderContinuityCompactionReasonLine);
      const text = [
        `continuity_compact_preview ${status}: preview_id=${previewId}; expires_at=${expiresAt}; advisories=${advisoryCount}.`,
        ...reasonLines,
      ].join("\n");
  
      return buildTextToolResult({
        text,
        details: validationResult,
      });
  };
};
