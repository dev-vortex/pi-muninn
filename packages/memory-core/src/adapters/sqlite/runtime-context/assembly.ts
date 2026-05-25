/**
 * File intent: assemble multi-source runtime context for project-aware prompts.
 *
 * This file combines project memory, curated global memory, environment traits,
 * and bounded continuity summaries into one prompt-ready context block. It also
 * records observability metrics so runtime context quality, fallback behavior,
 * and latency stay visible to commands and tests.
 */

import { createHash } from "node:crypto";

import type { ProjectMemoryMode } from "../../../project-memory/types.js";
import type { FanoutSearchHit } from "../project-index/fanout-retrieval.js";
import {
  searchProjectMemoryByMode,
  type ModeAwareProjectSearchResult,
} from "../project-memory/mode-selection.js";
import {
  loadGlobalTraitMemories,
  searchGlobalMasterMemory,
  type GlobalMasterMemoryHit,
} from "../project-memory/promotion-pipeline.js";
import { buildContinuityStartupSummary } from "../continuity/continuity-startup-summary.js";

/**
 * Input for assembling runtime context from project + environment memories.
 */
export interface RuntimeContextAssemblyInput {
  projectMemoryDir: string;
  globalMemoryDir: string;
  query: string;
  mode: ProjectMemoryMode;
  topKProject?: number;
  topKGlobal?: number;
  topKTraits?: number;
  perDbLimit?: number;
  indexFreshnessSeconds?: number;
  /** Active user id used for owner-scoped L2 cache access. */
  activeUserId?: string;
  /** Optional user-scoped continuity DB used for bounded startup briefing. */
  continuityDatabasePath?: string;
  /** Character budget for continuity startup summary text. */
  continuitySummaryMaxCharacters?: number;
}

/**
 * One normalized context item emitted by runtime context assembly.
 */
export interface RuntimeContextItem {
  scope: "environment-trait" | "project-context" | "global-context";
  id: string;
  content: string;
  topic: string;
  source: string;
  timestamp: string;
  score: number;
}

/**
 * Observability event emitted by one context assembly operation.
 */
export interface RuntimeContextAssemblyObservation {
  timestamp: string;
  query: string;
  requestedMode: ProjectMemoryMode;
  effectiveMode: ProjectMemoryMode;
  degraded: boolean;
  degradedReasons: string[];
  continuityBriefingIncluded: boolean;
  continuityEntryCount: number;
  continuityMilestoneCount: number;
  continuityBriefingTruncated: boolean;
  projectResultCount: number;
  globalResultCount: number;
  traitResultCount: number;
  composedCount: number;
  projectSearchLatencyMs: number;
  globalSearchLatencyMs: number;
  traitLoadLatencyMs: number;
  totalLatencyMs: number;
}

/**
 * Assembled runtime context envelope.
 */
export interface RuntimeContextAssemblyResult {
  query: string;
  requestedMode: ProjectMemoryMode;
  effectiveMode: ProjectMemoryMode;
  degraded: boolean;
  degradedReasons: string[];
  continuityBriefingText: string;
  project: RuntimeContextItem[];
  environmentTraits: RuntimeContextItem[];
  global: RuntimeContextItem[];
  composed: RuntimeContextItem[];
  promptText: string;
  observation: RuntimeContextAssemblyObservation;
}

/**
 * Tracker for runtime-context observability.
 */
export interface RuntimeContextObservabilityTracker {
  maxEntries: number;
  observations: RuntimeContextAssemblyObservation[];
}

/**
 * Snapshot summary of runtime-context observability metrics.
 */
export interface RuntimeContextObservabilitySnapshot {
  totalAssemblies: number;
  degradedAssemblies: number;
  degradedRate: number;
  fallbackCount: number;
  fallbackRate: number;
  avgTotalLatencyMs: number;
  p95TotalLatencyMs: number;
  recent: RuntimeContextAssemblyObservation[];
}

/**
 * Create an empty observability tracker.
 */
export const createRuntimeContextObservabilityTracker = (
  maxEntries: number = 200,
): RuntimeContextObservabilityTracker => ({
  maxEntries: Math.max(10, Math.min(maxEntries, 5000)),
  observations: [],
});

/**
 * Parse duration p95 from a list of numbers.
 */
const computeP95 = (values: number[]): number => {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1));
  return sorted[index];
};

/**
 * Add one observation to tracker with bounded retention.
 */
export const recordRuntimeContextObservation = (input: {
  tracker: RuntimeContextObservabilityTracker;
  observation: RuntimeContextAssemblyObservation;
}): void => {
  input.tracker.observations.push(input.observation);

  if (input.tracker.observations.length > input.tracker.maxEntries) {
    input.tracker.observations.splice(0, input.tracker.observations.length - input.tracker.maxEntries);
  }
};

