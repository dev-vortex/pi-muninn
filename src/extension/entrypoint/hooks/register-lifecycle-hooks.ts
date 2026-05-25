/**
 * File intent: compose all extracted lifecycle hook handlers for the pi entrypoint.
 *
 * This module is the human-readable lifecycle map. It owns every `pi.on(...)`
 * registration while event-specific files own handler behavior.
 */

import { createAgentEndHandler } from "./agent-hooks/agent-end-handler.js";
import { createAgentStartHandler } from "./agent-hooks/agent-start-handler.js";
import { createBeforeAgentStartHandler } from "./agent-hooks/before-agent-start-handler.js";
import { createContextHandler } from "./turn-hooks/context-handler.js";
import { createSessionShutdownHandler } from "./session-hooks/session-shutdown-handler.js";
import { createSessionStartHandler } from "./session-hooks/session-start-handler.js";
import { createSessionTreeHandler } from "./session-hooks/session-tree-handler.js";
import { createToolResultHandler } from "./tool-result-hooks/tool-result-handler.js";
import { createTurnEndHandler } from "./turn-hooks/turn-end-handler.js";
import { createTurnStartHandler } from "./turn-hooks/turn-start-handler.js";
import type { LifecycleHookDependencies } from "./types.js";

/**
 * Register all lifecycle hooks in a single readable map.
 */
export const registerLifecycleHooks = (deps: LifecycleHookDependencies): void => {
  const { pi } = deps;

  // Session startup hooks.
  pi.on("session_start", createSessionStartHandler(deps));
  pi.on("session_tree", createSessionTreeHandler(deps));

  // Agent lifecycle hooks.
  pi.on("before_agent_start", createBeforeAgentStartHandler(deps));
  pi.on("agent_start", createAgentStartHandler(deps));
  pi.on("agent_end", createAgentEndHandler(deps));

  // Turn lifecycle hooks.
  pi.on("turn_start", createTurnStartHandler(deps));
  pi.on("context", createContextHandler(deps));
  pi.on("turn_end", createTurnEndHandler(deps));

  // Tool and shutdown hooks.
  pi.on("tool_result", createToolResultHandler(deps));
  pi.on("session_shutdown", createSessionShutdownHandler(deps));
};
