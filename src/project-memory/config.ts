/**
 * File intent: load, normalize, migrate, and persist project-memory config.
 *
 * This file owns the `.agent/memory/pi-muninn.config.json` contract,
 * default values, legacy read-only fallback behavior, local `.gitignore`
 * generation, and project workspace bootstrap helpers. Keep config shape and
 * migration rules here instead of scattering filesystem/config writes through
 * extension command handlers.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  ContinuityBriefingMode,
  EnsureProjectWorkspaceInput,
  ProjectMemoryCheckpointPolicy,
  ProjectMemoryConfig,
  ProjectMemoryIdentityConfig,
  ProjectMemoryIdentitySource,
  ProjectMemoryPromotionConfig,
} from "./types.js";

/**
 * Directory under project root that stores project-memory artifacts.
 */
export const PROJECT_MEMORY_DIRECTORY = ".agent/memory";
/**
 * Extension-owned configuration filename for project-memory mode.
 *
 * Decision: avoid generic `config.json` ownership collisions with upstream
 * pi-mempalace or other extensions that may also use `.agent/memory`.
 */
export const PROJECT_MEMORY_CONFIG_FILENAME = "pi-muninn.config.json";
/**
 * Legacy project-memory config filename kept for read-only fallback/migration.
 */
export const LEGACY_PROJECT_MEMORY_CONFIG_FILENAME = "config.json";
/**
 * Repo-local `.gitignore` file generated under `${PROJECT}/.agent/memory`.
 */
export const PROJECT_MEMORY_LOCAL_GITIGNORE_FILENAME = ".gitignore";
/**
 * Environment flag that temporarily overrides continuity briefing retrieval mode.
 */
export const PROJECT_CONTINUITY_BRIEFING_MODE_ENV_FLAG = "PI_CONTINUITY_BRIEFING_MODE";

/**
 * Build the default project-memory configuration.
 *
 * Decision: keep project memory disabled by default so official pi-mempalace
 * behavior remains intact until the user explicitly enables project mode.
 */
export const buildDefaultProjectMemoryConfig = (): ProjectMemoryConfig => ({
  projectMemoryEnabled: false,
  mode: "index-first",
  index: {
    autoRebuild: false,
  },
  promotion: {
    enabled: true,
    minimumContentLength: 40,
    minimumScore: 0.65,
    maxAcceptedPerRun: 200,
    durableTopics: [
      "general",
      "trait",
      "traits",
      "preference",
      "preferences",
      "principle",
      "principles",
      "standard",
      "standards",
      "process",
      "identity",
    ],
    blockedSources: ["auto-capture"],
    durableKeywords: [
      "always",
      "never",
      "prefer",
      "preferred",
      "default",
      "policy",
      "principle",
      "standard",
      "guideline",
      "trait",
    ],
    sensitiveKeywords: [
      "password",
      "secret",
      "token",
      "api key",
      "private key",
      "ssh key",
      "credential",
      "ssn",
      "social security",
      "credit card",
      "card number",
      "bank account",
    ],
    hardBlockSensitive: true,
    localModelValidation: {
      enabled: true,
      sampleSize: 20,
      minimumContentLength: 40,
      minimumDurableSimilarity: 0.33,
      minimumCompositeScore: 0.06,
    },
  },
  checkpoint: {
    mode: "off",
    intervalSeconds: 600,
    minimumWrites: 50,
    pragmaMode: "PASSIVE",
  },
  continuityBriefing: {
    // Semantic is the release default; briefing rendering falls back to lexical
    // when vector search is unavailable so startup stays resilient.
    mode: "semantic",
  },
});

/**
 * Resolve the project-local memory directory path.
 */
export const resolveProjectMemoryDirectory = (projectRoot: string): string =>
  path.join(projectRoot, PROJECT_MEMORY_DIRECTORY);

/**
 * Resolve the active project-local extension config path.
 */
export const resolveProjectMemoryConfigPath = (projectRoot: string): string =>
  path.join(resolveProjectMemoryDirectory(projectRoot), PROJECT_MEMORY_CONFIG_FILENAME);

