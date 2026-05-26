/**
 * File intent: define the SQLite data-adapter boundary for L2 project-index data.
 *
 * Core owns L2 retrieval policy. This root-provided adapter owns concrete
 * index/cache persistence and wraps the current project-index SQLite/fan-out
 * implementation behind memory-core data-adapter ports.
 */

import path from "node:path";

import type {
  ContinuityProvenance,
  ContinuitySection,
} from "../../../packages/memory-core/src/continuity/continuity-codebook.js";
import {
  readContinuityEntriesByIds,
  readContinuityMilestones,
} from "./continuity/continuity-store.js";
import {
  readProjectIndexStatus,
} from "./project-index/project-index.js";
import {
  searchProjectMemoryByMode,
  type ModeAwareProjectSearchResult,
} from "./project-memory/mode-selection.js";
import {
  buildMemorySemanticSignalKey,
} from "./project-memory/memory-briefing-utils.js";
import {
  createSqliteVecProjectSemanticMemorySearchProvider,
  type ProjectSemanticMemorySearchProvider,
} from "./project-memory/semantic-search-provider.js";
import type {
  CoreProjectIndexContinuityMilestoneHit,
  CoreProjectIndexHit,
  CoreProjectIndexSearchInput,
  CoreProjectIndexSearchResult,
  ProjectIndexDataAdapterPort,
  RuntimeStatusRequest,
  CoreTextResult,
} from "../../../packages/memory-core/src/index.js";

/**
 * Minimal backend surface used by the project-index data adapter.
 */
export interface SqliteProjectIndexBackend {
  /** Search the concrete project index/cache. */
  search(input: CoreProjectIndexSearchInput): Promise<CoreProjectIndexSearchResult>;
  /** Read concrete project index/cache status. */
  readStatus(input: RuntimeStatusRequest): Promise<CoreTextResult>;
}

/**
 * Runtime mode used by current project-memory L2 retrieval.
 */
export type SqliteProjectIndexRetrievalMode = "fanout" | "index-first";

/**
 * Decode continuity section from the L2 topic label (`continuity/<section>`).
 */
