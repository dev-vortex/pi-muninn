/**
 * File intent: orchestrate prompt-scoped memory/continuity briefing assembly.
 *
 * Core owns prompt signal extraction, section ordering, and telemetry routing;
 * host adapters only bind concrete L0/L2/L3 providers.
 */

import type {
  PromptBriefingRequest,
  PromptBriefingResult,
} from "../contracts.js";
import type {
  ContinuityDataAdapterPort,
  CoreMemoryProviderPort,
  ProjectIndexDataAdapterPort,
  TelemetryPort,
} from "../ports.js";
import { buildContinuityPromptBriefing } from "./continuity-briefing.js";
import { buildMemoryPromptBriefing } from "./memory-briefing.js";
import {
  extractPromptSignalTokens,
  normalizePromptSignalText,
} from "./signal.js";

/**
 * Dependencies used by the core prompt briefing service.
 */
export interface PromptBriefingServiceDependencies {
  /** L0 continuity data adapter. */
  continuityData?: ContinuityDataAdapterPort;
  /** L2 project-index data adapter for project memory rows. */
  projectIndexData?: ProjectIndexDataAdapterPort;
  /** L3 memory provider for global curated/related-user rows. */
  memoryProvider?: Pick<CoreMemoryProviderPort, "search">;
  /** Optional telemetry recorder. */
  telemetry?: TelemetryPort;
}

/**
 * Record continuity briefing telemetry without making briefing injection fail.
 */
const recordContinuityBriefingTelemetry = async (input: {
  telemetry: TelemetryPort;
  request: PromptBriefingRequest;
  briefing: string;
  signalTokenCount: number;
}): Promise<string | null> => {
  try {
    await input.telemetry.record({
      context: input.request.context,
      eventType: "continuity_turn_briefing",
      valueA: input.briefing.length,
      valueB: input.signalTokenCount,
      payloadJson: JSON.stringify({
        promptKey: input.request.context.requestId || "unknown-request",
        signalTokenCount: input.signalTokenCount,
        source: input.request.telemetrySource || "prompt_briefing",
      }),
    });
    return null;
  } catch (error: unknown) {
    return `continuity telemetry event failed: ${error instanceof Error ? error.message : String(error)}`;
  }
};

/**
 * Create the core prompt briefing service.
 */
export const createPromptBriefingService = (
  dependencies: PromptBriefingServiceDependencies,
): {
  build: (input: PromptBriefingRequest) => Promise<PromptBriefingResult>;
} => ({
  build: async (input): Promise<PromptBriefingResult> => {
    const signalText = normalizePromptSignalText(input.prompt);
    const signalTokens = extractPromptSignalTokens(signalText);
    const sections: string[] = [];
    const warnings: string[] = [];

    if (input.includeContinuity && dependencies.continuityData) {
      const briefing = await buildContinuityPromptBriefing({
        continuityData: dependencies.continuityData,
        request: input,
        signalText,
        signalTokens,
      });
      sections.push(briefing);

      if (input.recordTelemetry !== false && dependencies.telemetry) {
        const warning = await recordContinuityBriefingTelemetry({
          telemetry: dependencies.telemetry,
          request: input,
          briefing,
          signalTokenCount: signalTokens.length,
        });
        if (warning) warnings.push(warning);
      }
    }

    if (input.includeProjectMemory) {
      sections.push(await buildMemoryPromptBriefing({
        projectIndexData: dependencies.projectIndexData,
        memoryProvider: dependencies.memoryProvider,
        request: input,
        signalTokens,
      }));
    }

    const briefingText = sections.length > 0 ? sections.join("\n\n") : null;
    return {
      status: briefingText ? "ok" : "unavailable",
      briefingText,
      warnings,
      diagnostics: {
        operation: "buildPromptBriefing",
        implementation: "memory-core",
        signalTokenCount: signalTokens.length,
        sections: sections.length,
      },
    };
  },
});
