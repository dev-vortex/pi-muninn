/**
 * File intent: provide pure helpers for prompt-scoped memory briefing assembly.
 *
 * Keep database access and final rendering out of this file; these helpers are
 * deterministic transforms used by both project and related-user memory lanes.
 */

import type { FanoutSearchHit } from "../project-index/fanout-retrieval.js";

/**
 * Clip one memory row to the configured briefing budget.
 */
export const clipMemoryContent = (content: string, maxLength: number): string => {
  const normalized = content.trim().replace(/\s+/g, " ");

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
};

/**
 * Normalize signal tokens for deterministic lexical matching.
 */
export const normalizeSignalTokens = (tokens: string[]): string[] => {
  const unique = new Set<string>();

  for (const token of tokens) {
    const normalized = token.trim().toLowerCase();
    if (normalized.length > 0) {
      unique.add(normalized);
    }
  }

  return [...unique].slice(0, 12);
};

/**
 * Count how many signal tokens appear in a candidate row.
 */
export const countTermMatches = (tokens: string[], content: string, topic: string): number => {
  if (tokens.length === 0) {
    return 0;
  }

  const haystack = `${content}\n${topic}`.toLowerCase();
  return tokens.reduce((count, token) => count + (haystack.includes(token) ? 1 : 0), 0);
};

/**
 * Build a stable lookup key for annotating already-selected memory rows.
 */
export const buildMemorySemanticSignalKey = (databasePath: string, id: string): string => `${databasePath}\u001F${id}`;

/**
 * Clamp one semantic similarity ratio into a display percentage.
 */
export const similarityToPercent = (similarity: number): number | undefined => {
  if (!Number.isFinite(similarity)) {
    return undefined;
  }

  return Math.max(0, Math.min(100, similarity * 100));
};

/**
 * Format semantic relevance for briefing rows.
 */
export const formatSemanticPercent = (percent: number): string => `${Math.round(Math.max(0, Math.min(100, percent)))}%`;

/**
 * Read optional semantic similarity already carried by a retrieval hit.
 */
export const readSemanticPercentFromHit = (hit: FanoutSearchHit): number | undefined => {
  const semanticSimilarity = (hit as FanoutSearchHit & { semanticSimilarity?: unknown }).semanticSimilarity;
  return typeof semanticSimilarity === "number" ? similarityToPercent(semanticSimilarity) : undefined;
};

/**
 * Rank memory hits by term matches and recency.
 */
export const rankRows = <T extends { termMatches: number; timestamp: string }>(rows: T[]): T[] =>
  [...rows].sort((left, right) => {
    if (right.termMatches !== left.termMatches) {
      return right.termMatches - left.termMatches;
    }

    return right.timestamp.localeCompare(left.timestamp);
  });