/**
 * Clear all retained observability events.
 */
export const resetRuntimeContextObservability = (tracker: RuntimeContextObservabilityTracker): void => {
  tracker.observations = [];
};

/**
 * Build summary metrics from current tracker observations.
 */
export const getRuntimeContextObservabilitySnapshot = (
  tracker: RuntimeContextObservabilityTracker,
): RuntimeContextObservabilitySnapshot => {
  const totalAssemblies = tracker.observations.length;

  if (totalAssemblies === 0) {
    return {
      totalAssemblies: 0,
      degradedAssemblies: 0,
      degradedRate: 0,
      fallbackCount: 0,
      fallbackRate: 0,
      avgTotalLatencyMs: 0,
      p95TotalLatencyMs: 0,
      recent: [],
    };
  }

  const degradedAssemblies = tracker.observations.filter((event) => event.degraded).length;
  const fallbackCount = tracker.observations.filter((event) =>
    event.requestedMode === "index-first" && event.effectiveMode === "fanout").length;

  const latencies = tracker.observations.map((event) => event.totalLatencyMs);
  const avgTotalLatencyMs = Math.round(latencies.reduce((acc, value) => acc + value, 0) / totalAssemblies);

  return {
    totalAssemblies,
    degradedAssemblies,
    degradedRate: Math.round((degradedAssemblies / totalAssemblies) * 1000) / 1000,
    fallbackCount,
    fallbackRate: Math.round((fallbackCount / totalAssemblies) * 1000) / 1000,
    avgTotalLatencyMs,
    p95TotalLatencyMs: Math.round(computeP95(latencies)),
    recent: tracker.observations.slice(-10),
  };
};

/**
 * Build stable content hash used for cross-scope deduplication.
 */
const contentHash = (content: string): string =>
  createHash("sha256")
    .update(content.trim().toLowerCase().replace(/\s+/g, " "), "utf-8")
    .digest("hex")
    .slice(0, 20);

/**
 * Map project search hit into normalized runtime-context item.
 */
const mapProjectItem = (hit: FanoutSearchHit): RuntimeContextItem => ({
  scope: "project-context",
  id: hit.id,
  content: hit.content,
  topic: hit.topic,
  source: hit.source,
  timestamp: hit.timestamp,
  score: hit.termMatches,
});

/**
 * Map global master hit into normalized runtime-context item.
 */
const mapGlobalItem = (input: {
  hit: GlobalMasterMemoryHit;
  scope: "environment-trait" | "global-context";
}): RuntimeContextItem => ({
  scope: input.scope,
  id: input.hit.id,
  content: input.hit.content,
  topic: input.hit.topic,
  source: input.hit.source,
  timestamp: input.hit.promotedAt,
  score: input.hit.score,
});

/**
 * Merge context items with first-wins dedup by normalized content hash.
 */
const mergeAndDedupeContextItems = (items: RuntimeContextItem[]): RuntimeContextItem[] => {
  const seen = new Set<string>();
  const merged: RuntimeContextItem[] = [];

  for (const item of items) {
    const hash = contentHash(item.content);
    if (seen.has(hash)) {
      continue;
    }

    seen.add(hash);
    merged.push(item);
  }

  return merged;
};

/**
 * Render assembled context into prompt-friendly plain text.
 */
const renderPromptText = (input: {
  query: string;
  requestedMode: ProjectMemoryMode;
  effectiveMode: ProjectMemoryMode;
  degraded: boolean;
  degradedReasons: string[];
  continuityBriefingText: string;
  environmentTraits: RuntimeContextItem[];
  project: RuntimeContextItem[];
  global: RuntimeContextItem[];
}): string => {
  const lines: string[] = [];

  lines.push(`Runtime context for query: "${input.query}"`);
  lines.push(`requestedMode=${input.requestedMode}; effectiveMode=${input.effectiveMode}; degraded=${input.degraded}`);

  if (input.degradedReasons.length > 0) {
    lines.push(`degradedReasons=${input.degradedReasons.join(" | ")}`);
  }

  if (input.continuityBriefingText.trim().length > 0) {
    lines.push("");
    lines.push("Continuity briefing:");
    lines.push(input.continuityBriefingText);
  }

  lines.push("");
  lines.push("Environment traits:");
  if (input.environmentTraits.length === 0) {
    lines.push("- none");
  } else {
    for (const item of input.environmentTraits) {
      lines.push(`- [${item.topic}] ${item.content}`);
    }
  }

  lines.push("");
  lines.push("Project context:");
  if (input.project.length === 0) {
    lines.push("- none");
  } else {
    for (const item of input.project) {
      lines.push(`- [${item.topic}] ${item.content}`);
    }
  }

  lines.push("");
  lines.push("Global context:");
  if (input.global.length === 0) {
    lines.push("- none");
  } else {
    for (const item of input.global) {
      lines.push(`- [${item.topic}] ${item.content}`);
    }
  }

  return lines.join("\n");
};

