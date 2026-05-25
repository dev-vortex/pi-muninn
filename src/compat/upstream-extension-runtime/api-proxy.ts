/**
 * File intent: proxy the Pi API exposed to vendored upstream pi-mempalace.
 *
 * The proxy captures upstream `/memory`, gates lifecycle auto-writes, wraps
 * selected tools, and leaves all unrelated host API calls untouched.
 */

import {
  BUNDLED_UPSTREAM_CUSTOM_WRAPPED_TOOLS,
  BUNDLED_UPSTREAM_GATED_EVENTS,
  BUNDLED_UPSTREAM_GATED_WRITE_TOOLS,
} from "./constants.js";
import { resolveContextCwd, resolveHomeDirectory } from "./environment.js";
import { executePayloadRoutedMemorySave } from "./memory-save-routes.js";
import { applyMemorySavePayloadContract } from "./payload-contracts.js";
import { executeProjectAwareMemoryRecall } from "./project-aware-memory-recall.js";
import { executeProjectAwareMemorySearch } from "./project-aware-memory-search.js";
import {
  executeProjectAwareMemoryGraph,
  executeProjectAwareMemoryTunnel,
} from "./project-user-relations.js";
import { resolveBundledUpstreamRuntimeMode } from "./runtime-mode.js";
import { buildProjectCurationBlockedToolResult } from "./text-tool-result.js";
import type { UpstreamMemoryCommandDefinition, UpstreamToolDefinition } from "./types.js";

export const createBundledUpstreamApiProxy = (input: {
  pi: any;
  homeDirectory?: string;
  onCaptureMemoryCommand?: (command: UpstreamMemoryCommandDefinition) => void;
}): any => {
  const homeDirectory = input.homeDirectory || resolveHomeDirectory();

  return new Proxy(input.pi, {
    get(target: any, property: PropertyKey, receiver: unknown): unknown {
      if (property === "on") {
        if (typeof target.on !== "function") {
          return undefined;
        }

        return (eventName: string, handler: (event: unknown, ctx: any) => unknown): void => {
          if (!BUNDLED_UPSTREAM_GATED_EVENTS.has(eventName)) {
            target.on(eventName, handler);
            return;
          }

          target.on(eventName, async (event: unknown, ctx: any) => {
            const mode = await resolveBundledUpstreamRuntimeMode({
              cwd: resolveContextCwd(ctx),
              homeDirectory,
            });

            if (!mode.allowGlobalLifecycleHooks) {
              return undefined;
            }

            return handler(event, ctx);
          });
        };
      }

      if (property === "sendUserMessage") {
        const sendUserMessage = Reflect.get(target, property, receiver);
        if (typeof sendUserMessage !== "function") {
          return sendUserMessage;
        }

        return (message: string, options?: unknown, ...rest: unknown[]): unknown => {
          const effectiveOptions = options === undefined
            ? { streamingBehavior: "followUp" }
            : options;

          return sendUserMessage.call(target, message, effectiveOptions, ...rest);
        };
      }

      if (property === "registerCommand") {
        if (typeof target.registerCommand !== "function") {
          return undefined;
        }

        return (commandName: string, command: UpstreamMemoryCommandDefinition): void => {
          if (commandName === "memory" && command && typeof command.handler === "function") {
            input.onCaptureMemoryCommand?.(command);
            return;
          }

          target.registerCommand(commandName, command);
        };
      }

      if (property === "registerTool") {
        if (typeof target.registerTool !== "function") {
          return undefined;
        }

        return (tool: UpstreamToolDefinition): void => {
          const payloadToolDefinition = applyMemorySavePayloadContract(tool);
          const toolName = typeof payloadToolDefinition?.name === "string"
            ? payloadToolDefinition.name
            : "";
          const originalExecute = typeof payloadToolDefinition?.execute === "function"
            ? payloadToolDefinition.execute
            : null;

          const shouldWrap = toolName.length > 0
            && !!originalExecute
            && (
              BUNDLED_UPSTREAM_GATED_WRITE_TOOLS.has(toolName)
              || BUNDLED_UPSTREAM_CUSTOM_WRAPPED_TOOLS.has(toolName)
            );

          if (!shouldWrap) {
            target.registerTool(payloadToolDefinition);
            return;
          }

          const wrappedTool: UpstreamToolDefinition = {
            ...payloadToolDefinition,
            execute: async (...executeArgs: any[]): Promise<unknown> => {
              const ctx = executeArgs[4];
              const mode = await resolveBundledUpstreamRuntimeMode({
                cwd: resolveContextCwd(ctx),
                homeDirectory,
              });

              if (toolName === "memory_save") {
                return executePayloadRoutedMemorySave({
                  toolInput: executeArgs[1],
                  ctx,
                  mode,
                  executeArgs,
                  originalExecute,
                });
              }

              if (toolName === "memory_search") {
                if (mode.mode !== "project-curation") {
                  return originalExecute(...executeArgs);
                }

                return executeProjectAwareMemorySearch({
                  toolInput: executeArgs[1],
                  ctx,
                  executeArgs,
                  originalExecute,
                  homeDirectory,
                });
              }

              if (toolName === "memory_recall") {
                if (mode.mode !== "project-curation") {
                  return originalExecute(...executeArgs);
                }

                return executeProjectAwareMemoryRecall({
                  toolInput: executeArgs[1],
                  ctx,
                  executeArgs,
                  originalExecute,
                });
              }

              if (toolName === "memory_graph") {
                if (mode.mode !== "project-curation") {
                  return originalExecute(...executeArgs);
                }

                return executeProjectAwareMemoryGraph({
                  ctx,
                });
              }

              if (toolName === "memory_tunnel") {
                if (mode.mode !== "project-curation") {
                  return originalExecute(...executeArgs);
                }

                return executeProjectAwareMemoryTunnel({
                  toolInput: executeArgs[1],
                  ctx,
                });
              }

              if (mode.mode === "compatibility") {
                return originalExecute(...executeArgs);
              }

              return buildProjectCurationBlockedToolResult({
                toolName,
                mode,
                explanation:
                  "This global-write tool remains blocked in project-curation mode. " +
                  "Use memory_save payload routing and project promotion flows.",
              });
            },
          };

          target.registerTool(wrappedTool);
        };
      }

      return Reflect.get(target, property, receiver);
    },
  });
};

/**
 * Register vendored upstream compatibility behavior in the host extension.
 *
 * Fails closed when optional native dependencies are unhealthy so runtime
 * degrades into deterministic fallback mode instead of command-time crashes.
 */
