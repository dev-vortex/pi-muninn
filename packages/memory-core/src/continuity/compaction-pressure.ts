/**
 * File intent: evaluate continuity compaction pressure from active-row counts.
 *
 * This domain helper is shared by briefing, status, and compaction surfaces so
 * pressure thresholds remain consistent outside the extension entrypoint glue.
 */

import type { ContinuitySection } from "./continuity-codebook.js";

const CONTINUITY_SECTION_VALUES: ContinuitySection[] = [
  "PLANS",
  "DECISIONS",
  "PROGRESS",
  "DISCOVERIES",
  "OUTCOMES",
];
const MEDIUM_ACTIVE_ENTRY_PRESSURE = 160;
const HIGH_ACTIVE_ENTRY_PRESSURE = 220;
const MEDIUM_SECTION_ENTRY_PRESSURE = 45;
const HIGH_SECTION_ENTRY_PRESSURE = 65;

/**
 * Result of continuity compaction pressure assessment.
 */
export interface ContinuityCompactionPressureAssessment {
  /** Human-readable pressure level. */
  level: "low" | "medium" | "high";
  /** Whether operators should consider compaction now. */
  recommended: boolean;
  /** Machine-readable pressure reasons. */
  reasons: string[];
  /** Active entry count used for assessment. */
  activeEntryCount: number;
  /** Pending approved preview count used for assessment. */
  pendingPreviewCount: number;
  /** Sections above the medium per-section threshold. */
  mediumPressureSections: ContinuitySection[];
  /** Sections above the high per-section threshold. */
  highPressureSections: ContinuitySection[];
}

/**
 * Assess compaction pressure for active continuity rows.
 */
export const assessContinuityCompactionPressure = (input: {
  activeEntryCount: number;
  sectionCounts: Record<ContinuitySection, number>;
  pendingPreviewCount: number;
}): ContinuityCompactionPressureAssessment => {
  const highPressureSections = CONTINUITY_SECTION_VALUES
    .filter((section) => input.sectionCounts[section] >= HIGH_SECTION_ENTRY_PRESSURE);

  const mediumPressureSections = CONTINUITY_SECTION_VALUES
    .filter((section) => input.sectionCounts[section] >= MEDIUM_SECTION_ENTRY_PRESSURE)
    .filter((section) => !highPressureSections.includes(section));

  const reasons: string[] = [];
  let level: "low" | "medium" | "high" = "low";

  if (input.activeEntryCount >= HIGH_ACTIVE_ENTRY_PRESSURE) {
    level = "high";
    reasons.push("pressure.active_entries.high");
  } else if (input.activeEntryCount >= MEDIUM_ACTIVE_ENTRY_PRESSURE) {
    level = "medium";
    reasons.push("pressure.active_entries.medium");
  }

  if (highPressureSections.length > 0) {
    level = "high";
    reasons.push("pressure.section_counts.high");
  } else if (mediumPressureSections.length > 0 && level === "low") {
    level = "medium";
    reasons.push("pressure.section_counts.medium");
  }

  if (input.pendingPreviewCount > 0) {
    // Pending operator-approved previews mean pressure exists even when row counts are low.
    if (level === "low") {
      level = "medium";
    }

    reasons.push("pressure.preview_pending");
  }

  const recommended = level !== "low" || input.pendingPreviewCount > 0;

  return {
    level,
    recommended,
    reasons: Array.from(new Set(reasons)),
    activeEntryCount: input.activeEntryCount,
    pendingPreviewCount: input.pendingPreviewCount,
    mediumPressureSections,
    highPressureSections,
  };
};
