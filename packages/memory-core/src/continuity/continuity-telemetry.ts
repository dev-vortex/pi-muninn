/**
 * File intent: own host-neutral L0 continuity telemetry report/review orchestration.
 *
 * Telemetry review is an operator/admin governance workflow for auditing
 * potential false rejects. It must not become a normal retrieval surface for
 * task-solving context.
 */

import type {
  CoreTextResult,
  TelemetryReportRequest,
  TelemetryReviewLabelRequest,
} from "../contracts.js";
import type { TelemetryPort } from "../ports.js";

/**
 * Dependencies needed by continuity telemetry orchestration.
 */
export interface ContinuityTelemetryServiceDependencies {
  /** Telemetry provider/data adapter for persisted report and label data. */
  telemetry: Pick<TelemetryPort, "report" | "label">;
}

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
 * Normalize optional bounded telemetry numbers before provider delegation.
 */
const normalizeOptionalPositiveInteger = (value: number | undefined): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.floor(value));
};

/**
 * Render one queue sample line for operator/admin review.
 */
const renderFalseRejectReviewSampleLine = (input: {
  sample: {
    eventId: string;
    timestamp: string;
    eventType: string;
    outcome: string | null;
    reasonCodes: string[];
    qualityReason: string | null;
    reviewLabel: TelemetryReviewLabelRequest["label"] | null;
  };
  index: number;
}): string => {
  const reasonCodes = input.sample.reasonCodes.length > 0
    ? input.sample.reasonCodes.join(",")
    : "none";
  const qualityReason = input.sample.qualityReason || "none";
  const reviewLabel = input.sample.reviewLabel || "unlabeled";
  return `${input.index + 1}. event_id=${input.sample.eventId}; ts=${input.sample.timestamp}; type=${input.sample.eventType}; outcome=${input.sample.outcome || "none"}; label=${reviewLabel}; reasonCodes=${reasonCodes}; qualityReason=${qualityReason}`;
};

/**
 * Create continuity telemetry report/review orchestration around one provider.
 */
export const createContinuityTelemetryService = (
  dependencies: ContinuityTelemetryServiceDependencies,
): {
  readReport: (input: TelemetryReportRequest) => Promise<CoreTextResult>;
  labelReview: (input: TelemetryReviewLabelRequest) => Promise<CoreTextResult>;
} => ({
  readReport: async (input: TelemetryReportRequest): Promise<CoreTextResult> => {
    if (!dependencies.telemetry.report) {
      return buildTextResult({
        status: "unavailable",
        text: "continuity_telemetry_review_queue unavailable: telemetry provider does not implement report.",
        details: {
          status: "unavailable",
          reason: "telemetry-report-unavailable",
        },
        warnings: ["telemetry-provider-missing-report"],
      });
    }

    const reportResult = await dependencies.telemetry.report({
      ...input,
      windowDays: normalizeOptionalPositiveInteger(input.windowDays),
      sampleLimit: normalizeOptionalPositiveInteger(input.sampleLimit),
    });
    const report = reportResult.report;

    if (report.status === "error" || reportResult.status === "error") {
      const warning = report.warning || reportResult.warnings[0] || "unknown error";
      return buildTextResult({
        status: "error",
        text: `continuity_telemetry_review_queue failed: ${warning}`,
        details: {
          status: "error",
          reason: "trend-report-failed",
          warning,
        },
        warnings: reportResult.warnings,
      });
    }

    const lines = report.falseRejectReviewSample.map((sample, index) =>
      renderFalseRejectReviewSampleLine({ sample, index }));

    return buildTextResult({
      status: "ok",
      text: [
        `continuity_telemetry_review_queue status=${report.status}; windowDays=${report.windowDays}; candidates=${report.falseRejectReviewCandidateCount}; labeled=${report.falseRejectReviewLabeledCount}; pending=${report.falseRejectReviewPendingCount}; labels(valid=${report.falseRejectLabeledValidRejectCount}, false=${report.falseRejectLabeledFalseRejectCount}, uncertain=${report.falseRejectLabeledUncertainCount}).`,
        ...lines,
      ].join("\n"),
      details: {
        status: report.status,
        ...reportResult.diagnostics,
        report,
      },
      warnings: reportResult.warnings,
    });
  },

  labelReview: async (input: TelemetryReviewLabelRequest): Promise<CoreTextResult> => {
    const eventId = input.eventId.trim();
    const note = typeof input.note === "string" && input.note.trim().length > 0
      ? input.note.trim()
      : undefined;

    if (!dependencies.telemetry.label) {
      return buildTextResult({
        status: "unavailable",
        text: "continuity_telemetry_review_label unavailable: telemetry provider does not implement label.",
        details: {
          status: "unavailable",
          reason: "telemetry-label-unavailable",
          eventId,
        },
        warnings: ["telemetry-provider-missing-label"],
      });
    }

    const labelResult = await dependencies.telemetry.label({
      ...input,
      eventId,
      note,
    });

    if (labelResult.labelStatus === "stored") {
      return buildTextResult({
        status: "ok",
        text: `continuity_telemetry_review_label stored: event_id=${eventId}; label=${input.label}.`,
        details: {
          status: "stored",
          ...labelResult.diagnostics,
          eventId,
          label: input.label,
        },
        warnings: labelResult.warnings,
      });
    }

    if (labelResult.labelStatus === "event-not-found") {
      return buildTextResult({
        status: "ok",
        text: `continuity_telemetry_review_label rejected: event_id '${eventId}' was not found.`,
        details: {
          status: "rejected",
          reason: "event-not-found",
          ...labelResult.diagnostics,
          eventId,
        },
        warnings: labelResult.warnings,
      });
    }

    if (labelResult.labelStatus === "event-not-review-eligible") {
      return buildTextResult({
        status: "ok",
        text: `continuity_telemetry_review_label rejected: event_id '${eventId}' is not a false-reject review candidate.`,
        details: {
          status: "rejected",
          reason: "event-not-review-eligible",
          ...labelResult.diagnostics,
          eventId,
        },
        warnings: labelResult.warnings,
      });
    }

    const warning = labelResult.warning || labelResult.warnings[0] || "unknown error";
    return buildTextResult({
      status: "error",
      text: `continuity_telemetry_review_label failed: ${warning}.`,
      details: {
        status: "error",
        reason: "review-label-write-failed",
        warning,
        ...labelResult.diagnostics,
        eventId,
      },
      warnings: labelResult.warnings,
    });
  },
});
