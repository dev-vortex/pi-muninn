/**
 * File intent: execute continuity compaction apply mutations and rollback helpers.
 *
 * This keeps continuity_compact_apply under the agreed file-size limit while
 * preserving source-link, vector-transition, and rollback behavior.
 */

import { randomUUID } from "node:crypto";

import type { ContinuitySection } from "../../../../../packages/memory-core/src/continuity/continuity-codebook.js";
import type { ContinuityEntryLifecycleRecord } from "../../../../memory-data-adapters/sqlite/continuity/index.js";
import type { ContinuityCompactionProposalPayload, ContinuityCompactionValidationReason } from "../continuity-compaction-shared.js";
import type { ExtensionToolDependencies } from "../types.js";

/**
 * One group successfully applied before final preview status persistence.
 */
export interface ContinuityCompactionAppliedGroup {
  summaryEntryId: string;
  sourceEntries: ContinuityEntryLifecycleRecord[];
}

/**
 * Rollback helpers/state shared by apply mutation and preview-status phases.
 */
export interface ContinuityCompactionApplyRollbackController {
  appliedGroups: ContinuityCompactionAppliedGroup[];
  rollbackFailureDiagnostics: string[];
  restoreCompactionSourceVectors: (sourceEntries: ContinuityEntryLifecycleRecord[]) => Promise<string[]>;
  cleanupCompactionSummaryState: (input: { summaryEntryId: string; sourceEntryIds: string[] }) => string[];
  rollbackAppliedGroups: () => Promise<string[]>;
  appendRollbackFailureReason: (rollbackFailures: string[], contextMessage: string) => void;
}

/**
 * Create rollback state/helpers for one apply execution.
 */
