/**
 * File intent: release-profile `/memory project` tokens and help text.
 *
 * Keep this file free of development command strings so release bundles have an
 * auditable stable command surface.
 */

export const RELEASE_PROJECT_MEMORY_ACTION_TOKENS = new Set([
  "status",
  "help",
  "set",
  "user",
  "on",
  "off",
  "mode",
  "continuity-briefing",
  "search",
  "index",
  "promote",
]);

/**
 * Render release-profile `/memory project` help text.
 */
export const renderReleaseProjectMemoryNamespaceHelp = (): string => (
  "Project namespace commands:\n" +
  "- /memory project status\n" +
  "- /memory project help\n" +
  "- /memory project on|off\n" +
  "- /memory project set <name>\n" +
  "- /memory project user <status|set <user>|auto>\n" +
  "- /memory project mode <status|index-first|fanout>\n" +
  "- /memory project continuity-briefing <status|lexical|semantic>\n" +
  "- /memory project search <query>\n" +
  "- /memory project index <status|rebuild>\n" +
  "- /memory project promote <status|run|dry-run|validate>"
);

/**
 * Mirror release command output through the shared notification path.
 */
export const notifyReleaseProjectNamespaceMessage = (
  message: string,
  _level: "info" | "warning" = "info",
): string => message;