const readContinuitySectionFromTopic = (topic: string | undefined): ContinuitySection | null => {
  const label = (topic || "").replace(/^continuity\//i, "").toLowerCase();
  switch (label) {
    case "plans": return "PLANS";
    case "decisions": return "DECISIONS";
    case "progress": return "PROGRESS";
    case "discoveries": return "DISCOVERIES";
    case "outcomes": return "OUTCOMES";
    default: return null;
  }
};

/**
 * Decode continuity provenance from the L2 source label (`continuity::<provenance>`).
 */
const readContinuityProvenanceFromSource = (source: string | undefined): ContinuityProvenance | null => {
  const label = (source || "").replace(/^continuity::/i, "").toLowerCase();
  switch (label) {
    case "user": return "USER";
    case "code": return "CODE";
    case "tool": return "TOOL";
    case "assumption": return "ASSUMPTION";
    default: return null;
  }
};

/**
 * Remove the L2 continuity prefix so source DB rows can be hydrated by id.
 */
const readContinuitySourceEntryIdFromL2Id = (id: string): string =>
  id.startsWith("cont:") ? id.slice("cont:".length) : id;

/**
 * Return true when one optional timestamp falls inside the requested range.
 */
const isWithinTimestampRange = (input: {
  timestamp: string;
  from?: string;
  to?: string;
}): boolean => {
  if (input.from && input.timestamp < input.from) return false;
  if (input.to && input.timestamp > input.to) return false;
  return true;
};

/**
 * Return true when summary text matches a lexical query, if supplied.
 */
const matchesQuery = (input: {
  text: string;
  query: string;
}): boolean => {
  const query = input.query.trim().toLowerCase();
  if (!query) return true;
  return input.text.toLowerCase().includes(query);
};

/**
 * Normalize one fan-out/index hit into the core project-index DTO.
 */
const normalizeProjectIndexHit = (hit: ModeAwareProjectSearchResult["results"][number]): CoreProjectIndexHit => {
  if (hit.kind === "continuity") {
    const sourceId = readContinuitySourceEntryIdFromL2Id(hit.id);
    const exactRow = readContinuityEntriesByIds({
      databasePath: hit.databasePath,
      entryIds: [sourceId],
    })[0];

    if (exactRow) {
      return {
        id: hit.id,
        sourceId,
        kind: "continuity",
        userId: hit.userId,
        databasePath: hit.databasePath,
        content: exactRow.content,
        topic: hit.topic,
        source: hit.source,
        timestamp: exactRow.timestamp,
        section: exactRow.section,
        provenance: exactRow.provenance,
        certainty: exactRow.certainty,
        compactedIntoEntryId: exactRow.compactedIntoEntryId,
        supersededByEntryId: exactRow.supersededByEntryId,
        termMatches: hit.termMatches,
        metadata: {
          provider: "sqlite-project-index-data-adapter",
          subjectHintKey: hit.subjectHintKey,
          groupId: hit.groupId,
        },
      };
    }

    return {
      id: hit.id,
      sourceId,
      kind: "continuity",
      userId: hit.userId,
      databasePath: hit.databasePath,
      content: hit.content,
      topic: hit.topic,
      source: hit.source,
      timestamp: hit.timestamp,
      section: readContinuitySectionFromTopic(hit.topic) || "PROGRESS",
      provenance: readContinuityProvenanceFromSource(hit.source) || "CODE",
      certainty: "UNCONFIRMED",
      compactedIntoEntryId: null,
      supersededByEntryId: null,
      termMatches: hit.termMatches,
      metadata: {
        provider: "sqlite-project-index-data-adapter",
        subjectHintKey: hit.subjectHintKey,
        groupId: hit.groupId,
      },
    };
  }

  return {
    id: hit.id,
    sourceId: hit.id,
    kind: "memory",
    userId: hit.userId,
    databasePath: hit.databasePath,
    content: hit.content,
    topic: hit.topic,
    source: hit.source,
    timestamp: hit.timestamp,
    termMatches: hit.termMatches,
    semanticSimilarity: typeof (hit as unknown as { semanticSimilarity?: unknown }).semanticSimilarity === "number"
      ? (hit as unknown as { semanticSimilarity: number }).semanticSimilarity
      : undefined,
    metadata: {
      provider: "sqlite-project-index-data-adapter",
      subjectHintKey: hit.subjectHintKey,
      groupId: hit.groupId,
    },
  };
};

/**
 * Annotate already-selected project-memory hits with vector similarity when available.
 */
const annotateProjectMemorySemanticSignals = async (input: {
  query: string;
  hits: CoreProjectIndexHit[];
  provider?: ProjectSemanticMemorySearchProvider;
}): Promise<CoreProjectIndexHit[]> => {
  const memoryHits = input.hits.filter((hit) => hit.kind === "memory" && hit.databasePath && hit.id);
  if (input.query.trim().length === 0 || memoryHits.length === 0) {
    return input.hits;
  }

  const selectedKeys = new Set(memoryHits.map((hit) => buildMemorySemanticSignalKey(hit.databasePath || "", hit.id)));
  const databasePaths = [...new Set(memoryHits.map((hit) => hit.databasePath || "").filter((databasePath) => databasePath.length > 0))];
  const provider = input.provider || createSqliteVecProjectSemanticMemorySearchProvider();

  try {
    const semantic = await provider.search({
      query: input.query,
      databasePaths,
      topK: Math.max(memoryHits.length * 4, 20),
      perDbLimit: Math.max(memoryHits.length * 4, 10),
    });
    const semanticSimilarityByKey = new Map<string, number>();
    for (const hit of semantic.results) {
      const key = buildMemorySemanticSignalKey(hit.databasePath, hit.id);
      if (selectedKeys.has(key)) {
        semanticSimilarityByKey.set(key, hit.semanticSimilarity);
      }
    }

    return input.hits.map((hit) => {
      if (hit.kind !== "memory" || typeof hit.semanticSimilarity === "number") {
        return hit;
      }
      const semanticSimilarity = semanticSimilarityByKey.get(buildMemorySemanticSignalKey(hit.databasePath || "", hit.id));
      return typeof semanticSimilarity === "number" ? { ...hit, semanticSimilarity } : hit;
    });
  } catch {
    // Semantic annotation is metadata-only; never change row selection/ranking on failure.
    return input.hits;
  }
};

/**
 * Read continuity milestones directly from source user DBs as read-only L2 evidence.
 */
const readContinuityMilestoneHits = async (input: {
  databasePaths: string[];
  query: string;
  section?: ContinuitySection;
  from?: string;
  to?: string;
  limit: number;
}): Promise<CoreProjectIndexContinuityMilestoneHit[]> => {
  const milestones: CoreProjectIndexContinuityMilestoneHit[] = [];

  for (const databasePath of input.databasePaths) {
    const userId = path.basename(databasePath, ".db");
    const rows = readContinuityMilestones({ databasePath, limit: 500 })
      .filter((row) => !input.section || row.section === input.section)
      .filter((row) => isWithinTimestampRange({
        timestamp: row.timestamp,
        from: input.from,
        to: input.to,
      }))
      .filter((row) => matchesQuery({ text: row.summary, query: input.query }));

    for (const row of rows) {
      milestones.push({
        id: row.id,
        userId,
        databasePath,
        section: row.section,
        provenance: row.provenance,
        certainty: row.certainty,
        summary: row.summary,
        timestamp: row.timestamp,
        sourceEntryCount: row.sourceEntryCount,
      });
    }
  }

  return milestones
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, input.limit);
};