export const createContinuityCompactionApplyRollbackController = (input: {
  deps: ExtensionToolDependencies;
  activeDatabase: { databasePath: string };
  reasons: ContinuityCompactionValidationReason[];
}): ContinuityCompactionApplyRollbackController => {
  const {
    deleteContinuityEntry,
    clearContinuityEntriesCompactedInto,
    indexContinuityVectorEntry,
    deleteContinuityVectorEntry,
    continuityVectorEmbedder,
  } = input.deps;
  const { activeDatabase, reasons } = input;
  const appliedGroups: ContinuityCompactionAppliedGroup[] = [];
  const rollbackFailureDiagnostics: string[] = [];

  const restoreCompactionSourceVectors = async (
    sourceEntries: ContinuityEntryLifecycleRecord[],
  ): Promise<string[]> => {
    const failures: string[] = [];

    for (const sourceEntry of sourceEntries) {
      try {
        const restore = await indexContinuityVectorEntry({
          databasePath: activeDatabase.databasePath,
          embedder: continuityVectorEmbedder,
          entry: {
            id: sourceEntry.id,
            section: sourceEntry.section,
            provenance: sourceEntry.provenance,
            certainty: sourceEntry.certainty,
            content: sourceEntry.content,
          },
        });

        if (restore.status === "error") {
          failures.push(`${sourceEntry.id}:${restore.warning || "unknown error"}`);
        }
      } catch (error: unknown) {
        failures.push(`${sourceEntry.id}:${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return failures;
  };

  const cleanupCompactionSummaryState = (cleanupInput: {
    summaryEntryId: string;
    sourceEntryIds: string[];
  }): string[] => {
    const failures: string[] = [];

    try {
      clearContinuityEntriesCompactedInto({
        databasePath: activeDatabase.databasePath,
        sourceEntryIds: cleanupInput.sourceEntryIds,
        compactedIntoEntryId: cleanupInput.summaryEntryId,
      });
    } catch (error: unknown) {
      failures.push(`clear-links:${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      deleteContinuityEntry({
        databasePath: activeDatabase.databasePath,
        id: cleanupInput.summaryEntryId,
      });
    } catch (error: unknown) {
      failures.push(`delete-summary-row:${error instanceof Error ? error.message : String(error)}`);
    }

    const summaryVectorCleanup = deleteContinuityVectorEntry({
      databasePath: activeDatabase.databasePath,
      entryId: cleanupInput.summaryEntryId,
    });

    if (summaryVectorCleanup.status === "error") {
      failures.push(`delete-summary-vector:${summaryVectorCleanup.warning || "unknown error"}`);
    }

    return failures;
  };

  const rollbackAppliedGroups = async (): Promise<string[]> => {
    const rollbackFailures: string[] = [];

    for (const groupState of [...appliedGroups].reverse()) {
      const sourceEntryIds = groupState.sourceEntries.map((entry) => entry.id);
      const cleanupFailures = cleanupCompactionSummaryState({
        summaryEntryId: groupState.summaryEntryId,
        sourceEntryIds,
      });
      rollbackFailures.push(
        ...cleanupFailures.map((failure) => `${groupState.summaryEntryId}:${failure}`),
      );

      const restoreFailures = await restoreCompactionSourceVectors(groupState.sourceEntries);
      rollbackFailures.push(
        ...restoreFailures.map((failure) => `${groupState.summaryEntryId}:restore:${failure}`),
      );
    }

    return rollbackFailures;
  };

  const appendRollbackFailureReason = (rollbackFailures: string[], contextMessage: string): void => {
    if (rollbackFailures.length === 0) {
      return;
    }

    rollbackFailureDiagnostics.push(...rollbackFailures);

    reasons.push({
      code: "veto.apply.transaction_failed",
      gate_id: "G017",
      severity: "error",
      message: contextMessage,
      observed: rollbackFailures.slice(0, 4).join(" | "),
      expected: "rollback restores all affected rows and vectors",
    });
  };

  return {
    appliedGroups,
    rollbackFailureDiagnostics,
    restoreCompactionSourceVectors,
    cleanupCompactionSummaryState,
    rollbackAppliedGroups,
    appendRollbackFailureReason,
  };
};

/**
 * Apply proposal groups, collecting hard-veto reasons on failure.
 */
export const applyContinuityCompactionProposalGroups = async (input: {
  deps: ExtensionToolDependencies;
  activeDatabase: { databasePath: string };
  proposal: ContinuityCompactionProposalPayload;
  reasons: ContinuityCompactionValidationReason[];
  nowTimestamp: string;
  rollback: ContinuityCompactionApplyRollbackController;
}): Promise<void> => {
  const {
    normalizeContinuityContent,
    readContinuityEntriesByIds,
    normalizeContinuityCompactionSourceEntryIds,
    storeContinuityEntryWithVectorConsistency,
    markContinuityEntriesCompactedInto,
    deleteContinuityVectorEntry,
  } = input.deps;
  const { activeDatabase, proposal, reasons, nowTimestamp, rollback } = input;

  const allSourceEntryIds = Array.from(new Set(
    proposal.groups.flatMap((group) => normalizeContinuityCompactionSourceEntryIds(group.source_entry_ids)),
  ));

  const sourceEntries = readContinuityEntriesByIds({
    databasePath: activeDatabase.databasePath,
    entryIds: allSourceEntryIds,
  });
  const sourceEntryById = new Map(sourceEntries.map((entry) => [entry.id, entry]));

  if (sourceEntries.length !== allSourceEntryIds.length) {
    const missing = allSourceEntryIds.filter((entryId) => !sourceEntryById.has(entryId));
    reasons.push({
      code: "veto.entry.missing",
      gate_id: "G003",
      severity: "error",
      message: "Source entry set changed after preview validation.",
      observed: missing.slice(0, 8).join(", "),
    });
  }

  const ineligible = sourceEntries
    .filter((entry) => entry.compactedIntoEntryId !== null || entry.supersededByEntryId !== null)
    .map((entry) => entry.id);

  if (ineligible.length > 0) {
    reasons.push({
      code: "veto.entry.not_eligible",
      gate_id: "G004",
      severity: "error",
      message: "Source entry set contains rows that are no longer active.",
      observed: ineligible.slice(0, 8).join(", "),
    });
  }

  if (reasons.length > 0) {
    return;
  }

  for (const group of proposal.groups) {
    const groupSourceIds = normalizeContinuityCompactionSourceEntryIds(group.source_entry_ids);
    const groupSourceEntries = groupSourceIds
      .map((sourceId) => sourceEntryById.get(sourceId) || null)
      .filter((entry): entry is ContinuityEntryLifecycleRecord => entry !== null);

    if (groupSourceEntries.length !== groupSourceIds.length) {
      reasons.push({
        code: "veto.entry.missing",
        gate_id: "G003",
        severity: "error",
        message: `Group '${group.group_id}' references missing source entries during apply.`,
      });
      const rollbackFailures = await rollback.rollbackAppliedGroups();
      rollback.appendRollbackFailureReason(
        rollbackFailures,
        `Rollback restoration failed after missing source entries in group '${group.group_id}'.`,
      );
      break;
    }

    const summarySection = group.section_hint && group.section_hint !== "MIXED"
      ? group.section_hint
      : "OUTCOMES";

    const summaryContent = normalizeContinuityContent(group.summary);
    const summaryEntryId = randomUUID();

    const summaryWrite = await storeContinuityEntryWithVectorConsistency({
      databasePath: activeDatabase.databasePath,
      id: summaryEntryId,
      timestamp: nowTimestamp,
      section: summarySection as ContinuitySection,
      provenance: "CODE",
      certainty: "CONFIRMED",
      content: summaryContent,
    });

    if (!summaryWrite.ok) {
      reasons.push({
        code: "veto.vector.transition_failed",
        gate_id: "G016",
        severity: "error",
        message: `Failed to index compacted summary for group '${group.group_id}'.`,
        observed: summaryWrite.error,
      });
      const rollbackFailures = await rollback.rollbackAppliedGroups();
      rollback.appendRollbackFailureReason(
        rollbackFailures,
        `Rollback restoration failed after summary index failure in group '${group.group_id}'.`,
      );
      break;
    }

    const updatedCount = markContinuityEntriesCompactedInto({
      databasePath: activeDatabase.databasePath,
      sourceEntryIds: groupSourceIds,
      compactedIntoEntryId: summaryEntryId,
    });

    if (updatedCount !== groupSourceIds.length) {
      const cleanupFailures = rollback.cleanupCompactionSummaryState({
        summaryEntryId,
        sourceEntryIds: groupSourceIds,
      });

      reasons.push({
        code: "veto.apply.transaction_failed",
        gate_id: "G017",
        severity: "error",
        message: `Failed to mark all source rows as compacted for group '${group.group_id}'.`,
        observed:
          `updated=${updatedCount}/${groupSourceIds.length}; ` +
          `cleanup=${cleanupFailures.length > 0 ? cleanupFailures.slice(0, 3).join(" | ") : "ok"}`,
        expected: String(groupSourceIds.length),
      });

      const rollbackFailures = await rollback.rollbackAppliedGroups();
      rollback.appendRollbackFailureReason(
        rollbackFailures,
        `Rollback restoration failed after partial compact-link update in group '${group.group_id}'.`,
      );
      break;
    }

    const vectorDeletionFailures: string[] = [];

    for (const sourceEntryId of groupSourceIds) {
      const cleanup = deleteContinuityVectorEntry({
        databasePath: activeDatabase.databasePath,
        entryId: sourceEntryId,
      });

      if (cleanup.status === "error") {
        vectorDeletionFailures.push(`${sourceEntryId}:${cleanup.warning || "unknown error"}`);
      }
    }

    if (vectorDeletionFailures.length > 0) {
      const cleanupFailures = rollback.cleanupCompactionSummaryState({
        summaryEntryId,
        sourceEntryIds: groupSourceIds,
      });
      const sourceRestoreFailures = await rollback.restoreCompactionSourceVectors(groupSourceEntries);

      reasons.push({
        code: "veto.vector.transition_failed",
        gate_id: "G016",
        severity: "error",
        message: `Vector transition failed while compacting group '${group.group_id}'.`,
        observed: [
          ...vectorDeletionFailures,
          ...cleanupFailures.map((failure) => `cleanup:${failure}`),
          ...sourceRestoreFailures.map((failure) => `restore:${failure}`),
        ].slice(0, 4).join(" | "),
      });

      const rollbackFailures = await rollback.rollbackAppliedGroups();
      rollback.appendRollbackFailureReason(
        rollbackFailures,
        `Rollback restoration failed after vector transition failure in group '${group.group_id}'.`,
      );
      break;
    }

    rollback.appliedGroups.push({
      summaryEntryId,
      sourceEntries: groupSourceEntries,
    });
  }
};
