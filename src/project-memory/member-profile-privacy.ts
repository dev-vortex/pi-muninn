/**
 * File intent: centralize privacy-safe project-member attribution helpers.
 *
 * Member profile labels may appear in tool output and prompt briefings, so this
 * module keeps display-name sanitization and identity hashing independent from
 * SQLite persistence. Config and profile writers can share the same privacy
 * rules without importing database code.
 */

import crypto from "node:crypto";

const MAX_DISPLAY_NAME_LENGTH = 120;
const EMAIL_LIKE_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/i;

/**
 * Return true when a label looks like a raw email address.
 */
export const isEmailLikeProjectMemberIdentityLabel = (value: string | null | undefined): boolean => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 && EMAIL_LIKE_PATTERN.test(normalized);
};

/**
 * Remove control characters, bound display names, and reject raw emails.
 */
export const normalizeProjectMemberDisplayName = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (normalized.length === 0 || isEmailLikeProjectMemberIdentityLabel(normalized)) {
    return null;
  }

  return normalized.length > MAX_DISPLAY_NAME_LENGTH
    ? normalized.slice(0, MAX_DISPLAY_NAME_LENGTH).trimEnd()
    : normalized;
};

/**
 * Build a stable privacy-safe hash for sensitive identity labels.
 */
export const hashProjectMemberIdentityLabel = (value: string | null | undefined): string | null => {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!normalized) {
    return null;
  }

  return crypto.createHash("sha256").update(normalized, "utf8").digest("hex");
};

/**
 * Normalize either an existing SHA-256 hex hash or a raw label into a hash.
 */
export const normalizeProjectMemberIdentityLabelHash = (value: string | null | undefined): string | null => {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!normalized) {
    return null;
  }

  return SHA256_HEX_PATTERN.test(normalized)
    ? normalized
    : hashProjectMemberIdentityLabel(normalized);
};
