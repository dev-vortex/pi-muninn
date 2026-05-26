/**
 * File intent: adapt pi-mempalace-compatible memory behavior to memory-core ports.
 *
 * This root-owned provider is allowed to understand vendor-compatible memory
 * shapes, but it only accepts an injected backend. That keeps the actual vendor
 * import and host lifecycle concerns out of memory-core while preserving a
 * replaceable compatibility path.
 */

import type {
  CoreMemoryHit,
  CoreMemoryProviderPort,
  CoreMemoryRecallInput,
  CoreMemoryRecallResult,
  CoreMemorySaveInput,
  CoreMemorySaveResult,
  CoreMemorySearchInput,
  CoreMemorySearchResult,
} from "../../../packages/memory-core/src/index.js";

/**
 * Vendor-compatible save input accepted by the provider-local backend adapter.
 */
export interface PiMempalaceBackendStoreInput {
  /** Content persisted by the vendor-compatible backend. */
  content: string;
  /** Project/name bucket used by the backend metadata. */
  project?: string;
  /** Topic bucket used by the backend metadata. */
  topic?: string;
  /** Source marker used by the backend metadata. */
  source?: string;
  /** ISO timestamp used by the backend metadata. */
  timestamp?: string;
  /** Optional importance hint forwarded when supported. */
  importance?: number;
}

/**
 * Vendor-compatible save result normalized by this provider.
 */
export interface PiMempalaceBackendStoreResult {
  /** Vendor-compatible status. */
  status: "stored" | "duplicate";
  /** Vendor/backend memory id. */
  id: string;
}

/**
 * Vendor-compatible memory row shape returned by backend search/recall.
 */
export interface PiMempalaceBackendMemoryHit {
  /** Vendor/backend memory id. */
  id: string;
  /** Memory content; vendor search usually calls this field `text`. */
  text: string;
  /** Project/name bucket. */
  project?: string;
  /** Topic bucket. */
  topic?: string;
  /** Source marker. */
  source?: string;
  /** ISO timestamp. */
  timestamp?: string;
  /** Vendor similarity score when available. */
  similarity?: number;
}

/**
 * Minimal backend surface used by the provider wrapper.
 */
export interface PiMempalaceMemoryBackend {
  /** Persist one memory through a vendor-compatible implementation. */
  store(input: PiMempalaceBackendStoreInput): Promise<PiMempalaceBackendStoreResult>;
  /** Search memories through a vendor-compatible implementation. */
  search(input: {
    query: string;
    project?: string;
    topic?: string;
    limit?: number;
  }): Promise<PiMempalaceBackendMemoryHit[]>;
  /** Recall memories through a vendor-compatible implementation. */
  recall(input: {
    project?: string;
    topic?: string;
    limit?: number;
  }): Promise<PiMempalaceBackendMemoryHit[]>;
}

/**
 * Resolve the provider metadata project/name bucket for one core input.
 */
const resolveProviderProjectName = (input: {
  projectName?: string;
  context: { projectRoot: string };
}): string => input.projectName || input.context.projectRoot;

/**
 * Normalize vendor-compatible status into core result fields.
 */
const buildSaveResult = (result: PiMempalaceBackendStoreResult): CoreMemorySaveResult => ({
  status: "ok",
  id: result.id,
  duplicate: result.status === "duplicate",
  warnings: [],
  diagnostics: {
    provider: "pi-mempalace-compatible",
    providerStatus: result.status,
  },
});

/**
 * Normalize thrown provider failures into core result fields.
 */
const buildErrorBase = (operation: string, error: unknown): {
  status: "error";
  warnings: string[];
  diagnostics: Record<string, unknown>;
} => ({
  status: "error",
  warnings: [error instanceof Error ? error.message : String(error)],
  diagnostics: {
    operation,
    provider: "pi-mempalace-compatible",
  },
});

/**
 * Resolve the best logical lane for a normalized hit.
 */
const resolveHitLane = (input: CoreMemorySearchInput | CoreMemoryRecallInput): CoreMemoryHit["lane"] =>
  input.lanes.includes("project-member") ? "project-member" : "global-curated";

/**
 * Convert one backend hit into the core-owned memory hit DTO.
 */
const normalizeHit = (
  hit: PiMempalaceBackendMemoryHit,
  input: CoreMemorySearchInput | CoreMemoryRecallInput,
): CoreMemoryHit => ({
  id: hit.id,
  lane: resolveHitLane(input),
  content: hit.text,
  projectName: hit.project,
  topic: hit.topic,
  source: hit.source,
  timestamp: hit.timestamp,
  score: hit.similarity,
  semanticSimilarity: hit.similarity,
  metadata: {
    provider: "pi-mempalace-compatible",
  },
});

/**
 * Create a memory-core provider that wraps a pi-mempalace-compatible backend.
 */
export const createPiMempalaceCompatibleMemoryProvider = (
  backend: PiMempalaceMemoryBackend,
): CoreMemoryProviderPort => ({
  save: async (input: CoreMemorySaveInput): Promise<CoreMemorySaveResult> => {
    try {
      const result = await backend.store({
        content: input.content,
        project: resolveProviderProjectName(input),
        topic: input.topic,
        source: input.source || input.lane,
        timestamp: input.timestamp || input.context.now,
        importance: input.importance,
      });

      return buildSaveResult(result);
    } catch (error: unknown) {
      return {
        ...buildErrorBase("save", error),
        id: null,
        duplicate: false,
      };
    }
  },

  search: async (input: CoreMemorySearchInput): Promise<CoreMemorySearchResult> => {
    try {
      const hits = await backend.search({
        query: input.query,
        project: input.projectName,
        topic: input.topic,
        limit: input.limit,
      });

      return {
        status: "ok",
        hits: hits.map((hit) => normalizeHit(hit, input)),
        warnings: [],
        diagnostics: {
          provider: "pi-mempalace-compatible",
          hitCount: hits.length,
        },
      };
    } catch (error: unknown) {
      return {
        ...buildErrorBase("search", error),
        hits: [],
      };
    }
  },

  recall: async (input: CoreMemoryRecallInput): Promise<CoreMemoryRecallResult> => {
    try {
      const hits = await backend.recall({
        project: input.projectName,
        topic: input.topic,
        limit: input.limit,
      });

      return {
        status: "ok",
        hits: hits.map((hit) => normalizeHit(hit, input)),
        warnings: [],
        diagnostics: {
          provider: "pi-mempalace-compatible",
          hitCount: hits.length,
        },
      };
    } catch (error: unknown) {
      return {
        ...buildErrorBase("recall", error),
        hits: [],
      };
    }
  },
});
