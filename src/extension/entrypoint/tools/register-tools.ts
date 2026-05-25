/**
 * File intent: compose all extracted tool definitions for the pi entrypoint.
 *
 * This module is the human-readable tool map. It owns every `pi.registerTool(...)`
 * registration while per-tool files own execute-handler behavior.
 */

import { Type } from "@sinclair/typebox";

import { createContinuityToolSchemas } from "./continuity-tool-schemas.js";
import { createProjectMemoryStatusTool } from "./project-memory-tools/project-memory-status-tool.js";
import { createProjectMemoryEnableTool } from "./project-memory-tools/project-memory-enable.js";
import { createContinuityWriteTool } from "./continuity-write-read-tools/continuity-write-tool.js";
import { createContinuityQueryTool } from "./continuity-write-read-tools/continuity-query-tool.js";
import { createContinuityTelemetryReviewQueueTool } from "./continuity-telemetry-review-tools/continuity-telemetry-review-queue-tool.js";
import { createContinuityTelemetryReviewLabelTool } from "./continuity-telemetry-review-tools/continuity-telemetry-review-label-tool.js";
import { createContinuityCompactionPreviewTool } from "./continuity-compaction-tools/continuity-compaction-preview-tool.js";
import { createContinuityCompactionApplyTool } from "./continuity-compaction-tools/continuity-compaction-apply-tool.js";

import type { ExtensionToolDependencies } from "./types.js";

/**
 * Register every extension-owned tool in a single readable map.
 */
