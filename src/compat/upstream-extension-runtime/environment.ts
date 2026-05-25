/**
 * File intent: environment/context helpers for upstream compatibility runtime.
 *
 * These helpers preserve upstream-compatible fallback behavior while avoiding
 * broad environment dumps or host-specific assumptions in route modules.
 */

import { BUNDLED_UPSTREAM_NATIVE_HEALTH_CHECK_DISABLED_ENV } from "./constants.js";

export const resolveHomeDirectory = (env: NodeJS.ProcessEnv = process.env): string =>
  env.HOME || env.USERPROFILE || "~";

/**
 * Allow deterministic opt-out of native dependency probe in controlled test lanes.
 */
export const isBundledUpstreamNativeHealthCheckDisabled = (): boolean => {
  const raw = process.env[BUNDLED_UPSTREAM_NATIVE_HEALTH_CHECK_DISABLED_ENV];
  if (!raw) {
    return false;
  }

  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
};

/**
 * Resolve cwd from extension context, with process cwd fallback.
 */
export const resolveContextCwd = (ctx: unknown): string => {
  if (
    typeof ctx === "object" &&
    ctx !== null &&
    "cwd" in ctx &&
    typeof (ctx as { cwd?: unknown }).cwd === "string"
  ) {
    return (ctx as { cwd: string }).cwd;
  }

  return process.cwd();
};
