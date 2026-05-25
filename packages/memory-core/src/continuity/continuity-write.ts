/**
 * File intent: own host-neutral L0 continuity write orchestration.
 *
 * This service validates and normalizes continuity write inputs, applies the
 * existing result-text contract, records telemetry through a host-neutral port,
 * and delegates persistence to a non-vendor data adapter.
 */

import type {
  ContinuityDataAdapterPort,
  CoreContinuityDataPersistResult,
  TelemetryPort,
} from "../ports.js";
import type {
  ContinuityWriteRequest,
  CoreTextResult,
} from "../contracts.js";

const CONTINUITY_SECTION_VALUES = [
  "PLANS",
  "DECISIONS",
  "PROGRESS",
  "DISCOVERIES",
  "OUTCOMES",
] as const;

const CONTINUITY_PROVENANCE_VALUES = [
  "USER",
  "CODE",
  "TOOL",
  "ASSUMPTION",
] as const;

const CONTINUITY_CERTAINTY_VALUES = [
  "CONFIRMED",
  "UNCONFIRMED",
] as const;

/**
 * Dependencies needed by continuity write orchestration.
 */
export interface ContinuityWriteServiceDependencies {
  /** Non-vendor continuity data adapter used for persistence. */
  continuityData: Pick<ContinuityDataAdapterPort, "persistWrite">;
  /** Optional telemetry port for write outcome events. */
  telemetry?: TelemetryPort;
}

/**
 * Normalize enum-like continuity labels.
 */
const normalizeContinuityEnumLabel = (value: string): string =>
  value.trim().replace(/^\[+/, "").replace(/\]+$/, "").trim().toUpperCase();

/**
 * Normalize one continuity section label.
 */
export const normalizeContinuitySection = (value: string): ContinuityWriteRequest["section"] | null => {
  const normalized = normalizeContinuityEnumLabel(value);
  return CONTINUITY_SECTION_VALUES.includes(normalized as (typeof CONTINUITY_SECTION_VALUES)[number])
    ? normalized as ContinuityWriteRequest["section"]
    : null;
};

/**
 * Normalize one continuity provenance label.
 */
export const normalizeContinuityProvenance = (value: string): ContinuityWriteRequest["provenance"] | null => {
  const normalized = normalizeContinuityEnumLabel(value);
  return CONTINUITY_PROVENANCE_VALUES.includes(normalized as (typeof CONTINUITY_PROVENANCE_VALUES)[number])
    ? normalized as ContinuityWriteRequest["provenance"]
    : null;
};

/**
 * Normalize one continuity certainty label.
 */
export const normalizeContinuityCertainty = (value?: string): NonNullable<ContinuityWriteRequest["certainty"]> | null => {
  if (!value) return "CONFIRMED";
  const normalized = normalizeContinuityEnumLabel(value);
  return CONTINUITY_CERTAINTY_VALUES.includes(normalized as (typeof CONTINUITY_CERTAINTY_VALUES)[number])
    ? normalized as NonNullable<ContinuityWriteRequest["certainty"]>
    : null;
};

/**
 * Normalize content whitespace for continuity rows and diagnostics.
 */
export const normalizeContinuityContent = (content: string): string =>
  content.trim().replace(/\s+/g, " ");

/**
 * Normalize timestamps to ISO strings with current time fallback.
 */
export const normalizeContinuityTimestamp = (value?: string, fallbackNow?: string): string => {
  const candidate = typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallbackNow || new Date().toISOString();

  const parsed = Date.parse(candidate);
  if (Number.isNaN(parsed)) {
    return fallbackNow && !Number.isNaN(Date.parse(fallbackNow))
      ? new Date(Date.parse(fallbackNow)).toISOString()
      : new Date().toISOString();
  }

  return new Date(parsed).toISOString();
};

/**
 * Append compact source refs to content using the existing text contract.
 */
export const buildContinuityContentWithSourceRefs = (input: {
  content: string;
  sourceRefs?: string[];
}): string => {
  const normalizedContent = normalizeContinuityContent(input.content);
  if (normalizedContent.length === 0) {
    return "";
  }

  const sourceRefs = input.sourceRefs || [];
  if (sourceRefs.length === 0 || /source_refs\s*:/i.test(normalizedContent)) {
    return normalizedContent;
  }

  return `${normalizedContent} (source_refs: ${sourceRefs.join(", ")})`;
};

/**
 * Build a text result whose diagnostics are directly usable as Pi tool details.
 */
