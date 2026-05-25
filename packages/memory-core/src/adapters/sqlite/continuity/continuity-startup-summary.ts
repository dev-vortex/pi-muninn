/**
 * File intent: build bounded, human-readable continuity summaries for runtime prompts.
 *
 * This file reads canonical continuity entries/milestones and turns them into a
 * compact startup/briefing block with deterministic priority, clipping, and
 * truncation metadata. Update this when changing how continuity context is
 * summarized before an agent starts or before a turn is answered.
 */

import type { ContinuitySection } from "../../../continuity/continuity-codebook.js";
import {
  readContinuityEntries,
  readContinuityMilestones,
  type ContinuityEntryRecord,
  type ContinuityMilestoneRecord,
} from "./continuity-store.js";

/**
 * Input for building bounded continuity startup summary text.
 */
export interface BuildContinuityStartupSummaryInput {
  databasePath: string;
  maxCharacters?: number;
  maxEntries?: number;
  maxMilestones?: number;
  sectionPriority?: ContinuitySection[];
}

/**
 * Result envelope for continuity startup summary generation.
 */
export interface ContinuityStartupSummaryResult {
  available: boolean;
  text: string;
  includedEntryCount: number;
  includedMilestoneCount: number;
  truncated: boolean;
  maxCharacters: number;
}

const DEFAULT_MAX_CHARACTERS = 1_000;
const DEFAULT_MAX_ENTRIES = 8;
const DEFAULT_MAX_MILESTONES = 3;
const DEFAULT_ENTRY_MAX_LENGTH = 220;
const DEFAULT_MILESTONE_MAX_LENGTH = 260;
const DEFAULT_SECTION_PRIORITY: ContinuitySection[] = [
  "DECISIONS",
  "PLANS",
  "OUTCOMES",
  "PROGRESS",
  "DISCOVERIES",
];

/**
 * Normalize free text into compact single-line summary chunks.
 */
