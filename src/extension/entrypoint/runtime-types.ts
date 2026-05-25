/**
 * File intent: define small shared types for the pi extension entrypoint modules.
 *
 * This file keeps entrypoint-facing structural contracts in one place so command,
 * hook, and tool modules can avoid importing large pi runtime types directly.
 * Keep these types intentionally minimal and expand them only when an extracted
 * module needs a stable cross-file contract.
 */

/**
 * UI notification levels supported by the extension command output helper.
 */
export type ExtensionNotificationLevel = "info" | "warning" | "error";

/**
 * Minimal UI surface used by command handlers for visible feedback.
 */
export interface ExtensionUiLike {
  notify?: (message: string, level?: ExtensionNotificationLevel) => unknown;
}

/**
 * Minimal command context surface used by extracted command helpers.
 */
export interface ExtensionCommandContextLike {
  ui?: ExtensionUiLike;
}

/**
 * Build profile used by source entrypoints and generated distribution bundles.
 */
export type PiExtensionBuildProfile = "dev" | "release";

/**
 * Options accepted by the extension composition root.
 */
export interface PiExtensionRegistrationOptions {
  profile?: PiExtensionBuildProfile;
}

/**
 * Common extension command registrar signature used by profile wrappers.
 */
export type PiExtensionCommandRegistrar = (deps: any) => void;

/**
 * Autocomplete item shape returned by `/memory` command completion helpers.
 */
export interface ExtensionAutocompleteItem {
  label: string;
  value: string;
  type: "text";
  /** Human-facing text shown by Pi autocomplete so users know what the command does. */
  description?: string;
}
