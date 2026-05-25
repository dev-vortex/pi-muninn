/**
 * File intent: own validation gates for continuity_compact_preview.
 *
 * This module keeps the preview tool file readable by isolating deterministic
 * schema, policy, summary-quality, and retrieval-regression checks.
 */

import { randomUUID } from "node:crypto";

import type { ContinuitySection } from "../../../../../packages/memory-core/src/continuity/continuity-codebook.js";
import { appendContinuityCompactionPreviewSummaryAdvisories } from "./continuity-compaction-preview-summary-gates.js";
import {
  type ContinuityCompactionProposalPayload,
  type ContinuityCompactionValidationReason,
} from "../continuity-compaction-shared.js";
import type { ExtensionToolDependencies } from "../types.js";

/**
 * Build validation output needed by continuity_compact_preview.
 */
export const buildContinuityCompactionPreviewValidation = (input: {
  deps: ExtensionToolDependencies;
  proposal: ContinuityCompactionProposalPayload;
  activeDatabase: { databasePath: string };
  requestScope: { requestScopeId: string };
  profile: any;
  candidateSourceEntryCount: number;
  nowTimestamp: string;
}): {
  reasons: ContinuityCompactionValidationReason[];
  sourceEntryIdList: string[];
  revisionChainId: string;
  revisionNumber: number;
  proposalFingerprint: string;
} => {
  const {
    CONTINUITY_COMPACTION_RECENT_FREEZE_HOURS,
    CONTINUITY_COMPACTION_PER_SECTION_ACTIVE_FLOOR,
    CONTINUITY_COMPACTION_GLOBAL_ACTIVE_RETAIN_FLOOR,
    CONTINUITY_COMPACTION_MAX_BATCH_COMPACT_PERCENT,
    CONTINUITY_COMPACTION_MAX_BATCH_COMPACT_ROWS,
    CONTINUITY_COMPACTION_LONG_REQUEST_SOURCE_ENTRY_THRESHOLD,
    CONTINUITY_COMPACTION_LONG_REQUEST_GROUP_THRESHOLD,
    CONTINUITY_SECTION_VALUES,
    readContinuityCompactionPreview,
    readContinuityEntriesByIds,
    readContinuityActiveCounts,
    readContinuityEntries,
    buildContinuityCompactionProposalFingerprint,
    continuityHasEmbeddedSourceRefs,
  } = input.deps;
  const {
    proposal,
    activeDatabase,
    requestScope,
    profile,
    candidateSourceEntryCount,
    nowTimestamp,
  } = input;

  const reasons: ContinuityCompactionValidationReason[] = [];
    
  if (profile.profileSelectionReason === "auto_detect_threshold") {
    reasons.push({
      code: "advisory.profile.auto_switched_long_request",
      gate_id: "G021",
      severity: "warning",
      message: "Runtime auto-switched this request scope to long-request compaction profile.",
      observed: `sourceEntries=${candidateSourceEntryCount}; groups=${proposal.groups.length}`,
      expected: `sourceEntries>=${CONTINUITY_COMPACTION_LONG_REQUEST_SOURCE_ENTRY_THRESHOLD} OR groups>=${CONTINUITY_COMPACTION_LONG_REQUEST_GROUP_THRESHOLD}`,
    });
  }
    
  let basedOnPreview = null as ReturnType<typeof readContinuityCompactionPreview>;
  let revisionChainId: string = randomUUID();
  let revisionNumber = 0;
    
  if (proposal.based_on_preview_id) {
    basedOnPreview = readContinuityCompactionPreview({
      databasePath: activeDatabase.databasePath,
      previewId: proposal.based_on_preview_id,
    });
    
    if (!basedOnPreview) {
      reasons.push({
        code: "veto.preview.not_found",
        gate_id: "G018",
        severity: "error",
        message: "based_on_preview_id was not found in persisted preview store.",
      });
    } else {
      revisionChainId = basedOnPreview.revisionChainId;
      revisionNumber = basedOnPreview.revisionNumber + 1;
    
      if (basedOnPreview.requestScopeId !== requestScope.requestScopeId) {
        reasons.push({
          code: "veto.preview.request_scope_mismatch",
          gate_id: "G020",
          severity: "error",
          message: "Revision request scope does not match parent preview scope.",
        });
      }
    }
  }
    
  if (proposal.proposal_id.trim().length === 0 || proposal.groups.length === 0) {
    reasons.push({
      code: "veto.schema.invalid",
      gate_id: "G001",
      severity: "error",
      message: "Compaction preview proposal payload is invalid or empty.",
    });
  }
    
  const uniqueSourceEntryIds = new Set<string>();
  const overlapSourceEntryIds = new Set<string>();
    
  for (const group of proposal.groups) {
    if (group.source_entry_ids.length < 2) {
      reasons.push({
        code: "veto.schema.invalid",
        gate_id: "G002",
        severity: "error",
        message: `Group '${group.group_id}' must include at least 2 source_entry_ids.`,
      });
    }
    
    for (const sourceEntryId of group.source_entry_ids) {
      if (uniqueSourceEntryIds.has(sourceEntryId)) {
        overlapSourceEntryIds.add(sourceEntryId);
      }
    
      uniqueSourceEntryIds.add(sourceEntryId);
    }
  }
    
  if (overlapSourceEntryIds.size > 0) {
    reasons.push({
      code: "veto.group.overlap",
      gate_id: "G005",
      severity: "error",
      message: "One or more source_entry_ids are reused across compaction groups.",
      observed: Array.from(overlapSourceEntryIds).slice(0, 8).join(", "),
    });
  }
    
  const sourceEntryIdList = Array.from(uniqueSourceEntryIds);
  const sourceEntries = readContinuityEntriesByIds({
    databasePath: activeDatabase.databasePath,
    entryIds: sourceEntryIdList,
  });
  const sourceEntryById = new Map(sourceEntries.map((entry) => [entry.id, entry]));
    
  if (sourceEntries.length !== sourceEntryIdList.length) {
    const missingIds = sourceEntryIdList.filter((entryId) => !sourceEntryById.has(entryId));
    
    reasons.push({
      code: "veto.entry.missing",
      gate_id: "G003",
      severity: "error",
      message: "One or more source continuity entries do not exist.",
      observed: missingIds.slice(0, 8).join(", "),
    });
  }
    
  const ineligibleIds = sourceEntries
    .filter((entry) => entry.compactedIntoEntryId !== null || entry.supersededByEntryId !== null)
    .map((entry) => entry.id);
    
  if (ineligibleIds.length > 0) {
    reasons.push({
      code: "veto.entry.not_eligible",
      gate_id: "G004",
      severity: "error",
      message: "One or more source continuity entries are already superseded/compacted.",
      observed: ineligibleIds.slice(0, 8).join(", "),
    });
  }
    
  const activeCounts = readContinuityActiveCounts({
    databasePath: activeDatabase.databasePath,
  });
    
  const activeSectionCountsBefore = activeCounts.status === "ok"
    ? activeCounts.sectionCounts
    : CONTINUITY_SECTION_VALUES.reduce((accumulator, section) => {
      accumulator[section] = 0;
      return accumulator;
    }, {
      PLANS: 0,
      DECISIONS: 0,
      PROGRESS: 0,
      DISCOVERIES: 0,
      OUTCOMES: 0,
    } as Record<ContinuitySection, number>);
    
  const activeTotalBefore = activeCounts.status === "ok"
    ? activeCounts.activeEntryCount
    : Math.max(sourceEntries.length, sourceEntryIdList.length);
    
  const activeEntriesBefore = readContinuityEntries({
    databasePath: activeDatabase.databasePath,
    includeCompacted: false,
    limit: 1_000,
  });
    
  const freezeThresholdEpoch = Date.parse(nowTimestamp) - (CONTINUITY_COMPACTION_RECENT_FREEZE_HOURS * 60 * 60 * 1000);
  const recentFreezeEntryIds = sourceEntries
    .filter((entry) => {
      const epoch = Date.parse(entry.timestamp);
      return Number.isFinite(epoch) && epoch >= freezeThresholdEpoch;
    })
    .map((entry) => entry.id);
    
  if (recentFreezeEntryIds.length > 0) {
    reasons.push({
      code: "advisory.policy.recent_freeze",
      gate_id: "G006",
      severity: "warning",
      message: "Preview includes recently written continuity rows inside freeze window.",
      observed: recentFreezeEntryIds.slice(0, 8).join(", "),
      expected: `older than ${CONTINUITY_COMPACTION_RECENT_FREEZE_HOURS}h`,
      suggestion: "Defer very recent rows or split preview into older stable groups.",
    });
  }
    
  const compactPercent = activeTotalBefore > 0
    ? sourceEntryIdList.length / activeTotalBefore
    : 0;
    
  if (
    sourceEntryIdList.length > CONTINUITY_COMPACTION_MAX_BATCH_COMPACT_ROWS
    || compactPercent > CONTINUITY_COMPACTION_MAX_BATCH_COMPACT_PERCENT
  ) {
    reasons.push({
      code: "advisory.policy.batch_too_large",
      gate_id: "G010",
      severity: "warning",
      message: "Preview batch size is above recommended compacting impact budget.",
      observed: `rows=${sourceEntryIdList.length}; percent=${(compactPercent * 100).toFixed(2)}%`,
      expected: `rows<=${CONTINUITY_COMPACTION_MAX_BATCH_COMPACT_ROWS}; percent<=${(CONTINUITY_COMPACTION_MAX_BATCH_COMPACT_PERCENT * 100).toFixed(2)}%`,
      suggestion: "Split compaction into smaller groups/passes.",
    });
  }
    
  const sectionImpactCounts = CONTINUITY_SECTION_VALUES.reduce((accumulator, section) => {
    accumulator[section] = 0;
    return accumulator;
  }, {
    PLANS: 0,
    DECISIONS: 0,
    PROGRESS: 0,
    DISCOVERIES: 0,
    OUTCOMES: 0,
  } as Record<ContinuitySection, number>);
    
  for (const entry of sourceEntries) {
    sectionImpactCounts[entry.section as ContinuitySection] += 1;
  }
    
  const sectionFloorViolations = CONTINUITY_SECTION_VALUES
    .map((section) => {
      const postCount = Math.max(0, activeSectionCountsBefore[section] - sectionImpactCounts[section]);
      return {
        section,
        postCount,
        impacted: sectionImpactCounts[section],
      };
    })
    .filter((row) => row.impacted > 0 && row.postCount < CONTINUITY_COMPACTION_PER_SECTION_ACTIVE_FLOOR);
    
  if (sectionFloorViolations.length > 0) {
    reasons.push({
      code: "advisory.policy.section_floor",
      gate_id: "G007",
      severity: "warning",
      message: "Preview would push one or more section active counts below recommended floor.",
      observed: sectionFloorViolations
        .map((row) => `${row.section}=${row.postCount}`)
        .join(", "),
      expected: `>=${CONTINUITY_COMPACTION_PER_SECTION_ACTIVE_FLOOR}`,
      suggestion: "Reduce section-specific compacted volume or regroup source entries.",
    });
  }
    
  const postActiveTotal = Math.max(0, activeTotalBefore - sourceEntryIdList.length);
  if (postActiveTotal < CONTINUITY_COMPACTION_GLOBAL_ACTIVE_RETAIN_FLOOR) {
    reasons.push({
      code: "advisory.policy.global_retain",
      gate_id: "G008",
      severity: "warning",
      message: "Preview would reduce active continuity set below recommended global retain floor.",
      observed: String(postActiveTotal),
      expected: `>=${CONTINUITY_COMPACTION_GLOBAL_ACTIVE_RETAIN_FLOOR}`,
      suggestion: "Compact fewer rows in this pass and keep more active context.",
    });
  }
    
  const protectedRows = sourceEntries
    .filter((entry) =>
      entry.section === "DECISIONS"
      && entry.provenance === "USER"
      && continuityHasEmbeddedSourceRefs(entry.content))
    .map((entry) => entry.id);
    
  if (protectedRows.length > 0) {
    reasons.push({
      code: "advisory.policy.protected_row",
      gate_id: "G009",
      severity: "warning",
      message: "Preview includes policy-protected USER DECISIONS rows with explicit source_refs evidence.",
      observed: protectedRows.slice(0, 8).join(", "),
      expected: "avoid compacting protected rows when possible",
      suggestion: "Keep protected rows active or isolate them into a dedicated low-impact compaction pass.",
    });
  }
    
  if (revisionNumber > profile.maxPreviewRevisionsPerRequest) {
    reasons.push({
      code: "veto.preview.revision_limit",
      gate_id: "G018",
      severity: "error",
      message: "Revision budget is exhausted for this preview chain.",
      observed: String(revisionNumber),
      expected: `<=${profile.maxPreviewRevisionsPerRequest}`,
    });
  }
    
  const proposalFingerprint = buildContinuityCompactionProposalFingerprint(proposal);
    
  if (basedOnPreview && basedOnPreview.proposalFingerprint === proposalFingerprint) {
    reasons.push({
      code: "veto.preview.no_material_change",
      gate_id: "G019",
      severity: "error",
      message: "Revised preview fingerprint is unchanged from parent preview.",
    });
  }
    
  appendContinuityCompactionPreviewSummaryAdvisories({
    deps: input.deps,
    reasons,
    proposal,
    sourceEntryById,
    activeEntriesBefore,
    nowTimestamp,
  });

  return {
    reasons,
    sourceEntryIdList,
    revisionChainId,
    revisionNumber,
    proposalFingerprint,
  };
};
