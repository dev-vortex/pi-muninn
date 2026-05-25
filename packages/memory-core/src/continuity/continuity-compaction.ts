/**
 * File intent: own host-neutral local L0 continuity compaction orchestration.
 *
 * This service validates core compaction requests and delegates physical preview
 * and apply persistence to the non-vendor continuity data adapter. Full Pi
 * compaction parity remains adapter-backed until the detailed L0 compaction
 * policy migration is complete.
 */

import type {
  ContinuityCompactApplyRequest,
  ContinuityCompactPreviewRequest,
  CoreTextResult,
} from "../contracts.js";
import type { ContinuityDataAdapterPort } from "../ports.js";

/**
 * Dependencies needed by local continuity compaction orchestration.
 */
export interface ContinuityCompactionServiceDependencies {
  /** Non-vendor continuity data adapter used for local L0 compaction. */
  continuityData: Pick<ContinuityDataAdapterPort, "previewCompaction" | "applyCompaction">;
}

/**
 * Normalize and de-duplicate source entry ids for compact preview requests.
 */
export const normalizeCompactionSourceEntryIds = (sourceEntryIds: string[]): string[] => {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const rawEntryId of sourceEntryIds) {
    const entryId = String(rawEntryId || "").trim();
    if (!entryId || seen.has(entryId)) continue;
    seen.add(entryId);
    normalized.push(entryId);
  }

  return normalized;
};

/**
 * Build a text result whose diagnostics are directly usable as tool details.
 */
const buildTextResult = (input: {
  status: CoreTextResult["status"];
  text: string;
  details: Record<string, unknown>;
  warnings?: string[];
}): CoreTextResult => ({
  status: input.status,
  text: input.text,
  warnings: input.warnings || [],
  diagnostics: input.details,
});

/**
 * Create local L0 continuity compaction orchestration around one data adapter.
 */
export const createContinuityCompactionService = (
  dependencies: ContinuityCompactionServiceDependencies,
): {
  preview: (input: ContinuityCompactPreviewRequest) => Promise<CoreTextResult>;
  apply: (input: ContinuityCompactApplyRequest) => Promise<CoreTextResult>;
} => ({
  preview: async (input: ContinuityCompactPreviewRequest): Promise<CoreTextResult> => {
    const sourceEntryIds = normalizeCompactionSourceEntryIds(input.sourceEntryIds);
    if (sourceEntryIds.length === 0) {
      return buildTextResult({
        status: "error",
        text: "continuity_compact_preview failed: sourceEntryIds are required.",
        details: {
          status: "error",
          reason: "invalid-source-entry-ids",
        },
      });
    }

    const summary = input.summary.trim().replace(/\s+/g, " ");
    if (!summary) {
      return buildTextResult({
        status: "error",
        text: "continuity_compact_preview failed: summary is required.",
        details: {
          status: "error",
          reason: "invalid-summary",
        },
      });
    }

    if (!dependencies.continuityData.previewCompaction) {
      return buildTextResult({
        status: "unavailable",
        text: "continuity_compact_preview unavailable: continuity data adapter does not implement compaction preview.",
        details: {
          status: "unavailable",
          reason: "compaction-preview-unavailable",
        },
        warnings: ["continuity-data-adapter-missing-previewCompaction"],
      });
    }

    return dependencies.continuityData.previewCompaction({
      ...input,
      sourceEntryIds,
      summary,
    });
  },

  apply: async (input: ContinuityCompactApplyRequest): Promise<CoreTextResult> => {
    const previewId = input.previewId.trim();
    if (!previewId) {
      return buildTextResult({
        status: "error",
        text: "continuity_compact_apply failed: previewId is required.",
        details: {
          status: "error",
          reason: "invalid-preview-id",
        },
      });
    }

    if (!dependencies.continuityData.applyCompaction) {
      return buildTextResult({
        status: "unavailable",
        text: "continuity_compact_apply unavailable: continuity data adapter does not implement compaction apply.",
        details: {
          status: "unavailable",
          reason: "compaction-apply-unavailable",
        },
        warnings: ["continuity-data-adapter-missing-applyCompaction"],
      });
    }

    return dependencies.continuityData.applyCompaction({
      ...input,
      previewId,
    });
  },
});
