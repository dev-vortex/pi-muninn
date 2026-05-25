/**
 * File intent: shared contracts for bundled upstream compatibility runtime.
 *
 * These types are exported through the stable `src/compat/upstream-extension-runtime.ts`
 * barrel so callers do not need to know the internal module split.
 */

import type { UpstreamPiMempalaceConflictResult } from "../upstream-package-conflict.js";

export type BundledUpstreamRuntimeMode =
  | "compatibility"
  | "project-curation"
  | "standalone-conflict";

/**
 * Evaluated runtime status for bundled upstream compatibility behavior.
 */
export interface BundledUpstreamRuntimeModeStatus {
  mode: BundledUpstreamRuntimeMode;
  allowGlobalLifecycleHooks: boolean;
  reason: string;
  conflictSources: string[];
}

/**
 * Minimal upstream memory command definition captured from vendored extension.
 */
export interface UpstreamMemoryCommandDefinition {
  description?: string;
  handler: (args: unknown, ctx: any) => Promise<unknown> | unknown;
  getArgumentCompletions?: (prefix: string) => Array<{
    label: string;
    value: string;
    type: "text";
  }>;
}

/**
 * Minimal upstream tool definition used for registration proxying.
 */
export interface UpstreamToolDefinition {
  name?: string;
  execute?: (...args: any[]) => Promise<unknown> | unknown;
  [key: string]: unknown;
}

/**
 * Result of attempting to register bundled upstream extension behavior.
 */
export interface BundledUpstreamCompatibilityRegistrationResult {
  status: "loaded" | "skipped-conflict" | "skipped-missing-api" | "skipped-load-error";
  conflict: UpstreamPiMempalaceConflictResult;
  warning?: string;
  capturedMemoryCommand: UpstreamMemoryCommandDefinition | null;
}
