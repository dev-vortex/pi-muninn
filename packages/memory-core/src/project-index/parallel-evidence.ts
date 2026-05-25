/**
 * File intent: derive deterministic grouping hints for cross-user evidence.
 *
 * This file extracts explicit source references or non-generic topics from
 * memory/continuity rows and turns them into stable group ids. Those group ids
 * let the project index surface parallel evidence from different contributors
 * without pretending to resolve chronology or conflicts.
 */

import { createHash } from "node:crypto";

/**
 * Parsed parallel-evidence marker derived from one entry payload.
 */
export interface ParallelEvidenceMarker {
  /**
   * Deterministic subject hint key used for cross-user grouping.
   *
   * Null means no reliable grouping hint was found.
   */
  subjectHintKey: string | null;
  /**
   * Deterministic group id derived from subject hint.
   *
   * Null when no subject hint key exists.
   */
  groupId: string | null;
}

/**
 * Input payload for deterministic subject-hint derivation.
 */
export interface DeriveParallelEvidenceMarkerInput {
  /** Free-form content payload from memory/continuity rows. */
  content: string;
  /** Topic metadata when available. */
  topic: string;
}

/**
 * Topics that are too generic for safe cross-user grouping.
 *
 * Decision:
 * - avoid grouping by broad buckets (`general`, `continuity/*`) because that
 *   creates noisy, low-signal cross-user bundles.
 */
const GENERIC_TOPIC_SET = new Set([
  "",
  "general",
]);

/**
 * Normalize one source-ref token into stable lowercase path-like form.
 */
const normalizeSourceRef = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/\\+/g, "/")
    .replace(/^\.\//, "")
    .replace(/\s+/g, " ")
    .replace(/^['"`]+|['"`]+$/g, "");

/**
 * Extract explicit `source_refs:` tokens from entry content.
 *
 * Supports common continuity formatting such as:
 * - `(source_refs: path/a.ts, path/b.ts)`
 * - `source_refs: path/a.ts, path/b.ts`
 */
export const extractSourceRefsFromContent = (content: string): string[] => {
  const matches = [...content.matchAll(/source_refs\s*:\s*([^\n\)]*)/gi)];
  if (matches.length === 0) {
    return [];
  }

  const refs = new Set<string>();

  for (const match of matches) {
    const raw = typeof match[1] === "string" ? match[1] : "";
    const tokens = raw
      .split(",")
      .map((token) => normalizeSourceRef(token))
      .filter((token) => token.length > 0);

    for (const token of tokens) {
      refs.add(token);
    }
  }

  return [...refs].sort((left, right) => left.localeCompare(right));
};

/**
 * Normalize topic for deterministic comparisons.
 */
const normalizeTopic = (topic: string): string =>
  topic
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

/**
 * Return deterministic subject hint key from explicit metadata only.
 *
 * Priority:
 * 1) explicit `source_refs` from content,
 * 2) non-generic topic.
 */
export const deriveSubjectHintKey = (input: DeriveParallelEvidenceMarkerInput): string | null => {
  const sourceRefs = extractSourceRefsFromContent(input.content);
  if (sourceRefs.length > 0) {
    return `refs:${sourceRefs.join("|")}`;
  }

  const topic = normalizeTopic(input.topic);
  if (GENERIC_TOPIC_SET.has(topic) || topic.startsWith("continuity/")) {
    return null;
  }

  return topic.length > 0 ? `topic:${topic}` : null;
};

/**
 * Build deterministic group id from one subject hint key.
 */
export const deriveParallelGroupId = (subjectHintKey: string): string =>
  createHash("sha1")
    .update(`l2-parallel/v1|${subjectHintKey}`, "utf-8")
    .digest("hex");

/**
 * Build deterministic parallel-evidence marker payload for one entry.
 */
export const deriveParallelEvidenceMarker = (
  input: DeriveParallelEvidenceMarkerInput,
): ParallelEvidenceMarker => {
  const subjectHintKey = deriveSubjectHintKey(input);

  return {
    subjectHintKey,
    groupId: subjectHintKey ? deriveParallelGroupId(subjectHintKey) : null,
  };
};