/**
 * Resolve the legacy project-local config path used only as a read fallback.
 */
export const resolveLegacyProjectMemoryConfigPath = (projectRoot: string): string =>
  path.join(resolveProjectMemoryDirectory(projectRoot), LEGACY_PROJECT_MEMORY_CONFIG_FILENAME);

/**
 * In-process write queue keyed by config path.
 *
 * Decision: serialize config mutations per workspace so concurrent runtime
 * toggles/user-id persistence cannot clobber each other with stale snapshots.
 */
const projectConfigWriteQueueByPath = new Map<string, Promise<void>>();

/**
 * Run one project-config operation under a per-config-path in-process lock.
 */
const runProjectConfigWriteLocked = async <T>(input: {
  configPath: string;
  operation: () => Promise<T>;
}): Promise<T> => {
  const queuedBefore = projectConfigWriteQueueByPath.get(input.configPath) || Promise.resolve();

  let releaseCurrent: (() => void) | undefined;
  const currentGate = new Promise<void>((resolve) => {
    releaseCurrent = () => resolve();
  });

  const queuedCurrent = queuedBefore.then(async () => currentGate);
  projectConfigWriteQueueByPath.set(input.configPath, queuedCurrent);

  await queuedBefore;

  try {
    return await input.operation();
  } finally {
    releaseCurrent?.();

    if (projectConfigWriteQueueByPath.get(input.configPath) === queuedCurrent) {
      projectConfigWriteQueueByPath.delete(input.configPath);
    }
  }
};

/**
 * Persist one normalized project-memory config to disk.
 */
const persistProjectMemoryConfig = async (input: {
  projectRoot: string;
  config: ProjectMemoryConfig;
}): Promise<ProjectMemoryConfig> => {
  const memoryDir = resolveProjectMemoryDirectory(input.projectRoot);
  const configPath = resolveProjectMemoryConfigPath(input.projectRoot);

  await mkdir(memoryDir, { recursive: true });

  const normalized = normalizeProjectMemoryConfig(input.config);
  await writeFile(configPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");

  return normalized;
};

/**
 * Normalize unknown input to a safe `ProjectMemoryConfig` shape.
 *
 * This function is intentionally defensive so corrupted/manual edits to
 * project config files don't crash startup.
 */
const normalizeStringList = (input: unknown, fallback: string[]): string[] => {
  if (!Array.isArray(input)) {
    return fallback;
  }

  const normalized = input
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);

  return normalized.length > 0
    ? [...new Set(normalized)]
    : fallback;
};

/**
 * Normalize unknown identity source into supported enum values.
 */
/**
 * Normalize unknown continuity briefing mode values.
 */
export const normalizeContinuityBriefingMode = (mode: unknown): ContinuityBriefingMode | null => {
  if (mode === "lexical" || mode === "semantic") {
    return mode;
  }

  return null;
};

const normalizeIdentitySource = (source: unknown): ProjectMemoryIdentitySource => {
  switch (source) {
    case "explicit":
    case "env-id":
    case "project-config":
    case "git-email":
    case "git-name":
    case "env-email":
    case "env-username":
    case "os-username":
    case "random-local":
    case "unresolved":
      return source;
    default:
      return "unresolved";
  }
};

/**
 * Normalize unknown input to a safe `ProjectMemoryConfig` shape.
 *
 * This function is intentionally defensive so corrupted/manual edits to
 * project config files don't crash startup.
 */
