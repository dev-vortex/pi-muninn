/**
 * File intent: own project-member attribution profile persistence.
 *
 * Deterministic user ids are good storage keys but bad human labels. This module
 * stores privacy-safe member profile metadata inside each project-member DB so
 * derived L2 indexes can later reconcile contributors without making L2
 * canonical.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

import {
  type BetterSqliteDatabase,
  openBetterSqliteDatabase,
  sqliteTableExists,
} from "../memory-data-adapters/sqlite/common/better-sqlite3-adapter.js";
import {
  hashProjectMemberIdentityLabel,
  normalizeProjectMemberDisplayName,
  normalizeProjectMemberIdentityLabelHash,
} from "./member-profile-privacy.js";
import type { ProjectMemoryIdentitySource } from "./types.js";

export {
  hashProjectMemberIdentityLabel,
  isEmailLikeProjectMemberIdentityLabel,
  normalizeProjectMemberDisplayName,
  normalizeProjectMemberIdentityLabelHash,
} from "./member-profile-privacy.js";

/**
 * Canonical member profile row stored in one project-member DB.
 */
export interface ProjectMemberProfile {
  userId: string;
  displayName: string | null;
  identitySource: ProjectMemoryIdentitySource | "db-filename";
  identityLabelHash: string | null;
  isPortable: boolean;
  isRandomLocal: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  updatedAt: string;
}

/**
 * Input for creating/updating one canonical project-member profile.
 */
export interface UpsertProjectMemberProfileInput {
  databasePath: string;
  userId: string;
  displayName?: string | null;
  identitySource: ProjectMemoryIdentitySource;
  identityLabel?: string | null;
  identityLabelHash?: string | null;
  isPortable: boolean;
  isRandomLocal: boolean;
  timestamp?: string;
}

/**
 * Input for deriving display metadata from local runtime identity signals.
 */
export interface ResolveProjectMemberDisplayNameInput {
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
  explicitDisplayName?: string | null;
}

/**
 * Ensure the canonical project-member profile schema exists in one member DB.
 */