/**
 * Assemble runtime context from environment traits + project memory + global master hits.
 */
export const assembleRuntimeContext = async (
  input: RuntimeContextAssemblyInput,
): Promise<RuntimeContextAssemblyResult> => {
  const topKProject = Math.max(1, Math.min(input.topKProject ?? 8, 100));
  const topKGlobal = Math.max(1, Math.min(input.topKGlobal ?? 5, 50));
  const topKTraits = Math.max(1, Math.min(input.topKTraits ?? 4, 50));

  const startedAt = Date.now();
  const degradedReasons: string[] = [];

  const continuitySummary = input.continuityDatabasePath
    ? buildContinuityStartupSummary({
      databasePath: input.continuityDatabasePath,
      maxCharacters: input.continuitySummaryMaxCharacters,
    })
    : {
      available: false,
      text: "",
      includedEntryCount: 0,
      includedMilestoneCount: 0,
      truncated: false,
      maxCharacters: input.continuitySummaryMaxCharacters ?? 0,
    };

  const projectSearchStarted = Date.now();
  const projectResult: ModeAwareProjectSearchResult = await searchProjectMemoryByMode({
    projectMemoryDir: input.projectMemoryDir,
    query: input.query,
    mode: input.mode,
    topK: topKProject,
    perDbLimit: input.perDbLimit,
    indexFreshnessSeconds: input.indexFreshnessSeconds,
    activeUserId: input.activeUserId,
  });
  const projectSearchLatencyMs = Date.now() - projectSearchStarted;

  if (projectResult.degraded && projectResult.degradedReason) {
    degradedReasons.push(`project=${projectResult.degradedReason}`);
  }

  const globalSearchStarted = Date.now();
  const globalSearch = await searchGlobalMasterMemory({
    globalMemoryDir: input.globalMemoryDir,
    query: input.query,
    topK: topKGlobal,
  });
  const globalSearchLatencyMs = Date.now() - globalSearchStarted;

  if (globalSearch.error) {
    degradedReasons.push(`global-search=${globalSearch.error}`);
  }

  if (!globalSearch.exists) {
    degradedReasons.push("global master memory not initialized");
  }

  const traitLoadStarted = Date.now();
  const traitLoad = await loadGlobalTraitMemories({
    globalMemoryDir: input.globalMemoryDir,
    topK: topKTraits,
  });
  const traitLoadLatencyMs = Date.now() - traitLoadStarted;

  if (traitLoad.error) {
    degradedReasons.push(`trait-load=${traitLoad.error}`);
  }

  const projectItems = projectResult.results.map(mapProjectItem);
  const globalItems = globalSearch.results.map((hit) => mapGlobalItem({ hit, scope: "global-context" }));
  const traitItems = traitLoad.results.map((hit) => mapGlobalItem({ hit, scope: "environment-trait" }));

  const composed = mergeAndDedupeContextItems([
    ...traitItems,
    ...projectItems,
    ...globalItems,
  ]);

  const degraded = projectResult.degraded || degradedReasons.length > 0;
  const totalLatencyMs = Date.now() - startedAt;

  const observation: RuntimeContextAssemblyObservation = {
    timestamp: new Date().toISOString(),
    query: input.query,
    requestedMode: input.mode,
    effectiveMode: projectResult.effectiveMode,
    degraded,
    degradedReasons,
    continuityBriefingIncluded: continuitySummary.available && continuitySummary.text.trim().length > 0,
    continuityEntryCount: continuitySummary.includedEntryCount,
    continuityMilestoneCount: continuitySummary.includedMilestoneCount,
    continuityBriefingTruncated: continuitySummary.truncated,
    projectResultCount: projectItems.length,
    globalResultCount: globalItems.length,
    traitResultCount: traitItems.length,
    composedCount: composed.length,
    projectSearchLatencyMs,
    globalSearchLatencyMs,
    traitLoadLatencyMs,
    totalLatencyMs,
  };

  return {
    query: input.query,
    requestedMode: input.mode,
    effectiveMode: projectResult.effectiveMode,
    degraded,
    degradedReasons,
    continuityBriefingText: continuitySummary.text,
    project: projectItems,
    environmentTraits: traitItems,
    global: globalItems,
    composed,
    promptText: renderPromptText({
      query: input.query,
      requestedMode: input.mode,
      effectiveMode: projectResult.effectiveMode,
      degraded,
      degradedReasons,
      continuityBriefingText: continuitySummary.text,
      environmentTraits: traitItems,
      project: projectItems,
      global: globalItems,
    }),
    observation,
  };
};