export const normalizeProjectMemoryConfig = (
  input: unknown,
): ProjectMemoryConfig => {
  const defaults = buildDefaultProjectMemoryConfig();

  if (!input || typeof input !== "object") {
    return defaults;
  }

  const raw = input as Partial<ProjectMemoryConfig>;
  const rawIndex: Partial<ProjectMemoryConfig["index"]> =
    raw.index && typeof raw.index === "object" ? raw.index : {};
  const rawPromotion: Partial<ProjectMemoryPromotionConfig> =
    raw.promotion && typeof raw.promotion === "object" ? raw.promotion : {};
  const rawLocalModelValidation: Partial<ProjectMemoryPromotionConfig["localModelValidation"]> =
    rawPromotion.localModelValidation && typeof rawPromotion.localModelValidation === "object"
      ? rawPromotion.localModelValidation
      : {};
  const rawCheckpoint: Partial<ProjectMemoryCheckpointPolicy> =
    raw.checkpoint && typeof raw.checkpoint === "object" ? raw.checkpoint : {};
  const rawContinuityBriefing = raw.continuityBriefing && typeof raw.continuityBriefing === "object"
    ? raw.continuityBriefing as { mode?: unknown }
    : {};
  const rawIdentity: Partial<ProjectMemoryIdentityConfig> =
    raw.identity && typeof raw.identity === "object" ? raw.identity : {};

  const mode = raw.mode === "fanout" || raw.mode === "index-first"
    ? raw.mode
    : defaults.mode;

  const myUserId = typeof raw.myUserId === "string" && raw.myUserId.trim().length > 0
    ? raw.myUserId.trim()
    : undefined;

  const intervalSeconds = typeof rawIndex.intervalSeconds === "number" && rawIndex.intervalSeconds > 0
    ? Math.floor(rawIndex.intervalSeconds)
    : undefined;

  const minimumContentLength =
    typeof rawPromotion.minimumContentLength === "number" && rawPromotion.minimumContentLength >= 1
      ? Math.floor(rawPromotion.minimumContentLength)
      : defaults.promotion.minimumContentLength;

  const minimumScore =
    typeof rawPromotion.minimumScore === "number"
      ? Math.max(0, Math.min(1, rawPromotion.minimumScore))
      : defaults.promotion.minimumScore;

  const maxAcceptedPerRun =
    typeof rawPromotion.maxAcceptedPerRun === "number" && rawPromotion.maxAcceptedPerRun >= 1
      ? Math.floor(rawPromotion.maxAcceptedPerRun)
      : defaults.promotion.maxAcceptedPerRun;

  const localModelSampleSize =
    typeof rawLocalModelValidation.sampleSize === "number" && rawLocalModelValidation.sampleSize >= 1
      ? Math.floor(rawLocalModelValidation.sampleSize)
      : defaults.promotion.localModelValidation.sampleSize;

  const localModelMinimumContentLength =
    typeof rawLocalModelValidation.minimumContentLength === "number" &&
    rawLocalModelValidation.minimumContentLength >= 1
      ? Math.floor(rawLocalModelValidation.minimumContentLength)
      : defaults.promotion.localModelValidation.minimumContentLength;

  const localModelMinimumDurableSimilarity =
    typeof rawLocalModelValidation.minimumDurableSimilarity === "number"
      ? Math.max(-1, Math.min(1, rawLocalModelValidation.minimumDurableSimilarity))
      : defaults.promotion.localModelValidation.minimumDurableSimilarity;

  const localModelMinimumCompositeScore =
    typeof rawLocalModelValidation.minimumCompositeScore === "number"
      ? Math.max(-1, Math.min(1, rawLocalModelValidation.minimumCompositeScore))
      : defaults.promotion.localModelValidation.minimumCompositeScore;

  const checkpointMode =
    rawCheckpoint.mode === "off" ||
    rawCheckpoint.mode === "shutdown" ||
    rawCheckpoint.mode === "periodic" ||
    rawCheckpoint.mode === "periodic+shutdown"
      ? rawCheckpoint.mode
      : defaults.checkpoint.mode;

  const checkpointIntervalSeconds =
    typeof rawCheckpoint.intervalSeconds === "number" && rawCheckpoint.intervalSeconds >= 1
      ? Math.floor(rawCheckpoint.intervalSeconds)
      : defaults.checkpoint.intervalSeconds;

  const checkpointMinimumWrites =
    typeof rawCheckpoint.minimumWrites === "number" && rawCheckpoint.minimumWrites >= 1
      ? Math.floor(rawCheckpoint.minimumWrites)
      : defaults.checkpoint.minimumWrites;

  const checkpointPragmaMode =
    rawCheckpoint.pragmaMode === "PASSIVE" || rawCheckpoint.pragmaMode === "RESTART"
      ? rawCheckpoint.pragmaMode
      : defaults.checkpoint.pragmaMode;

  const continuityBriefingMode = normalizeContinuityBriefingMode(rawContinuityBriefing.mode)
    || defaults.continuityBriefing?.mode
    || "semantic";

  const normalizedIdentitySource = normalizeIdentitySource(rawIdentity.source);
  const normalizedIdentityIsRandomLocal = typeof rawIdentity.isRandomLocal === "boolean"
    ? rawIdentity.isRandomLocal
    : normalizedIdentitySource === "random-local";
  const normalizedIdentityIsPortable = typeof rawIdentity.isPortable === "boolean"
    ? rawIdentity.isPortable
    : !normalizedIdentityIsRandomLocal
      && normalizedIdentitySource !== "unresolved"
      && normalizedIdentitySource !== "env-username"
      && normalizedIdentitySource !== "os-username"
      && normalizedIdentitySource !== "env-email";

  const identity = (myUserId || normalizedIdentitySource !== "unresolved")
    ? {
      source: normalizedIdentitySource,
      isRandomLocal: normalizedIdentityIsRandomLocal,
      isPortable: normalizedIdentityIsPortable,
    }
    : undefined;

  return {
    projectMemoryEnabled: typeof raw.projectMemoryEnabled === "boolean"
      ? raw.projectMemoryEnabled
      : defaults.projectMemoryEnabled,
    mode,
    ...(myUserId ? { myUserId } : {}),
    ...(identity ? { identity } : {}),
    index: {
      autoRebuild: typeof rawIndex.autoRebuild === "boolean"
        ? rawIndex.autoRebuild
        : defaults.index.autoRebuild,
      ...(intervalSeconds ? { intervalSeconds } : {}),
    },
    promotion: {
      enabled: typeof rawPromotion.enabled === "boolean"
        ? rawPromotion.enabled
        : defaults.promotion.enabled,
      minimumContentLength,
      minimumScore,
      maxAcceptedPerRun,
      durableTopics: normalizeStringList(rawPromotion.durableTopics, defaults.promotion.durableTopics),
      blockedSources: normalizeStringList(rawPromotion.blockedSources, defaults.promotion.blockedSources),
      durableKeywords: normalizeStringList(rawPromotion.durableKeywords, defaults.promotion.durableKeywords),
      sensitiveKeywords: normalizeStringList(rawPromotion.sensitiveKeywords, defaults.promotion.sensitiveKeywords),
      hardBlockSensitive: typeof rawPromotion.hardBlockSensitive === "boolean"
        ? rawPromotion.hardBlockSensitive
        : defaults.promotion.hardBlockSensitive,
      localModelValidation: {
        enabled: typeof rawLocalModelValidation.enabled === "boolean"
          ? rawLocalModelValidation.enabled
          : defaults.promotion.localModelValidation.enabled,
        sampleSize: localModelSampleSize,
        minimumContentLength: localModelMinimumContentLength,
        minimumDurableSimilarity: localModelMinimumDurableSimilarity,
        minimumCompositeScore: localModelMinimumCompositeScore,
      },
    },
    checkpoint: {
      mode: checkpointMode,
      intervalSeconds: checkpointIntervalSeconds,
      minimumWrites: checkpointMinimumWrites,
      pragmaMode: checkpointPragmaMode,
    },
    continuityBriefing: {
      mode: continuityBriefingMode,
    },
  };
};

