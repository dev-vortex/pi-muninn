/**
 * File intent: own host-neutral L3 global curated memory routing and policy.
 *
 * The service keeps reusable/global memory routing and promotion safety gates in
 * memory-core while delegating persistence/search to a vendor-compatible memory
 * provider behind `CoreMemoryProviderPort`.
 */

import type {
  MemoryOperationResult,
  MemorySaveRequest,
} from "../contracts.js";
import type { CoreMemoryProviderPort } from "../ports.js";

/**
 * Core promotion decision categories for global curated memory candidates.
 */
export type GlobalPromotionDecisionCode =
  | "accepted"
  | "too-short"
  | "blocked-source"
  | "project-specific"
  | "sensitive-content"
  | "low-score";

/**
 * Deterministic promotion policy owned by memory-core.
 */
export interface GlobalPromotionPolicy {
  /** Minimum candidate length accepted for durable global memory. */
  minimumContentLength: number;
  /** Minimum deterministic score required to accept candidate promotion. */
  minimumScore: number;
  /** Topics that are durable enough to be promoted. */
  durableTopics: string[];
  /** Sources never eligible for promotion. */
  blockedSources: string[];
  /** Keywords that increase durable promotion confidence. */
  durableKeywords: string[];
  /** Sensitive keywords that should not enter global memory. */
  sensitiveKeywords: string[];
  /** Whether sensitive markers hard-block promotion. */
  hardBlockSensitive: boolean;
}

/**
 * Candidate evaluated for global curated promotion.
 */
export interface GlobalPromotionCandidate {
  /** Candidate content. */
  content: string;
  /** Candidate topic. */
  topic: string;
  /** Candidate source. */
  source: string;
  /** Number of duplicate/equivalent occurrences in project index. */
  occurrenceCount: number;
  /** Number of distinct users represented by the candidate. */
  distinctUserCount: number;
}

/**
 * Deterministic promotion evaluation result.
 */
export interface GlobalPromotionEvaluationResult {
  /** Whether this candidate passes deterministic policy gates. */
  accepted: boolean;
  /** Deterministic score after gate checks. */
  score: number;
  /** Human-readable explanation of the decision. */
  rationale: string;
  /** Machine-readable decision code. */
  decisionCode: GlobalPromotionDecisionCode;
}

/**
 * Dependencies needed by global curated memory orchestration.
 */
export interface GlobalCuratedMemoryServiceDependencies {
  /** L1/L3 provider; this service uses only the global-curated lane. */
  memoryProvider: Pick<CoreMemoryProviderPort, "save">;
}

/**
 * Baseline deterministic policy for global curated promotion.
 */
export const DEFAULT_GLOBAL_PROMOTION_POLICY: GlobalPromotionPolicy = {
  minimumContentLength: 40,
  minimumScore: 0.65,
  durableTopics: [
    "general",
    "trait",
    "traits",
    "preference",
    "preferences",
    "principle",
    "principles",
    "standard",
    "standards",
    "process",
    "identity",
  ],
  blockedSources: ["auto-capture"],
  durableKeywords: [
    "always",
    "never",
    "prefer",
    "preferred",
    "default",
    "policy",
    "principle",
    "standard",
    "guideline",
    "trait",
  ],
  sensitiveKeywords: [
    "password",
    "secret",
    "token",
    "api key",
    "private key",
    "ssh key",
    "credential",
    "ssn",
    "social security",
    "credit card",
    "card number",
    "bank account",
  ],
  hardBlockSensitive: true,
};

/**
 * Normalize arbitrary user/LLM text fields for persistence and diagnostics.
 */
const normalizeText = (value: string | undefined): string =>
  (value || "").trim().replace(/\s+/g, " ");

/**
 * Build a memory operation result whose diagnostics are tool-details friendly.
 */
const buildOperationResult = (input: {
  status: MemoryOperationResult["status"];
  text: string;
  details: Record<string, unknown>;
  warnings?: string[];
}): MemoryOperationResult => ({
  status: input.status,
  text: input.text,
  warnings: input.warnings || [],
  diagnostics: input.details,
});

/**
 * Detect sensitive markers in candidate content.
 */
const detectSensitiveMarkers = (content: string, sensitiveKeywords: string[]): string[] => {
  const lowered = content.toLowerCase();
  return sensitiveKeywords.filter((keyword) => lowered.includes(keyword));
};

/**
 * Heuristic detector for explicit project/code artifacts.
 */
export const looksProjectSpecificForGlobalPromotion = (content: string): boolean => {
  const markers = [
    /\b(src\/|tests\/|\.agent\/|package\.json|dockerfile|makefile)\b/i,
    /\b\w+\.(ts|tsx|js|jsx|py|java|go|rb|cs|sql|md)\b/i,
    /\b(pr|mr|ticket|issue|commit)\s*#?\d+/i,
  ];

  return markers.some((pattern) => pattern.test(content));
};

/**
 * Evaluate one global promotion candidate against deterministic core policy.
 */
