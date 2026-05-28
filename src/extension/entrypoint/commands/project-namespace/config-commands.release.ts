/**
 * File intent: implement release-profile `/memory project` configuration commands.
 */

import { setProjectMemoryEnabled, setProjectMemoryMode } from "../../runtime-services/project-config-toggles.js";
import { getProjectSessionRuntime } from "../../runtime-services/project-session-store.js";
import {
  ensureProjectMemoryLocalGitignore,
  loadProjectMemoryConfig,
  PROJECT_CONTINUITY_BRIEFING_MODE_ENV_FLAG,
  resolveProjectContinuityBriefingMode,
  updateProjectMemoryConfig,
} from "../../../../project-memory/config.js";
import {
  hashProjectMemberIdentityLabel,
  normalizeProjectMemberDisplayName,
  readProjectMemberProfiles,
  upsertProjectMemberProfile,
} from "../../../../project-memory/member-profile.js";
import { generateDeterministicUserId } from "../../../../project-memory/user-id.js";
import { migrateProjectUserDatabaseIdentity } from "../../../../runtime/project-runtime-context.js";
import type { ExtensionCommandDependencies } from "../types.js";
import { notifyReleaseProjectNamespaceMessage } from "./help.release.js";

/**
 * Handle `/memory project set <name>` by forwarding to upstream project naming.
 */
export const handleReleaseProjectSetCommand = async (input: {
  deps: ExtensionCommandDependencies;
  restArgs: string[];
  ctx: any;
}): Promise<string> => {
  const { deps, restArgs, ctx } = input;
  const projectName = restArgs.join(" ").trim();
  if (!projectName) {
    return "Usage: /memory project set <name>";
  }

  const bundledUpstreamMemoryCommand = deps.getBundledUpstreamMemoryCommand();
  if (!bundledUpstreamMemoryCommand) {
    const upstreamSummary = await deps.renderUpstreamRuntimeSummary(ctx);
    return `Cannot set upstream project to '${projectName}' because bundled /memory compatibility is unavailable (${upstreamSummary}).`;
  }

  await bundledUpstreamMemoryCommand.handler(`project ${projectName}`, ctx);
  return `Upstream project set to '${projectName}'.`;
};

/**
 * Handle `/memory project user ...` identity commands.
 */
