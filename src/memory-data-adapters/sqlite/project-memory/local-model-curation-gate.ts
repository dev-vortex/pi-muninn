/**
 * File intent: score promotion candidates with local semantic heuristics.
 *
 * This file compares project-index candidate text against durable/global,
 * project-specific, and noise anchors to produce curation decisions before
 * promoting project memory into global memory. Keep candidate scoring and
 * validation sampling here; keep promotion persistence in `promotion-pipeline.ts`.
 */

import { createHash } from "node:crypto";

import {
  openBetterSqliteDatabase,
} from "../common/better-sqlite3-adapter.js";
import {
  readProjectIndexStatus,
  resolveProjectIndexDatabasePath,
} from "../project-index/project-index.js";

/**
 * Local embedding function used for curation-gate decisions.
 */
export type LocalCurationEmbedText = (text: string) => Promise<number[] | Float32Array>;

/**
 * Tunables for local-model curation gate.
 */
export interface LocalModelCurationGateConfig {
  /** Minimum candidate length required before any promotion consideration. */
  minimumContentLength: number;
  /** Minimum durable similarity required for promotion. */
  minimumDurableSimilarity: number;
  /** Minimum durable-vs-context margin required for promotion. */
  minimumCompositeScore: number;
}

/**
 * One local-model decision scorecard.
 */
export interface LocalModelCurationScores {
  durableSimilarity: number;
  projectSpecificSimilarity: number;
  noiseSimilarity: number;
  compositeScore: number;
}

/**
 * One candidate-level local-model curation decision.
 */
export interface LocalModelCurationDecision {
  promoteGlobal: boolean;
  confidence: number;
  rationale: string;
  scores: LocalModelCurationScores;
}

/**
 * Input payload for candidate-level curation decision.
 */
export interface EvaluateLocalModelCurationCandidateInput {
  content: string;
  topic?: string;
  source?: string;
  config?: Partial<LocalModelCurationGateConfig>;
  embedText?: LocalCurationEmbedText;
}

/**
 * One project-index candidate row used for validation sampling.
 */
interface ProjectIndexCandidateRow {
  contentHash: string;
  content: string;
  topic: string;
  source: string;
  timestamp: string;
  representativeUserId: string;
}

/**
 * One recorded decision from project-index validation run.
 */
export interface ProjectIndexLocalModelDecisionRow {
  contentHash: string;
  topic: string;
  source: string;
  timestamp: string;
  representativeUserId: string;
  promoteGlobal: boolean;
  confidence: number;
  rationale: string;
  scores: LocalModelCurationScores;
}

/**
 * Input payload for project-index local-model validation.
 */
export interface ValidateProjectIndexWithLocalModelInput {
  projectMemoryDir: string;
  sampleSize?: number;
  config?: Partial<LocalModelCurationGateConfig>;
  embedText?: LocalCurationEmbedText;
}

/**
 * Validation result envelope for project-index local-model gate checks.
 */
export interface ValidateProjectIndexWithLocalModelResult {
  projectMemoryDir: string;
  indexDatabasePath: string;
  indexStatus: string;
  indexReady: boolean;
  sampleSize: number;
  candidateCount: number;
  evaluatedCount: number;
  promotedCount: number;
  rejectedCount: number;
  decisions: ProjectIndexLocalModelDecisionRow[];
  warnings: string[];
}

const DEFAULT_LOCAL_MODEL_CURATION_GATE_CONFIG: LocalModelCurationGateConfig = {
  minimumContentLength: 40,
  minimumDurableSimilarity: 0.33,
  minimumCompositeScore: 0.06,
};

const LOCAL_EMBED_MODEL_NAME = "Xenova/all-MiniLM-L6-v2";

const DURABLE_PROTOTYPES = [
  "This memory captures durable cross-project preferences, standards, principles, or identity traits.",
  "This information should remain useful across many projects and over long periods.",
  "General, enduring context about user behavior, policy, or reasoning style.",
];

const PROJECT_SPECIFIC_PROTOTYPES = [
  "This memory is specific to a single project task, file, ticket, branch, or implementation detail.",
  "Short-lived project progress update that should stay project-local.",
  "Project-only debugging details and temporary implementation context.",
];

const NOISE_PROTOTYPES = [
  "Short conversational filler, acknowledgement, or low-signal response.",
  "Non-durable chatter that should not be promoted globally.",
  "Ephemeral response text without enduring long-term value.",
];

const LEXICAL_DURABLE_KEYWORDS = [
  "default",
  "principle",
  "standard",
  "policy",
  "preference",
  "cross-project",
  "durable",
  "always",
  "never",
];

