/**
 * File intent: release-profile `/memory` command parsing and completions.
 *
 * This file intentionally contains only the approved release project namespace
 * candidates so release bundles do not carry development command strings.
 */

import type { UpstreamMemoryCommandDefinition } from "../../compat/upstream-extension-runtime.js";
import type { ExtensionAutocompleteItem } from "./runtime-types.js";

interface CompletionSpec {
  value: string;
  description: string;
}

const UPSTREAM_MEMORY_COMMAND_FALLBACK_COMPLETIONS: readonly CompletionSpec[] = [
  { value: "status", description: "Show whether memory is enabled and whether project memory is active." },
  { value: "stats", description: "Show memory counts and health information." },
  { value: "project", description: "Open project-memory commands for this repository." },
  { value: "search", description: "Search saved memory for a word, phrase, or question." },
  { value: "graph", description: "Show relationships between memory topics and projects." },
  { value: "knowledge", description: "Look up saved facts about a person, project, tool, or other item." },
  { value: "rooms", description: "List memory topics, optionally for one project." },
  { value: "taxonomy", description: "Show saved memory organized by project and topic." },
  { value: "diary", description: "Read or search diary-style memory notes." },
  { value: "timeline", description: "Show saved facts in chronological order." },
  { value: "on", description: "Turn memory on." },
  { value: "off", description: "Turn memory off." },
];

const RELEASE_PROJECT_NAMESPACE_COMPLETION_CANDIDATES: readonly CompletionSpec[] = [
  { value: "project", description: "Show project-memory status and help for this repository." },
  { value: "project status", description: "Show project memory health, storage, identity, and handoff-note status." },
  { value: "project help", description: "List available project-memory commands." },
  { value: "project on", description: "Enable project memory in this repository." },
  { value: "project off", description: "Disable project memory in this repository without deleting saved files." },
  { value: "project set", description: "Set the project name used by memory. Add the name after this command." },
  { value: "project user", description: "Show or change the user identity used for project memory files." },
  { value: "project user status", description: "Show which user identity is used for project memory." },
  { value: "project user set", description: "Set a stable project-memory identity. Add your name or email after this command." },
  { value: "project user auto", description: "Return project-memory identity detection to automatic mode." },
  { value: "project mode", description: "Show or change how project memory search is read." },
  { value: "project mode status", description: "Show the current project-memory search mode." },
  { value: "project mode index-first", description: "Prefer the fast project search index and fall back when needed." },
  { value: "project mode fanout", description: "Search project member DBs directly instead of preferring the index." },
  { value: "project continuity-briefing", description: "Show or change how project handoff notes are selected for automatic briefings." },
  { value: "project continuity-briefing status", description: "Show the current handoff-note briefing mode." },
  { value: "project continuity-briefing lexical", description: "Use word-match selection for handoff-note briefings." },
  { value: "project continuity-briefing semantic", description: "Use meaning-based selection for handoff-note briefings when available." },
  { value: "project search", description: "Search only the current project memory. Add your search text after this command." },
  { value: "project index", description: "Show or refresh project search data." },
  { value: "project index status", description: "Show whether project search data is healthy and up to date." },
  { value: "project index rebuild", description: "Rebuild project search data from saved project memory." },
  { value: "project promote", description: "Review project lessons that may be useful as reusable personal memory." },
  { value: "project promote status", description: "Show whether there are reusable project lessons ready to review." },
  { value: "project promote run", description: "Save accepted reusable project lessons into personal memory." },
  { value: "project promote dry-run", description: "Preview reusable project lessons without changing memory." },
  { value: "project promote validate", description: "Check promotion state and report any issues." },
];

const DESCRIPTION_BY_VALUE = new Map<string, string>([
  ...UPSTREAM_MEMORY_COMMAND_FALLBACK_COMPLETIONS.map((item) => [item.value, item.description] as const),
  ...RELEASE_PROJECT_NAMESPACE_COMPLETION_CANDIDATES.map((item) => [item.value, item.description] as const),
]);

/**
 * Convert one completion spec into Pi autocomplete item shape.
 */
