/**
 * File intent: centralize TypeBox schemas shared by extracted continuity tools.
 *
 * Keeping schemas in one file prevents duplicate tool contract definitions while
 * preserving the exact public payload shapes used before Slice 3 extraction.
 */

import { Type } from "@sinclair/typebox";

/**
 * Build all continuity tool schemas using the configured source-ref limit.
 */
export const createContinuityToolSchemas = (input: { sourceRefLimit: number }) => {
  const continuitySectionSchema = Type.String({
    pattern: "^\\[?(PLANS|DECISIONS|PROGRESS|DISCOVERIES|OUTCOMES)\\]?$",
    description: "Continuity section label (e.g., PLANS or [PLANS]).",
  });

  const continuityProvenanceSchema = Type.String({
    pattern: "^\\[?(USER|CODE|TOOL|ASSUMPTION)\\]?$",
    description: "Continuity provenance label (e.g., CODE or [CODE]).",
  });

  const continuityCertaintySchema = Type.String({
    pattern: "^\\[?(CONFIRMED|UNCONFIRMED)\\]?$",
    description: "Continuity certainty label (e.g., CONFIRMED or [UNCONFIRMED]).",
  });

  const continuitySourceRefsSchema = Type.Array(
    Type.String({ minLength: 1 }),
    {
      minItems: 1,
      maxItems: input.sourceRefLimit,
      description: "Optional explicit evidence refs. Strongly recommended for DECISIONS/DISCOVERIES/OUTCOMES to satisfy provenance quality warnings.",
    },
  );

  const continuityCompactionSectionHintSchema = Type.String({
    pattern: "^(PLANS|DECISIONS|PROGRESS|DISCOVERIES|OUTCOMES|MIXED)$",
    description: "Optional section hint for one compacted summary group.",
  });

  return {
    continuitySectionSchema,
    continuityProvenanceSchema,
    continuityCertaintySchema,
    continuityWriteSchema: Type.Object({
      timestamp: Type.Optional(Type.String({ description: "ISO timestamp for continuity row (defaults to now)." })),
      section: continuitySectionSchema,
      provenance: continuityProvenanceSchema,
      certainty: Type.Optional(continuityCertaintySchema),
      source_refs: Type.Optional(continuitySourceRefsSchema),
      content: Type.String({ description: "Continuity content text to persist." }),
    }),
    continuityQuerySchema: Type.Object({
      query: Type.Optional(Type.String({ description: "Optional text query matched against continuity content." })),
      section: Type.Optional(continuitySectionSchema),
      from: Type.Optional(Type.String({ description: "Optional lower-bound ISO timestamp." })),
      to: Type.Optional(Type.String({ description: "Optional upper-bound ISO timestamp." })),
      limit: Type.Optional(Type.Number({ description: "Maximum rows to return (default: 20, max: 100)." })),
      include_milestones: Type.Optional(Type.Boolean({ description: "Include milestone rows from continuity_milestones (DB source only)." })),
      include_compacted: Type.Optional(Type.Boolean({ description: "Include compacted source rows in results (default: false)." })),
    }),
    continuityCompactionPreviewSchema: Type.Object({
      proposal_id: Type.String({ description: "Caller proposal id for tracing this compaction draft." }),
      based_on_preview_id: Type.Optional(Type.String({ description: "Optional prior preview id when submitting a revision." })),
      generated_at: Type.Optional(Type.String({ description: "Optional generation timestamp for proposal audit metadata." })),
      groups: Type.Array(
        Type.Object({
          group_id: Type.String({ description: "Group id unique inside this proposal payload." }),
          source_entry_ids: Type.Array(
            Type.String({ minLength: 1 }),
            {
              minItems: 2,
              maxItems: 120,
              description: "Source continuity entry ids to compact in this group.",
            },
          ),
          summary: Type.String({ description: "Compacted semantic summary text for this group." }),
          section_hint: Type.Optional(continuityCompactionSectionHintSchema),
        }),
        {
          minItems: 1,
          maxItems: 12,
          description: "Compaction groups proposed for preview validation.",
        },
      ),
    }),
    continuityCompactionApplySchema: Type.Object({
      preview_id: Type.String({ description: "Persisted compaction preview id to apply." }),
    }),
    continuityTelemetryReviewQueueSchema: Type.Object({
      window_days: Type.Optional(Type.Number({
        description: "Optional report window in days (bounded to 7..365; default 30).",
      })),
      sample_limit: Type.Optional(Type.Number({
        description: "Optional false-reject review sample size (bounded to 1..50; default 12).",
      })),
    }),
    continuityTelemetryReviewLabelSchema: Type.Object({
      event_id: Type.String({
        minLength: 1,
        description: "Telemetry event_id returned by continuity_telemetry_review_queue.",
      }),
      label: Type.Union([
        Type.Literal("valid_reject"),
        Type.Literal("false_reject"),
        Type.Literal("uncertain"),
      ], {
        description: "Review label decision for one candidate event.",
      }),
      note: Type.Optional(Type.String({
        minLength: 1,
        maxLength: 500,
        description: "Optional reviewer note for audit context.",
      })),
    }),
  };
};