const LEXICAL_PROJECT_KEYWORDS = [
  "ticket",
  "branch",
  "src/",
  "file",
  "project",
  "task",
  "pr",
  "bug",
  "fix",
  "feature",
];

const LEXICAL_NOISE_KEYWORDS = [
  "thanks",
  "thank you",
  "sure",
  "okay",
  "ok",
  "great",
  "cool",
  "hello",
  "bye",
];

let defaultEmbedTextPromise: Promise<LocalCurationEmbedText> | null = null;

/**
 * Clamp numeric value to [0, 1].
 */
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * Normalize unknown numeric vectors into plain finite number arrays.
 */
const normalizeVector = (input: number[] | Float32Array): number[] => {
  const values = Array.from(input);
  return values.map((value) => (Number.isFinite(value) ? value : 0));
};

/**
 * Compute cosine similarity between two vectors.
 */
const cosineSimilarity = (left: number[], right: number[]): number => {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }

  if (leftNorm <= 0 || rightNorm <= 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
};

/**
 * Compute average similarity between candidate and prototype vectors.
 */
const averageSimilarity = (candidate: number[], prototypeVectors: number[][]): number => {
  if (prototypeVectors.length === 0) {
    return 0;
  }

  const sum = prototypeVectors.reduce((accumulator, prototypeVector) =>
    accumulator + cosineSimilarity(candidate, prototypeVector), 0,
  );

  return sum / prototypeVectors.length;
};

/**
 * Build a stable hash used for candidate deduping in validation runs.
 */
const contentHash = (content: string): string =>
  createHash("sha256").update(content.trim().toLowerCase(), "utf8").digest("hex").slice(0, 16);

/**
 * Resolve configurable local gate thresholds with safe bounds.
 */
const resolveGateConfig = (
  config?: Partial<LocalModelCurationGateConfig>,
): LocalModelCurationGateConfig => ({
  minimumContentLength:
    typeof config?.minimumContentLength === "number" && config.minimumContentLength >= 1
      ? Math.floor(config.minimumContentLength)
      : DEFAULT_LOCAL_MODEL_CURATION_GATE_CONFIG.minimumContentLength,
  minimumDurableSimilarity:
    typeof config?.minimumDurableSimilarity === "number"
      ? Math.max(-1, Math.min(1, config.minimumDurableSimilarity))
      : DEFAULT_LOCAL_MODEL_CURATION_GATE_CONFIG.minimumDurableSimilarity,
  minimumCompositeScore:
    typeof config?.minimumCompositeScore === "number"
      ? Math.max(-1, Math.min(1, config.minimumCompositeScore))
      : DEFAULT_LOCAL_MODEL_CURATION_GATE_CONFIG.minimumCompositeScore,
});

/**
 * Count keyword hits in normalized text.
 */
const countKeywordHits = (text: string, keywords: string[]): number =>
  keywords.reduce((accumulator, keyword) =>
    accumulator + (text.includes(keyword) ? 1 : 0), 0,
  );

/**
 * Resolve deterministic lexical fallback embedder.
 *
 * Decision:
 * - fallback keeps curation validation usable on low-resource/offline machines,
 * - lexical vectors are intentionally simple and stable for repeatability.
 */
const resolveLexicalFallbackEmbedText = (): LocalCurationEmbedText =>
  async (text: string): Promise<number[]> => {
    const normalized = text.toLowerCase();
    const tokenCount = normalized.split(/\s+/).filter((token) => token.length > 0).length;
    const lengthFeature = Math.min(1, tokenCount / 60);

    const durableHits = countKeywordHits(normalized, LEXICAL_DURABLE_KEYWORDS);
    const projectHits = countKeywordHits(normalized, LEXICAL_PROJECT_KEYWORDS);
    const noiseHits = countKeywordHits(normalized, LEXICAL_NOISE_KEYWORDS);

    // Keep all dimensions > 0 for stable cosine math.
    return [
      durableHits + 1,
      projectHits + 1,
      noiseHits + 1,
      lengthFeature + 1,
    ];
  };

/**
 * Reset default embedder cache (test-only utility).
 */
export const resetDefaultLocalCurationEmbedderCacheForTests = (): void => {
  defaultEmbedTextPromise = null;
};

/**
 * Resolve default local embed function from `@huggingface/transformers`.
 */
const resolveDefaultEmbedText = async (): Promise<LocalCurationEmbedText> => {
  if (!defaultEmbedTextPromise) {
    defaultEmbedTextPromise = (async () => {
      if (process.env.PI_OFFLINE === "1") {
        return resolveLexicalFallbackEmbedText();
      }

      try {
        const { pipeline } = await import("@huggingface/transformers");
        const extractor = await pipeline("feature-extraction", LOCAL_EMBED_MODEL_NAME, {
          dtype: "fp32" as never,
        });

        return async (text: string): Promise<number[]> => {
          const result = await extractor(text, {
            pooling: "mean",
            normalize: true,
          });

          return normalizeVector(result.data as Float32Array);
        };
      } catch {
        return resolveLexicalFallbackEmbedText();
      }
    })();
  }

  return defaultEmbedTextPromise;
};

