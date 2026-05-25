/**
 * File intent: release-profile Pi extension source entrypoint.
 *
 * This wrapper gives the distribution build a stable release/prod entry module.
 * Release command filtering is enforced by the profile-aware registration path
 * as the Rollup distribution slices split dev-only modules away from release.
 */

import { registerReleaseExtensionCommands } from "./commands/register-commands.release.js";
import { registerProjectAwareMemoryExtension } from "./register-project-aware-memory-extension.js";

/**
 * Register the release profile of the project-aware memory extension.
 *
 * Release builds must keep only the approved stable command/tool surface and
 * must not import development-only command modules once the profile split is
 * wired into the generated artifact.
 */
export default function projectAwareMemoryExtensionRelease(pi: any): void {
  registerProjectAwareMemoryExtension(pi, {
    profile: "release",
    registerCommands: registerReleaseExtensionCommands,
  });
}
