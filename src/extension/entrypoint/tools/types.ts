/**
 * File intent: define shared contracts for extracted tool registration modules.
 *
 * Slice 3 keeps tool behavior stable by passing existing entrypoint callbacks and
 * constants into focused tool registrars. The dependency bundle is intentionally
 * permissive during extraction so behavior can move first; later slices should
 * narrow each tool module to domain-specific dependency interfaces.
 */

/**
 * Text tool result shape returned by extension tools.
 */
import type { ContinuitySection } from "../../../../packages/memory-core/src/continuity/continuity-codebook.js";

export interface ExtensionTextToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown> | null;
}

/**
 * Shared dependency bag for behavior-preserving tool extraction.
 */
export interface ExtensionToolDependencies {
  pi: any;
  CONTINUITY_SECTION_VALUES: ContinuitySection[];
  searchProjectMemoryByMode: (...args: any[]) => Promise<{ results: any[]; [key: string]: any }>;
  hydrateCrossUserContinuityEntry: (hit: any) => any;
  readCrossUserContinuityMilestones: (...args: any[]) => Promise<any[]>;
  readContinuityEntriesByIds: (...args: any[]) => any[];
  readContinuityActiveCounts: (...args: any[]) => {
    status: "ok" | "no-db" | "error";
    activeEntryCount: number;
    sectionCounts: Record<ContinuitySection, number>;
    [key: string]: any;
  };
  readContinuityEntries: (...args: any[]) => any[];
  normalizeContinuityCompactionSourceEntryIds: (values: string[]) => string[];
  rankContinuityCompactionProbeEntries: (...args: any[]) => any[];
  [dependencyName: string]: any;
}