export const handleReleaseProjectUserCommand = async (input: {
  deps: ExtensionCommandDependencies;
  restArgs: string[];
  ctx: any;
}): Promise<string> => {
  const { deps, restArgs, ctx } = input;
  const [subAction = "status", ...userArgs] = restArgs;

  if (subAction === "set") {
    const rawUserValue = userArgs.join(" ").trim();
    if (!rawUserValue) {
      return "Usage: /memory project user set <user>";
    }

    const recalculatedUserId = generateDeterministicUserId(rawUserValue);
    const explicitDisplayName = normalizeProjectMemberDisplayName(rawUserValue);
    const explicitIdentityLabelHash = hashProjectMemberIdentityLabel(rawUserValue) || undefined;
    const currentConfig = await loadProjectMemoryConfig(ctx.cwd);
    const previousUserId = currentConfig.myUserId?.trim() || null;

    await updateProjectMemoryConfig({
      projectRoot: ctx.cwd,
      updater: (current) => ({
        ...current,
        myUserId: recalculatedUserId,
        identity: {
          source: "explicit",
          ...(explicitDisplayName ? { displayName: explicitDisplayName } : {}),
          ...(explicitIdentityLabelHash ? { identityLabelHash: explicitIdentityLabelHash } : {}),
          isPortable: true,
          isRandomLocal: false,
        },
      }),
    });

    let migrationSummary = "dbMigration=skipped";
    if (previousUserId && previousUserId !== recalculatedUserId) {
      try {
        const migration = await migrateProjectUserDatabaseIdentity({
          projectRoot: ctx.cwd,
          fromUserId: previousUserId,
          toUserId: recalculatedUserId,
        });

        migrationSummary = migration.warning
          ? `dbMigration=${migration.status}(${migration.warning})`
          : `dbMigration=${migration.status}`;
      } catch (error: unknown) {
        migrationSummary = `dbMigration=error(${error instanceof Error ? error.message : String(error)})`;
      }
    }

    let gitignoreSummary = "localGitignore=updated";
    try {
      await ensureProjectMemoryLocalGitignore({
        projectRoot: ctx.cwd,
        userId: recalculatedUserId,
        allowUserDatabaseCommit: true,
      });
    } catch (error: unknown) {
      gitignoreSummary = `localGitignore=error(${error instanceof Error ? error.message : String(error)})`;
    }

    const result = await deps.bootstrap(ctx);
    const runtime = getProjectSessionRuntime({
      ctx,
      store: deps.sessionStore,
    });

    if (!result.ok || !runtime) {
      return `Failed to set project memory user using '${rawUserValue}': ${result.error || "runtime not initialized"}`;
    }

    if (runtime.storePaths.activeScope === "project-enabled" && runtime.userId) {
      upsertProjectMemberProfile({
        databasePath: runtime.storePaths.projectUserDatabasePath,
        userId: runtime.userId,
        displayName: explicitDisplayName,
        identitySource: "explicit",
        identityLabelHash: explicitIdentityLabelHash,
        isPortable: true,
        isRandomLocal: false,
      });
    }

    if (!currentConfig.projectMemoryEnabled) {
      return notifyReleaseProjectNamespaceMessage(
        `Project memory user configured as ${recalculatedUserId} (source=explicit) while project mode is disabled. ${migrationSummary}; ${gitignoreSummary}. Enable with '/memory project on' to activate project-scoped writes.`,
      );
    }

    const identity = runtime.config.identity;
    return notifyReleaseProjectNamespaceMessage(
      `Project memory user set to ${runtime.userId} (source=${runtime.userIdSource}, portable=${identity?.isPortable === true ? "yes" : "no"}, randomLocal=${identity?.isRandomLocal === true ? "yes" : "no"}; ${migrationSummary}; ${gitignoreSummary}).`,
    );
  }

  if (subAction === "auto") {
    await updateProjectMemoryConfig({
      projectRoot: ctx.cwd,
      updater: (current) => ({
        ...current,
        myUserId: undefined,
        identity: {
          source: "unresolved",
          isPortable: false,
          isRandomLocal: false,
        },
      }),
    });

    const result = await deps.bootstrap(ctx);
    const runtime = getProjectSessionRuntime({
      ctx,
      store: deps.sessionStore,
    });

    if (!result.ok || !runtime) {
      return `Project memory identity reset to auto mode, but runtime bootstrap failed: ${result.error || "runtime not initialized"}`;
    }

    const identity = runtime.config.identity;
    return notifyReleaseProjectNamespaceMessage(
      `Project memory identity set to auto (resolved user=${runtime.userId}, source=${runtime.userIdSource}, portable=${identity?.isPortable === true ? "yes" : "no"}, randomLocal=${identity?.isRandomLocal === true ? "yes" : "no"}).`,
    );
  }

  if (subAction !== "status") {
    return "Usage: /memory project user <status|set <user>|auto>";
  }

  const config = await loadProjectMemoryConfig(ctx.cwd);
  const runtime = getProjectSessionRuntime({
    ctx,
    store: deps.sessionStore,
  });

  const resolved = runtime
    ? `resolved=${runtime.userId || "none"} (source=${runtime.userIdSource})`
    : "resolved=unavailable (runtime not initialized)";

  const configured = config.myUserId
    ? `configured=${config.myUserId}`
    : "configured=none";

  const identity = config.identity
    ? `identity(source=${config.identity.source}, displayName=${config.identity.displayName || "none"}, portable=${config.identity.isPortable ? "yes" : "no"}, randomLocal=${config.identity.isRandomLocal ? "yes" : "no"})`
    : "identity=unset";

  let profile = "profile=unavailable";
  if (runtime?.storePaths.activeScope === "project-enabled") {
    const activeProfile = readProjectMemberProfiles(runtime.storePaths.projectUserDatabasePath)
      .find((row) => row.userId === runtime.userId);
    profile = activeProfile
      ? `profile(displayName=${activeProfile.displayName || "none"}, source=${activeProfile.identitySource}, registered=yes)`
      : "profile=missing";
  }

  return notifyReleaseProjectNamespaceMessage(`Project memory user status: ${configured}; ${identity}; ${resolved}; ${profile}.`);
};

/**
 * Handle `/memory project on|off` mode toggles.
 */
