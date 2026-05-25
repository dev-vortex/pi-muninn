/**
 * File intent: load and warm runtime-policy snippets for lifecycle injection.
 *
 * The entrypoint owns three policy snippets (orchestration, project memory,
 * continuity); this module keeps marker extraction and one-shot warning behavior
 * together without changing lifecycle semantics.
 */

import { readFile } from "node:fs/promises";

import type { MemoryExtensionRuntimeState } from "../runtime-state.js";
import {
  CONTINUITY_RUNTIME_END_MARKER,
  CONTINUITY_RUNTIME_START_MARKER,
  PERSISTENCE_ORCHESTRATION_RUNTIME_END_MARKER,
  PERSISTENCE_ORCHESTRATION_RUNTIME_START_MARKER,
  PROJECT_MEMORY_RUNTIME_END_MARKER,
  PROJECT_MEMORY_RUNTIME_START_MARKER,
} from "./constants.js";
import {
  isContinuityRuntimePolicyEnabled,
  isPersistenceOrchestrationRuntimePolicyEnabled,
  isProjectMemoryRuntimePolicyEnabled,
  resolveContinuityRuntimePolicyPath,
  resolvePersistenceOrchestrationRuntimePolicyPath,
  resolveProjectMemoryRuntimePolicyPath,
} from "./runtime-config.js";

/**
 * Extract one runtime-policy snippet bounded by start/end markers.
 */
export const extractRuntimePolicySnippet = (input: {
  policyMarkdown: string;
  startMarker: string;
  endMarker: string;
}): string | null => {
  const startIndex = input.policyMarkdown.indexOf(input.startMarker);
  const endIndex = input.policyMarkdown.indexOf(input.endMarker);

  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
    return null;
  }

  const sliced = input.policyMarkdown
    .slice(startIndex + input.startMarker.length, endIndex)
    .trim();

  return sliced.length > 0 ? sliced : null;
};

/**
 * Extract runtime activation snippet from continuity runtime policy template.
 */
export const extractContinuityRuntimeSnippet = (policyMarkdown: string): string | null =>
  extractRuntimePolicySnippet({
    policyMarkdown,
    startMarker: CONTINUITY_RUNTIME_START_MARKER,
    endMarker: CONTINUITY_RUNTIME_END_MARKER,
  });

/**
 * Extract runtime activation snippet from project-memory runtime policy template.
 */
export const extractProjectMemoryRuntimeSnippet = (policyMarkdown: string): string | null =>
  extractRuntimePolicySnippet({
    policyMarkdown,
    startMarker: PROJECT_MEMORY_RUNTIME_START_MARKER,
    endMarker: PROJECT_MEMORY_RUNTIME_END_MARKER,
  });

/**
 * Extract runtime activation snippet from persistence orchestration template.
 */
export const extractPersistenceOrchestrationRuntimeSnippet = (policyMarkdown: string): string | null =>
  extractRuntimePolicySnippet({
    policyMarkdown,
    startMarker: PERSISTENCE_ORCHESTRATION_RUNTIME_START_MARKER,
    endMarker: PERSISTENCE_ORCHESTRATION_RUNTIME_END_MARKER,
  });

/**
 * Build policy snippet services with one-shot warning state.
 */
export const createRuntimePolicyServices = (state: MemoryExtensionRuntimeState): {
  warmContinuityRuntimeSnippet: (ctx: any) => Promise<void>;
  warmProjectMemoryRuntimeSnippet: (ctx: any) => Promise<void>;
  warmPersistenceOrchestrationRuntimeSnippet: (ctx: any) => Promise<void>;
} => {
  let continuityRuntimePolicyWarningLogged = false;
  let projectMemoryRuntimePolicyWarningLogged = false;
  let persistenceOrchestrationRuntimePolicyWarningLogged = false;

  const emitWarning = (input: {
    flag: "continuity" | "project-memory" | "persistence-orchestration";
    message: string;
  }): void => {
    if (input.flag === "continuity" && continuityRuntimePolicyWarningLogged) return;
    if (input.flag === "project-memory" && projectMemoryRuntimePolicyWarningLogged) return;
    if (input.flag === "persistence-orchestration" && persistenceOrchestrationRuntimePolicyWarningLogged) return;

    if (input.flag === "continuity") continuityRuntimePolicyWarningLogged = true;
    if (input.flag === "project-memory") projectMemoryRuntimePolicyWarningLogged = true;
    if (input.flag === "persistence-orchestration") persistenceOrchestrationRuntimePolicyWarningLogged = true;

    // eslint-disable-next-line no-console
    console.warn(`[pi-muninn] ${input.message}`);
  };

  const loadSnippet = async (input: {
    path: string;
    label: "continuity" | "project-memory" | "persistence-orchestration";
    extract: (markdown: string) => string | null;
  }): Promise<string | null> => {
    try {
      const markdown = await readFile(input.path, "utf8");
      const snippet = input.extract(markdown);
      if (snippet) return snippet;

      emitWarning({
        flag: input.label,
        message: `${input.label} runtime policy markers were not found in ${input.path}. Runtime policy injection is disabled.`,
      });
      return null;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      emitWarning({
        flag: input.label,
        message: `${input.label} runtime policy could not be loaded from ${input.path}: ${message}`,
      });
      return null;
    }
  };

  const resolveSessionId = (ctx: any): string =>
    ctx?.sessionManager?.getSessionId?.() || "default-session";

  const warmContinuityRuntimeSnippet = async (ctx: any): Promise<void> => {
    if (!isContinuityRuntimePolicyEnabled()) return;
    const sessionId = resolveSessionId(ctx);
    if (state.continuityRuntimeSnippetBySession.has(sessionId)) return;

    const snippet = await loadSnippet({
      path: resolveContinuityRuntimePolicyPath(),
      label: "continuity",
      extract: extractContinuityRuntimeSnippet,
    });
    if (snippet) state.continuityRuntimeSnippetBySession.set(sessionId, snippet);
  };

  const warmProjectMemoryRuntimeSnippet = async (ctx: any): Promise<void> => {
    if (!isProjectMemoryRuntimePolicyEnabled()) return;
    const sessionId = resolveSessionId(ctx);
    if (state.projectMemoryRuntimeSnippetBySession.has(sessionId)) return;

    const snippet = await loadSnippet({
      path: resolveProjectMemoryRuntimePolicyPath(),
      label: "project-memory",
      extract: extractProjectMemoryRuntimeSnippet,
    });
    if (snippet) state.projectMemoryRuntimeSnippetBySession.set(sessionId, snippet);
  };

  const warmPersistenceOrchestrationRuntimeSnippet = async (ctx: any): Promise<void> => {
    if (!isPersistenceOrchestrationRuntimePolicyEnabled()) return;
    if (!isContinuityRuntimePolicyEnabled() && !isProjectMemoryRuntimePolicyEnabled()) return;

    const sessionId = resolveSessionId(ctx);
    if (state.persistenceOrchestrationRuntimeSnippetBySession.has(sessionId)) return;

    const snippet = await loadSnippet({
      path: resolvePersistenceOrchestrationRuntimePolicyPath(),
      label: "persistence-orchestration",
      extract: extractPersistenceOrchestrationRuntimeSnippet,
    });
    if (snippet) state.persistenceOrchestrationRuntimeSnippetBySession.set(sessionId, snippet);
  };

  return {
    warmContinuityRuntimeSnippet,
    warmProjectMemoryRuntimeSnippet,
    warmPersistenceOrchestrationRuntimeSnippet,
  };
};