export const evaluateGlobalPromotionCandidate = (
  candidate: GlobalPromotionCandidate,
  policy: GlobalPromotionPolicy = DEFAULT_GLOBAL_PROMOTION_POLICY,
): GlobalPromotionEvaluationResult => {
  const content = normalizeText(candidate.content);
  const topic = normalizeText(candidate.topic).toLowerCase() || "general";
  const source = normalizeText(candidate.source).toLowerCase() || "unknown";
  const contentLower = content.toLowerCase();

  if (content.length < policy.minimumContentLength) {
    return {
      accepted: false,
      score: 0,
      rationale: `content shorter than minimum (${policy.minimumContentLength})`,
      decisionCode: "too-short",
    };
  }

  if (policy.blockedSources.includes(source)) {
    return {
      accepted: false,
      score: 0,
      rationale: `source '${candidate.source}' is blocked by policy`,
      decisionCode: "blocked-source",
    };
  }

  const sensitiveMarkers = detectSensitiveMarkers(content, policy.sensitiveKeywords);
  if (policy.hardBlockSensitive && sensitiveMarkers.length > 0) {
    return {
      accepted: false,
      score: 0,
      rationale: `sensitive marker detected (${sensitiveMarkers.slice(0, 3).join(", ")})`,
      decisionCode: "sensitive-content",
    };
  }

  if (looksProjectSpecificForGlobalPromotion(content)) {
    return {
      accepted: false,
      score: 0,
      rationale: "project/code artifact markers detected",
      decisionCode: "project-specific",
    };
  }

  const reasons: string[] = [];
  let score = 0;

  if (policy.durableTopics.includes(topic)) {
    score += topic === "general" ? 0.25 : 0.45;
    reasons.push(`durable topic '${candidate.topic || "general"}'`);
  }

  if (policy.durableKeywords.some((keyword) => contentLower.includes(keyword))) {
    score += 0.2;
    reasons.push("contains durable keyword");
  }

  if (candidate.occurrenceCount >= 2) {
    score += 0.15;
    reasons.push("repeated in project index");
  }

  if (candidate.distinctUserCount >= 2) {
    score += 0.15;
    reasons.push("seen across multiple users");
  }

  if (source.startsWith("manual")) {
    score += 0.2;
    reasons.push("manual source");
  }

  const roundedScore = Math.round(score * 1000) / 1000;
  if (score < policy.minimumScore) {
    return {
      accepted: false,
      score: roundedScore,
      rationale: reasons.length > 0
        ? `${reasons.join("; ")} (score ${score.toFixed(3)} < ${policy.minimumScore})`
        : `insufficient durable signals (score ${score.toFixed(3)} < ${policy.minimumScore})`,
      decisionCode: "low-score",
    };
  }

  return {
    accepted: true,
    score: roundedScore,
    rationale: reasons.join("; "),
    decisionCode: "accepted",
  };
};

/**
 * Create global curated memory orchestration around one memory provider.
 */
export const createGlobalCuratedMemoryService = (
  dependencies: GlobalCuratedMemoryServiceDependencies,
): {
  save: (input: MemorySaveRequest) => Promise<MemoryOperationResult>;
} => ({
  save: async (input: MemorySaveRequest): Promise<MemoryOperationResult> => {
    const generalContent = normalizeText(input.generalContent);
    if (!generalContent) {
      return buildOperationResult({
        status: "error",
        text: "memory_save general route requires non-empty general_content.",
        details: {
          status: "blocked-project-curation",
          target: "general",
          route: "memory_save_L3",
          reason: "invalid-general-payload",
        },
      });
    }

    const topic = normalizeText(input.generalTopic) || "general";
    const providerResult = await dependencies.memoryProvider.save({
      context: input.context,
      lane: "global-curated",
      content: generalContent,
      projectName: "general",
      topic,
      source: "manual-save",
      timestamp: input.context.now,
      importance: input.importance,
    });

    if (providerResult.status === "error") {
      const warning = providerResult.warnings[0] || "unknown error";
      return buildOperationResult({
        status: "error",
        text: `memory_save general route failed: ${warning}`,
        details: {
          status: "error-general-route",
          target: "general",
          route: "memory_save_L3",
          error: warning,
          ...providerResult.diagnostics,
        },
        warnings: providerResult.warnings,
      });
    }

    const isDuplicate = providerResult.duplicate;
    return buildOperationResult({
      status: "ok",
      text: isDuplicate
        ? "memory_save routed general payload to related user memory (duplicate already existed)."
        : "memory_save routed general payload to related user memory and stored it for cross-project reuse.",
      details: {
        status: isDuplicate ? "duplicate-general" : "stored-general",
        target: "general",
        route: "memory_save_L3",
        storageLayer: "related_user_memory",
        policy: "high-recall",
        projectBucket: "general",
        topic,
        importance: input.importance,
        memoryId: providerResult.id,
        upstreamStatus: isDuplicate ? "duplicate" : "stored",
        ...providerResult.diagnostics,
        routingQuality: {
          decisionMode: "explicit-general-payload",
          capturePolicy: "broad",
          traceability: {
            targetField: "general_content",
            topicProvided: Boolean(input.generalTopic),
            topicDefaulted: !input.generalTopic,
            contentLength: generalContent.length,
          },
        },
      },
    });
  },
});