/**
 * Build semantically-rich candidate prompt used by local model evaluator.
 */
const buildCandidatePrompt = (input: {
  content: string;
  topic?: string;
  source?: string;
}): string => {
  const topic = input.topic || "general";
  const source = input.source || "unknown";

  return [
    `Topic: ${topic}`,
    `Source: ${source}`,
    "Candidate memory:",
    input.content.trim(),
  ].join("\n");
};

/**
 * Evaluate one candidate with local semantic model gate.
 */
export const evaluateLocalModelCurationCandidate = async (
  input: EvaluateLocalModelCurationCandidateInput,
): Promise<LocalModelCurationDecision> => {
  const config = resolveGateConfig(input.config);
  const content = input.content.trim();

  if (content.length < config.minimumContentLength) {
    return {
      promoteGlobal: false,
      confidence: 1,
      rationale: `content length ${content.length} is below minimum ${config.minimumContentLength}`,
      scores: {
        durableSimilarity: 0,
        projectSpecificSimilarity: 0,
        noiseSimilarity: 0,
        compositeScore: -1,
      },
    };
  }

  const embedText = input.embedText || (await resolveDefaultEmbedText());

  const candidateVector = normalizeVector(
    await embedText(
      buildCandidatePrompt({
        content,
        topic: input.topic,
        source: input.source,
      }),
    ),
  );

  const durableVectors = await Promise.all(DURABLE_PROTOTYPES.map(async (prototype) =>
    normalizeVector(await embedText(prototype))
  ));

  const projectSpecificVectors = await Promise.all(PROJECT_SPECIFIC_PROTOTYPES.map(async (prototype) =>
    normalizeVector(await embedText(prototype))
  ));

  const noiseVectors = await Promise.all(NOISE_PROTOTYPES.map(async (prototype) =>
    normalizeVector(await embedText(prototype))
  ));

  const durableSimilarity = averageSimilarity(candidateVector, durableVectors);
  const projectSpecificSimilarity = averageSimilarity(candidateVector, projectSpecificVectors);
  const noiseSimilarity = averageSimilarity(candidateVector, noiseVectors);
  const compositeScore = durableSimilarity - Math.max(projectSpecificSimilarity, noiseSimilarity);

  const promoteGlobal =
    durableSimilarity >= config.minimumDurableSimilarity &&
    compositeScore >= config.minimumCompositeScore;

  const confidence = clamp01(
    (durableSimilarity + Math.max(0, compositeScore) + (promoteGlobal ? 0.2 : 0)) / 1.8,
  );

  return {
    promoteGlobal,
    confidence,
    rationale:
      `durable=${durableSimilarity.toFixed(3)}, ` +
      `project=${projectSpecificSimilarity.toFixed(3)}, ` +
      `noise=${noiseSimilarity.toFixed(3)}, ` +
      `composite=${compositeScore.toFixed(3)} ` +
      `(minDurable=${config.minimumDurableSimilarity.toFixed(3)}, minComposite=${config.minimumCompositeScore.toFixed(3)})`,
    scores: {
      durableSimilarity,
      projectSpecificSimilarity,
      noiseSimilarity,
      compositeScore,
    },
  };
};

/**
 * Read recent index candidates from `${PROJECT}/.agent/memory/cache.db`.
 */
const readRecentProjectIndexCandidates = (input: {
  indexDatabasePath: string;
  sampleSize: number;
  ownerUserId?: string | null;
}): ProjectIndexCandidateRow[] => {
  const db = openBetterSqliteDatabase(input.indexDatabasePath, {
    readOnly: true,
    fileMustExist: true,
  });

  try {
    const fetchLimit = Math.max(input.sampleSize * 4, input.sampleSize);

    const ownerUserId = input.ownerUserId?.trim() || null;

    const rows = ownerUserId
      ? db.prepare(`
        SELECT content, topic, source, timestamp, user_id
        FROM indexed_memories
        WHERE owner_user_id = ?
          AND record_kind = 'memory'
        ORDER BY timestamp DESC
        LIMIT ?
      `).all(ownerUserId, fetchLimit)
      : db.prepare(`
        SELECT content, topic, source, timestamp, user_id
        FROM indexed_memories
        WHERE record_kind = 'memory'
        ORDER BY timestamp DESC
        LIMIT ?
      `).all(fetchLimit);

    const deduped = new Map<string, ProjectIndexCandidateRow>();

    for (const row of rows) {
      const content = typeof row.content === "string" ? row.content.trim() : "";
      if (!content) {
        continue;
      }

      const hash = contentHash(content);
      if (deduped.has(hash)) {
        continue;
      }

      deduped.set(hash, {
        contentHash: hash,
        content,
        topic: typeof row.topic === "string" ? row.topic : "general",
        source: typeof row.source === "string" ? row.source : "unknown",
        timestamp: typeof row.timestamp === "string" ? row.timestamp : "",
        representativeUserId: typeof row.user_id === "string" ? row.user_id : "unknown-user",
      });

      if (deduped.size >= input.sampleSize) {
        break;
      }
    }

    return [...deduped.values()];
  } finally {
    db.close();
  }
};

