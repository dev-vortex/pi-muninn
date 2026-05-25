/**
 * File intent: detect standalone upstream pi-mempalace package conflicts.
 *
 * This file reads global/project pi settings, normalizes package sources, resolves
 * local package paths when needed, and reports whether a separate `pi-mempalace`
 * package is configured alongside Pi Muninn. Use this to prevent two
 * memory extensions from writing to the same global DB in one runtime.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Package source discovery result for upstream pi-mempalace conflict checks.
 */
export interface UpstreamPiMempalaceConflictResult {
  /** True when upstream pi-mempalace source is present in settings packages. */
  detected: boolean;
  /** Matched package sources from project/global settings. */
  sources: string[];
  /** Global settings path checked. */
  globalSettingsPath: string;
  /** Project settings path checked. */
  projectSettingsPath: string;
}

interface PiSettingsFile {
  packages?: unknown;
}

interface PackageSourceWithOrigin {
  source: string;
  settingsPath: string;
}

const THIS_PACKAGE_NAMES = new Set([
  "@dev-vortex/pi-muninn",
  // Keep the source-era/repository package name as a self alias so local-path
  // installs under old checkout directories do not look like upstream conflicts.
  "pi-muninn",
]);
const UPSTREAM_PACKAGE_NAME = "pi-mempalace";

/**
 * Return true when a normalized package name/source refers to this package.
 */
const isThisPackageNameOrAlias = (normalized: string): boolean =>
  Array.from(THIS_PACKAGE_NAMES).some((packageName) => normalized.includes(packageName));

/**
 * Normalize a package source for deterministic matching.
 */
const normalizeSource = (source: string): string => source.trim().toLowerCase();

/**
 * Trim a package source while preserving casing for path resolution.
 */
const trimSource = (source: string): string => source.trim();

/**
 * Return true when source looks like standalone upstream pi-mempalace package.
 */
export const isStandaloneUpstreamPiMempalaceSource = (source: string): boolean => {
  const normalized = normalizeSource(source);
  if (!normalized.includes(UPSTREAM_PACKAGE_NAME)) {
    return false;
  }

  // Keep this package and its source-era alias out of conflict matches.
  return !isThisPackageNameOrAlias(normalized);
};

/**
 * Detect whether source string likely points to local filesystem path.
 */
const isLikelyLocalPathSource = (source: string): boolean => {
  const trimmed = trimSource(source);
  if (!trimmed) {
    return false;
  }

  return trimmed.startsWith("./")
    || trimmed.startsWith("../")
    || trimmed.startsWith("/")
    || trimmed.startsWith("~/")
    || trimmed.startsWith("~\\")
    || /^[A-Za-z]:[\\/]/.test(trimmed);
};

/**
 * Resolve local-path package source against settings location.
 */
const resolveLocalPathSource = (input: {
  source: string;
  settingsPath: string;
  homeDirectory: string;
}): string => {
  const trimmed = trimSource(input.source);

  if (trimmed === "~") {
    return input.homeDirectory;
  }

  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.resolve(input.homeDirectory, trimmed.slice(2));
  }

  if (path.isAbsolute(trimmed)) {
    return trimmed;
  }

  return path.resolve(path.dirname(input.settingsPath), trimmed);
};

/**
 * Resolve package name from one local path source when possible.
 */
const resolvePackageNameFromLocalSource = (input: {
  source: string;
  settingsPath: string;
  homeDirectory: string;
}): string | null => {
  const resolvedSource = resolveLocalPathSource(input);

  if (!existsSync(resolvedSource)) {
    return null;
  }

  try {
    const stats = statSync(resolvedSource);
    const packageRoot = stats.isDirectory()
      ? resolvedSource
      : stats.isFile()
        ? path.dirname(resolvedSource)
        : null;

    if (!packageRoot) {
      return null;
    }

    const packageJsonPath = path.join(packageRoot, "package.json");
    if (!existsSync(packageJsonPath)) {
      return null;
    }

    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      name?: unknown;
    };

    return typeof parsed.name === "string" ? normalizeSource(parsed.name) : null;
  } catch {
    return null;
  }
};

/**
 * Classify source with settings-origin context to avoid local-path false positives.
 */
const isStandaloneUpstreamSourceWithOrigin = (input: {
  source: string;
  settingsPath: string;
  homeDirectory: string;
}): boolean => {
  const normalizedSource = normalizeSource(input.source);

  if (isThisPackageNameOrAlias(normalizedSource)) {
    return false;
  }

  if (isLikelyLocalPathSource(input.source)) {
    const packageName = resolvePackageNameFromLocalSource(input);

    if (packageName && THIS_PACKAGE_NAMES.has(packageName)) {
      return false;
    }

    if (packageName === UPSTREAM_PACKAGE_NAME) {
      return true;
    }
  }

  return isStandaloneUpstreamPiMempalaceSource(input.source);
};

/**
 * Extract normalized package sources from a settings payload.
 */
export const extractPackageSources = (settings: PiSettingsFile): string[] => {
  if (!Array.isArray(settings.packages)) {
    return [];
  }

  const sources: string[] = [];

  for (const entry of settings.packages) {
    if (typeof entry === "string") {
      const trimmed = trimSource(entry);
      if (trimmed) {
        sources.push(trimmed);
      }
      continue;
    }

    if (
      typeof entry === "object" &&
      entry !== null &&
      "source" in entry &&
      typeof (entry as { source?: unknown }).source === "string"
    ) {
      const trimmed = trimSource((entry as { source: string }).source);
      if (trimmed) {
        sources.push(trimmed);
      }
    }
  }

  return sources;
};

/**
 * Read package sources from one optional settings file.
 */
const readPackageSourcesFromSettingsPath = (settingsPath: string): PackageSourceWithOrigin[] => {
  if (!existsSync(settingsPath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as PiSettingsFile;
    return extractPackageSources(parsed).map((source) => ({
      source,
      settingsPath,
    }));
  } catch {
    // Invalid settings payload should not crash extension bootstrap.
    return [];
  }
};

/**
 * Detect whether standalone upstream pi-mempalace is configured in settings.
 */
export const detectUpstreamPiMempalaceConflict = (input: {
  cwd: string;
  homeDirectory: string;
}): UpstreamPiMempalaceConflictResult => {
  const globalSettingsPath = path.join(input.homeDirectory, ".pi", "agent", "settings.json");
  const projectSettingsPath = path.join(input.cwd, ".pi", "settings.json");

  const sources = [
    ...readPackageSourcesFromSettingsPath(globalSettingsPath),
    ...readPackageSourcesFromSettingsPath(projectSettingsPath),
  ]
    .filter((entry) => isStandaloneUpstreamSourceWithOrigin({
      source: entry.source,
      settingsPath: entry.settingsPath,
      homeDirectory: input.homeDirectory,
    }))
    .map((entry) => normalizeSource(entry.source));

  return {
    detected: sources.length > 0,
    sources,
    globalSettingsPath,
    projectSettingsPath,
  };
};
