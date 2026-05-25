/**
 * File intent: provide small runtime helpers shared across extracted entrypoint services.
 *
 * These helpers are not generic utilities; they are scoped to Pi Muninn
 * extension runtime state and preserve previous session/request semantics.
 */

import { createHash } from "node:crypto";

import type {
  ContinuityCompactionProfileSelectionReason,
  ContinuityCompactionRequestProfile,
  MemoryExtensionRuntimeState,
} from "../runtime-state.js";
import {
  CONTINUITY_COMPACTION_LONG_REQUEST_GROUP_THRESHOLD,
  CONTINUITY_COMPACTION_LONG_REQUEST_SOURCE_ENTRY_THRESHOLD,
} from "./constants.js";
import { isContinuityBlockedVerboseEnabled, resolveContinuityCompactionProfileSelectionMode, resolveContinuityCompactionRequestBudgets, resolveContinuityCompactionRequestProfileOverride } from "./runtime-config.js";

/**
 * Build text tool-result payload without relying on vendored helpers.
 */
export const buildTextToolResult = (input: {
  text: string;
  details?: Record<string, unknown>;
}): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown> | null;
} => ({
  content: [{ type: "text", text: input.text }],
  details: input.details || null,
});

/**
 * Resolve session id with deterministic fallback.
 */
export const resolveSessionId = (ctx: any): string =>
  ctx?.sessionManager?.getSessionId?.() || "default-session";

/**
 * Emit temporary diagnostics whenever continuity registration is blocked.
 */
export const logContinuityBlocked = (input: {
  stage: string;
  reason: string;
  detail?: string;
  ctx?: any;
}): void => {
  if (!isContinuityBlockedVerboseEnabled()) {
    return;
  }

  const detailSuffix = input.detail && input.detail.trim().length > 0
    ? ` detail=${input.detail.trim()}`
    : "";

  const message = `[project-memory] continuity-blocked stage=${input.stage} reason=${input.reason}${detailSuffix}`;

  // eslint-disable-next-line no-console
  console.warn(message);

  if (input.ctx?.hasUI && typeof input.ctx?.ui?.notify === "function") {
    input.ctx.ui.notify(message, "warning");
  }
};

/**
 * Resolve deterministic request-scope id for compaction preview/apply budgets.
 */
export const createContinuityCompactionRequestServices = (state: MemoryExtensionRuntimeState): {
  resolveContinuityCompactionRequestScope: (ctx: any) => { requestScopeId: string; requestKey: string };
  resolveContinuityCompactionRequestProfile: (input: {
    ctx: any;
    requestScopeId: string;
    candidateSourceEntryCount?: number;
    candidateGroupCount?: number;
    preferredProfile?: ContinuityCompactionRequestProfile;
  }) => {
    profile: ContinuityCompactionRequestProfile;
    profileSelectionReason: ContinuityCompactionProfileSelectionReason;
    maxPreviewsPerRequest: number;
    maxAppliesPerRequest: number;
    maxPreviewRevisionsPerRequest: number;
  };
} => {
  const resolveContinuityCompactionRequestScope = (ctx: any): {
    requestScopeId: string;
    requestKey: string;
  } => {
    const sessionId = resolveSessionId(ctx);
    const requestKey = state.continuityRuntimeRequestKeyBySession.get(sessionId) || "no-user-message";

    const digest = createHash("sha256")
      .update(`${sessionId}:${requestKey}`, "utf8")
      .digest("hex")
      .slice(0, 24);

    return { requestScopeId: `req_${digest}`, requestKey };
  };

  const resolveContinuityCompactionRequestProfile = (input: {
    ctx: any;
    requestScopeId: string;
    candidateSourceEntryCount?: number;
    candidateGroupCount?: number;
    preferredProfile?: ContinuityCompactionRequestProfile;
  }): {
    profile: ContinuityCompactionRequestProfile;
    profileSelectionReason: ContinuityCompactionProfileSelectionReason;
    maxPreviewsPerRequest: number;
    maxAppliesPerRequest: number;
    maxPreviewRevisionsPerRequest: number;
  } => {
    const sessionId = resolveSessionId(input.ctx);
    const profileByScope = state.continuityCompactionProfileBySession.get(sessionId) || new Map<string, {
      profile: ContinuityCompactionRequestProfile;
      profileSelectionReason: ContinuityCompactionProfileSelectionReason;
    }>();

    const locked = profileByScope.get(input.requestScopeId);
    if (locked) {
      return {
        profile: locked.profile,
        profileSelectionReason: locked.profileSelectionReason,
        ...resolveContinuityCompactionRequestBudgets(locked.profile),
      };
    }

    let selectedProfile: ContinuityCompactionRequestProfile = "strict";
    let profileSelectionReason: ContinuityCompactionProfileSelectionReason = "default_strict";

    if (input.preferredProfile) {
      selectedProfile = input.preferredProfile;
      profileSelectionReason = input.preferredProfile === "strict"
        ? "default_strict"
        : "auto_detect_threshold";
    } else {
      const operatorOverride = resolveContinuityCompactionRequestProfileOverride();
      if (operatorOverride) {
        selectedProfile = operatorOverride;
        profileSelectionReason = "operator_override";
      } else {
        const mode = resolveContinuityCompactionProfileSelectionMode();
        const sourceEntryCount = input.candidateSourceEntryCount || 0;
        const groupCount = input.candidateGroupCount || 0;
        if (
          mode === "auto_detect_long_request" &&
          (sourceEntryCount >= CONTINUITY_COMPACTION_LONG_REQUEST_SOURCE_ENTRY_THRESHOLD ||
            groupCount >= CONTINUITY_COMPACTION_LONG_REQUEST_GROUP_THRESHOLD)
        ) {
          selectedProfile = "long-request";
          profileSelectionReason = "auto_detect_threshold";
        }
      }
    }

    profileByScope.set(input.requestScopeId, {
      profile: selectedProfile,
      profileSelectionReason,
    });
    state.continuityCompactionProfileBySession.set(sessionId, profileByScope);

    return {
      profile: selectedProfile,
      profileSelectionReason,
      ...resolveContinuityCompactionRequestBudgets(selectedProfile),
    };
  };

  return {
    resolveContinuityCompactionRequestScope,
    resolveContinuityCompactionRequestProfile,
  };
};