/**
 * Validate project-index candidates against the local-model curation gate.
 */
export const validateProjectIndexWithLocalModel = async (
  input: ValidateProjectIndexWithLocalModelInput,
): Promise<ValidateProjectIndexWithLocalModelResult> => {
  const sampleSize = Math.max(1, Math.min(input.sampleSize ?? 20, 200));
  const indexDatabasePath = resolveProjectIndexDatabasePath(input.projectMemoryDir);
  const status = await readProjectIndexStatus({ projectMemoryDir: input.projectMemoryDir });
  const indexReady = status.status === "ready" || status.status === "partial";

  if (!indexReady) {
    return {
      projectMemoryDir: input.projectMemoryDir,
      indexDatabasePath,
      indexStatus: status.status,
      indexReady: false,
      sampleSize,
      candidateCount: 0,
      evaluatedCount: 0,
      promotedCount: 0,
      rejectedCount: 0,
      decisions: [],
      warnings: [
        `project index is not ready (status=${status.status}); run '/memory project index rebuild' first`,
      ],
    };
  }

  const candidates = readRecentProjectIndexCandidates({
    indexDatabasePath,
    sampleSize,
    ownerUserId: status.ownerUserId,
  });

  const decisions: ProjectIndexLocalModelDecisionRow[] = [];

  for (const candidate of candidates) {
    const decision = await evaluateLocalModelCurationCandidate({
      content: candidate.content,
      topic: candidate.topic,
      source: candidate.source,
      config: input.config,
      embedText: input.embedText,
    });

    decisions.push({
      contentHash: candidate.contentHash,
      topic: candidate.topic,
      source: candidate.source,
      timestamp: candidate.timestamp,
      representativeUserId: candidate.representativeUserId,
      promoteGlobal: decision.promoteGlobal,
      confidence: decision.confidence,
      rationale: decision.rationale,
      scores: decision.scores,
    });
  }

  const promotedCount = decisions.filter((item) => item.promoteGlobal).length;

  return {
    projectMemoryDir: input.projectMemoryDir,
    indexDatabasePath,
    indexStatus: status.status,
    indexReady: true,
    sampleSize,
    candidateCount: candidates.length,
    evaluatedCount: decisions.length,
    promotedCount,
    rejectedCount: decisions.length - promotedCount,
    decisions,
    warnings: [],
  };
};

/**
 * Render a concise textual summary for command output.
 */
export const renderProjectIndexLocalModelValidationSummary = (
  result: ValidateProjectIndexWithLocalModelResult,
): string => {
  const header =
    `Local model curation validation: indexStatus=${result.indexStatus}, ` +
    `evaluated=${result.evaluatedCount}/${result.sampleSize}, ` +
    `promoted=${result.promotedCount}, rejected=${result.rejectedCount}.`;

  if (result.evaluatedCount === 0) {
    const warningText = result.warnings.length > 0
      ? ` Warnings: ${result.warnings.join(" | ")}.`
      : "";
    return `${header}${warningText}`;
  }

  const topPromoted = result.decisions
    .filter((decision) => decision.promoteGlobal)
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, 3)
    .map((decision) =>
      `${decision.contentHash}(${decision.confidence.toFixed(2)}; ${decision.scores.compositeScore.toFixed(3)})`
    );

  const topRejected = result.decisions
    .filter((decision) => !decision.promoteGlobal)
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, 3)
    .map((decision) =>
      `${decision.contentHash}(${decision.confidence.toFixed(2)}; ${decision.scores.compositeScore.toFixed(3)})`
    );

  const promotedText = topPromoted.length > 0
    ? ` Top promoted: ${topPromoted.join(", ")}.`
    : "";
  const rejectedText = topRejected.length > 0
    ? ` Top rejected: ${topRejected.join(", ")}.`
    : "";

  const warningText = result.warnings.length > 0
    ? ` Warnings: ${result.warnings.join(" | ")}.`
    : "";

  return `${header}${promotedText}${rejectedText}${warningText}`;
};
