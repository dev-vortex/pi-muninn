/**
 * File intent: normalize continuity command/tool inputs before persistence or validation.
 *
 * These helpers preserve the entrypoint's permissive label/timestamp parsing and
 * compact source-reference handling while moving the logic out of package index.
 */

import path from "node:path";

import type {
  ContinuityCertainty,
  ContinuityProvenance,
  ContinuitySection,
} from "../../../../packages/memory-core/src/continuity/continuity-codebook.js";
import {
  CONTINUITY_CERTAINTY_SET,
  CONTINUITY_COMPACTION_SECTION_HINT_VALUES,
  CONTINUITY_PROVENANCE_SET,
  CONTINUITY_SECTION_SET,
  CONTINUITY_SOURCE_REF_LIMIT,
  type ContinuityCompactionSectionHint,
} from "./constants.js";
import { normalizeContinuityTrackedPath } from "./continuity-evidence.js";

/**
 * Normalize enum-like continuity labels.
 *
 * Accepts both plain and bracketed labels (e.g., "PLANS" or "[PLANS]").
 */
export const normalizeContinuityEnumLabel = (value: string): string =>
  value.trim().replace(/^\[+/, "").replace(/\]+$/, "").trim().toUpperCase();

/**
 * Normalize continuity section, accepting bracketed inputs.
 */
export const normalizeContinuitySection = (value: string): ContinuitySection | null => {
  const normalized = normalizeContinuityEnumLabel(value);
  if (!CONTINUITY_SECTION_SET.has(normalized)) {
    return null;
  }

  return normalized as ContinuitySection;
};

/**
 * Normalize continuity provenance, accepting bracketed inputs.
 */
export const normalizeContinuityProvenance = (value: string): ContinuityProvenance | null => {
  const normalized = normalizeContinuityEnumLabel(value);
  if (!CONTINUITY_PROVENANCE_SET.has(normalized)) {
    return null;
  }

  return normalized as ContinuityProvenance;
};

/**
 * Normalize certainty, defaulting to confirmed when omitted.
 */
export const normalizeContinuityCertainty = (value?: string): ContinuityCertainty | null => {
  if (!value) {
    return "CONFIRMED";
  }

  const normalized = normalizeContinuityEnumLabel(value);
  if (!CONTINUITY_CERTAINTY_SET.has(normalized)) {
    return null;
  }

  return normalized as ContinuityCertainty;
};

/**
 * Normalize compaction section hints from LLM proposal payloads.
 */
export const normalizeContinuityCompactionSectionHint = (
  value: string | undefined,
): ContinuityCompactionSectionHint | null => {
  if (!value) {
    return null;
  }

  const normalized = normalizeContinuityEnumLabel(value);
  return CONTINUITY_COMPACTION_SECTION_HINT_VALUES.includes(normalized as ContinuityCompactionSectionHint)
    ? (normalized as ContinuityCompactionSectionHint)
    : null;
};

/**
 * Normalize content whitespace for continuity rows and diagnostics.
 */
export const normalizeContinuityContent = (content: string): string =>
  content.trim().replace(/\s+/g, " ");

/**
 * Normalize compaction source entry IDs with stable de-duplication.
 */
export const normalizeContinuityCompactionSourceEntryIds = (entryIds: string[]): string[] => {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const rawEntryId of entryIds) {
    const entryId = String(rawEntryId || "").trim();
    if (!entryId || seen.has(entryId)) {
      continue;
    }

    seen.add(entryId);
    normalized.push(entryId);
  }

  return normalized;
};

/**
 * Normalize timestamps to ISO strings with current time fallback.
 */
export const normalizeContinuityTimestamp = (value?: string): string => {
  const candidate = typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : new Date().toISOString();

  const parsed = Date.parse(candidate);
  if (Number.isNaN(parsed)) {
    return new Date().toISOString();
  }

  return new Date(parsed).toISOString();
};

/**
 * Add bounded hours to an ISO timestamp.
 */
export const addHoursToIsoTimestamp = (baseTimestamp: string, hours: number): string => {
  const baseEpoch = Date.parse(baseTimestamp);
  const safeBaseEpoch = Number.isNaN(baseEpoch)
    ? Date.now()
    : baseEpoch;
  const safeHours = Math.max(0, Math.floor(hours));
  return new Date(safeBaseEpoch + safeHours * 60 * 60 * 1000).toISOString();
};

/**
 * Add bounded days to an ISO timestamp.
 */
export const addDaysToIsoTimestamp = (baseTimestamp: string, days: number): string => {
  const baseEpoch = Date.parse(baseTimestamp);
  const safeBaseEpoch = Number.isNaN(baseEpoch)
    ? Date.now()
    : baseEpoch;
  const safeDays = Math.max(0, Math.floor(days));
  return new Date(safeBaseEpoch + safeDays * 24 * 60 * 60 * 1000).toISOString();
};

/**
 * Read a string field from arbitrary object-like input.
 */
export const readObjectStringField = (input: unknown, field: string): string | null => {
  if (typeof input !== "object" || input === null) {
    return null;
  }

  const value = (input as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
};

/**
 * Read a number field from arbitrary object-like input.
 */
export const readObjectNumberField = (input: unknown, field: string): number | null => {
  if (typeof input !== "object" || input === null) {
    return null;
  }

  const value = (input as Record<string, unknown>)[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

/**
 * Read a boolean field from arbitrary object-like input.
 */
export const readObjectBooleanField = (input: unknown, field: string): boolean | null => {
  if (typeof input !== "object" || input === null) {
    return null;
  }

  const value = (input as Record<string, unknown>)[field];
  return typeof value === "boolean" ? value : null;
};

/**
 * Read a string-array field from arbitrary object-like input.
 */
export const readObjectStringArrayField = (input: unknown, field: string): string[] => {
  if (typeof input !== "object" || input === null) {
    return [];
  }

  const value = (input as Record<string, unknown>)[field];
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
};

/**
 * Normalize source refs from explicit arrays plus structured metadata.
 */
export const normalizeContinuitySourceRefs = (input: {
  ctx: any;
  sourceRefs: unknown;
}): string[] => {
  if (!Array.isArray(input.sourceRefs)) {
    return [];
  }

  const values = input.sourceRefs
    .filter((candidate): candidate is string => typeof candidate === "string")
    .map((candidate) => candidate.trim().replace(/\s+/g, " "))
    .filter((candidate) => candidate.length > 0);

  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const looksLikePath = value.includes("/") || value.includes("\\") || value.startsWith(".") || path.isAbsolute(value);

    const normalizedValue = looksLikePath
      ? normalizeContinuityTrackedPath({ ctx: input.ctx, rawPath: value })
      : value;

    const key = normalizedValue.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push(normalizedValue);

    if (normalized.length >= CONTINUITY_SOURCE_REF_LIMIT) {
      break;
    }
  }

  return normalized.sort((left, right) => left.localeCompare(right));
};

/**
 * Append compact source refs to content using the existing text contract.
 */
export const buildContinuityContentWithSourceRefs = (input: {
  content: string;
  sourceRefs: string[];
}): string => {
  const normalizedContent = normalizeContinuityContent(input.content);
  if (normalizedContent.length === 0) {
    return "";
  }

  if (input.sourceRefs.length === 0 || /source_refs\s*:/i.test(normalizedContent)) {
    return normalizedContent;
  }

  return `${normalizedContent} (source_refs: ${input.sourceRefs.join(", ")})`;
};