export const registerExtensionTools = (deps: ExtensionToolDependencies): void => {
  if (typeof deps.pi?.registerTool !== "function") {
    return;
  }

  const { pi } = deps;
  const {
    continuityWriteSchema,
    continuityQuerySchema,
    continuityCompactionPreviewSchema,
    continuityCompactionApplySchema,
    continuityTelemetryReviewQueueSchema,
    continuityTelemetryReviewLabelSchema,
  } = createContinuityToolSchemas({
    sourceRefLimit: deps.CONTINUITY_SOURCE_REF_LIMIT,
  });

  // Project-memory tools.
  pi.registerTool({
    name: "project_memory_status",
    label: "Project Memory Status",
    description: "Show current project-memory runtime status for this workspace/session.",
    promptSnippet: "project_memory_status() — show project memory status and scope",
    promptGuidelines: [
      "Use when continuity tools report project memory disabled and you need to verify runtime scope.",
    ],
    parameters: Type.Object({}),
    execute: createProjectMemoryStatusTool(deps),
  });

  pi.registerTool({
    name: "project_memory_enable",
    label: "Project Memory Enable",
    description: "Enable/disable project memory for current workspace and refresh runtime context.",
    promptSnippet: "project_memory_enable(enabled?) — toggle project memory (default: enabled=true)",
    promptGuidelines: [
      "Use when continuity DB tools fail because project memory is disabled.",
      "After enabling, continue with continuity_write.",
      "For durable decisions/preferences, also call memory_save using payload targets (project_content/general_content) so memory state stays explicit and queryable.",
    ],
    parameters: Type.Object({
      enabled: Type.Optional(Type.Boolean({
        description: "Set true to enable project memory (default), false to disable.",
      })),
    }),
    execute: createProjectMemoryEnableTool(deps),
  });

  // Continuity write/read tools.
  pi.registerTool({
    name: "continuity_write",
    label: "Continuity Write",
    description: "Persist one continuity entry to canonical continuity sidecar DB in a single call.",
    promptSnippet: "continuity_write(timestamp?, section, provenance, certainty?, source_refs?, content) — persist continuity entry to canonical DB",
    promptGuidelines: [
      "Use this as the default continuity write path.",
      "Write continuity as work progresses (do not batch everything only at request end).",
      "When multiple artifacts/decisions are involved, write separate semantic entries per artifact/decision.",
      "For DECISIONS/DISCOVERIES/OUTCOMES, include source_refs evidence so provenance is explicit.",
      "After storing high-signal decisions/preferences in continuity, also call memory_save with payload targets: project_content for project-specific facts, general_content for reusable preferences, or both when both scopes apply.",
      "Avoid command-output/log report prose in semantic entries; low-signal report-style rows are skipped.",
      "If this fails, treat continuity persistence as failed and report explicitly.",
      "Do not retry with different section/provenance/content when failure indicates runtime indexing/DB errors; escalate the runtime issue instead.",
    ],
    parameters: continuityWriteSchema,
    execute: createContinuityWriteTool(deps),
  });

  pi.registerTool({
    name: "continuity_query",
    label: "Continuity Query",
    description: "Query cross-user project continuity through the project continuity aggregate.",
    promptSnippet: "continuity_query(query?, section?, from?, to?, limit?, include_milestones?, include_compacted?) — query cross-user project continuity",
    promptGuidelines: [
      "Use this as the default continuity retrieval tool.",
      "Project-enabled contract: results come from the cross-user project continuity aggregate with user attribution.",
      "Memory and continuity are split: use continuity_query for continuity rows, memory_search/memory_recall for memories.",
      "Use bounded filters and limits to keep continuity retrieval focused and cheap.",
    ],
    parameters: continuityQuerySchema,
    execute: createContinuityQueryTool(deps),
  });

  // Continuity telemetry review tools.
  pi.registerTool({
    name: "continuity_telemetry_review_queue",
    label: "Continuity Telemetry Review Queue",
    description: "List sampled false-reject continuity candidates and current review-label state.",
    promptSnippet: "continuity_telemetry_review_queue(window_days?, sample_limit?) — fetch review candidates",
    promptGuidelines: [
      "Use after continuity status/stats shows false-reject review candidates.",
      "Label returned event_id values with continuity_telemetry_review_label.",
    ],
    parameters: continuityTelemetryReviewQueueSchema,
    execute: createContinuityTelemetryReviewQueueTool(deps),
  });

  pi.registerTool({
    name: "continuity_telemetry_review_label",
    label: "Continuity Telemetry Review Label",
    description: "Store one review label for a false-reject continuity telemetry candidate.",
    promptSnippet: "continuity_telemetry_review_label(event_id, label, note?) — label one candidate",
    promptGuidelines: [
      "Always obtain event_id from continuity_telemetry_review_queue output.",
      "Use label=valid_reject when runtime rejection is correct.",
      "Use label=false_reject when runtime rejection appears incorrect.",
      "Use label=uncertain when evidence is insufficient.",
    ],
    parameters: continuityTelemetryReviewLabelSchema,
    execute: createContinuityTelemetryReviewLabelTool(deps),
  });

  // Continuity compaction tools.
  pi.registerTool({
    name: "continuity_compact_preview",
    label: "Continuity Compact Preview",
    description: "Validate and persist one non-destructive compaction preview proposal with deterministic gates.",
    promptSnippet: "continuity_compact_preview(proposal_id, groups[], based_on_preview_id?, generated_at?) — validate/persist compaction preview",
    promptGuidelines: [
      "Use before continuity_compact_apply.",
      "Provide source_entry_ids grouped by coherent semantic topic and include clear summary text.",
      "Build source_entry_ids from continuity_query [ENTRY id=...] results.",
      "Payload example: {\"proposal_id\":\"proposal-topic-001\",\"groups\":[{\"group_id\":\"group-1\",\"source_entry_ids\":[\"<ENTRY_ID_1>\",\"<ENTRY_ID_2>\"],\"summary\":\"<bounded semantic summary>\",\"section_hint\":\"MIXED\"}]}",
      "When preview returns approved_with_advisories, revise with based_on_preview_id unless review_state is terminal.",
      "Do not attempt apply with stale/foreign preview ids.",
    ],
    parameters: continuityCompactionPreviewSchema,
    execute: createContinuityCompactionPreviewTool(deps),
  });

  pi.registerTool({
    name: "continuity_compact_apply",
    label: "Continuity Compact Apply",
    description: "Apply one persisted, approved continuity compaction preview non-destructively.",
    promptSnippet: "continuity_compact_apply(preview_id) — apply approved non-destructive compaction preview",
    promptGuidelines: [
      "Use only after continuity_compact_preview returns an approved preview_id.",
      "Apply is non-destructive: source entries are marked compacted and linked to a new summary entry.",
      "Do not apply previews from another request scope or stale preview ids.",
      "Payload example: {\"preview_id\":\"<preview_id_from_preview_result>\"}",
    ],
    parameters: continuityCompactionApplySchema,
    execute: createContinuityCompactionApplyTool(deps),
  });
};