/**
 * Resolve the effective continuity briefing mode with an environment override.
 */
export const resolveProjectContinuityBriefingMode = (
  config: ProjectMemoryConfig,
  env: NodeJS.ProcessEnv = process.env,
): { mode: ContinuityBriefingMode; source: "config" | "env" } => {
  const envMode = normalizeContinuityBriefingMode(env[PROJECT_CONTINUITY_BRIEFING_MODE_ENV_FLAG]);
  if (envMode) {
    return { mode: envMode, source: "env" };
  }

  return { mode: config.continuityBriefing?.mode || "semantic", source: "config" };
};

/**
 * Read and normalize one project-memory config file if it exists.
 */
const readProjectMemoryConfigIfExists = async (
  configPath: string,
): Promise<ProjectMemoryConfig | null> => {
  try {
    const content = await readFile(configPath, "utf-8");
    return normalizeProjectMemoryConfig(JSON.parse(content));
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

/**
 * Load project-memory config from the active extension-owned config file.
 *
 * Falls back to the legacy generic `config.json` only when the active file is
 * missing. The legacy file is never written by this module.
 */
export const loadProjectMemoryConfig = async (
  projectRoot: string,
): Promise<ProjectMemoryConfig> => {
  const activeConfig = await readProjectMemoryConfigIfExists(
    resolveProjectMemoryConfigPath(projectRoot),
  );

  if (activeConfig) {
    return activeConfig;
  }

  const legacyConfig = await readProjectMemoryConfigIfExists(
    resolveLegacyProjectMemoryConfigPath(projectRoot),
  );

  return legacyConfig ?? buildDefaultProjectMemoryConfig();
};

/**
 * Persist project-memory config to the active extension-owned config file.
 */
export const writeProjectMemoryConfig = async (
  projectRoot: string,
  config: ProjectMemoryConfig,
): Promise<void> => {
  const configPath = resolveProjectMemoryConfigPath(projectRoot);

  await runProjectConfigWriteLocked({
    configPath,
    operation: async () => {
      await ensureProjectMemoryLocalGitignoreForConfig({
        projectRoot,
        config,
      });

      await persistProjectMemoryConfig({
        projectRoot,
        config,
      });
    },
  });
};

/**
 * Ensure project-local memory `.gitignore` contains generated cache exclusions.
 *
 * Decision:
 * - best-effort only (no root `.gitignore`, no hooks),
 * - managed block update to avoid clobbering user-owned custom lines.
 */
export const ensureProjectMemoryLocalGitignore = async (input: {
  projectRoot: string;
  userId?: string | null;
  allowUserDatabaseCommit?: boolean;
}): Promise<void> => {
  const memoryDir = resolveProjectMemoryDirectory(input.projectRoot);
  const gitignorePath = path.join(memoryDir, PROJECT_MEMORY_LOCAL_GITIGNORE_FILENAME);

  await mkdir(memoryDir, { recursive: true });

  const normalizedUserId = input.userId?.trim() || null;
  const allowUserDatabaseCommit = input.allowUserDatabaseCommit !== false;

  const managedLines = normalizedUserId && allowUserDatabaseCommit
    ? [
      "# >>> pi-muninn generated memory safety rules >>>",
      "# Best-effort local policy: ignore runtime artifacts and other members' DBs.",
      "*",
      // Keep the active member's SQLite family together without unignoring unrelated files.
      `!${normalizedUserId}.db*`,
      "# <<< pi-muninn generated memory safety rules <<<",
    ]
    : normalizedUserId && !allowUserDatabaseCommit
      ? [
        "# >>> pi-muninn generated memory safety rules >>>",
        "# Local-only identity/config state: ignore everything until stable identity is configured.",
        "*",
        "*.db",
        "*.db-wal",
        "*.db-shm",
        "*.db-journal",
        "# <<< pi-muninn generated memory safety rules <<<",
      ]
      : [
        "# >>> pi-muninn generated memory safety rules >>>",
        "# Project memory is local by default; config may contain a user id and must not be shared.",
        "*",
        "# <<< pi-muninn generated memory safety rules <<<",
      ];

  const managedBlock = managedLines.join("\n");

  let existing = "";
  try {
    existing = await readFile(gitignorePath, "utf-8");
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const startMarker = "# >>> pi-muninn generated memory safety rules >>>";
  const endMarker = "# <<< pi-muninn generated memory safety rules <<<";
  const managedBlockPattern = /# >>> (?:pi-muninn|pi-mempalace(?:-git)?) generated (?:cache ignores|memory safety rules) >>>[\s\S]*?# <<< (?:pi-muninn|pi-mempalace(?:-git)?) generated (?:cache ignores|memory safety rules) <<</g;

  let nextContent: string;
  const hasManagedBlock = managedBlockPattern.test(existing);
  managedBlockPattern.lastIndex = 0;

  if (hasManagedBlock) {
    nextContent = existing.replace(
      managedBlockPattern,
      managedBlock,
    );
  } else if (existing.trim().length === 0) {
    nextContent = `${managedBlock}\n`;
  } else {
    nextContent = `${existing.trimEnd()}\n\n${managedBlock}\n`;
  }

  if (nextContent !== existing) {
    await writeFile(gitignorePath, nextContent, "utf-8");
  }
};

/**
 * Best-effort local ignore bootstrap derived from current project config.
 *
 * Decision: the runtime config can contain `myUserId`, so the memory directory
 * must be ignored even before project mode is enabled or an active DB exists.
 */
const ensureProjectMemoryLocalGitignoreForConfig = async (input: {
  projectRoot: string;
  config: ProjectMemoryConfig;
}): Promise<void> => {
  try {
    const identityIsRandomLocal = input.config.identity?.isRandomLocal === true
      || input.config.myUserId?.startsWith("u_local_") === true;

    await ensureProjectMemoryLocalGitignore({
      projectRoot: input.projectRoot,
      userId: input.config.myUserId,
      allowUserDatabaseCommit: !identityIsRandomLocal,
    });
  } catch {
    // Best-effort only: local ignore generation must not block config reads/writes.
  }
};

/**
 * Atomically update project-memory config from the latest persisted snapshot.
 *
 * Decision: callers that derive new config from existing values must use this
 * helper to avoid stale-read overwrite races.
 */
export const updateProjectMemoryConfig = async (input: {
  projectRoot: string;
  updater: (current: ProjectMemoryConfig) => ProjectMemoryConfig;
}): Promise<ProjectMemoryConfig> => {
  const configPath = resolveProjectMemoryConfigPath(input.projectRoot);

  return runProjectConfigWriteLocked({
    configPath,
    operation: async () => {
      const current = await loadProjectMemoryConfig(input.projectRoot);
      const updated = input.updater(current);

      await ensureProjectMemoryLocalGitignoreForConfig({
        projectRoot: input.projectRoot,
        config: updated,
      });

      return persistProjectMemoryConfig({
        projectRoot: input.projectRoot,
        config: updated,
      });
    },
  });
};

/**
 * Ensure `${PROJECT}/.agent/memory` exists and create the active extension
 * config file if missing.
 *
 * Existing active config is never overwritten. Legacy `config.json` is used as
 * a read-only migration source when the active config file does not exist.
 */
export const ensureProjectMemoryWorkspace = async (
  input: EnsureProjectWorkspaceInput,
): Promise<{ memoryDir: string; configPath: string; config: ProjectMemoryConfig }> => {
  const memoryDir = resolveProjectMemoryDirectory(input.projectRoot);
  const configPath = resolveProjectMemoryConfigPath(input.projectRoot);

  await mkdir(memoryDir, { recursive: true });

  const activeConfig = await readProjectMemoryConfigIfExists(configPath);
  if (activeConfig) {
    await ensureProjectMemoryLocalGitignoreForConfig({
      projectRoot: input.projectRoot,
      config: activeConfig,
    });

    return {
      memoryDir,
      configPath,
      config: activeConfig,
    };
  }

  const legacyConfig = await readProjectMemoryConfigIfExists(
    resolveLegacyProjectMemoryConfigPath(input.projectRoot),
  );

  const defaults = {
    ...buildDefaultProjectMemoryConfig(),
    ...input.defaultOverrides,
  };

  const initialConfig = legacyConfig ?? normalizeProjectMemoryConfig(defaults);

  // `writeProjectMemoryConfig` writes local ignore rules before the config file
  // so broad `git add` commands do not pick up local runtime config.
  await writeProjectMemoryConfig(input.projectRoot, initialConfig);

  return {
    memoryDir,
    configPath,
    config: initialConfig,
  };
};