const buildToolTextResult = (input: {
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
 * Record continuity write telemetry without making telemetry failure user-facing.
 */
const recordWriteTelemetry = async (input: {
  telemetry?: TelemetryPort;
  request: ContinuityWriteRequest;
  eventType: "continuity_write_stored" | "continuity_write_skipped_duplicate" | "continuity_write_skipped_low_signal";
  section: ContinuityWriteRequest["section"];
  payloadJson?: string;
}): Promise<void> => {
  if (!input.telemetry) return;

  try {
    await input.telemetry.record({
      context: input.request.context,
      eventType: input.eventType,
      valueText: input.section,
      payloadJson: input.payloadJson,
    });
  } catch {
    // Telemetry must never change user-visible continuity write semantics.
  }
};

/**
 * Convert adapter persistence failure into the public continuity_write result.
 */
const buildPersistenceFailureResult = (result: CoreContinuityDataPersistResult): CoreTextResult => {
  const warning = result.warnings[0] || "unknown error";
  return buildToolTextResult({
    status: "error",
    text: `continuity_write failed: ${warning}`,
    details: {
      status: "error",
      reason: "continuity-write-failed",
      fingerprint: result.fingerprint,
    },
    warnings: result.warnings,
  });
};

/**
 * Build continuity write orchestration around one data adapter.
 */
export const createContinuityWriteService = (
  dependencies: ContinuityWriteServiceDependencies,
): {
  write: (input: ContinuityWriteRequest) => Promise<CoreTextResult>;
} => ({
  write: async (input: ContinuityWriteRequest): Promise<CoreTextResult> => {
    const section = normalizeContinuitySection(String(input.section));
    if (!section) {
      return buildToolTextResult({
        status: "error",
        text: `continuity_write failed: invalid section '${input.section}'. Use one of: ${CONTINUITY_SECTION_VALUES.join(", ")}.`,
        details: { status: "error", reason: "invalid-section" },
      });
    }

    const provenance = normalizeContinuityProvenance(String(input.provenance));
    if (!provenance) {
      return buildToolTextResult({
        status: "error",
        text: `continuity_write failed: invalid provenance '${input.provenance}'. Use one of: ${CONTINUITY_PROVENANCE_VALUES.join(", ")}.`,
        details: { status: "error", reason: "invalid-provenance" },
      });
    }

    const certainty = normalizeContinuityCertainty(input.certainty);
    if (!certainty) {
      return buildToolTextResult({
        status: "error",
        text: `continuity_write failed: invalid certainty '${input.certainty}'. Use one of: ${CONTINUITY_CERTAINTY_VALUES.join(", ")}.`,
        details: { status: "error", reason: "invalid-certainty" },
      });
    }

    const timestamp = normalizeContinuityTimestamp(input.timestamp, input.context.now);
    const content = buildContinuityContentWithSourceRefs({
      content: input.content || "",
      sourceRefs: input.sourceRefs,
    });

    if (!content) {
      return buildToolTextResult({
        status: "error",
        text: "continuity_write failed: content is required.",
        details: { status: "error", reason: "invalid-content" },
      });
    }

    const persistence = await dependencies.continuityData.persistWrite({
      ...input,
      section,
      provenance,
      certainty,
      timestamp,
      content,
      sourceRefs: input.sourceRefs || [],
    });

    if (persistence.status === "error") {
      return buildPersistenceFailureResult(persistence);
    }

    if (persistence.outcome === "skipped") {
      const reason = persistence.skipReason === "duplicate"
        ? "duplicate-continuity-entry"
        : "low-signal-continuity-entry";

      await recordWriteTelemetry({
        telemetry: dependencies.telemetry,
        request: input,
        eventType: persistence.skipReason === "duplicate"
          ? "continuity_write_skipped_duplicate"
          : "continuity_write_skipped_low_signal",
        section,
        payloadJson: JSON.stringify({
          reason,
          duplicateTimestamp: persistence.duplicateTimestamp || null,
          qualityReason: persistence.qualityReason || null,
        }),
      });

      return buildToolTextResult({
        status: "ok",
        text: persistence.skipReason === "duplicate"
          ? `continuity_write skipped duplicate entry (existing timestamp=${persistence.duplicateTimestamp || "unknown"}).`
          : "continuity_write skipped low-signal semantic entry; provide decision/discovery intent instead of operational report logs.",
        details: {
          status: "skipped",
          reason,
          fingerprint: persistence.fingerprint,
          duplicateTimestamp: persistence.duplicateTimestamp || null,
          qualityReason: persistence.qualityReason || null,
          section,
          timestamp: persistence.timestamp,
        },
      });
    }

    await recordWriteTelemetry({
      telemetry: dependencies.telemetry,
      request: input,
      eventType: "continuity_write_stored",
      section,
    });

    return buildToolTextResult({
      status: "ok",
      text: "continuity_write stored entry in canonical continuity sidecar DB.",
      details: {
        status: "stored",
        fingerprint: persistence.fingerprint,
        section,
        timestamp: persistence.timestamp,
      },
    });
  },
});
