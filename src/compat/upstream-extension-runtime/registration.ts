/**
 * File intent: register vendored upstream compatibility behavior safely.
 *
 * Registration validates host API shape, standalone package conflicts, optional
 * native dependency health, then loads upstream through the compatibility proxy.
 */

import {
  checkBundledUpstreamNativeDependencyHealth,
  type UpstreamNativeDependencyHealthCheckResult,
} from "../upstream-native-dependency-health.js";
import {
  detectUpstreamPiMempalaceConflict,
  type UpstreamPiMempalaceConflictResult,
} from "../upstream-package-conflict.js";
import { createBundledUpstreamApiProxy } from "./api-proxy.js";
import {
  isBundledUpstreamNativeHealthCheckDisabled,
  resolveHomeDirectory,
} from "./environment.js";
import type {
  BundledUpstreamCompatibilityRegistrationResult,
  UpstreamMemoryCommandDefinition,
} from "./types.js";

export const buildStandaloneConflictWarning = (conflict: UpstreamPiMempalaceConflictResult): string =>
  "Detected standalone pi-mempalace package in settings. " +
  "Bundled upstream compatibility inside Pi Muninn was disabled to avoid duplicate global DB writers. " +
  "Keep only one memory package active (recommended: remove standalone pi-mempalace). " +
  `Sources: ${conflict.sources.join(", ")}`;

/**
 * Register vendored upstream compatibility behavior in the host extension.
 *
 * Fails closed when optional native dependencies are unhealthy so runtime
 * degrades into deterministic fallback mode instead of command-time crashes.
 */
export const registerBundledUpstreamCompatibility = (input: {
  pi: any;
  bundledUpstreamExtension: (pi: any) => void;
  homeDirectory?: string;
  nativeDependencyHealthCheck?: () => UpstreamNativeDependencyHealthCheckResult;
}): BundledUpstreamCompatibilityRegistrationResult => {
  const homeDirectory = input.homeDirectory || resolveHomeDirectory();
  const defaultConflict: UpstreamPiMempalaceConflictResult = {
    detected: false,
    sources: [],
    globalSettingsPath: `${homeDirectory}/.pi/agent/settings.json`,
    projectSettingsPath: `${process.cwd()}/.pi/settings.json`,
  };

  if (
    typeof input.pi?.on !== "function" ||
    typeof input.pi?.registerCommand !== "function" ||
    typeof input.pi?.registerTool !== "function"
  ) {
    return {
      status: "skipped-missing-api",
      conflict: defaultConflict,
      capturedMemoryCommand: null,
    };
  }

  const conflict = detectUpstreamPiMempalaceConflict({
    cwd: process.cwd(),
    homeDirectory,
  });

  if (conflict.detected) {
    return {
      status: "skipped-conflict",
      conflict,
      warning: buildStandaloneConflictWarning(conflict),
      capturedMemoryCommand: null,
    };
  }

  const nativeDependencyHealthCheck = input.nativeDependencyHealthCheck
    || checkBundledUpstreamNativeDependencyHealth;
  const nativeDependencyHealth = isBundledUpstreamNativeHealthCheckDisabled()
    ? {
      healthy: true,
      warning: null,
    }
    : nativeDependencyHealthCheck();

  if (!nativeDependencyHealth.healthy) {
    return {
      status: "skipped-load-error",
      conflict,
      warning: nativeDependencyHealth.warning
        || "Bundled upstream compatibility was disabled because optional native dependencies are unavailable.",
      capturedMemoryCommand: null,
    };
  }

  let capturedMemoryCommand: UpstreamMemoryCommandDefinition | null = null;

  const proxiedPi = createBundledUpstreamApiProxy({
    pi: input.pi,
    homeDirectory,
    onCaptureMemoryCommand: (command) => {
      capturedMemoryCommand = command;
    },
  });

  try {
    input.bundledUpstreamExtension(proxiedPi);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      status: "skipped-load-error",
      conflict,
      warning: `Bundled upstream compatibility failed to load and was disabled: ${message}`,
      capturedMemoryCommand: null,
    };
  }

  return {
    status: "loaded",
    conflict,
    capturedMemoryCommand,
  };
};
