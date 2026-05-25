/**
 * File intent: stable public barrel for bundled upstream compatibility runtime.
 *
 * Implementation is split under `src/compat/upstream-extension-runtime/*` so
 * runtime mode, registration, proxying, routes, and read models can evolve in
 * focused modules without changing this import surface.
 */

export type {
  BundledUpstreamCompatibilityRegistrationResult,
  BundledUpstreamRuntimeMode,
  BundledUpstreamRuntimeModeStatus,
  UpstreamMemoryCommandDefinition,
  UpstreamToolDefinition,
} from "./upstream-extension-runtime/types.js";
export { createBundledUpstreamApiProxy } from "./upstream-extension-runtime/api-proxy.js";
export { registerBundledUpstreamCompatibility } from "./upstream-extension-runtime/registration.js";
export { resolveBundledUpstreamRuntimeMode } from "./upstream-extension-runtime/runtime-mode.js";
