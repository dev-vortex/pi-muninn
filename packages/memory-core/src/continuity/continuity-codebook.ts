/**
 * File intent: define the continuity domain vocabulary and compact storage codes.
 *
 * This file holds the canonical section/provenance/certainty labels used in
 * human-facing continuity text, plus the small DB codes used by SQLite rows.
 * Extend this first when adding a new continuity metadata dimension or label,
 * because store, rendering, and validation code all depend on this contract.
 */

/**
 * Human-readable continuity sections.
 */
export type ContinuitySection =
  | "PLANS"
  | "DECISIONS"
  | "PROGRESS"
  | "DISCOVERIES"
  | "OUTCOMES";

/**
 * Compact DB code for continuity section.
 */
export type ContinuitySectionCode = "P" | "D" | "R" | "X" | "O";

/**
 * Human-readable provenance labels.
 */
export type ContinuityProvenance = "USER" | "CODE" | "TOOL" | "ASSUMPTION";

/**
 * Compact DB code for provenance.
 */
export type ContinuityProvenanceCode = "U" | "C" | "T" | "A";

/**
 * Human-readable certainty labels.
 */
export type ContinuityCertainty = "CONFIRMED" | "UNCONFIRMED";

/**
 * Compact DB code for certainty.
 *
 * Decision:
 * - keep integer codes for lowest storage overhead and SQL friendliness.
 */
export type ContinuityCertaintyCode = 0 | 1;

/**
 * Full label bundle used in human-facing rendering.
 */
export interface ContinuityMetadataLabels {
  section: ContinuitySection;
  provenance: ContinuityProvenance;
  certainty: ContinuityCertainty;
}

/**
 * Compact code bundle used in canonical DB storage.
 */
export interface ContinuityMetadataCodes {
  sectionCode: ContinuitySectionCode;
  provenanceCode: ContinuityProvenanceCode;
  certaintyCode: ContinuityCertaintyCode;
}

/**
 * Static section label -> code map.
 */
const SECTION_CODEBOOK: Record<ContinuitySection, ContinuitySectionCode> = {
  PLANS: "P",
  DECISIONS: "D",
  PROGRESS: "R",
  DISCOVERIES: "X",
  OUTCOMES: "O",
};

/**
 * Static provenance label -> code map.
 */
const PROVENANCE_CODEBOOK: Record<ContinuityProvenance, ContinuityProvenanceCode> = {
  USER: "U",
  CODE: "C",
  TOOL: "T",
  ASSUMPTION: "A",
};

/**
 * Static certainty label -> code map.
 */
const CERTAINTY_CODEBOOK: Record<ContinuityCertainty, ContinuityCertaintyCode> = {
  CONFIRMED: 0,
  UNCONFIRMED: 1,
};

/**
 * Build reverse map for section code decoding.
 */
const SECTION_LABEL_BY_CODE: Record<ContinuitySectionCode, ContinuitySection> = {
  P: "PLANS",
  D: "DECISIONS",
  R: "PROGRESS",
  X: "DISCOVERIES",
  O: "OUTCOMES",
};

/**
 * Build reverse map for provenance code decoding.
 */
const PROVENANCE_LABEL_BY_CODE: Record<ContinuityProvenanceCode, ContinuityProvenance> = {
  U: "USER",
  C: "CODE",
  T: "TOOL",
  A: "ASSUMPTION",
};

/**
 * Build reverse map for certainty code decoding.
 */
const CERTAINTY_LABEL_BY_CODE: Record<ContinuityCertaintyCode, ContinuityCertainty> = {
  0: "CONFIRMED",
  1: "UNCONFIRMED",
};

/**
 * Encode one section label into compact code.
 */
export const encodeContinuitySection = (section: ContinuitySection): ContinuitySectionCode =>
  SECTION_CODEBOOK[section];

/**
 * Decode one section code into human-readable label.
 */
export const decodeContinuitySection = (code: string): ContinuitySection | null => {
  if (code === "P" || code === "D" || code === "R" || code === "X" || code === "O") {
    return SECTION_LABEL_BY_CODE[code];
  }

  return null;
};

/**
 * Encode one provenance label into compact code.
 */
export const encodeContinuityProvenance = (
  provenance: ContinuityProvenance,
): ContinuityProvenanceCode =>
  PROVENANCE_CODEBOOK[provenance];

/**
 * Decode one provenance code into human-readable label.
 */
export const decodeContinuityProvenance = (code: string): ContinuityProvenance | null => {
  if (code === "U" || code === "C" || code === "T" || code === "A") {
    return PROVENANCE_LABEL_BY_CODE[code];
  }

  return null;
};

/**
 * Encode certainty label into compact numeric code.
 */
export const encodeContinuityCertainty = (
  certainty: ContinuityCertainty,
): ContinuityCertaintyCode =>
  CERTAINTY_CODEBOOK[certainty];

/**
 * Normalize unknown certainty code input to supported compact codes.
 */
export const normalizeContinuityCertaintyCode = (
  code: unknown,
): ContinuityCertaintyCode | null => {
  if (code === 0 || code === "0") {
    return 0;
  }

  if (code === 1 || code === "1") {
    return 1;
  }

  return null;
};

/**
 * Decode one certainty code into human-readable label.
 */
export const decodeContinuityCertainty = (code: unknown): ContinuityCertainty | null => {
  const normalized = normalizeContinuityCertaintyCode(code);
  if (normalized === null) {
    return null;
  }

  return CERTAINTY_LABEL_BY_CODE[normalized];
};

/**
 * Encode full continuity metadata labels into compact DB codes.
 */
export const encodeContinuityMetadata = (
  labels: ContinuityMetadataLabels,
): ContinuityMetadataCodes => ({
  sectionCode: encodeContinuitySection(labels.section),
  provenanceCode: encodeContinuityProvenance(labels.provenance),
  certaintyCode: encodeContinuityCertainty(labels.certainty),
});

/**
 * Decode compact DB metadata into human-readable labels.
 */
export const decodeContinuityMetadata = (codes: {
  sectionCode: string;
  provenanceCode: string;
  certaintyCode: unknown;
}): ContinuityMetadataLabels | null => {
  const section = decodeContinuitySection(codes.sectionCode);
  const provenance = decodeContinuityProvenance(codes.provenanceCode);
  const certainty = decodeContinuityCertainty(codes.certaintyCode);

  if (!section || !provenance || !certainty) {
    return null;
  }

  return {
    section,
    provenance,
    certainty,
  };
};