/**
 * Create a project-index data adapter bound to one project-memory directory.
 */
export const createSqliteProjectIndexDataAdapterForProjectMemoryDir = (input: {
  projectMemoryDir: string;
  mode: SqliteProjectIndexRetrievalMode;
  activeUserId?: string | null;
  indexFreshnessSeconds?: number;
  semanticSignalProvider?: ProjectSemanticMemorySearchProvider;
}): ProjectIndexDataAdapterPort => createSqliteProjectIndexDataAdapter({
  search: async (searchInput): Promise<CoreProjectIndexSearchResult> => {
    const requestedLimit = Math.max(1, Math.min(Math.floor(searchInput.limit || 20), 100));
    const projectSearch = await searchProjectMemoryByMode({
      projectMemoryDir: input.projectMemoryDir,
      query: searchInput.query,
      mode: input.mode,
      topK: Math.max(requestedLimit * 8, 64),
      perDbLimit: Math.max(requestedLimit * 2, 10),
      indexFreshnessSeconds: input.indexFreshnessSeconds,
      activeUserId: input.activeUserId || undefined,
    });

    const kindFilter = new Set(searchInput.kindFilter || ["memory", "continuity"]);
    const hits = await annotateProjectMemorySemanticSignals({
      query: searchInput.query,
      provider: input.semanticSignalProvider,
      hits: projectSearch.results
        .filter((hit) => kindFilter.has(hit.kind))
        .map(normalizeProjectIndexHit)
        .filter((hit) => !searchInput.topic || hit.topic?.toLowerCase() === searchInput.topic.toLowerCase())
        .filter((hit) => !searchInput.section || hit.section === searchInput.section)
        .filter((hit) => isWithinTimestampRange({
          timestamp: hit.timestamp || "",
          from: searchInput.from,
          to: searchInput.to,
        }))
        .filter((hit) => Boolean(searchInput.includeCompacted) || hit.kind !== "continuity" || (
          !hit.compactedIntoEntryId && !hit.supersededByEntryId
        ))
        .slice(0, requestedLimit),
    });

    const sourceDatabasePaths = Array.from(new Set(projectSearch.results.map((hit) => hit.databasePath)));
    const milestones = searchInput.includeMilestones && kindFilter.has("continuity")
      ? await readContinuityMilestoneHits({
        databasePaths: sourceDatabasePaths,
        query: searchInput.query,
        section: searchInput.section,
        from: searchInput.from,
        to: searchInput.to,
        limit: requestedLimit,
      })
      : [];

    return {
      status: "ok",
      hits,
      milestones,
      requestedMode: projectSearch.requestedMode,
      effectiveMode: projectSearch.effectiveMode,
      degradedReason: projectSearch.degradedReason || null,
      databaseCount: projectSearch.databaseCount,
      searchedDatabaseCount: projectSearch.searchedDatabaseCount,
      warnings: projectSearch.errors.map((error) => error.error),
      diagnostics: {
        provider: "sqlite-project-index-data-adapter",
        projectMemoryDir: input.projectMemoryDir,
        errorCount: projectSearch.errors.length,
        indexStatus: projectSearch.indexStatus || null,
      },
    };
  },
  readStatus: async () => {
    const status = await readProjectIndexStatus({ projectMemoryDir: input.projectMemoryDir });
    return {
      status: status.status === "error" ? "error" : "ok",
      text: `project index status=${status.status}; rows=${status.indexedRowCount}; sources=${status.sourceDatabaseCount}.`,
      warnings: status.lastError ? [status.lastError] : [],
      diagnostics: {
        provider: "sqlite-project-index-data-adapter",
        projectMemoryDir: input.projectMemoryDir,
        status,
      },
    };
  },
});

/**
 * Create a project-index data adapter around a concrete SQLite-like backend.
 */
export const createSqliteProjectIndexDataAdapter = (
  backend: SqliteProjectIndexBackend,
): ProjectIndexDataAdapterPort => ({
  search: async (input) => backend.search(input),
  readStatus: async (input) => backend.readStatus(input),
});
