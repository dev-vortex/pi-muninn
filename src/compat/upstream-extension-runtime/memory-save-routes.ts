/**
 * File intent: upstream-compatible memory_save payload route execution.
 *
 * This module owns the L1 project route, L3 general route, compatibility-mode
 * forwarding, and dual-target aggregation while preserving public result text.
 */

import path from "node:path";

import { createPiMempalaceCompatibleMemoryProvider } from "../../memory-providers/pi-mempalace-compatible/index.js";
import { createMemoryCore } from "../../../packages/memory-core/src/index.js";
import { loadProjectMemoryConfig } from "../../project-memory/config.js";
import { resolveProjectMemoryStorePaths } from "../../project-memory/store-resolver.js";
import { resolveProjectUserId } from "../../project-memory/user-id.js";
import { resolveContextCwd } from "./environment.js";
import {
  readMemorySavePayloadContract,
  type MemorySavePayloadContract,
} from "./payload-contracts.js";
import {
  buildTextToolResult,
  readTextToolResultStatus,
  readUnknownToolResultStatus,
  type TextToolResult,
} from "./text-tool-result.js";
import type { BundledUpstreamRuntimeModeStatus } from "./types.js";
import {
  ensureVendorCompatibleProjectUserMemorySchema,
  resolveProjectUserVendorStore,
} from "./vendor-project-store.js";

