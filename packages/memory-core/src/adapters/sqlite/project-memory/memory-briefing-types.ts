/**
 * File intent: define prompt-scoped project-memory briefing contracts.
 *
 * These types are shared by the memory briefing builder and its focused helper
 * modules so implementation files stay small and easy to navigate.
 */

import type { ProjectSemanticMemorySearchProvider } from "./semantic-search-provider.js";
import type { ProjectMemoryMode } from "../../../project-memory/types.js";

/**
 * One rendered memory briefing row with LLM-readable source labels.
 */
export interface MemoryBriefingRow {
  /** LLM-readable memory scope. */
  scope: "project" | "related_user";
  /** Human-readable contributor/member label when relevant. */
  contributor?: string;
  /** Topic metadata from the memory row. */
  topic: string;
  /** ISO timestamp from the memory row. */
  timestamp: string;
  /** Bounded memory text. */
  content: string;
  /** Matched query term count. */
  termMatches: number;
  /** Optional semantic relevance percentage for this row, when the retrieval path exposes one. */
  semanticPercent?: number;
}

/**
 * Coverage metadata for one briefing lane.
 */
export interface MemoryBriefingCoverage {
  /** Number of rows included in the briefing. */
  shown: number;
  /** Number of bounded candidate rows discovered before clipping to shown rows. */
  total: number;
  /** Number of candidate rows omitted from this briefing. */
  omitted: number;
  /** Newest timestamp among candidate rows. */
  newest: string | null;
  /** Oldest timestamp among candidate rows. */
  oldest: string | null;
  /** Whether more candidate rows exist outside the shown subset. */
  moreAvailable: boolean;
  /** Human-readable lane availability/degradation note. */
  note: string | null;
}

/**
 * Result envelope for a generated memory briefing.
 */
export interface MemoryBriefingResult {
  /** Rendered briefing text ready to append to the system prompt. */
  briefing: string;
  /** Project-memory coverage metadata. */
  projectCoverage: MemoryBriefingCoverage;
  /** Related user-memory coverage metadata. */
  relatedCoverage: MemoryBriefingCoverage;
  /** LLM-readable retrieval status. */
  retrieval: "normal" | "fallback" | "unavailable";
  /** Whether any lane had fallback/error behavior. */
  degraded: boolean;
  /** Whether the LLM should call memory tools for deeper evidence before answering. */
  deeperSearchRecommended: boolean;
}

/**
 * Input for building one memory briefing.
 */
export interface BuildMemoryBriefingInput {
  /** Project-local memory directory (`${PROJECT}/.agent/memory`). */
  projectMemoryDir: string;
  /** Global upstream memory DB path supplied by the host package. */
  globalDatabasePath: string;
  /** Active project user id used only for current-user aliasing. */
  activeUserId: string | null;
  /** Current project retrieval mode. */
  mode: ProjectMemoryMode;
  /** Project index freshness threshold in seconds. */
  indexFreshnessSeconds?: number;
  /** Query/signal tokens derived from the current user prompt. */
  signalTokens: string[];
  /** Max project-memory rows to show. */
  projectRowLimit?: number;
  /** Max related user-memory rows to show. */
  relatedRowLimit?: number;
  /** Max candidate rows to inspect per lane. */
  candidateLimit?: number;
  /** Max characters per rendered memory row. */
  rowClipLength?: number;
  /** Optional display-name lookup for future member-name support. */
  displayNameByUserId?: Record<string, string>;
  /** Optional provider used only to annotate selected rows; it must not change row selection/ranking. */
  semanticSignalProvider?: ProjectSemanticMemorySearchProvider;
}

/**
 * Candidate row read from the global reusable-user-memory DB.
 */
export interface RelatedUserMemoryCandidate {
  id: string;
  topic: string;
  timestamp: string;
  content: string;
  termMatches: number;
}
