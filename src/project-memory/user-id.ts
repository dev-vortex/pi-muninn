/**
 * File intent: resolve stable per-user identity for project-memory ownership.
 *
 * This file owns the precedence chain for explicit/env/config/git/environment/OS
 * identity sources, deterministic user-id hashing, random-local fallback, and
 * portability metadata. Keep identity derivation here so DB ownership, git guard
 * behavior, and runtime status all agree on the same user id.
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

import type { ProjectMemoryIdentitySource } from "./types.js";

/** Environment variable for explicit, already-normalized user id. */
export const PROJECT_MEMORY_USER_ID_ENV = "PI_MEMORY_USER_ID";

/**
 * Resolution sources returned by `resolveProjectUserId`.
 */
export type ProjectUserIdResolutionSource = ProjectMemoryIdentitySource;

/**
 * Resolve whether one identity source is considered portable across machines.
 */
export const isPortableUserIdResolutionSource = (
  source: ProjectUserIdResolutionSource,
): boolean => (
  source === "explicit"
  || source === "env-id"
  || source === "project-config"
  || source === "git-email"
  || source === "git-name"
);

const USERNAME_ENV_KEYS = ["USER", "USERNAME", "LOGNAME"] as const;
const EMAIL_ENV_KEYS = ["EMAIL", "USER_EMAIL"] as const;

/**
 * Normalize user id value for safe file naming.
 */
export const normalizeUserId = (input: string): string => {
  const normalized = input.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return normalized.replace(/-+/g, "-").replace(/^-|-$/g, "");
};

/**
 * Build deterministic user id from a stable seed (e.g., email or username).
 */
export const generateDeterministicUserId = (seed: string): string => {
  const canonicalSeed = seed.trim().toLowerCase();
  const hash = crypto.createHash("sha256").update(canonicalSeed, "utf-8").digest("hex");
  return `u_${hash.slice(0, 16)}`;
};

/**
 * Generate local-random user id fallback for non-portable project-local usage.
 */
export const generateRandomLocalUserId = (): string => {
  const suffix = crypto.randomBytes(8).toString("hex");
  return `u_local_${suffix}`;
};

/**
 * Read repository-local git identity field from project root.
 *
 * We intentionally query `--local` only so this remains project-scoped and
 * does not silently depend on machine-global git configuration.
 */
const readLocalGitIdentity = (input: {
  projectRoot?: string;
  env: NodeJS.ProcessEnv;
  field: "user.email" | "user.name";
}): string | null => {
  if (!input.projectRoot) {
    return null;
  }

  try {
    const value = execFileSync(
      "git",
      ["-C", input.projectRoot, "config", "--local", "--get", input.field],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: input.env,
        maxBuffer: 1024 * 16,
      },
    ).trim();

    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
};

/**
 * Return the first non-empty environment username value.
 */
const readEnvironmentEmail = (env: NodeJS.ProcessEnv): string | null => {
  for (const key of EMAIL_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
};

/**
 * Return first non-empty environment username value.
 */
const readEnvironmentUsername = (env: NodeJS.ProcessEnv): string | null => {
  for (const key of USERNAME_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
};

/**
 * Read OS username from runtime when env username variables are unavailable.
 */
const readOsUsername = (env: NodeJS.ProcessEnv): string | null => {
  try {
    const username = execFileSync("id", ["-un"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env,
      maxBuffer: 1024 * 8,
    }).trim();

    return username.length > 0 ? username : null;
  } catch {
    return null;
  }
};

/**
 * Resolve project user id with deterministic precedence.
 *
 * Finalized policy:
 * 1) explicit argument
 * 2) project config `myUserId`
 * 3) `PI_MEMORY_USER_ID`
 * 4) deterministic seed from repo-local git `user.email`
 * 5) deterministic seed from repo-local git `user.name`
 * 6) deterministic seed from runtime environment email (`EMAIL` / `USER_EMAIL`)
 * 7) deterministic seed from runtime environment username (`USER` / `USERNAME` / `LOGNAME`)
 * 8) deterministic seed from OS username (`id -un`) when env username vars are absent
 * 9) optional random local fallback (`random-local`) when enabled by caller
 * 10) unresolved (`null`) when random fallback is disabled
 */
export const resolveProjectUserId = (input: {
  explicitUserId?: string;
  projectConfigUserId?: string;
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
  allowRandomLocalFallback?: boolean;
}): { userId: string | null; source: ProjectUserIdResolutionSource } => {
  const env = input.env ?? process.env;

  if (input.explicitUserId) {
    return {
      userId: normalizeUserId(input.explicitUserId),
      source: "explicit",
    };
  }

  if (input.projectConfigUserId && input.projectConfigUserId.trim().length > 0) {
    return {
      userId: normalizeUserId(input.projectConfigUserId),
      source: "project-config",
    };
  }

  const envUserId = env[PROJECT_MEMORY_USER_ID_ENV];
  if (typeof envUserId === "string" && envUserId.trim().length > 0) {
    return {
      userId: normalizeUserId(envUserId),
      source: "env-id",
    };
  }

  const gitEmail = readLocalGitIdentity({
    projectRoot: input.projectRoot,
    env,
    field: "user.email",
  });
  if (gitEmail) {
    return {
      userId: generateDeterministicUserId(gitEmail),
      source: "git-email",
    };
  }

  const gitName = readLocalGitIdentity({
    projectRoot: input.projectRoot,
    env,
    field: "user.name",
  });
  if (gitName) {
    return {
      userId: generateDeterministicUserId(gitName),
      source: "git-name",
    };
  }

  const envEmail = readEnvironmentEmail(env);
  if (envEmail) {
    return {
      userId: generateDeterministicUserId(envEmail),
      source: "env-email",
    };
  }

  const envUsername = readEnvironmentUsername(env);
  if (envUsername) {
    return {
      userId: generateDeterministicUserId(envUsername),
      source: "env-username",
    };
  }

  const allowOsUsernameFallback = input.env === undefined;
  if (allowOsUsernameFallback) {
    const osUsername = readOsUsername(env);
    if (osUsername) {
      return {
        userId: generateDeterministicUserId(osUsername),
        source: "os-username",
      };
    }
  }

  if (input.allowRandomLocalFallback) {
    return {
      userId: generateRandomLocalUserId(),
      source: "random-local",
    };
  }

  return {
    userId: null,
    source: "unresolved",
  };
};
