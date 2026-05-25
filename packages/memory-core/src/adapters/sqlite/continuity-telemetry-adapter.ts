/**
 * File intent: adapt SQLite-backed continuity telemetry to memory-core ports.
 *
 * This memory-core adapter keeps concrete continuity telemetry persistence
 * behind the SQLite boundary while memory-core owns report/label orchestration.
 */

import {
  readContinuityTelemetryTrendReport,
  storeContinuityTelemetryEvent,
  storeContinuityTelemetryReviewLabel,
} from "./continuity/continuity-store.js";
import type {
  CoreTelemetryReportResult,
  CoreTelemetryReviewLabelResult,
  TelemetryPort,
} from "../../index.js";

/**
 * Build diagnostics shared by SQLite telemetry provider results.
 */
const buildDiagnostics = (databasePath: string): Record<string, unknown> => ({
  provider: "sqlite-continuity-telemetry-provider",
  databasePath,
});

/**
 * Create a telemetry provider bound to one canonical continuity database.
 */
export const createSqliteContinuityTelemetryProviderForDatabase = (input: {
  databasePath: string;
}): TelemetryPort => ({
  record: async (event) => {
    const result = storeContinuityTelemetryEvent({
      databasePath: input.databasePath,
      eventType: event.eventType as Parameters<typeof storeContinuityTelemetryEvent>[0]["eventType"],
      valueA: event.valueA,
      valueB: event.valueB,
      valueText: event.valueText,
      payloadJson: event.payloadJson,
    });

    if (result.status === "error") {
      throw new Error(result.warning || "continuity telemetry record failed");
    }
  },

  report: async (reportInput): Promise<CoreTelemetryReportResult> => {
    const report = readContinuityTelemetryTrendReport({
      databasePath: input.databasePath,
      windowDays: reportInput.windowDays,
      reviewSampleLimit: reportInput.sampleLimit,
    });

    return {
      status: report.status === "error" ? "error" : "ok",
      report,
      warnings: report.warning ? [report.warning] : [],
      diagnostics: buildDiagnostics(input.databasePath),
    };
  },

  label: async (labelInput): Promise<CoreTelemetryReviewLabelResult> => {
    const eventId = labelInput.eventId.trim();
    const result = storeContinuityTelemetryReviewLabel({
      databasePath: input.databasePath,
      eventId,
      label: labelInput.label,
      reviewer: "agent",
      note: labelInput.note,
    });

    return {
      status: result.status === "error" ? "error" : "ok",
      labelStatus: result.status,
      eventId,
      label: labelInput.label,
      warning: result.warning,
      warnings: result.warning ? [result.warning] : [],
      diagnostics: buildDiagnostics(input.databasePath),
    };
  },
});
