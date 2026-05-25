/**
 * File intent: shared project-memory lane selection and metadata formatting.
 *
 * Search and recall wrappers both need the same memory-only row selection while
 * keeping continuity rows excluded from the memory tool surface.
 */

export const selectProjectMemoryHits = (input: {
  results: Array<{
    userId: string;
    kind: string;
    topic: string;
    timestamp: string;
    content: string;
    semanticSimilarity?: number;
  }>;
  topicFilter: string | null;
  limit: number;
}): Array<{
  userId: string;
  topic: string;
  timestamp: string;
  content: string;
  semanticSimilarity?: number;
}> => input.results
  .filter((hit) => hit.kind === "memory")
  .filter((hit) => input.topicFilter ? hit.topic.toLowerCase() === input.topicFilter : true)
  .slice(0, input.limit)
  .map((hit) => ({
    userId: hit.userId,
    topic: hit.topic,
    timestamp: hit.timestamp,
    content: hit.content,
    ...(typeof hit.semanticSimilarity === "number" ? { semanticSimilarity: hit.semanticSimilarity } : {}),
  }));

/**
 * Join project-lane degradation notes while keeping output concise.
 */
export const appendProjectLaneNote = (current: string | null, note: string): string =>
  [current, note]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("; ");

/**
 * Format optional vector similarity using upstream-compatible memory_search match wording.
 */
export const formatMemorySearchSimilarity = (similarity: number): string | null => {
  if (!Number.isFinite(similarity)) {
    return null;
  }

  return `${(Math.max(0, Math.min(1, similarity)) * 100).toFixed(1)}% match`;
};
