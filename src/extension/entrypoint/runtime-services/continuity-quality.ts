/**
 * File intent: decode continuity-write signals and enforce continuity write quality gates.
 *
 * The runtime uses these helpers for both explicit continuity tools and automatic
 * mutation journaling while keeping persistence semantics unchanged.
 */

import type { ContinuityCertainty, ContinuityProvenance, ContinuitySection } from "../../../../packages/memory-core/src/continuity/continuity-codebook.js";
import { isLowSignalSemanticOperationalTelemetryEntry } from "../../../../packages/memory-core/src/continuity/continuity-quality-gate.js";
import { readContinuityEntries } from "../../../../packages/memory-core/src/adapters/sqlite/continuity/index.js";
import {
  CONTINUITY_DEDUP_LOOKBACK_LIMIT,
  CONTINUITY_DUPLICATE_WINDOW_MS,
} from "./constants.js";
import {
  normalizeContinuityContent,
  normalizeContinuityProvenance,
  normalizeContinuitySection,
  normalizeContinuitySourceRefs,
  normalizeContinuityTimestamp,
  readObjectStringArrayField,
  readObjectStringField,
} from "./continuity-normalization.js";

/**
 * Decode the semantic shape of one continuity_write tool call.
 */
export const decodeContinuityWriteSignalFromToolInput = (input: {
  ctx: any;
  toolInput: unknown;
}): {
  section: ContinuitySection;
  provenance: ContinuityProvenance;
  sourceRefs: string[];
} | null => {
  const sectionRaw = readObjectStringField(input.toolInput, "section");
  const provenanceRaw = readObjectStringField(input.toolInput, "provenance");

  if (!sectionRaw || !provenanceRaw) {
    return null;
  }

  const section = normalizeContinuitySection(sectionRaw);
  const provenance = normalizeContinuityProvenance(provenanceRaw);

  if (!section || !provenance) {
    return null;
  }

  const sourceRefs = normalizeContinuitySourceRefs({
    ctx: input.ctx,
    sourceRefs: readObjectStringArrayField(input.toolInput, "source_refs"),
  });

  return {
    section,
    provenance,
    sourceRefs,
  };
};

/**
 * Build compact automatic continuity text from a mutating tool result.
 */
export const buildAutomaticContinuityContentFromToolResult = (input: {
  toolName: string;
  toolInput: unknown;
}): string | null => {
  if (input.toolName === "write") {
    const filePath = readObjectStringField(input.toolInput, "path");
    if (!filePath) {
      return null;
    }

    return `Workspace file write executed: ${filePath}.`;
  }

  if (input.toolName === "edit") {
    const filePath = readObjectStringField(input.toolInput, "path");
    if (!filePath) {
      return null;
    }

    const maybeEdits = typeof input.toolInput === "object" && input.toolInput !== null
      ? (input.toolInput as Record<string, unknown>).edits
      : null;

    const replacementCount = Array.isArray(maybeEdits)
      ? maybeEdits.length
      : 0;

    const replacementSuffix = replacementCount > 0
      ? ` replacements=${replacementCount}.`
      : "";

    return `Workspace file edit executed: ${filePath}.${replacementSuffix}`.trimEnd();
  }

  return null;
};

/**
 * Build a stable content fingerprint for continuity write telemetry.
 */
export const buildContinuityEntryFingerprint = (input: {
  timestamp: string;
  section: ContinuitySection;
  provenance: ContinuityProvenance;
  certainty: ContinuityCertainty;
  content: string;
}): string => [
  input.timestamp,
  input.section,
  input.provenance,
  input.certainty,
  input.content,
].join("");

/**
 * Build strict identity key including timestamp for exact continuity duplicates.
 */
export const buildContinuityEntryIdentityKey = (input: {
  timestamp: string;
  section: ContinuitySection;
  provenance: ContinuityProvenance;
  certainty: ContinuityCertainty;
  content: string;
}): string => [
  normalizeContinuityTimestamp(input.timestamp),
  input.section,
  input.provenance,
  input.certainty,
  normalizeContinuityContent(input.content),
].join("\u001F");

/**
 * Build semantic identity key without timestamp for near-term duplicate checks.
 */
export const buildContinuitySemanticIdentityKey = (input: {
  section: ContinuitySection;
  provenance: ContinuityProvenance;
  certainty: ContinuityCertainty;
  content: string;
}): string => [
  input.section,
  input.provenance,
  input.certainty,
  normalizeContinuityContent(input.content).toLowerCase(),
].join("\u001F");

/**
 * Find a recent semantic duplicate in active continuity rows.
 */
export const findRecentContinuitySemanticDuplicate = (input: {
  databasePath: string;
  timestamp: string;
  section: ContinuitySection;
  provenance: ContinuityProvenance;
  certainty: ContinuityCertainty;
  content: string;
}): { id: string; timestamp: string } | null => {
  const targetKey = buildContinuitySemanticIdentityKey({
    section: input.section,
    provenance: input.provenance,
    certainty: input.certainty,
    content: input.content,
  });
  const inputEpoch = Date.parse(input.timestamp);

  const candidates = readContinuityEntries({
    databasePath: input.databasePath,
    limit: CONTINUITY_DEDUP_LOOKBACK_LIMIT,
  });

  for (const candidate of candidates) {
    const candidateKey = buildContinuitySemanticIdentityKey({
      section: candidate.section,
      provenance: candidate.provenance,
      certainty: candidate.certainty,
      content: candidate.content,
    });

    if (candidateKey !== targetKey) {
      continue;
    }

    const candidateEpoch = Date.parse(candidate.timestamp);
    if (Number.isNaN(inputEpoch) || Number.isNaN(candidateEpoch)) {
      return {
        id: candidate.id,
        timestamp: candidate.timestamp,
      };
    }

    if (Math.abs(inputEpoch - candidateEpoch) <= CONTINUITY_DUPLICATE_WINDOW_MS) {
      return {
        id: candidate.id,
        timestamp: candidate.timestamp,
      };
    }
  }

  return null;
};

/**
 * Evaluate whether a continuity write should store, skip duplicate, or skip low-signal.
 */
export const evaluateContinuityWriteQualityGate = (input: {
  databasePath: string;
  timestamp: string;
  section: ContinuitySection;
  provenance: ContinuityProvenance;
  certainty: ContinuityCertainty;
  content: string;
}):
  | { status: "ok" }
  | { status: "skip-duplicate"; duplicate: { id: string; timestamp: string } | null }
  | { status: "skip-low-signal"; reason: string } => {
  if (isLowSignalSemanticOperationalTelemetryEntry({
    section: input.section,
    provenance: input.provenance,
    content: input.content,
  })) {
    return {
      status: "skip-low-signal",
      reason: "semantic-user-report-operational-telemetry",
    };
  }

  const duplicate = findRecentContinuitySemanticDuplicate(input);
  if (duplicate) {
    return {
      status: "skip-duplicate",
      duplicate,
    };
  }

  return {
    status: "ok",
  };
};
