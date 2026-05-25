/**
 * File intent: define shared contracts for extracted `/memory` command modules.
 *
 * Slice 4 keeps behavior stable by passing existing entrypoint callbacks and
 * services into focused command handlers. The dependency bag is intentionally
 * permissive during extraction; later domain slices can narrow each group.
 */

import type { UpstreamMemoryCommandDefinition } from "../../../compat/upstream-extension-runtime.js";
import type { PiExtensionBuildProfile } from "../runtime-types.js";

/**
 * Existing `/memory` command dependencies passed from the package entrypoint.
 */
export interface ExtensionCommandDependencies {
  pi: any;
  profile: PiExtensionBuildProfile;
  sessionStore: any;
  bootstrap: (ctx: any, options?: { explicitUserId?: string }) => Promise<{ ok: boolean; error?: string }>;
  initializeBundledUpstreamCompatibility: () => Promise<void>;
  getBundledUpstreamMemoryCommand: () => UpstreamMemoryCommandDefinition | null;
  renderUpstreamRuntimeSummary: (ctx: any) => Promise<string>;
  resolveProjectRuntime: (ctx: any) => Promise<any | null>;
  buildPromptBriefing: (input: {
    event: unknown;
    runtime: any | null;
    includeContinuity: boolean;
    includeProjectMemory: boolean;
    recordTelemetry?: boolean;
    debugShowBriefing?: (briefing: string) => void;
  }) => Promise<string | null>;
  isContinuityRuntimePolicyEnabled: () => boolean;
  isProjectMemoryRuntimePolicyEnabled: () => boolean;
  isBriefingDebugEnabled: (ctx: any) => boolean;
  setBriefingDebugEnabled: (ctx: any, enabled: boolean) => void;
  buildProjectRuntimeStatusSummary: (runtime: any | null) => { summary: string; details: Record<string, unknown> };
  buildContinuityRuntimeStatusSummary: (runtime: any | null) => { summary: string; details: Record<string, unknown> };
  buildProjectRetrievalStatusSummary: (ctx: any) => { summary: string; details: Record<string, unknown> };
  buildProjectCacheStatusSummary: (runtime: any | null) => Promise<{ summary: string; details: Record<string, unknown> }>;
  getObservabilityTracker: (ctx: any) => any;
  [dependencyName: string]: any;
}