export const executeMemorySaveL1 = async (input: {
  projectContent: string;
  projectTopic: string | null;
  projectImportance: number | null;
  ctx: unknown;
}): Promise<TextToolResult> => {
  if (input.projectContent.trim().length === 0) {
    return buildTextToolResult({
      text: "memory_save project route requires non-empty project_content.",
      details: {
        status: "blocked-project-curation",
        target: "project",
        route: "memory_save_L1",
        reason: "invalid-project-payload",
      },
    });
  }

  const cwd = resolveContextCwd(input.ctx);

  try {
    const config = await loadProjectMemoryConfig(cwd);
    const resolvedUserId = resolveProjectUserId({
      projectConfigUserId: config.myUserId,
      projectRoot: cwd,
    });

    if (!resolvedUserId.userId) {
      return buildTextToolResult({
        text: "memory_save project route could not resolve project user id. Configure PI_MEMORY_USER_ID or project myUserId.",
        details: {
          status: "blocked-project-curation",
          target: "project",
          route: "memory_save_L1",
          reason: "project-user-id-unresolved",
          source: resolvedUserId.source,
        },
      });
    }

    const storePaths = resolveProjectMemoryStorePaths({
      projectRoot: cwd,
      config,
      userId: resolvedUserId.userId,
    });

    const topic = input.projectTopic || "general";
    const timestamp = new Date().toISOString();

    ensureVendorCompatibleProjectUserMemorySchema(storePaths.projectUserDatabasePath);

    const vendorStoreResult = await resolveProjectUserVendorStore(storePaths.projectUserDatabasePath);

    if (!vendorStoreResult.ok) {
      return buildTextToolResult({
        text: `memory_save project route failed: vendor MemoryStore unavailable (${vendorStoreResult.error}).`,
        details: {
          status: "error-project-specific-route",
          target: "project",
          route: "memory_save_L1",
          reason: "vendor-store-unavailable",
          vendorUnavailableReason: vendorStoreResult.error,
          databasePath: storePaths.projectUserDatabasePath,
        },
      });
    }

    vendorStoreResult.store.load();

    const memoryProvider = createPiMempalaceCompatibleMemoryProvider({
      store: async (storeInput) => {
        const result = await vendorStoreResult.store.store({
          ...storeInput,
          session_id: "",
        });

        return {
          status: result.status === "duplicate" ? "duplicate" as const : "stored" as const,
          id: result.id,
        };
      },
      search: async (searchInput) => {
        if (typeof vendorStoreResult.store.search !== "function") {
          return [];
        }

        const result = await vendorStoreResult.store.search(searchInput.query, {
          project: searchInput.project,
          topic: searchInput.topic,
          n_results: searchInput.limit,
        });
        return result.results;
      },
      recall: async (recallInput) => {
        if (typeof vendorStoreResult.store.recall !== "function") {
          return [];
        }

        const result = vendorStoreResult.store.recall({
          project: recallInput.project,
          topic: recallInput.topic,
          n_results: recallInput.limit,
        });
        return result.results;
      },
    });

    const core = createMemoryCore({ memoryProvider });
    const result = await core.memorySave({
      context: {
        projectRoot: cwd,
        userId: resolvedUserId.userId,
        now: timestamp,
      },
      projectName: path.basename(cwd) || "project",
      projectContent: input.projectContent,
      projectTopic: topic,
      importance: input.projectImportance ?? 0.8,
    });

    return buildTextToolResult({
      text: result.text,
      details: {
        ...result.diagnostics,
        userIdSource: resolvedUserId.source,
        databasePath: storePaths.projectUserDatabasePath,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    return buildTextToolResult({
      text: `memory_save project route failed: ${message}`,
      details: {
        status: "error-project-specific-route",
        target: "project",
        route: "memory_save_L1",
        error: message,
      },
    });
  }
};

/**
 * Execute one upstream memory_save call from payload-target dispatch.
 */
export const executeUpstreamMemorySaveRoute = async (input: {
  executeArgs: any[];
  originalExecute: (...args: any[]) => Promise<unknown> | unknown;
  content: string;
  topic: string | null;
  importance: number | null;
  projectOverride?: string;
}): Promise<unknown> => {
  const forwardedArgs = [...input.executeArgs];
  const originalToolInput = typeof forwardedArgs[1] === "object" && forwardedArgs[1] !== null
    ? forwardedArgs[1] as Record<string, unknown>
    : {};

  forwardedArgs[1] = {
    ...originalToolInput,
    content: input.content,
    ...(input.topic ? { topic: input.topic } : {}),
    ...(typeof input.importance === "number" ? { importance: input.importance } : {}),
    ...(input.projectOverride ? { project: input.projectOverride } : {}),
  };

  return input.originalExecute(...forwardedArgs);
};

/**
 * Read status field from unknown tool-result payload.
 */

export const executeMemorySaveL3 = async (input: {
  mode: BundledUpstreamRuntimeModeStatus;
  ctx: unknown;
  executeArgs: any[];
  originalExecute: (...args: any[]) => Promise<unknown> | unknown;
  generalContent: string;
  generalTopic: string | null;
  generalImportance: number | null;
}): Promise<TextToolResult> => {
  if (input.generalContent.trim().length === 0) {
    return buildTextToolResult({
      text: "memory_save general route requires non-empty general_content.",
      details: {
        status: "blocked-project-curation",
        target: "general",
        route: "memory_save_L3",
        reason: "invalid-general-payload",
      },
    });
  }

  try {
    let lastUpstreamResult: unknown = null;
    const memoryProvider = createPiMempalaceCompatibleMemoryProvider({
      store: async (storeInput) => {
        lastUpstreamResult = await executeUpstreamMemorySaveRoute({
          executeArgs: input.executeArgs,
          originalExecute: input.originalExecute,
          content: storeInput.content,
          topic: storeInput.topic || input.generalTopic,
          importance: typeof storeInput.importance === "number" ? storeInput.importance : input.generalImportance,
          projectOverride: "general",
        });

        const upstreamStatus = readUnknownToolResultStatus(lastUpstreamResult);
        return {
          status: upstreamStatus === "duplicate" ? "duplicate" as const : "stored" as const,
          id: "global-memory-upstream",
        };
      },
      search: async () => [],
      recall: async () => [],
    });
    const core = createMemoryCore({ memoryProvider });
    const result = await core.memorySave({
      context: {
        projectRoot: resolveContextCwd(input.ctx),
        userId: null,
      },
      generalContent: input.generalContent,
      generalTopic: input.generalTopic || undefined,
      importance: input.generalImportance ?? undefined,
    });

    return buildTextToolResult({
      text: result.text,
      details: {
        ...result.diagnostics,
        importance: input.generalImportance,
        upstreamResult: lastUpstreamResult,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    return buildTextToolResult({
      text: `memory_save general route failed: ${message}`,
      details: {
        status: "error-general-route",
        target: "general",
        route: "memory_save_L3",
        error: message,
      },
    });
  }
};

/**
 * Run payload-target dispatch through upstream memory_save in compatibility mode.
 */
export const executeCompatibilityMemorySave = async (input: {
  payload: MemorySavePayloadContract;
  executeArgs: any[];
  originalExecute: (...args: any[]) => Promise<unknown> | unknown;
}): Promise<unknown> => {
  const hasProjectPayload = input.payload.projectContent !== null;
  const hasGeneralPayload = input.payload.generalContent !== null;

  if (hasProjectPayload && !hasGeneralPayload) {
    return executeUpstreamMemorySaveRoute({
      executeArgs: input.executeArgs,
      originalExecute: input.originalExecute,
      content: input.payload.projectContent || "",
      topic: input.payload.projectTopic,
      importance: input.payload.projectImportance,
    });
  }

  if (!hasProjectPayload && hasGeneralPayload) {
    return executeUpstreamMemorySaveRoute({
      executeArgs: input.executeArgs,
      originalExecute: input.originalExecute,
      content: input.payload.generalContent || "",
      topic: input.payload.generalTopic,
      importance: input.payload.generalImportance,
    });
  }

  const projectResult = await executeUpstreamMemorySaveRoute({
    executeArgs: input.executeArgs,
    originalExecute: input.originalExecute,
    content: input.payload.projectContent || "",
    topic: input.payload.projectTopic,
    importance: input.payload.projectImportance,
  });
  const generalResult = await executeUpstreamMemorySaveRoute({
    executeArgs: input.executeArgs,
    originalExecute: input.originalExecute,
    content: input.payload.generalContent || "",
    topic: input.payload.generalTopic,
    importance: input.payload.generalImportance,
  });

  return buildTextToolResult({
    text: "memory_save compatibility dispatch stored project and general payload targets via upstream memory_save.",
    details: {
      status: "stored-compatibility-multi-target",
      route: "memory_save_compatibility_dispatch",
      projectResult,
      generalResult,
    },
  });
};

/**
 * Dispatch memory_save payload targets into memory_save_L1 and/or memory_save_L3 routes.
 */
export const executePayloadRoutedMemorySave = async (input: {
  toolInput: unknown;
  ctx: unknown;
  mode: BundledUpstreamRuntimeModeStatus;
  executeArgs: any[];
  originalExecute: (...args: any[]) => Promise<unknown> | unknown;
}): Promise<unknown> => {
  const payload = readMemorySavePayloadContract(input.toolInput);

  if (payload.legacyFields.length > 0) {
    return buildTextToolResult({
      text:
        "memory_save legacy fields are no longer supported in this development contract. " +
        "Use project_content and/or general_content payload fields.",
      details: {
        status: "blocked-project-curation",
        route: "memory_save_dispatch",
        reason: "legacy-contract-removed",
        legacyFields: payload.legacyFields,
      },
    });
  }

  const hasProjectPayload = payload.projectContent !== null;
  const hasGeneralPayload = payload.generalContent !== null;

  if (!hasProjectPayload && !hasGeneralPayload) {
    return buildTextToolResult({
      text:
        "memory_save requires at least one target payload (`project_content` and/or `general_content`).",
      details: {
        status: "blocked-project-curation",
        route: "memory_save_dispatch",
        reason: "missing-target-payload",
      },
    });
  }

  if (input.mode.mode === "compatibility") {
    return executeCompatibilityMemorySave({
      payload,
      executeArgs: input.executeArgs,
      originalExecute: input.originalExecute,
    });
  }

  if (hasProjectPayload && !hasGeneralPayload) {
    return executeMemorySaveL1({
      projectContent: payload.projectContent || "",
      projectTopic: payload.projectTopic,
      projectImportance: payload.projectImportance,
      ctx: input.ctx,
    });
  }

  if (!hasProjectPayload && hasGeneralPayload) {
    return executeMemorySaveL3({
      mode: input.mode,
      ctx: input.ctx,
      executeArgs: input.executeArgs,
      originalExecute: input.originalExecute,
      generalContent: payload.generalContent || "",
      generalTopic: payload.generalTopic,
      generalImportance: payload.generalImportance,
    });
  }

  const l1Result = await executeMemorySaveL1({
    projectContent: payload.projectContent || "",
    projectTopic: payload.projectTopic,
    projectImportance: payload.projectImportance,
    ctx: input.ctx,
  });
  const l3Result = await executeMemorySaveL3({
    mode: input.mode,
    ctx: input.ctx,
    executeArgs: input.executeArgs,
    originalExecute: input.originalExecute,
    generalContent: payload.generalContent || "",
    generalTopic: payload.generalTopic,
    generalImportance: payload.generalImportance,
  });

  const l1Status = readTextToolResultStatus(l1Result) || "unknown";
  const l3Status = readTextToolResultStatus(l3Result) || "unknown";
  const l1Stored = l1Status === "stored-project-specific";
  const l3Stored = l3Status === "stored-general" || l3Status === "duplicate-general";

  const status = l1Stored && l3Stored
    ? "stored-target-payload"
    : (l1Stored || l3Stored ? "partial-target-payload" : "blocked-target-payload");

  return buildTextToolResult({
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
      l1: l1Result.details,
      l3: l3Result.details,
    },
  });
};

/**
 * Build user-facing warning string when standalone upstream package is configured.
 */