const toAutocompleteItem = (spec: CompletionSpec): ExtensionAutocompleteItem => ({
  label: spec.value,
  value: spec.value,
  type: "text",
  description: spec.description,
});

/**
 * Parse one completion candidate into a command-token string plus description.
 */
const normalizeCompletionSpec = (candidate: unknown): CompletionSpec | null => {
  if (typeof candidate === "string") {
    const normalized = candidate.trim();
    return normalized.length > 0
      ? { value: normalized, description: DESCRIPTION_BY_VALUE.get(normalized) || "Run this memory command." }
      : null;
  }

  if (typeof candidate === "object" && candidate !== null) {
    const value = (candidate as { value?: unknown }).value;
    const label = (candidate as { label?: unknown }).label;
    const normalizedValue = typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : typeof label === "string" && label.trim().length > 0
        ? label.trim()
        : null;

    if (!normalizedValue) {
      return null;
    }

    const description = (candidate as { description?: unknown }).description;
    return {
      value: normalizedValue,
      description: typeof description === "string" && description.trim().length > 0
        ? description.trim()
        : DESCRIPTION_BY_VALUE.get(normalizedValue) || "Run this memory command.",
    };
  }

  return null;
};

/**
 * Normalize completion prefix so both `memory ...` and `/memory ...` shapes work.
 */
const normalizeMemoryCommandCompletionPrefix = (prefix: string): string => {
  const trimmedStart = prefix.trimStart();

  if (/^\/memory\b/i.test(trimmedStart)) {
    return trimmedStart.replace(/^\/memory\b\s*/i, "");
  }

  if (/^memory\b/i.test(trimmedStart)) {
    return trimmedStart.replace(/^memory\b\s*/i, "");
  }

  return trimmedStart;
};

/**
 * Build release `/memory` argument completions while preserving upstream parity.
 */
export const buildReleaseMemoryCommandCompletions = (input: {
  prefix: string;
  upstreamCommand: UpstreamMemoryCommandDefinition | null;
}): ExtensionAutocompleteItem[] => {
  const normalizedPrefixRaw = normalizeMemoryCommandCompletionPrefix(input.prefix);
  const normalizedPrefix = normalizedPrefixRaw.trim();
  const projectNamespacePrefix = normalizedPrefixRaw.trimEnd();

  if (normalizedPrefix === "project" || normalizedPrefix.startsWith("project ")) {
    return RELEASE_PROJECT_NAMESPACE_COMPLETION_CANDIDATES
      .filter((item) => item.value.startsWith(projectNamespacePrefix))
      .map(toAutocompleteItem);
  }

  const upstreamCompletionFn = input.upstreamCommand?.getArgumentCompletions;
  const upstreamSpecs = typeof upstreamCompletionFn === "function"
    ? (upstreamCompletionFn(normalizedPrefix) || [])
      .map((candidate) => normalizeCompletionSpec(candidate))
      .filter((candidate): candidate is CompletionSpec => candidate !== null)
    : [...UPSTREAM_MEMORY_COMMAND_FALLBACK_COMPLETIONS];

  const mergedSpecsByValue = new Map<string, CompletionSpec>();
  for (const spec of [RELEASE_PROJECT_NAMESPACE_COMPLETION_CANDIDATES[0], ...upstreamSpecs]) {
    if (!mergedSpecsByValue.has(spec.value)) {
      mergedSpecsByValue.set(spec.value, spec);
    }
  }

  return [...mergedSpecsByValue.values()]
    .filter((item) => item.value.startsWith(normalizedPrefix))
    .map(toAutocompleteItem);
};

/**
 * Normalize command arguments supplied by pi command handlers.
 */
export const normalizeReleaseCommandArgs = (args: unknown): string[] => {
  const rawTokens = Array.isArray(args)
    ? args
    : typeof args === "string"
      ? args.split(/\s+/)
      : [];

  const tokens = rawTokens
    .map((arg) => String(arg).trim())
    .filter((arg) => arg.length > 0);

  const first = tokens[0]?.toLowerCase();
  if (first === "memory" || first === "/memory") {
    return tokens.slice(1);
  }

  return tokens;
};
