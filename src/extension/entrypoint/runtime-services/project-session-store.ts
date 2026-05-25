/**
 * File intent: manage session-scoped project runtime cache for the Pi entrypoint.
 *
 * This service bridges Pi extension contexts to resolved project runtime context,
 * stores that context per session id, and clears it on shutdown. Keep session
 * cache wiring here; keep deep runtime resolution in `runtime/project-runtime-context.ts`.
 */

import {
  resolveProjectRuntimeContext,
  type ProjectRuntimeContext,
} from "../../../runtime/project-runtime-context.js";

/**
 * Minimal context surface required from a Pi extension context for session wiring.
 */
export interface ExtensionContextLike {
  /** Project/workspace root path used for project memory files. */
  cwd: string;
  /** Optional session manager used to isolate runtime context per session. */
  sessionManager?: {
    getSessionId?: () => string;
  };
}

/**
 * Session runtime store used by the repo-controlled extension entrypoint.
 */
export interface ProjectSessionRuntimeStore {
  /** Runtime context keyed by session id. */
  bySessionId: Map<string, ProjectRuntimeContext>;
}

/**
 * Create an empty session runtime store.
 */
export const createProjectSessionRuntimeStore = (): ProjectSessionRuntimeStore => ({
  bySessionId: new Map(),
});

/**
 * Resolve the current session id with a deterministic fallback.
 *
 * Decision: fallback to a static id to keep behavior deterministic when
 * session manager data is unavailable (for example tests or degraded runtime).
 */
export const resolveProjectSessionId = (ctx: ExtensionContextLike): string =>
  ctx.sessionManager?.getSessionId?.() || "default-session";

/**
 * Bootstrap project runtime context for the provided extension context and
 * persist it in the session runtime store.
 */
export const bootstrapProjectSessionRuntime = async (input: {
  ctx: ExtensionContextLike;
  store: ProjectSessionRuntimeStore;
  explicitUserId?: string;
  persistResolvedUserId?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<ProjectRuntimeContext> => {
  const runtimeContext = await resolveProjectRuntimeContext({
    projectRoot: input.ctx.cwd,
    explicitUserId: input.explicitUserId,
    persistResolvedUserId: input.persistResolvedUserId,
    env: input.env,
  });

  input.store.bySessionId.set(resolveProjectSessionId(input.ctx), runtimeContext);
  return runtimeContext;
};

/**
 * Retrieve the current session runtime context if available.
 */
export const getProjectSessionRuntime = (input: {
  ctx: ExtensionContextLike;
  store: ProjectSessionRuntimeStore;
}): ProjectRuntimeContext | null =>
  input.store.bySessionId.get(resolveProjectSessionId(input.ctx)) || null;

/**
 * Clear the current session runtime context on session shutdown.
 */
export const clearProjectSessionRuntime = (input: {
  ctx: ExtensionContextLike;
  store: ProjectSessionRuntimeStore;
}): void => {
  input.store.bySessionId.delete(resolveProjectSessionId(input.ctx));
};