export const handleReleaseProjectToggleCommand = async (input: {
  deps: ExtensionCommandDependencies;
  action: "on" | "off";
  ctx: any;
}): Promise<string> => {
  const { deps, action, ctx } = input;
  const enabled = action === "on";
  const updated = await setProjectMemoryEnabled({
    projectRoot: ctx.cwd,
    enabled,
  });

  const result = await deps.bootstrap(ctx);

  const checkpointSummary = `checkpoint=${updated.checkpoint.mode}/${updated.checkpoint.pragmaMode}`;
  const upstreamSummary = await deps.renderUpstreamRuntimeSummary(ctx);

  if (!result.ok) {
    const message = `Project memory is now ${updated.projectMemoryEnabled ? "enabled" : "disabled"} (mode=${updated.mode}; ${checkpointSummary}; ${upstreamSummary}), but bootstrap failed: ${result.error}`;

    if (ctx?.hasUI && typeof ctx?.ui?.notify === "function") {
      ctx.ui.notify(message, "warning");
    }

    return message;
  }

  const message = `Project memory is now ${updated.projectMemoryEnabled ? "enabled" : "disabled"} (mode=${updated.mode}; ${checkpointSummary}; ${upstreamSummary}).`;

  if (ctx?.hasUI && typeof ctx?.ui?.notify === "function") {
    ctx.ui.notify(message, "info");
  }

  return message;
};

/**
 * Handle `/memory project mode ...` retrieval mode commands.
 */
export const handleReleaseProjectModeCommand = async (input: {
  deps: ExtensionCommandDependencies;
  restArgs: string[];
  ctx: any;
}): Promise<string> => {
  const { deps, restArgs, ctx } = input;
  const [subAction = "status"] = restArgs;
  const config = await loadProjectMemoryConfig(ctx.cwd);

  if (subAction === "status") {
    return notifyReleaseProjectNamespaceMessage(`Project memory mode: ${config.mode} (default=index-first, fallback=fanout).`);
  }

  if (subAction !== "index-first" && subAction !== "fanout") {
    return notifyReleaseProjectNamespaceMessage("Usage: /memory project mode <status|index-first|fanout>", "warning");
  }

  const updated = await setProjectMemoryMode({
    projectRoot: ctx.cwd,
    mode: subAction,
  });

  const result = await deps.bootstrap(ctx);
  if (!result.ok) {
    return notifyReleaseProjectNamespaceMessage(
      `Project memory mode set to ${updated.mode}, but bootstrap failed: ${result.error}`,
      "warning",
    );
  }

  return notifyReleaseProjectNamespaceMessage(`Project memory mode is now ${updated.mode}.`);
};

/**
 * Handle release `/memory project continuity-briefing ...` mode commands.
 *
 * This is release-facing because it changes runtime retrieval behavior, not
 * developer diagnostics. Semantic remains the default, with lexical available
 * as an explicit fallback/control mode.
 */
export const handleReleaseProjectContinuityBriefingCommand = async (input: {
  deps: ExtensionCommandDependencies;
  restArgs: string[];
  ctx: any;
}): Promise<string> => {
  const { deps, restArgs, ctx } = input;
  const [subAction = "status"] = restArgs;
  const config = await loadProjectMemoryConfig(ctx.cwd);
  const effective = resolveProjectContinuityBriefingMode(config);

  if (subAction === "status") {
    const envValue = process.env[PROJECT_CONTINUITY_BRIEFING_MODE_ENV_FLAG] || "unset";
    return notifyReleaseProjectNamespaceMessage(
      `Continuity briefing mode: configured=${config.continuityBriefing?.mode || "semantic"}, effective=${effective.mode}, source=${effective.source}, env(${PROJECT_CONTINUITY_BRIEFING_MODE_ENV_FLAG})=${envValue}.`,
    );
  }

  if (subAction !== "lexical" && subAction !== "semantic") {
    return notifyReleaseProjectNamespaceMessage("Usage: /memory project continuity-briefing <status|lexical|semantic>", "warning");
  }

  const updated = await updateProjectMemoryConfig({
    projectRoot: ctx.cwd,
    updater: (current) => ({
      ...current,
      continuityBriefing: {
        ...current.continuityBriefing,
        mode: subAction,
      },
    }),
  });

  const result = await deps.bootstrap(ctx);
  if (!result.ok) {
    return notifyReleaseProjectNamespaceMessage(
      `Continuity briefing mode set to ${updated.continuityBriefing?.mode || subAction}, but bootstrap failed: ${result.error}`,
      "warning",
    );
  }

  const nextEffective = resolveProjectContinuityBriefingMode(updated);
  return notifyReleaseProjectNamespaceMessage(
    `Continuity briefing mode is now ${updated.continuityBriefing?.mode || subAction} (effective=${nextEffective.mode}, source=${nextEffective.source}).`,
  );
};
