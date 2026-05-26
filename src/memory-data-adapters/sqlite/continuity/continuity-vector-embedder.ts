/**
 * File intent: convert continuity records into local semantic vectors.
 *
 * This file holds the embedding text format, default local transformer model,
 * vector dimension contract, and lazy feature-extractor adapter. Use this when
 * changing what semantic meaning is embedded for continuity entries; keep vector
 * storage/search mechanics in `continuity-vector-store.ts`.
 */

import type {
  ContinuityCertainty,
  ContinuityProvenance,
  ContinuitySection,
} from "../../../../packages/memory-core/src/continuity/continuity-codebook.js";

/**
 * Default local embedding model aligned with upstream pi-mempalace behavior.
 */
export const CONTINUITY_VECTOR_MODEL_NAME = "Xenova/all-MiniLM-L6-v2";

/**
 * Default embedding dimension produced by the local model.
 */
export const CONTINUITY_VECTOR_EMBEDDING_DIMENSION = 384;

interface ContinuityFeatureExtractorResult {
  data: ArrayLike<number>;
}

interface ContinuityFeatureExtractionOptions {
  pooling: "mean";
  normalize: boolean;
}

/**
 * Minimal feature-extractor contract used by the continuity vector adapter.
 */
export type ContinuityFeatureExtractor = (
  text: string,
  options: ContinuityFeatureExtractionOptions,
) => Promise<ContinuityFeatureExtractorResult>;

/**
 * Structured continuity entry payload used to compose embedding text.
 */
export interface ContinuityVectorEmbeddingEntry {
  section: ContinuitySection;
  provenance: ContinuityProvenance;
  certainty: ContinuityCertainty;
  content: string;
}

/**
 * Runtime interface for continuity vector embeddings.
 */
export interface ContinuityVectorEmbedder {
  modelName: string;
  embeddingDimension: number;
  embedText: (text: string) => Promise<Float32Array>;
  embedEntry: (entry: ContinuityVectorEmbeddingEntry) => Promise<Float32Array>;
}

/**
 * Build deterministic embedding text from one continuity entry.
 */
export const buildContinuityVectorEmbeddingText = (entry: ContinuityVectorEmbeddingEntry): string => {
  const content = (entry.content || "")
    .trim()
    .replace(/\s+/g, " ");

  return `[${entry.section}] [${entry.provenance}] [${entry.certainty}] ${content}`.trim();
};

/**
 * Resolve default local feature extractor from @huggingface/transformers.
 *
 * Note:
 * - This is embedding inference (feature extraction), not generative completion.
 * - Loaded lazily so runtime cost is paid only when semantic mode is used.
 */
const createDefaultFeatureExtractor = async (modelName: string): Promise<ContinuityFeatureExtractor> => {
  const { pipeline } = await import("@huggingface/transformers");
  const extractor = await pipeline("feature-extraction", modelName, {
    dtype: "fp32" as any,
  });

  return async (
    text: string,
    options: ContinuityFeatureExtractionOptions,
  ): Promise<ContinuityFeatureExtractorResult> =>
    extractor(text, options) as Promise<ContinuityFeatureExtractorResult>;
};

/**
 * Normalize unknown extractor output into a finite Float32 vector.
 */
const normalizeExtractorVector = (input: {
  data: ArrayLike<number>;
  expectedDimension: number;
}): Float32Array => {
  const vector = input.data instanceof Float32Array
    ? input.data
    : Float32Array.from(Array.from(input.data));

  if (vector.length !== input.expectedDimension) {
    throw new Error(
      `continuity vector dimension mismatch: expected ${input.expectedDimension}, got ${vector.length}`,
    );
  }

  return vector;
};

/**
 * Build one lazy continuity embedder with overridable extractor factory.
 */
export const createContinuityVectorEmbedder = (input?: {
  modelName?: string;
  embeddingDimension?: number;
  createExtractor?: (modelName: string) => Promise<ContinuityFeatureExtractor>;
}): ContinuityVectorEmbedder => {
  const modelName = input?.modelName || CONTINUITY_VECTOR_MODEL_NAME;
  const embeddingDimension = input?.embeddingDimension || CONTINUITY_VECTOR_EMBEDDING_DIMENSION;
  const createExtractor = input?.createExtractor || createDefaultFeatureExtractor;

  let extractorPromise: Promise<ContinuityFeatureExtractor> | null = null;

  const resolveExtractor = async (): Promise<ContinuityFeatureExtractor> => {
    if (!extractorPromise) {
      extractorPromise = createExtractor(modelName);
    }

    return extractorPromise;
  };

  const embedText = async (text: string): Promise<Float32Array> => {
    const extractor = await resolveExtractor();
    const result = await extractor(text, {
      pooling: "mean",
      normalize: true,
    });

    return normalizeExtractorVector({
      data: result.data,
      expectedDimension: embeddingDimension,
    });
  };

  const embedEntry = async (entry: ContinuityVectorEmbeddingEntry): Promise<Float32Array> =>
    embedText(buildContinuityVectorEmbeddingText(entry));

  return {
    modelName,
    embeddingDimension,
    embedText,
    embedEntry,
  };
};
