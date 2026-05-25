/**
 * File intent: define shared dependency contracts for extracted lifecycle hook modules.
 *
 * Slice 2 keeps lifecycle behavior unchanged by passing existing entrypoint
 * closures into focused hook registrars. The contract is intentionally explicit
 * so later slices can replace broad callback dependencies with narrower domain
 * services as code moves out of the package entrypoint.
 */

import type { BundledUpstreamCompatibilityRegistrationResult } from "../../../compat/upstream-extension-runtime.js";
import type { MemoryExtensionRuntimeState } from "../runtime-state.js";

/**
 * Generic pi lifecycle handler shape used by extracted hook factories.
 */
export type LifecycleEventHandler = (event: unknown, ctx: any) => Promise<unknown> | unknown;

/**
 * Minimal outcome returned by project runtime bootstrap.
 */
export interface LifecycleBootstrapResult {
  ok: boolean;
  error?: string;
}

/**
 * Runtime-policy feature switches used by lifecycle hooks.
 */
export interface LifecyclePolicyDependencies {
  isContinuityRuntimePolicyEnabled: () => boolean;
  isProjectMemoryRuntimePolicyEnabled: () => boolean;
  isPersistenceOrchestrationRuntimePolicyEnabled: () => boolean;
  isContinuitySessionSummaryEnabled: () => boolean;
  isContinuityMutationAutoJournalEnabled: () => boolean;
  isContinuityBlockedVerboseEnabled: () => boolean;
}

/**
 * Snippet warmers invoked before prompt/context injection.
 */
export interface LifecycleSnippetDependencies {
  warmPersistenceOrchestrationRuntimeSnippet: (ctx: any) => Promise<void>;
  warmContinuityRuntimeSnippet: (ctx: any) => Promise<void>;
  warmProjectMemoryRuntimeSnippet: (ctx: any) => Promise<void>;
}

/**
 * Existing runtime callbacks used by lifecycle hook modules.
 */
export interface LifecycleRuntimeDependencies {
  bootstrap: (ctx: any) => Promise<LifecycleBootstrapResult>;
  resolveProjectRuntime: (ctx: any) => Promise<any>;
  resolveSessionId: (ctx: any) => string;
  resolveLatestUserRequestKey: (messages: unknown[]) => string;
}

/**
 * Upstream compatibility callbacks needed during startup hooks.
 */
export interface LifecycleCompatibilityDependencies {
  initializeBundledUpstreamCompatibility: () => Promise<void>;
  getBundledUpstream: () => BundledUpstreamCompatibilityRegistrationResult;
}

/**
 * Dynamic briefing callbacks used by lifecycle hooks.
 */
export interface LifecyclePromptBriefingDependencies {
  buildPromptBriefing: (input: {
    event: unknown;
    runtime: any | null;
    includeContinuity: boolean;
    includeProjectMemory: boolean;
    recordTelemetry?: boolean;
    debugShowBriefing?: (briefing: string) => void;
  }) => Promise<string | null>;
}

/**
 * Continuity compliance, evidence, and auto-journal callbacks used by hooks.
 */
export interface LifecycleContinuityDependencies {
  getContinuityComplianceTracker: (ctx: any) => any;
  resetContinuityComplianceTracker: (ctx: any) => void;
  renderContinuityEvidenceSummary: (input: { label: string; paths: Set<string> }) => string;
  runContinuityCompactionLifecycleHygiene: (input: { runtime: any; trigger: "agent_end" | "session_shutdown" }) => void;
  storeSessionContinuitySummary: (input: { ctx: any; runtime: any; pendingMemoryWrites: number }) => Promise<void>;
  logContinuityBlocked: (input: { stage: string; reason: string; detail?: string; ctx?: any }) => void;
  readObjectStringField: (input: unknown, field: string) => string | null;
  normalizeContinuityTrackedPath: (input: { ctx: any; rawPath: string }) => string | null;
  recordContinuityEvidencePath: (input: { target: Set<string>; pathValue: string | null }) => void;
  decodeContinuityWriteSignalFromToolInput: (input: { ctx: any; toolInput: unknown }) => any;
  recordContinuityArtifactCoverageFromContent: (input: {
    content: string;
    artifactPaths: Set<string>;
    coverageTarget: Set<string>;
  }) => void;
  recordContinuityArtifactCoverageFromSourceRefs: (input: {
    sourceRefs: string[];
    artifactPaths: Set<string>;
    coverageTarget: Set<string>;
  }) => void;
  continuityContentHasPathEvidence: (input: { content: string; paths: Set<string> }) => boolean;
  continuitySourceRefsHavePathEvidence: (input: { sourceRefs: string[]; paths: Set<string> }) => boolean;
  continuityHasUserIntentEvidence: (input: { content: string; sourceRefs: string[] }) => boolean;
  buildAutomaticContinuityContentFromToolResult: (input: { toolName: string; toolInput: unknown }) => string | null;
  persistAutomaticContinuityDualWrite: (input: {
    databasePath: string;
    section: "PROGRESS";
    provenance: "TOOL";
    certainty: "CONFIRMED";
    content: string;
  }) => Promise<any>;
}

/**
 * Runtime checkpoint callbacks used by memory-write lifecycle hooks.
 */
export interface LifecycleCheckpointDependencies {
  getCheckpointTracker: (ctx: any) => any;
  recordRuntimeMemoryWrite: (tracker: any) => void;
  runPeriodicCheckpointIfNeeded: (input: any) => any;
  runShutdownCheckpointIfEnabled: (input: any) => any;
  resolveCheckpointDatabasePaths: (input: any) => string[];
  warnCheckpointFailures: (failures: string[], reason: "periodic" | "shutdown") => void;
}

/**
 * Shared constants used by lifecycle hook modules.
 */
export interface LifecycleConstants {
  memoryWriteToolNames: ReadonlySet<string>;
  continuityActivityToolNames: ReadonlySet<string>;
  continuityExplicitWriteToolNames: ReadonlySet<string>;
  continuitySemanticSectionSet: ReadonlySet<unknown>;
  continuitySourceRefRequiredSectionSet: ReadonlySet<unknown>;
}

/**
 * Full dependency bundle for lifecycle hook registration.
 */
export interface LifecycleHookDependencies {
  pi: any;
  state: MemoryExtensionRuntimeState;
  constants: LifecycleConstants;
  policies: LifecyclePolicyDependencies;
  snippets: LifecycleSnippetDependencies;
  runtime: LifecycleRuntimeDependencies;
  compatibility: LifecycleCompatibilityDependencies;
  promptBriefings: LifecyclePromptBriefingDependencies;
  continuity: LifecycleContinuityDependencies;
  checkpoint: LifecycleCheckpointDependencies;
}
