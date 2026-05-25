/**
 * File intent: create the canonical continuity_write tool handler.
 *
 * The handler persists one continuity entry into the canonical sidecar DB and
 * preserves the existing validation, telemetry, and low-signal handling.
 */

import { createMemoryCore } from "../../../../../packages/memory-core/src/index.js";
import { createSqliteContinuityDataAdapter } from "../../../../../packages/memory-core/src/adapters/sqlite/index.js";
import type { ExtensionToolDependencies } from "./../types.js";

/**
 * Build the continuity_write execute handler.
 */
export const createContinuityWriteTool = (deps: ExtensionToolDependencies) => {
  const {
    CONTINUITY_SECTION_VALUES,
    CONTINUITY_PROVENANCE_VALUES,
    buildTextToolResult,
    resolveActiveContinuityDatabasePath,
    logContinuityBlocked,
    normalizeContinuitySection,
    normalizeContinuityProvenance,
    normalizeContinuityCertainty,
    normalizeContinuityTimestamp,
    normalizeContinuitySourceRefs,
    buildContinuityContentWithSourceRefs,
    persistAutomaticContinuityDualWrite,
    recordContinuityTelemetry,
  } = deps;

  return async (_toolCallId: string, params: {
      timestamp?: string;
      section: string;
      provenance: string;
      certainty?: string;
      source_refs?: string[];
      content: string;
    }, _signal: AbortSignal, _onUpdate: unknown, ctx: any) => {
      const activeDatabase = await resolveActiveContinuityDatabasePath(ctx);
      if (!activeDatabase.ok) {
        logContinuityBlocked({
          stage: "continuity_write",
          reason: "project-memory-disabled",
          detail: activeDatabase.error,
          ctx,
        });
  
        return buildTextToolResult({
          text: `continuity_write failed: ${activeDatabase.error}`,
          details: { status: "error", reason: "project-memory-disabled" },
        });
      }
  
      const section = normalizeContinuitySection(params.section);
      if (!section) {
        logContinuityBlocked({
          stage: "continuity_write",
          reason: "invalid-section",
          detail: String(params.section),
          ctx,
        });
  
        return buildTextToolResult({
          text: `continuity_write failed: invalid section '${params.section}'. Use one of: ${CONTINUITY_SECTION_VALUES.join(", ")}.`,
          details: { status: "error", reason: "invalid-section" },
        });
      }
  
      const provenance = normalizeContinuityProvenance(params.provenance);
      if (!provenance) {
        logContinuityBlocked({
          stage: "continuity_write",
          reason: "invalid-provenance",
          detail: String(params.provenance),
          ctx,
        });
  
        return buildTextToolResult({
          text: `continuity_write failed: invalid provenance '${params.provenance}'. Use one of: ${CONTINUITY_PROVENANCE_VALUES.join(", ")}.`,
          details: { status: "error", reason: "invalid-provenance" },
        });
      }
  
      const certainty = normalizeContinuityCertainty(params.certainty) || "CONFIRMED";
      const timestamp = normalizeContinuityTimestamp(params.timestamp);
      const sourceRefs = normalizeContinuitySourceRefs({
        ctx,
        sourceRefs: params.source_refs,
      });
      const content = buildContinuityContentWithSourceRefs({
        content: params.content || "",
        sourceRefs,
      });
  
      if (!content) {
        logContinuityBlocked({
          stage: "continuity_write",
          reason: "invalid-content",
          ctx,
        });
  
        return buildTextToolResult({
          text: "continuity_write failed: content is required.",
          details: { status: "error", reason: "invalid-content" },
        });
      }
  
      const continuityData = createSqliteContinuityDataAdapter({
        persistWrite: async (writeInput) => {
          const continuityWrite = await persistAutomaticContinuityDualWrite({
            databasePath: activeDatabase.databasePath,
            section: writeInput.section,
            provenance: writeInput.provenance,
            certainty: writeInput.certainty,
            timestamp: writeInput.timestamp,
            content: writeInput.content,
            sourceRefs: writeInput.sourceRefs,
          });

          if (!continuityWrite.ok) {
            throw new Error(continuityWrite.error);
          }

          return continuityWrite.status === "skipped"
            ? {
              outcome: "skipped" as const,
              skipReason: continuityWrite.skipReason,
              fingerprint: continuityWrite.fingerprint,
              timestamp: continuityWrite.timestamp,
              duplicateTimestamp: continuityWrite.duplicateTimestamp,
              qualityReason: continuityWrite.qualityReason,
            }
            : {
              outcome: "stored" as const,
              fingerprint: continuityWrite.fingerprint,
              timestamp: continuityWrite.timestamp,
            };
        },
        write: async () => {
          throw new Error("continuity_write uses persistWrite in core-owned L0 path");
        },
        query: async () => ({ entries: [] }),
        readStatus: async () => ({ activeCount: 0 }),
      });

      const core = createMemoryCore({
        continuityData,
        telemetry: {
          record: async (event) => {
            recordContinuityTelemetry({
              databasePath: activeDatabase.databasePath,
              eventType: event.eventType as "continuity_write_stored" | "continuity_write_skipped_duplicate" | "continuity_write_skipped_low_signal",
              valueText: event.valueText,
              payloadJson: event.payloadJson,
            });
          },
        },
      });

      const result = await core.continuityWrite({
        context: {
          projectRoot: ctx.cwd,
          userId: null,
          now: timestamp,
        },
        section,
        provenance,
        certainty,
        timestamp,
        content,
        sourceRefs,
      });

      if (result.diagnostics.reason === "continuity-write-failed") {
        logContinuityBlocked({
          stage: "continuity_write",
          reason: "continuity-write-failed",
          detail: result.warnings[0],
          ctx,
        });
      }

      if (result.diagnostics.status === "skipped") {
        logContinuityBlocked({
          stage: "continuity_write",
          reason: String(result.diagnostics.reason),
          detail: result.diagnostics.reason === "duplicate-continuity-entry"
            ? `matchedAt=${String(result.diagnostics.duplicateTimestamp || "unknown")}`
            : String(result.diagnostics.qualityReason || ""),
          ctx,
        });
      }

      return buildTextToolResult({
        text: result.text,
        details: {
          ...result.diagnostics,
          databasePath: activeDatabase.databasePath,
        },
      });
  };
};
