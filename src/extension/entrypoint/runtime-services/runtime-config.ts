/**
 * File intent: resolve entrypoint runtime flags, policy paths, and compaction budgets.
 *
 * The functions here preserve environment-variable behavior while making the
 * package entrypoint import static, documented runtime configuration helpers.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ContinuityCompactionRequestProfile } from "../runtime-state.js";
import {
  CONTINUITY_BLOCKED_VERBOSE_ENV_FLAG,
  CONTINUITY_COMPACTION_LONG_MAX_APPLIES_PER_REQUEST,
  CONTINUITY_COMPACTION_LONG_MAX_PREVIEWS_PER_REQUEST,
  CONTINUITY_COMPACTION_MAX_PREVIEW_REVISIONS,
  CONTINUITY_COMPACTION_PROFILE_SELECTION_MODE_ENV_FLAG,
  CONTINUITY_COMPACTION_REQUEST_PROFILE_ENV_FLAG,
  CONTINUITY_COMPACTION_STRICT_MAX_APPLIES_PER_REQUEST,
  CONTINUITY_COMPACTION_STRICT_MAX_PREVIEWS_PER_REQUEST,
  CONTINUITY_MUTATION_AUTO_JOURNAL_ENV_FLAG,
  CONTINUITY_RUNTIME_ENV_FLAG,
  CONTINUITY_SESSION_SUMMARY_ENV_FLAG,
  PERSISTENCE_ORCHESTRATION_RUNTIME_ENV_FLAG,
  PROJECT_MEMORY_RUNTIME_ENV_FLAG,
  type ContinuityCompactionProfileSelectionMode,
} from "./constants.js";

const resolveRuntimePolicyAssetPath = (fileName: string): string => {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Source tree and TypeScript support chunks keep policies beside entrypoint source.
    path.resolve(moduleDir, "../runtime-policies", fileName),
    // Generated index.js may inline this module at the extension root.
    path.resolve(moduleDir, "runtime-policies", fileName),
    // TypeScript package export keeps policies under the Pi extension resource tree.
    path.resolve(moduleDir, "../../../../extensions/pi-muninn/runtime-policies", fileName),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates.at(-1)!;
};

/**
 * Resolve package-owned continuity runtime policy template path.
 */
export const resolveContinuityRuntimePolicyPath = (): string =>
  resolveRuntimePolicyAssetPath("continuity-runtime-policy.md");

/**
 * Resolve package-owned project-memory runtime policy template path.
 */
export const resolveProjectMemoryRuntimePolicyPath = (): string =>
  resolveRuntimePolicyAssetPath("project-memory-runtime-policy.md");

/**
 * Resolve package-owned persistence orchestration runtime policy template path.
 */
export const resolvePersistenceOrchestrationRuntimePolicyPath = (): string =>
  resolveRuntimePolicyAssetPath("persistence-orchestration-runtime-policy.md");

/**
 * Parse environment boolean flags using the original permissive on/off values.
 */
export const parseBooleanEnvFlag = (input: {
  name: string;
  defaultValue: boolean;
}): boolean => {
  const raw = process.env[input.name];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return input.defaultValue;
  }

  const normalized = raw.trim().toLowerCase();
  if (["0", "false", "off", "no", "disabled"].includes(normalized)) {
    return false;
  }

  if (["1", "true", "on", "yes", "enabled"].includes(normalized)) {
    return true;
  }

  return input.defaultValue;
};

/**
 * Runtime policy injection flag for continuity.
 */
export const isContinuityRuntimePolicyEnabled = (): boolean =>
  parseBooleanEnvFlag({
    name: CONTINUITY_RUNTIME_ENV_FLAG,
    defaultValue: true,
  });

/**
 * Runtime policy injection flag for project memory.
 */
export const isProjectMemoryRuntimePolicyEnabled = (): boolean =>
  parseBooleanEnvFlag({
    name: PROJECT_MEMORY_RUNTIME_ENV_FLAG,
    defaultValue: true,
  });

/**
 * Runtime policy injection flag for persistence orchestration.
 */
export const isPersistenceOrchestrationRuntimePolicyEnabled = (): boolean =>
  parseBooleanEnvFlag({
    name: PERSISTENCE_ORCHESTRATION_RUNTIME_ENV_FLAG,
    defaultValue: true,
  });

/**
 * Continuity vector indexing is mandatory for current runtime behavior.
 */
export const isContinuityVectorEnabled = (): boolean => true;

/**
 * Runtime flag for session summary writes.
 */
export const isContinuitySessionSummaryEnabled = (): boolean =>
  parseBooleanEnvFlag({
    name: CONTINUITY_SESSION_SUMMARY_ENV_FLAG,
    defaultValue: true,
  });

/**
 * Runtime flag for automatic continuity journaling.
 */
export const isContinuityMutationAutoJournalEnabled = (): boolean =>
  parseBooleanEnvFlag({
    name: CONTINUITY_MUTATION_AUTO_JOURNAL_ENV_FLAG,
    defaultValue: false,
  });

/**
 * Runtime flag for verbose continuity-blocked diagnostics.
 */
export const isContinuityBlockedVerboseEnabled = (): boolean =>
  parseBooleanEnvFlag({
    name: CONTINUITY_BLOCKED_VERBOSE_ENV_FLAG,
    defaultValue: false,
  });

/**
 * Resolve operator/auto long-request compaction profile selection mode.
 */
export const resolveContinuityCompactionProfileSelectionMode = (): ContinuityCompactionProfileSelectionMode => {
  const raw = process.env[CONTINUITY_COMPACTION_PROFILE_SELECTION_MODE_ENV_FLAG];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return "auto_detect_long_request";
  }

  const normalized = raw.trim().toLowerCase();
  return normalized === "operator_only" || normalized === "operator-only"
    ? "operator_only"
    : "auto_detect_long_request";
};

/**
 * Resolve operator-requested compaction profile override.
 */
export const resolveContinuityCompactionRequestProfileOverride = (): ContinuityCompactionRequestProfile | null => {
  const raw = process.env[CONTINUITY_COMPACTION_REQUEST_PROFILE_ENV_FLAG];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === "strict") {
    return "strict";
  }

  if (normalized === "long-request" || normalized === "long_request") {
    return "long-request";
  }

  return null;
};

/**
 * Resolve bounded request budgets for one compaction profile.
 */
export const resolveContinuityCompactionRequestBudgets = (profile: ContinuityCompactionRequestProfile): {
  maxPreviewsPerRequest: number;
  maxAppliesPerRequest: number;
  maxPreviewRevisionsPerRequest: number;
} => {
  if (profile === "long-request") {
    return {
      maxPreviewsPerRequest: CONTINUITY_COMPACTION_LONG_MAX_PREVIEWS_PER_REQUEST,
      maxAppliesPerRequest: CONTINUITY_COMPACTION_LONG_MAX_APPLIES_PER_REQUEST,
      maxPreviewRevisionsPerRequest: CONTINUITY_COMPACTION_MAX_PREVIEW_REVISIONS,
    };
  }

  return {
    maxPreviewsPerRequest: CONTINUITY_COMPACTION_STRICT_MAX_PREVIEWS_PER_REQUEST,
    maxAppliesPerRequest: CONTINUITY_COMPACTION_STRICT_MAX_APPLIES_PER_REQUEST,
    maxPreviewRevisionsPerRequest: CONTINUITY_COMPACTION_MAX_PREVIEW_REVISIONS,
  };
};