export const ensureProjectMemberProfileSchema = (db: Pick<BetterSqliteDatabase, "exec">): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_member_profiles (
      user_id TEXT PRIMARY KEY,
      display_name TEXT,
      identity_source TEXT NOT NULL,
      identity_label_hash TEXT,
      is_portable INTEGER NOT NULL DEFAULT 0,
      is_random_local INTEGER NOT NULL DEFAULT 0,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_project_member_profiles_last_seen
      ON project_member_profiles(last_seen_at DESC);
  `);
};

/**
 * Read a local Git config field without falling back to global Git identity.
 */
const readLocalGitIdentity = (input: {
  projectRoot?: string;
  env: NodeJS.ProcessEnv;
  field: "user.name" | "user.email";
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
 * Read the first available runtime username signal.
 */
const readEnvironmentUsername = (env: NodeJS.ProcessEnv): string | null => {
  for (const key of ["USER", "USERNAME", "LOGNAME"] as const) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
};

/**
 * Read the first available runtime email signal for hashing only.
 */
const readEnvironmentEmail = (env: NodeJS.ProcessEnv): string | null => {
  for (const key of ["EMAIL", "USER_EMAIL"] as const) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
};

/**
 * Resolve a safe display name from explicit input, local Git name, or username.
 */
export const resolveProjectMemberDisplayName = (input: ResolveProjectMemberDisplayNameInput): string | null => {
  const explicit = normalizeProjectMemberDisplayName(input.explicitDisplayName);
  if (explicit) {
    return explicit;
  }

  const env = input.env ?? process.env;
  const gitName = normalizeProjectMemberDisplayName(readLocalGitIdentity({
    projectRoot: input.projectRoot,
    env,
    field: "user.name",
  }));
  if (gitName) {
    return gitName;
  }

  return normalizeProjectMemberDisplayName(readEnvironmentUsername(env));
};

/**
 * Resolve a privacy-safe hash for email-like identity evidence, never raw email.
 */
export const resolveProjectMemberIdentityLabelHash = (input: {
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
  explicitIdentityLabel?: string | null;
}): string | null => {
  const explicitHash = hashProjectMemberIdentityLabel(input.explicitIdentityLabel);
  if (explicitHash) {
    return explicitHash;
  }

  const env = input.env ?? process.env;
  const gitEmail = readLocalGitIdentity({
    projectRoot: input.projectRoot,
    env,
    field: "user.email",
  });

  return hashProjectMemberIdentityLabel(gitEmail || readEnvironmentEmail(env));
};

/**
 * Create or update the active member profile in one project-member DB.
 */
export const upsertProjectMemberProfile = (input: UpsertProjectMemberProfileInput): ProjectMemberProfile => {
  mkdirSync(path.dirname(input.databasePath), { recursive: true });

  const timestamp = input.timestamp || new Date().toISOString();
  const displayName = normalizeProjectMemberDisplayName(input.displayName);
  const identityLabelHash = normalizeProjectMemberIdentityLabelHash(input.identityLabelHash)
    || hashProjectMemberIdentityLabel(input.identityLabel);
  const db = openBetterSqliteDatabase(input.databasePath);

  try {
    ensureProjectMemberProfileSchema(db);

    const existing = db.prepare(`
      SELECT first_seen_at
      FROM project_member_profiles
      WHERE user_id = ?
    `).get(input.userId);

    const firstSeenAt = typeof existing?.first_seen_at === "string"
      ? existing.first_seen_at
      : timestamp;

    db.prepare(`
      INSERT INTO project_member_profiles (
        user_id,
        display_name,
        identity_source,
        identity_label_hash,
        is_portable,
        is_random_local,
        first_seen_at,
        last_seen_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        display_name = excluded.display_name,
        identity_source = excluded.identity_source,
        identity_label_hash = excluded.identity_label_hash,
        is_portable = excluded.is_portable,
        is_random_local = excluded.is_random_local,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at
    `).run(
      input.userId,
      displayName,
      input.identitySource,
      identityLabelHash,
      input.isPortable ? 1 : 0,
      input.isRandomLocal ? 1 : 0,
      firstSeenAt,
      timestamp,
      timestamp,
    );

    // Each project-member DB is owned by one member. Delete stale migrated
    // profile rows so L2 does not treat identity-renamed DBs as multiple people.
    db.prepare("DELETE FROM project_member_profiles WHERE user_id != ?").run(input.userId);

    return {
      userId: input.userId,
      displayName,
      identitySource: input.identitySource,
      identityLabelHash,
      isPortable: input.isPortable,
      isRandomLocal: input.isRandomLocal,
      firstSeenAt,
      lastSeenAt: timestamp,
      updatedAt: timestamp,
    };
  } finally {
    db.close();
  }
};

/**
 * Read canonical member profiles from one project-member DB.
 */
export const readProjectMemberProfiles = (databasePath: string): ProjectMemberProfile[] => {
  const db = openBetterSqliteDatabase(databasePath, {
    readOnly: true,
    fileMustExist: true,
  });

  try {
    if (!sqliteTableExists({ db, tableName: "project_member_profiles" })) {
      return [];
    }

    const rows = db.prepare(`
      SELECT
        user_id,
        display_name,
        identity_source,
        identity_label_hash,
        is_portable,
        is_random_local,
        first_seen_at,
        last_seen_at,
        updated_at
      FROM project_member_profiles
      ORDER BY user_id ASC
    `).all() as Array<Record<string, unknown>>;

    return rows
      .filter((row) => typeof row.user_id === "string" && row.user_id.length > 0)
      .map((row) => ({
        userId: row.user_id as string,
        displayName: typeof row.display_name === "string" && row.display_name.length > 0
          ? row.display_name
          : null,
        identitySource: typeof row.identity_source === "string"
          ? row.identity_source as ProjectMemberProfile["identitySource"]
          : "db-filename",
        identityLabelHash: typeof row.identity_label_hash === "string" && row.identity_label_hash.length > 0
          ? row.identity_label_hash
          : null,
        isPortable: row.is_portable === 1,
        isRandomLocal: row.is_random_local === 1,
        firstSeenAt: typeof row.first_seen_at === "string" ? row.first_seen_at : "",
        lastSeenAt: typeof row.last_seen_at === "string" ? row.last_seen_at : "",
        updatedAt: typeof row.updated_at === "string" ? row.updated_at : "",
      }));
  } finally {
    db.close();
  }
};
