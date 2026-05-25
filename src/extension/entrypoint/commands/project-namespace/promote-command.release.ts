/**
 * File intent: implement release-profile `/memory project promote ...` commands.
 */

import { getProjectSessionRuntime } from "../../runtime-services/project-session-store.js";
import { loadProjectMemoryConfig, resolveProjectMemoryDirectory } from "../../../../project-memory/config.js";
import {
  readPromotionPipelineStatus,
  runDeterministicPromotionPipeline,
} from "../../../../../packages/memory-core/src/adapters/sqlite/project-memory/promotion-pipeline.js";
import type { ExtensionCommandDependencies } from "../types.js";

/**
 * Handle release-profile `/memory project promote ...` operations.
 */
export const handleReleaseProjectPromoteCommand = async (input: {
  deps: ExtensionCommandDependencies;
  restArgs: string[];
  ctx: any;
}): Promise<string> => {
  const { deps, restArgs, ctx } = input;
  const [subAction = "status"] = restArgs;

  if (subAction !== "status" && subAction !== "run" && subAction !== "dry-run" && subAction !== "validate") {
    return "Usage: /memory project promote <status|run|dry-run|validate>";
  }

  const config = await loadProjectMemoryConfig(ctx.cwd);
  if (!config.projectMemoryEnabled) {
    return "Project memory is disabled. Promotion operations are unavailable in compatibility mode.";
  }

  if (!config.promotion.enabled) {
    return "Promotion policy is disabled in project config (`promotion.enabled=false`).";
  }

  let runtime = getProjectSessionRuntime({
    ctx,
    store: deps.sessionStore,
  });

  if (!runtime) {
    const result = await deps.bootstrap(ctx);
    if (!result.ok) {
      return `Promotion unavailable (bootstrap failed: ${result.error}).`;
    }

    runtime = getProjectSessionRuntime({
      ctx,
      store: deps.sessionStore,
    });

    if (!runtime) {
      return "Promotion unavailable (runtime not initialized).";
    }
  }

  const projectMemoryDir = resolveProjectMemoryDirectory(ctx.cwd);
  const globalMemoryDir = runtime.storePaths.globalMemoryDir;

  if (subAction === "run" || subAction === "dry-run" || subAction === "validate") {
    const promotion = await runDeterministicPromotionPipeline({
      projectMemoryDir,
      globalMemoryDir,
      dryRun: subAction !== "run",
      policy: config.promotion,
      localModelGate: {
        minimumContentLength: config.promotion.localModelValidation.minimumContentLength,
        minimumDurableSimilarity: config.promotion.localModelValidation.minimumDurableSimilarity,
        minimumCompositeScore: config.promotion.localModelValidation.minimumCompositeScore,
      },
    });

    const warningSuffix = promotion.warnings.length > 0
      ? ` warnings=${promotion.warnings.length}`
      : "";

    const localModelSuffix =
      ` localModelGate=mandatory` +
      ` modelRejected=${promotion.decisionCounts["model-rejected"]}`;

    if (subAction === "validate") {
      return `Promotion validation finished: accepted=${promotion.acceptedCount}, rejected=${promotion.rejectedCount}, candidates=${promotion.candidateCount}, indexStatus=${promotion.projectIndexStatus}, decisionCounts=${JSON.stringify(promotion.decisionCounts)}.${localModelSuffix}.${warningSuffix}`;
    }

    return `Promotion ${promotion.mode} finished: accepted=${promotion.acceptedCount}, rejected=${promotion.rejectedCount}, duplicates=${promotion.duplicateCount}, candidates=${promotion.candidateCount}, indexStatus=${promotion.projectIndexStatus}, minScore=${promotion.policyUsed.minimumScore}, hardBlockSensitive=${promotion.policyUsed.hardBlockSensitive}.${localModelSuffix}.${warningSuffix}`;
  }

  const status = await readPromotionPipelineStatus({ globalMemoryDir });
  const policySummary =
    `policy(minScore=${config.promotion.minimumScore}, minLen=${config.promotion.minimumContentLength}, hardBlockSensitive=${config.promotion.hardBlockSensitive}; ` +
    `localModelPromotionGate=mandatory; ` +
    `shadowValidation(enabled=${config.promotion.localModelValidation.enabled}, sampleSize=${config.promotion.localModelValidation.sampleSize}, ` +
    `minDurable=${config.promotion.localModelValidation.minimumDurableSimilarity}, minComposite=${config.promotion.localModelValidation.minimumCompositeScore}))`;

  const legacySummary = status.legacyStore.exists
    ? " legacyMasterDetected=yes; legacy migration is unavailable in the release command surface."
    : " legacyMasterDetected=no.";

  if (!status.exists) {
    return `Promotion status: no curated global DB at ${status.globalMasterDatabasePath}; storage=${status.storageMode}. ${policySummary}. Run '/memory project promote run' to initialize.${legacySummary}`;
  }

  const lastRun = status.lastRun
    ? ` lastRun=${status.lastRun.runId} (accepted=${status.lastRun.acceptedCount}, rejected=${status.lastRun.rejectedCount}, duplicates=${status.lastRun.duplicateCount}, dryRun=${status.lastRun.dryRun})`
    : " lastRun=none";

  return `Promotion status: promoted=${status.promotedCount}, lastPromotedAt=${status.lastPromotedAt || "never"};${lastRun}; storage=${status.storageMode}; using=${status.globalMasterDatabasePath}; ${policySummary}.${legacySummary}`;
};
