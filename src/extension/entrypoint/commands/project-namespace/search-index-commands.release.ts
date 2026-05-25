/**
 * File intent: implement release-profile project search and index commands.
 */

import { getProjectSessionRuntime } from "../../runtime-services/project-session-store.js";
import { loadProjectMemoryConfig, resolveProjectMemoryDirectory } from "../../../../project-memory/config.js";
import { searchProjectMemoryByMode } from "../../../../../packages/memory-core/src/adapters/sqlite/project-memory/mode-selection.js";
import { readProjectIndexStatus, rebuildProjectIndex } from "../../../../../packages/memory-core/src/adapters/sqlite/project-index/index.js";
import type { ExtensionCommandDependencies } from "../types.js";
import { notifyReleaseProjectNamespaceMessage } from "./help.release.js";

/**
 * Handle `/memory project search <query>`.
 */
export const handleReleaseProjectSearchCommand = async (input: {
  deps: ExtensionCommandDependencies;
  restArgs: string[];
  ctx: any;
}): Promise<string> => {
  const { deps, restArgs, ctx } = input;
  const query = restArgs.join(" ").trim();
  if (!query) {
    return notifyReleaseProjectNamespaceMessage("Usage: /memory project search <query>", "warning");
  }

  const config = await loadProjectMemoryConfig(ctx.cwd);
  if (!config.projectMemoryEnabled) {
    return notifyReleaseProjectNamespaceMessage("Project memory is disabled. Use '/memory project on' first.", "warning");
  }

  const projectMemoryDir = resolveProjectMemoryDirectory(ctx.cwd);
  const activeRuntime = getProjectSessionRuntime({
    ctx,
    store: deps.sessionStore,
  });

  const searchResult = await searchProjectMemoryByMode({
    projectMemoryDir,
    query,
    mode: config.mode,
    topK: 10,
    perDbLimit: 10,
    indexFreshnessSeconds: config.index.intervalSeconds,
    activeUserId: activeRuntime?.userId || config.myUserId,
  });

  if (searchResult.results.length === 0) {
    const warnings = searchResult.errors.length > 0
      ? ` with ${searchResult.errors.length} warning(s)`
      : "";
    const degraded = searchResult.degraded && searchResult.degradedReason
      ? `; degraded=${searchResult.degradedReason}`
      : "";
    return notifyReleaseProjectNamespaceMessage(
      `No ${searchResult.effectiveMode} results for query: "${query}"${warnings}${degraded}.`,
    );
  }

  const label = searchResult.effectiveMode === "index-first" ? "Index-first" : "Fan-out";
  let output = `${label} results for "${query}" (${searchResult.results.length} hits across ${searchResult.searchedDatabaseCount}/${searchResult.databaseCount} DBs; requested=${searchResult.requestedMode}; effective=${searchResult.effectiveMode}):\n\n`;

  for (const hit of searchResult.results) {
    const snippet = hit.content.length > 180
      ? `${hit.content.slice(0, 177)}...`
      : hit.content;
    const groupSuffix = hit.groupId ? ` group=${hit.groupId.slice(0, 8)}` : "";
    output += `- [${hit.kind}/${hit.userId}/${hit.topic}] (${hit.timestamp}${groupSuffix}) ${snippet}\n`;
  }

  if (searchResult.degraded && searchResult.degradedReason) {
    output += `\nMode degradation: ${searchResult.degradedReason}.`;
  }

  if (searchResult.errors.length > 0) {
    output += `\nWarnings: ${searchResult.errors.length} retrieval issue(s) detected.`;
  }

  return notifyReleaseProjectNamespaceMessage(output);
};

/**
 * Handle `/memory project index ...` operations.
 */
export const handleReleaseProjectIndexCommand = async (input: {
  deps: ExtensionCommandDependencies;
  restArgs: string[];
  ctx: any;
}): Promise<string> => {
  const { deps, restArgs, ctx } = input;
  const [subAction = "status"] = restArgs;

  const config = await loadProjectMemoryConfig(ctx.cwd);
  if (!config.projectMemoryEnabled) {
    return "Project memory is disabled. Index operations are unavailable in compatibility mode.";
  }

  const projectMemoryDir = resolveProjectMemoryDirectory(ctx.cwd);
  const activeRuntime = getProjectSessionRuntime({
    ctx,
    store: deps.sessionStore,
  });
  const activeUserId = activeRuntime?.userId || config.myUserId;

  if (subAction === "rebuild") {
    const rebuildResult = await rebuildProjectIndex({
      projectMemoryDir,
      activeUserId,
    });
    const errorSuffix = rebuildResult.errors.length > 0
      ? ` with ${rebuildResult.errors.length} warning(s)`
      : "";

    return `Project index rebuild finished: status=${rebuildResult.status}, owner=${rebuildResult.ownerUserId || "none"}, sourceDBs=${rebuildResult.sourceDatabaseCount}, rows=${rebuildResult.indexedRowCount}, l1Rows=${rebuildResult.indexedMemoryRowCount}, l0Rows=${rebuildResult.indexedContinuityRowCount}, parallelGroups=${rebuildResult.parallelEvidenceGroupCount}, durationMs=${rebuildResult.lastDurationMs}${errorSuffix}.`;
  }

  if (subAction !== "status") {
    return "Usage: /memory project index <status|rebuild>";
  }

  const status = await readProjectIndexStatus({ projectMemoryDir });
  const rebuildAt = status.lastRebuildAt || "never";
  const errorInfo = status.lastError ? `, lastError=${status.lastError}` : "";
  const ownerInfo = status.ownerUserId || "none";
  const fingerprintInfo = status.sourceFingerprint
    ? status.sourceFingerprint.slice(0, 12)
    : "none";

  return `Project index status: ${status.status}; owner=${ownerInfo}; lastRebuildAt=${rebuildAt}; sourceDBs=${status.sourceDatabaseCount}; rows=${status.indexedRowCount}; l1Rows=${status.indexedMemoryRowCount}; l0Rows=${status.indexedContinuityRowCount}; parallelGroups=${status.parallelEvidenceGroupCount}; schema=${status.schemaVersion}; fingerprint=${fingerprintInfo}; durationMs=${status.lastDurationMs ?? "n/a"}${errorInfo}.`;
};