const normalizeSummaryChunk = (input: {
  text: string;
  maxLength: number;
}): string => {
  const normalized = input.text.trim().replace(/\s+/g, " ");

  if (normalized.length <= input.maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(1, input.maxLength - 1)).trimEnd()}…`;
};

/**
 * Build deterministic section priority map for stable sorting.
 */
const createSectionPriorityMap = (priority: ContinuitySection[]): Map<ContinuitySection, number> => {
  const map = new Map<ContinuitySection, number>();

  priority.forEach((section, index) => {
    if (!map.has(section)) {
      map.set(section, index);
    }
  });

  DEFAULT_SECTION_PRIORITY.forEach((section) => {
    if (!map.has(section)) {
      map.set(section, map.size);
    }
  });

  return map;
};

/**
 * Sort continuity entries by configured section priority, then recency.
 */
const sortEntriesByPriorityAndRecency = (input: {
  entries: ContinuityEntryRecord[];
  sectionPriority: ContinuitySection[];
}): ContinuityEntryRecord[] => {
  const priorityBySection = createSectionPriorityMap(input.sectionPriority);

  return [...input.entries].sort((a, b) => {
    const sectionPriorityDelta =
      (priorityBySection.get(a.section) ?? Number.MAX_SAFE_INTEGER)
      - (priorityBySection.get(b.section) ?? Number.MAX_SAFE_INTEGER);

    if (sectionPriorityDelta !== 0) {
      return sectionPriorityDelta;
    }

    return b.timestamp.localeCompare(a.timestamp);
  });
};

/**
 * Append line while respecting global character budget.
 */
const appendBoundedLine = (input: {
  lines: string[];
  line: string;
  maxCharacters: number;
}): boolean => {
  const prefixLength = input.lines.length === 0 ? 0 : 1;
  const nextLength = input.line.length + prefixLength;
  const currentLength = input.lines.join("\n").length;

  if (currentLength + nextLength > input.maxCharacters) {
    return false;
  }

  input.lines.push(input.line);
  return true;
};

/**
 * Append a set of lines if any item is available.
 */
const appendSection = (input: {
  lines: string[];
  header: string;
  items: string[];
  maxCharacters: number;
}): {
  appendedItemCount: number;
  truncated: boolean;
} => {
  if (input.items.length === 0) {
    return {
      appendedItemCount: 0,
      truncated: false,
    };
  }

  if (!appendBoundedLine({ lines: input.lines, line: input.header, maxCharacters: input.maxCharacters })) {
    return {
      appendedItemCount: 0,
      truncated: true,
    };
  }

  let appendedItemCount = 0;

  for (const item of input.items) {
    const bulletLine = `- ${item}`;

    const ok = appendBoundedLine({
      lines: input.lines,
      line: bulletLine,
      maxCharacters: input.maxCharacters,
    });

    if (!ok) {
      // Keep at least one representative bullet when the section itself fits,
      // otherwise tiny max-character budgets can produce headers-only summaries.
      const currentLength = input.lines.join("\n").length;
      const newlineLength = input.lines.length === 0 ? 0 : 1;
      const remainingCharacters = input.maxCharacters - currentLength - newlineLength;

      if (remainingCharacters >= 4) {
        const clipped = bulletLine.length <= remainingCharacters
          ? bulletLine
          : `${bulletLine.slice(0, Math.max(1, remainingCharacters - 1)).trimEnd()}…`;

        if (appendBoundedLine({ lines: input.lines, line: clipped, maxCharacters: input.maxCharacters })) {
          appendedItemCount += 1;
        }
      }

      return {
        appendedItemCount,
        truncated: true,
      };
    }

    appendedItemCount += 1;
  }

  return {
    appendedItemCount,
    truncated: false,
  };
};

/**
 * Build bounded continuity startup summary from persisted continuity tables.
 *
 * Decision:
 * - keep summary deterministic and bounded for startup/runtime safety,
 * - prioritize higher-signal sections before lower-signal discovery chatter.
 */
export const buildContinuityStartupSummary = (
  input: BuildContinuityStartupSummaryInput,
): ContinuityStartupSummaryResult => {
  const maxCharacters = Math.max(120, Math.min(input.maxCharacters ?? DEFAULT_MAX_CHARACTERS, 5_000));
  const maxEntries = Math.max(1, Math.min(input.maxEntries ?? DEFAULT_MAX_ENTRIES, 50));
  const maxMilestones = Math.max(0, Math.min(input.maxMilestones ?? DEFAULT_MAX_MILESTONES, 20));
  const sectionPriority = input.sectionPriority ?? DEFAULT_SECTION_PRIORITY;

  const milestones = readContinuityMilestones({
    databasePath: input.databasePath,
    limit: maxMilestones,
  });

  const entries = sortEntriesByPriorityAndRecency({
    entries: readContinuityEntries({
      databasePath: input.databasePath,
      limit: Math.max(maxEntries * 3, maxEntries),
    }),
    sectionPriority,
  }).slice(0, maxEntries);

  if (milestones.length === 0 && entries.length === 0) {
    return {
      available: false,
      text: "",
      includedEntryCount: 0,
      includedMilestoneCount: 0,
      truncated: false,
      maxCharacters,
    };
  }

  const milestoneLines = milestones.map((milestone: ContinuityMilestoneRecord) => {
    const summary = normalizeSummaryChunk({
      text: milestone.summary,
      maxLength: DEFAULT_MILESTONE_MAX_LENGTH,
    });

    return `[${milestone.section}/${milestone.provenance}/${milestone.certainty}] ${summary}`;
  });

  const entryLines = entries.map((entry: ContinuityEntryRecord) => {
    const content = normalizeSummaryChunk({
      text: entry.content,
      maxLength: DEFAULT_ENTRY_MAX_LENGTH,
    });

    return `[${entry.section}/${entry.provenance}/${entry.certainty}] ${content}`;
  });

  const lines: string[] = [];

  let includedMilestoneCount = 0;
  let includedEntryCount = 0;

  const milestoneAppend = appendSection({
    lines,
    header: "Milestones:",
    items: milestoneLines,
    maxCharacters,
  });
  includedMilestoneCount += milestoneAppend.appendedItemCount;

  const entryAppend = appendSection({
    lines,
    header: "Recent continuity entries:",
    items: entryLines,
    maxCharacters,
  });
  includedEntryCount += entryAppend.appendedItemCount;

  const truncated = milestoneAppend.truncated || entryAppend.truncated;

  if (truncated) {
    appendBoundedLine({
      lines,
      line: "[continuity summary truncated]",
      maxCharacters,
    });
  }

  return {
    available: true,
    text: lines.join("\n"),
    includedEntryCount,
    includedMilestoneCount,
    truncated,
    maxCharacters,
  };
};
