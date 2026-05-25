/**
 * File intent: extract bounded prompt signals for core prompt briefings.
 */

const PROMPT_BRIEFING_SIGNAL_TOKEN_LIMIT = 8;
const PROMPT_BRIEFING_SIGNAL_STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "because",
  "before",
  "being",
  "could",
  "current",
  "during",
  "from",
  "have",
  "into",
  "just",
  "memory",
  "project",
  "should",
  "that",
  "their",
  "there",
  "these",
  "this",
  "turn",
  "user",
  "with",
  "would",
]);

/**
 * Normalize one prompt into compact query/signal text.
 */
export const normalizePromptSignalText = (content: string): string => content.trim().replace(/\s+/g, " ");

/**
 * Extract bounded, de-duplicated query tokens shared by memory and continuity briefings.
 */
export const extractPromptSignalTokens = (signalText: string): string[] => {
  if (signalText.trim().length === 0) return [];

  const rawTokens = signalText
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 4);

  const tokens: string[] = [];
  const seen = new Set<string>();

  for (const token of rawTokens) {
    if (PROMPT_BRIEFING_SIGNAL_STOP_WORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
    if (tokens.length >= PROMPT_BRIEFING_SIGNAL_TOKEN_LIMIT) break;
  }

  return tokens;
};
