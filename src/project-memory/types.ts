/**
 * File intent: define root-package project-memory config and compatibility types.
 *
 * Host-neutral project-memory contracts now live in `packages/memory-core`.
 * Keep Pi/root configuration, identity persistence, checkpoint controls, and
 * store path types here until those concerns are explicitly generalized.
 */

import type {
  ContinuityBriefingMode,
  ProjectMemoryMode,
} from "../../packages/memory-core/src/project-memory/types.js";

export type {
  ContinuityBriefingMode,
  ProjectMemoryMode,
} from "../../packages/memory-core/src/project-memory/types.js";

/**
 * Runtime controls for the continuity briefing injected beside project memory.
 */
export interface ProjectMemoryContinuityBriefingConfig {
  /** Current continuity briefing retrieval strategy. */
  mode: ContinuityBriefingMode;
}

/**
 * Project-memory configuration kept under `${PROJECT}/.agent/memory/pi-muninn.config.json`.
 */
export interface ProjectMemoryLocalModelValidationConfig {
  /** Toggle for local-model shadow validation command path. */
  enabled: boolean;
  /** Default number of project-index candidates to evaluate per run. */
  sampleSize: number;
  /** Minimum candidate length accepted for local-model evaluation. */
  minimumContentLength: number;
  /** Minimum durable similarity threshold for promotion suggestion. */
  minimumDurableSimilarity: number;
  /** Minimum composite margin threshold for promotion suggestion. */
  minimumCompositeScore: number;
}

export interface ProjectMemoryPromotionConfig {
  /** Toggle for deterministic promotion flow from project index to global curated memory. */
  enabled: boolean;
  /** Minimum content length accepted for candidate evaluation. */
  minimumContentLength: number;
  /** Minimum deterministic score required to promote candidate content. */
  minimumScore: number;
  /** Safety guard limiting how many candidates can be promoted per run. */
  maxAcceptedPerRun: number;
  /** Topics considered durable enough to contribute to promotion score. */
  durableTopics: string[];
  /** Sources never eligible for promotion. */
  blockedSources: string[];
  /** Keyword hints that increase promotion confidence. */
  durableKeywords: string[];
  /** Sensitive markers that should not be promoted to global curated memory. */
  sensitiveKeywords: string[];
  /** If true, detected sensitive markers hard-block promotion regardless of score. */
  hardBlockSensitive: boolean;
  /** Local-model shadow validation controls used before global write cutover. */
  localModelValidation: ProjectMemoryLocalModelValidationConfig;
}

/**
 * Runtime SQLite checkpoint policy used to control WAL compaction behavior.
 */
export type ProjectMemoryCheckpointMode = "off" | "shutdown" | "periodic" | "periodic+shutdown";

/**
 * Runtime checkpoint pragma modes supported by `PRAGMA wal_checkpoint(...)`.
 *
 * Note: `TRUNCATE` is reserved for commit-time snapshot policy in git guard.
 * Runtime checkpoints default to lighter `PASSIVE` mode for performance.
 */
export type ProjectMemoryCheckpointPragmaMode = "PASSIVE" | "RESTART";

/**
 * Runtime SQLite checkpoint policy used to control WAL compaction behavior.
 */
export interface ProjectMemoryCheckpointPolicy {
  /** Runtime checkpoint trigger mode. */
  mode: ProjectMemoryCheckpointMode;
  /** Minimum interval between periodic checkpoints. */
  intervalSeconds: number;
  /** Minimum observed memory-write events before periodic checkpointing. */
  minimumWrites: number;
  /** SQLite checkpoint pragma mode. */
  pragmaMode: ProjectMemoryCheckpointPragmaMode;
}

export type ProjectMemoryIdentitySource =
  | "explicit"
  | "env-id"
  | "project-config"
  | "git-email"
  | "git-name"
  | "env-email"
  | "env-username"
  | "os-username"
  | "random-local"
  | "unresolved";

/**
 * Persisted identity metadata for project-member DB ownership behavior.
 */
export interface ProjectMemoryIdentityConfig {
  /** Resolution source used for current `myUserId`. */
  source: ProjectMemoryIdentitySource;
  /** Privacy-safe display label intentionally configured by the user. */
  displayName?: string;
  /** Privacy-safe hash of the identity label used to derive `myUserId`. */
  identityLabelHash?: string;
  /** If true, user id is local-random and must not be committed. */
  isRandomLocal: boolean;
  /** If true, identity source is considered portable across machines. */
  isPortable: boolean;
}

export interface ProjectMemoryConfig {
  /**
   * When `false`, runtime must preserve official pi-mempalace behavior
   * and read/write only `${HOME}/.pi/agent/memory/memories.db`.
   */
  projectMemoryEnabled: boolean;
  /**
   * Runtime retrieval strategy used when project memory is enabled.
   */
  mode: ProjectMemoryMode;
  /**
   * Optional user identifier used for `${PROJECT}/.agent/memory/<my_user_unique_id>.db`.
   */
  myUserId?: string;
  /**
   * Identity metadata used for commit-safety and migration behavior.
   */
  identity?: ProjectMemoryIdentityConfig;
  /**
   * Index maintenance configuration.
   */
  index: {
    autoRebuild: boolean;
    intervalSeconds?: number;
  };
  /**
   * Deterministic policy used by the promotion pipeline.
   */
  promotion: ProjectMemoryPromotionConfig;
  /**
   * Runtime SQLite checkpoint behavior for WAL durability/performance balance.
   */
  checkpoint: ProjectMemoryCheckpointPolicy;
  /**
   * Continuity briefing retrieval strategy for once-per-prompt context.
   */
  continuityBriefing?: ProjectMemoryContinuityBriefingConfig;
}

/**
 * Absolute paths resolved by the project-memory store resolver.
 */
export interface ProjectMemoryStorePaths {
  /** Active scope according to `projectMemoryEnabled`. */
  activeScope: "global-only" | "project-enabled";
  /** Official pi-mempalace home directory path. */
  globalMemoryDir: string;
  /** Official global config path. */
  globalConfigPath: string;
  /** Official global SQLite database path. */
  globalDatabasePath: string;
  /** Project-local memory directory path. */
  projectMemoryDir: string;
  /** Project-local configuration path. */
  projectConfigPath: string;
  /** Current user project-memory database path. */
  projectUserDatabasePath: string;
  /** Project composed/index database path. */
  projectIndexDatabasePath: string;
}

/**
 * Input for project-memory workspace bootstrap.
 */
export interface EnsureProjectWorkspaceInput {
  projectRoot: string;
  /**
   * Optional default overrides merged on top of default configuration
   * only when creating a new config file.
   */
  defaultOverrides?: Partial<ProjectMemoryConfig>;
}
