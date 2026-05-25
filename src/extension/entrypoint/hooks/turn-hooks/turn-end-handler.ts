/**
 * File intent: create the turn_end lifecycle handler.
 *
 * Project-memory turn-end auto-capture is intentionally disabled so memory
 * persistence remains explicit through LLM-driven memory_save payload routing.
 */

import type { LifecycleEventHandler, LifecycleHookDependencies } from "../types.js";

/**
 * Build the turn_end handler with explicit lifecycle dependencies.
 */
export const createTurnEndHandler = (_deps: LifecycleHookDependencies): LifecycleEventHandler =>
  async (_event: unknown, _ctx: any) => {
    // Project-memory turn-end auto-capture was intentionally removed.
    // Memory persistence must remain explicit (LLM-driven memory_save payload routing).
  };
