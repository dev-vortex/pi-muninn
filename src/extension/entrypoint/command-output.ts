/**
 * File intent: centralize visible command feedback behavior for pi clients.
 *
 * Some pi clients ignore command handler return strings, so command handlers must
 * also mirror user-visible text through `ctx.ui.notify()`. Keep that behavior
 * here so command modules do not each reimplement best-effort UI notification.
 */

import type {
  ExtensionCommandContextLike,
  ExtensionNotificationLevel,
} from "./runtime-types.js";

/**
 * Notify the UI when possible and always return the original message.
 *
 * Notification delivery is best-effort: UI failures must never make a command
 * fail because the returned string remains useful for tests/RPC-style callers.
 */
export const notifyCommandOutput = (
  ctx: ExtensionCommandContextLike,
  message: string,
  level: ExtensionNotificationLevel = "info",
): string => {
  if (typeof ctx?.ui?.notify === "function") {
    try {
      ctx.ui.notify(message, level);
    } catch {
      // Command feedback must never break command execution.
    }
  }

  return message;
};
