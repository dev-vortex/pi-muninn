/**
 * File intent: manage bundled upstream pi-mempalace compatibility state.
 *
 * This keeps lazy upstream loading, conflict warnings, command capture, and
 * runtime-mode summaries outside the package entrypoint.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import {
  registerBundledUpstreamCompatibility,
  resolveBundledUpstreamRuntimeMode,
  type BundledUpstreamCompatibilityRegistrationResult,
  type UpstreamMemoryCommandDefinition,
} from "../../../compat/upstream-extension-runtime.js";
import { resolveWorkspaceRoot } from "./continuity-evidence.js";

const resolveVendoredUpstreamExtensionUrl = (): string => {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const sourceGraphPackageRoot = path.resolve(moduleDir, "../../../../");
  const sourceGraphVendorTs = path.join(
    sourceGraphPackageRoot,
    "vendor",
    "pi-mempalace",
    "extensions",
    "pi-mempalace",
    "index.ts",
  );
  const candidates = [
    path.resolve(moduleDir, "../vendor/pi-mempalace/index.js"),
    path.resolve(moduleDir, "vendor/pi-mempalace/index.js"),
    // TS source-graph packages ship the vendored upstream files as original TS.
    ...(!existsSync(path.join(sourceGraphPackageRoot, ".git")) ? [sourceGraphVendorTs] : []),
    path.resolve(moduleDir, "../../../../vendor/pi-mempalace/extensions/pi-mempalace/index.js"),
  ];

  const resolved = candidates.find((candidate) => existsSync(candidate)) ?? candidates.at(-1)!;
  return pathToFileURL(resolved).href;
};

/**
 * Build lazy upstream compatibility services for commands/hooks.
 */
export const createBundledUpstreamCompatibilityServices = (pi: any): {
  initializeBundledUpstreamCompatibility: () => Promise<void>;
  renderUpstreamRuntimeSummary: (ctx: any) => Promise<string>;
  getBundledUpstreamMemoryCommand: () => UpstreamMemoryCommandDefinition | null;
  getBundledUpstreamRegistration: () => BundledUpstreamCompatibilityRegistrationResult;
} => {
  let bundledUpstream: BundledUpstreamCompatibilityRegistrationResult = {
    status: "skipped-load-error",
    conflict: {
      detected: false,
      sources: [],
      globalSettingsPath: "UNCONFIRMED",
      projectSettingsPath: "UNCONFIRMED",
    },
    warning: "Bundled upstream compatibility was not initialized yet.",
    capturedMemoryCommand: null,
  };
  let bundledUpstreamMemoryCommand: UpstreamMemoryCommandDefinition | null = null;
  let bundledUpstreamInitPromise: Promise<void> | null = null;
  let bundledUpstreamWarningLogged = false;

  const emitBundledUpstreamWarning = (): void => {
    if (bundledUpstreamWarningLogged) {
      return;
    }

    if (
      (bundledUpstream.status !== "skipped-conflict" && bundledUpstream.status !== "skipped-load-error") ||
      !bundledUpstream.warning
    ) {
      return;
    }

    bundledUpstreamWarningLogged = true;

    // eslint-disable-next-line no-console
    console.warn(`[pi-muninn] ${bundledUpstream.warning}`);
  };

  const initializeBundledUpstreamCompatibility = async (): Promise<void> => {
    if (bundledUpstreamInitPromise) {
      await bundledUpstreamInitPromise;
      return;
    }

    bundledUpstreamInitPromise = (async () => {
      if (
        typeof pi?.on !== "function" ||
        typeof pi?.registerCommand !== "function" ||
        typeof pi?.registerTool !== "function"
      ) {
        bundledUpstream = registerBundledUpstreamCompatibility({
          pi,
          bundledUpstreamExtension: () => undefined,
        });
        bundledUpstreamMemoryCommand = bundledUpstream.capturedMemoryCommand;
        return;
      }

      try {
        const loadedModule = await import(resolveVendoredUpstreamExtensionUrl());
        const vendoredExtensionCandidate = (loadedModule as { default?: unknown }).default;

        if (typeof vendoredExtensionCandidate !== "function") {
          throw new Error("vendored upstream extension default export is not a function");
        }

        const vendoredExtension = vendoredExtensionCandidate as (piRuntime: any) => void;

        bundledUpstream = registerBundledUpstreamCompatibility({
          pi,
          bundledUpstreamExtension: vendoredExtension,
        });
        bundledUpstreamMemoryCommand = bundledUpstream.capturedMemoryCommand;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        bundledUpstream = registerBundledUpstreamCompatibility({
          pi,
          bundledUpstreamExtension: () => {
            throw new Error(message);
          },
        });
        bundledUpstreamMemoryCommand = bundledUpstream.capturedMemoryCommand;
      }

      emitBundledUpstreamWarning();
    })();

    await bundledUpstreamInitPromise;
  };

  const renderUpstreamRuntimeSummary = async (ctx: any): Promise<string> => {
    await initializeBundledUpstreamCompatibility();

    if (bundledUpstream.status === "skipped-missing-api") {
      return "upstream=bundled-compat-unavailable(reason=missing-extension-api)";
    }

    if (bundledUpstream.status === "skipped-load-error") {
      return "upstream=bundled-compat-unavailable(reason=load-error)";
    }

    const mode = await resolveBundledUpstreamRuntimeMode({
      cwd: resolveWorkspaceRoot(ctx),
    });

    const conflictSources = mode.conflictSources.length > 0
      ? `; sources=${mode.conflictSources.join(",")}`
      : "";

    return `upstream=${mode.mode}; globalHooks=${mode.allowGlobalLifecycleHooks ? "enabled" : "disabled"}; reason=${mode.reason}${conflictSources}`;
  };

  return {
    initializeBundledUpstreamCompatibility,
    renderUpstreamRuntimeSummary,
    getBundledUpstreamMemoryCommand: () => bundledUpstreamMemoryCommand,
    getBundledUpstreamRegistration: () => bundledUpstream,
  };
};
