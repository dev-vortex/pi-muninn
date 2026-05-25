/**
 * File intent: route memory_save payload targets across L1 and L3 core services.
 *
 * The router preserves the existing payload-target contract while keeping
 * project-member and global-curated persistence behind a shared memory provider
 * boundary.
 */

import type {
  MemoryOperationResult,
  MemorySaveRequest,
} from "../contracts.js";
import type { CoreMemoryProviderPort } from "../ports.js";
import { createGlobalCuratedMemoryService } from "../global-memory/global-curated-memory.js";
import { createProjectMemberMemoryService } from "../project-memory/project-member-memory.js";

/**
 * Dependencies needed by memory-save routing.
 */
export interface MemorySaveRoutingServiceDependencies {
  /** L1/L3 provider used by target-specific services. */
  memoryProvider: Pick<CoreMemoryProviderPort, "save" | "search" | "recall">;
}

/**
 * Normalize arbitrary content fields for routing decisions.
 */
const normalizeText = (value: string | undefined): string =>
  (value || "").trim().replace(/\s+/g, " ");

/**
 * Build a memory operation result with tool-details-friendly diagnostics.
 */
const buildOperationResult = (input: {
  status: MemoryOperationResult["status"];
  text: string;
  details: Record<string, unknown>;
  warnings?: string[];
}): MemoryOperationResult => ({
  status: input.status,
  text: input.text,
  warnings: input.warnings || [],
  diagnostics: input.details,
});

/**
 * Extract status from one target result diagnostics object.
 */
const readRouteStatus = (result: MemoryOperationResult): string => {
  const status = result.diagnostics.status;
  return typeof status === "string" ? status : "unknown";
};

/**
 * Create payload-target memory_save routing around one provider.
 */
export const createMemorySaveRoutingService = (
  dependencies: MemorySaveRoutingServiceDependencies,
): {
  save: (input: MemorySaveRequest) => Promise<MemoryOperationResult>;
} => ({
  save: async (input: MemorySaveRequest): Promise<MemoryOperationResult> => {
    const hasProjectPayload = normalizeText(input.projectContent).length > 0;
    const hasGeneralPayload = normalizeText(input.generalContent).length > 0;

    if (!hasProjectPayload && !hasGeneralPayload) {
      return buildOperationResult({
        status: "error",
        text: "memory_save requires at least one target payload (`project_content` and/or `general_content`).",
        details: {
          status: "blocked-project-curation",
          route: "memory_save_dispatch",
          reason: "missing-target-payload",
        },
      });
    }

    const projectService = createProjectMemberMemoryService({
      memoryProvider: dependencies.memoryProvider,
    });
    const globalService = createGlobalCuratedMemoryService({
      memoryProvider: dependencies.memoryProvider,
    });

    if (hasProjectPayload && !hasGeneralPayload) {
      return projectService.save({
        ...input,
        generalContent: undefined,
      });
    }

    if (!hasProjectPayload && hasGeneralPayload) {
      return globalService.save({
        ...input,
        projectContent: undefined,
      });
    }

    const l1Result = await projectService.save({
      ...input,
      generalContent: undefined,
    });
    const l3Result = await globalService.save({
      ...input,
      projectContent: undefined,
    });
    const l1Status = readRouteStatus(l1Result);
    const l3Status = readRouteStatus(l3Result);
    const l1Stored = l1Status === "stored-project-specific";
    const l3Stored = l3Status === "stored-general" || l3Status === "duplicate-general";
    const status = l1Stored && l3Stored
      ? "stored-target-payload"
      : (l1Stored || l3Stored ? "partial-target-payload" : "blocked-target-payload");

    return buildOperationResult({
      status: l1Result.status === "error" && l3Result.status === "error" ? "error" : "ok",
      text:
        "memory_save payload dispatch executed project and general memory targets " +
        `(project=${l1Status}; general=${l3Status}).`,
      details: {
        status,
        targets: ["project", "general"],
        route: "memory_save_dispatch",
        routes: {
          memory_save_L1: l1Status,
          memory_save_L3: l3Status,
        },
        l1: l1Result.diagnostics,
        l3: l3Result.diagnostics,
      },
      warnings: [...l1Result.warnings, ...l3Result.warnings],
    });
  },
});
