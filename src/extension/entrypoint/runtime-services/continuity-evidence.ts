/**
 * File intent: track artifact/source evidence for continuity compliance checks.
 *
 * These helpers detect whether semantic continuity entries carry enough human
 * provenance without coupling that logic to lifecycle hook registration.
 */

import path from "node:path";

import { CONTINUITY_REQUEST_EVIDENCE_PATH_LIMIT, CONTINUITY_USER_INTENT_SIGNAL_PATTERNS } from "./constants.js";

/**
 * Resolve active workspace root from lifecycle context with process fallback.
 */
export const resolveWorkspaceRoot = (ctx: any): string =>
  typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd();

/**
 * Normalize one tracked path for continuity evidence.
 */
export const normalizeContinuityTrackedPath = (input: {
  ctx: any;
  rawPath: string;
}): string => {
  const normalized = input.rawPath.trim();
  if (normalized.length === 0) {
    return normalized;
  }

  const workspaceRoot = resolveWorkspaceRoot(input.ctx);
  const absolutePath = path.isAbsolute(normalized)
    ? normalized
    : path.resolve(workspaceRoot, normalized);
  const relativePath = path.relative(workspaceRoot, absolutePath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return absolutePath;
  }

  return relativePath || normalized;
};

/**
 * Record one artifact path into the continuity compliance tracker.
 */
export const recordContinuityEvidencePath = (input: {
  target: Set<string>;
  pathValue: string | null;
}): void => {
  if (!input.pathValue || input.pathValue.trim().length === 0) {
    return;
  }

  if (input.target.has(input.pathValue)) {
    return;
  }

  if (input.target.size >= CONTINUITY_REQUEST_EVIDENCE_PATH_LIMIT) {
    const oldest = input.target.values().next().value;
    if (typeof oldest === "string") {
      input.target.delete(oldest);
    }
  }

  input.target.add(input.pathValue);
};

/**
 * Check whether content mentions at least one changed/request artifact path.
 */
export const continuityContentHasPathEvidence = (input: {
  content: string;
  paths: Set<string>;
}): boolean => {
  const normalizedContent = input.content.trim().toLowerCase();
  if (normalizedContent.length === 0 || input.paths.size === 0) {
    return false;
  }

  for (const pathValue of input.paths) {
    const normalizedPath = pathValue.toLowerCase();
    if (normalizedPath.length === 0) {
      continue;
    }

    if (normalizedContent.includes(normalizedPath)) {
      return true;
    }

    const baseName = path.basename(normalizedPath);
    if (baseName.length > 0 && normalizedContent.includes(baseName)) {
      return true;
    }
  }

  return false;
};

/**
 * Check whether source refs include at least one changed/request artifact path.
 */
export const continuitySourceRefsHavePathEvidence = (input: {
  sourceRefs: string[];
  paths: Set<string>;
}): boolean => {
  if (input.sourceRefs.length === 0 || input.paths.size === 0) {
    return false;
  }

  const normalizedPathPool = [...input.paths]
    .map((value) => value.toLowerCase())
    .filter((value) => value.length > 0);

  if (normalizedPathPool.length === 0) {
    return false;
  }

  for (const sourceRef of input.sourceRefs) {
    const normalizedRef = sourceRef.toLowerCase();
    if (normalizedRef.length === 0) {
      continue;
    }

    for (const normalizedPath of normalizedPathPool) {
      if (normalizedRef.includes(normalizedPath)) {
        return true;
      }

      const baseName = path.basename(normalizedPath);
      if (baseName.length > 0 && normalizedRef.includes(baseName)) {
        return true;
      }
    }
  }

  return false;
};

/**
 * Detect user-intent evidence in semantic continuity content/source refs.
 */
export const continuityHasUserIntentEvidence = (input: {
  content: string;
  sourceRefs: string[];
}): boolean => {
  const normalizedContent = input.content.trim();
  if (CONTINUITY_USER_INTENT_SIGNAL_PATTERNS.some((pattern) => pattern.test(normalizedContent))) {
    return true;
  }

  return input.sourceRefs.some((sourceRef) =>
    CONTINUITY_USER_INTENT_SIGNAL_PATTERNS.some((pattern) => pattern.test(sourceRef))
  );
};

/**
 * Detect whether content carries embedded source_refs evidence.
 */
export const continuityHasEmbeddedSourceRefs = (content: string): boolean =>
  /\bsource_refs\s*:/i.test(content);

/**
 * Record artifact coverage from continuity entry content.
 */
export const recordContinuityArtifactCoverageFromContent = (input: {
  content: string;
  artifactPaths: Set<string>;
  coverageTarget: Set<string>;
}): void => {
  const normalizedContent = input.content.trim().toLowerCase();
  if (normalizedContent.length === 0 || input.artifactPaths.size === 0) {
    return;
  }

  for (const artifactPath of input.artifactPaths) {
    const normalizedPath = artifactPath.toLowerCase();
    if (normalizedPath.length === 0) {
      continue;
    }

    const baseName = path.basename(normalizedPath);
    if (
      normalizedContent.includes(normalizedPath)
      || (baseName.length > 0 && normalizedContent.includes(baseName))
    ) {
      input.coverageTarget.add(artifactPath);
    }
  }
};

/**
 * Record artifact coverage from explicit source refs.
 */
export const recordContinuityArtifactCoverageFromSourceRefs = (input: {
  sourceRefs: string[];
  artifactPaths: Set<string>;
  coverageTarget: Set<string>;
}): void => {
  if (input.sourceRefs.length === 0 || input.artifactPaths.size === 0) {
    return;
  }

  for (const artifactPath of input.artifactPaths) {
    const normalizedPath = artifactPath.toLowerCase();
    if (normalizedPath.length === 0) {
      continue;
    }

    const baseName = path.basename(normalizedPath);

    for (const sourceRef of input.sourceRefs) {
      const normalizedRef = sourceRef.toLowerCase();
      if (
        normalizedRef.includes(normalizedPath)
        || (baseName.length > 0 && normalizedRef.includes(baseName))
      ) {
        input.coverageTarget.add(artifactPath);
        break;
      }
    }
  }
};

/**
 * Render a compact artifact evidence summary for warning messages.
 */
export const renderContinuityEvidenceSummary = (input: {
  label: string;
  paths: Set<string>;
  maxItems?: number;
}): string => {
  if (input.paths.size === 0) {
    return `${input.label}=none`;
  }

  const maxItems = Math.max(1, input.maxItems ?? 3);
  const values = [...input.paths];
  const visible = values.slice(0, maxItems);
  const remaining = Math.max(0, values.length - visible.length);

  const suffix = remaining > 0
    ? ` (+${remaining} more)`
    : "";

  return `${input.label}=${visible.join(", ")}${suffix}`;
};

/**
 * Bound changed/request evidence paths to avoid noisy continuity warnings.
 */
export const selectBoundedContinuityEvidencePaths = (paths: Set<string>): string[] =>
  [...paths].slice(0, CONTINUITY_REQUEST_EVIDENCE_PATH_LIMIT);
