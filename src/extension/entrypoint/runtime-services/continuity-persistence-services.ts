/**
 * File intent: persist continuity rows with vector consistency and quality gates.
 *
 * This module owns DB write/rollback semantics that used to live in the package
 * entrypoint closure, preserving mandatory vector-index consistency.
 */

import { randomUUID } from "node:crypto";

import type { ContinuityCertainty, ContinuityProvenance, ContinuitySection } from "../../../../packages/memory-core/src/continuity/continuity-codebook.js";
import {
  deleteContinuityEntry,
  deleteContinuityVectorEntry,
  indexContinuityVectorEntry,
  storeContinuityEntry,
  type ContinuityVectorEmbedder,
} from "../../../memory-data-adapters/sqlite/continuity/index.js";
import { buildContinuityContentWithSourceRefs, normalizeContinuityTimestamp } from "./continuity-normalization.js";
import { buildContinuityEntryFingerprint, evaluateContinuityWriteQualityGate } from "./continuity-quality.js";
import { isContinuityVectorEnabled } from "./runtime-config.js";

/**
 * Build continuity persistence services around the active vector embedder.
 */
export const createContinuityPersistenceServices = (input: {
  continuityVectorEmbedder: ContinuityVectorEmbedder;
}): {
  storeContinuityEntryWithVectorConsistency: (entry: {
    databasePath: string;
    id: string;
    timestamp: string;
    section: ContinuitySection;
    provenance: ContinuityProvenance;
    certainty: ContinuityCertainty;
    content: string;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
  persistAutomaticContinuityDualWrite: (entry: {
    databasePath: string;
    section: ContinuitySection;
    provenance: ContinuityProvenance;
    certainty?: ContinuityCertainty;
    timestamp?: string;
    content: string;
    sourceRefs?: string[];
  }) => Promise<
    | { ok: true; status: "stored"; fingerprint: string; timestamp: string }
    | {
      ok: true;
      status: "skipped";
      skipReason: "duplicate" | "low-signal";
      fingerprint: string;
      timestamp: string;
      duplicateTimestamp?: string;
      qualityReason?: string;
    }
    | { ok: false; error: string; fingerprint?: string }
  >;
} => {
  const storeContinuityEntryWithVectorConsistency = async (entry: {
    databasePath: string;
    id: string;
    timestamp: string;
    section: ContinuitySection;
    provenance: ContinuityProvenance;
    certainty: ContinuityCertainty;
    content: string;
  }): Promise<{ ok: true } | { ok: false; error: string }> => {
    try {
      storeContinuityEntry(entry);
    } catch (error: unknown) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (!isContinuityVectorEnabled()) {
      return { ok: true };
    }

    const vectorIndex = await indexContinuityVectorEntry({
      databasePath: entry.databasePath,
      embedder: input.continuityVectorEmbedder,
      entry: {
        id: entry.id,
        section: entry.section,
        provenance: entry.provenance,
        certainty: entry.certainty,
        content: entry.content,
      },
    });

    if (vectorIndex.status !== "error") {
      return { ok: true };
    }

    let rollbackEntryError: string | null = null;
    let rollbackVectorError: string | null = null;

    try {
      deleteContinuityEntry({
        databasePath: entry.databasePath,
        id: entry.id,
      });
    } catch (error: unknown) {
      rollbackEntryError = error instanceof Error ? error.message : String(error);
    }

    const vectorCleanup = deleteContinuityVectorEntry({
      databasePath: entry.databasePath,
      entryId: entry.id,
    });

    if (vectorCleanup.status === "error") {
      rollbackVectorError = vectorCleanup.warning || "unknown vector cleanup failure";
    }

    return {
      ok: false,
      error:
        `continuity vector indexing failed (${vectorIndex.warning || "unknown error"}); ` +
        `entry_rollback=${rollbackEntryError ? `failed:${rollbackEntryError}` : "ok"}; ` +
        `vector_rollback=${rollbackVectorError ? `failed:${rollbackVectorError}` : "ok"}`,
    };
  };

  const persistAutomaticContinuityDualWrite = async (entry: {
    databasePath: string;
    section: ContinuitySection;
    provenance: ContinuityProvenance;
    certainty?: ContinuityCertainty;
    timestamp?: string;
    content: string;
    sourceRefs?: string[];
  }): Promise<
    | { ok: true; status: "stored"; fingerprint: string; timestamp: string }
    | {
      ok: true;
      status: "skipped";
      skipReason: "duplicate" | "low-signal";
      fingerprint: string;
      timestamp: string;
      duplicateTimestamp?: string;
      qualityReason?: string;
    }
    | { ok: false; error: string; fingerprint?: string }
  > => {
    const certainty = entry.certainty || "CONFIRMED";
    const timestamp = normalizeContinuityTimestamp(entry.timestamp);
    const content = buildContinuityContentWithSourceRefs({
      content: entry.content,
      sourceRefs: Array.isArray(entry.sourceRefs) ? entry.sourceRefs : [],
    });

    if (!content) {
      return { ok: false, error: "automatic continuity content is empty" };
    }

    const fingerprint = buildContinuityEntryFingerprint({
      timestamp,
      section: entry.section,
      provenance: entry.provenance,
      certainty,
      content,
    });

    const qualityGate = evaluateContinuityWriteQualityGate({
      databasePath: entry.databasePath,
      timestamp,
      section: entry.section,
      provenance: entry.provenance,
      certainty,
      content,
    });

    if (qualityGate.status === "skip-low-signal") {
      return {
        ok: true,
        status: "skipped",
        skipReason: "low-signal",
        fingerprint,
        timestamp,
        qualityReason: qualityGate.reason,
      };
    }

    if (qualityGate.status === "skip-duplicate") {
      return {
        ok: true,
        status: "skipped",
        skipReason: "duplicate",
        fingerprint,
        timestamp,
        duplicateTimestamp: qualityGate.duplicate?.timestamp,
      };
    }

    const dbWrite = await storeContinuityEntryWithVectorConsistency({
      databasePath: entry.databasePath,
      id: randomUUID(),
      timestamp,
      section: entry.section,
      provenance: entry.provenance,
      certainty,
      content,
    });

    if (!dbWrite.ok) {
      return { ok: false, error: dbWrite.error, fingerprint };
    }

    return { ok: true, status: "stored", fingerprint, timestamp };
  };

  return {
    storeContinuityEntryWithVectorConsistency,
    persistAutomaticContinuityDualWrite,
  };
};
