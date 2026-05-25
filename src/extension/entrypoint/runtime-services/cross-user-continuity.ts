/**
 * File intent: hydrate continuity rows/milestones discovered through project index hits.
 *
 * This is the bridge between L2 project-index records and canonical continuity
 * rows in member-owned project databases.
 */

import path from "node:path";

import type {
  ContinuityEntryLifecycleRecord,
  ContinuityMilestoneRecord,
} from "../../../../packages/memory-core/src/adapters/sqlite/continuity/index.js";
import { readContinuityEntriesByIds, readContinuityMilestones } from "../../../../packages/memory-core/src/adapters/sqlite/continuity/index.js";
import type { ContinuityProvenance, ContinuitySection } from "../../../../packages/memory-core/src/continuity/continuity-codebook.js";
import { discoverProjectUserDatabases } from "../../../../packages/memory-core/src/adapters/sqlite/project-index/index.js";
import { normalizeContinuityContent, normalizeContinuitySection, normalizeContinuityProvenance } from "./continuity-normalization.js";

export interface CrossUserContinuityEntryResult extends ContinuityEntryLifecycleRecord {
  userId: string;
  databasePath: string;
  sourceEntryId: string;
  l2Id: string;
}

export interface CrossUserContinuityMilestoneResult extends ContinuityMilestoneRecord {
  userId: string;
  databasePath: string;
  sourceMilestoneId: string;
}

/**
 * Decode continuity section from the L2 topic label (`continuity/<section>`).
 */
export const readContinuitySectionFromL2Topic = (topic: string): ContinuitySection | null => {
  const sectionLabel = topic.replace(/^continuity\//i, "");
  return normalizeContinuitySection(sectionLabel);
};

/**
 * Decode continuity provenance from the L2 source label (`continuity::<provenance>`).
 */
export const readContinuityProvenanceFromL2Source = (source: string): ContinuityProvenance | null => {
  const provenanceLabel = source.replace(/^continuity::/i, "");
  return normalizeContinuityProvenance(provenanceLabel);
};

/**
 * Remove the L2 continuity prefix so the source DB can be inspected by id.
 */
export const readContinuitySourceEntryIdFromL2Id = (id: string): string =>
  id.startsWith("cont:") ? id.slice("cont:".length) : id;

/**
 * Resolve exact lifecycle metadata for one L2-selected continuity hit.
 */
export const hydrateCrossUserContinuityEntry = (hit: {
  id: string;
  userId: string;
  databasePath: string;
  topic: string;
  source: string;
  timestamp: string;
  content: string;
}): CrossUserContinuityEntryResult => {
  const sourceEntryId = readContinuitySourceEntryIdFromL2Id(hit.id);
  const exactRow = readContinuityEntriesByIds({
    databasePath: hit.databasePath,
    entryIds: [sourceEntryId],
  })[0];

  if (exactRow) {
    return {
      ...exactRow,
      userId: hit.userId,
      databasePath: hit.databasePath,
      sourceEntryId,
      l2Id: hit.id,
    };
  }

  return {
    id: sourceEntryId,
    sourceEntryId,
    l2Id: hit.id,
    userId: hit.userId,
    databasePath: hit.databasePath,
    timestamp: hit.timestamp,
    section: readContinuitySectionFromL2Topic(hit.topic) || "PROGRESS",
    provenance: readContinuityProvenanceFromL2Source(hit.source) || "CODE",
    certainty: "UNCONFIRMED",
    content: hit.content,
    supersededByEntryId: null,
    compactedIntoEntryId: null,
  };
};

/**
 * Read cross-user continuity milestones directly from user DBs as read-only evidence.
 */
export const readCrossUserContinuityMilestones = async (input: {
  projectMemoryDir: string;
  query: string;
  section: ContinuitySection | null;
  fromTimestamp: string | null;
  toTimestamp: string | null;
  limit: number;
}): Promise<CrossUserContinuityMilestoneResult[]> => {
  const databasePaths = await discoverProjectUserDatabases(input.projectMemoryDir);
  const query = input.query.toLowerCase();
  const withinRange = (timestamp: string): boolean => {
    if (input.fromTimestamp && timestamp < input.fromTimestamp) {
      return false;
    }

    if (input.toTimestamp && timestamp > input.toTimestamp) {
      return false;
    }

    return true;
  };

  const milestones: CrossUserContinuityMilestoneResult[] = [];

  for (const databasePath of databasePaths) {
    const userId = path.basename(databasePath, ".db");
    const rows = readContinuityMilestones({ databasePath, limit: 500 })
      .filter((row) => !input.section || row.section === input.section)
      .filter((row) => withinRange(row.timestamp))
      .filter((row) => query.length === 0 || normalizeContinuityContent(row.summary).toLowerCase().includes(query));

    for (const row of rows) {
      milestones.push({
        ...row,
        userId,
        databasePath,
        sourceMilestoneId: row.id,
      });
    }
  }

  return milestones
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, input.limit);
};
