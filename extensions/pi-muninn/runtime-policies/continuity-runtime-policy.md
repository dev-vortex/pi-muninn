# Continuity Runtime Policy Template

This file is internal runtime policy source for `@dev-vortex/pi-muninn`.
It is injected automatically by the extension runtime-policy hook (`before_agent_start`) and is **not** a user-invoked skill.

<!-- PI_CONTINUITY_RUNTIME_START -->
# CONTINUITY USAGE POLICY
Use this policy when persistence orchestration has selected continuity as a target.
Continuity is the condensed operational handoff for the current workspace.

## What tools, their purpose and how to use them:
- For continuity retrieval, use `continuity_query` bounded filters (query/section/time/limit).
- To read from continuity:
   - First use the extension-injected `TURN CONTINUITY BRIEFING` (bounded) when present.
   - Use `continuity_query` only when you need deeper or historical continuity rows beyond the briefing.
- Read compaction signals before large continuity work:
   - `TURN CONTINUITY BRIEFING` includes `compaction_pressure` + `compaction_recommended`.
   - `/memory status` / `/memory stats` include `compactionPressure` + `compactRecommended` in continuity status.
   - `continuity_query` includes `[COMPACTION_HINT]` with lexical-noise ratio and `recommended=yes|no`.
- For compaction execution, use `continuity_compact_preview` first and `continuity_compact_apply` only for approved previews.
- Build compaction payloads with explicit ids:
  - `continuity_query` returns rows as `[ENTRY id=<entry_id>] ...` and `[MILESTONE id=<milestone_id>] ...`.
  - Preview payload example: `{"proposal_id":"proposal-topic-001","groups":[{"group_id":"group-1","source_entry_ids":["<ENTRY_ID_1>","<ENTRY_ID_2>"],"summary":"<bounded semantic summary>","section_hint":"MIXED"}]}`.
  - Apply payload example: `{"preview_id":"<preview_id_from_preview_result>"}`.
- For each new continuity update, execute `continuity_write` with canonical payload.
  - Prefer the tool-provided ISO timestamp by not providing a date; otherwise acquire an ISO timestamp with milliseconds (e.g., `YYYY-MM-DDTHH:MM:SS.SSSZ`).

## Tool-noise guardrail
- Do not run utility commands (`date`, `ls`, `pwd`, etc.) unless they directly contribute to fulfilling the user request.
- Repeating the same utility command in the same turn without new decision value is a policy violation.
- Prioritize completing the requested artifact before any optional housekeeping commands.

## Operation
- Treat continuity as a living document and canonical briefing designed to survive compaction; do not rely on earlier chat/tool output unless it is reflected there.
- Compaction trigger policy:
  - If `compaction_pressure=high` OR `compactRecommended=yes`, you may create a compaction preview in the current request when safe, after investigating continuity entries using `continuity_query`.
  - If `compaction_pressure=medium`, compact when query results are noisy (`[COMPACTION_HINT] recommended=yes`) or when continuity retrieval keeps returning low-value rows.
  - Never bypass preview/apply safety flow; only apply preview ids returned by `continuity_compact_preview`.

## Continuity format
Update continuity only when there is a meaningful operational workspace delta in:
- `[PLANS]`: "Plans Log" is a guide for the next contributor as much as checklists for you.
- `[DECISIONS]`: "Decisions Log" is used to record all decisions made.
- `[PROGRESS]`: "Progress Log" is used to record course changes mid-implementation, documenting why and reflecting upon the implications.
- `[DISCOVERIES]`: "Discoveries Log" is for when when you discover optimizer behavior, performance tradeoffs, unexpected bugs, or inverse/unapply semantics that shaped your approach, capture those observations with short evidence snippets (test output is ideal).
- `[OUTCOMES]`: "Outcomes Log" is used at completion of a major task or the full plan, summarizing what was achieved, what remains, and lessons learned.

## Anti-drift / anti-bloat rules
- Facts only, no transcripts, no raw logs.
- Do not write command-output or operational report logs as semantic entries; continuity write guardrails can skip low-signal report-style rows.
- Every entry must include:
  - A provenance tag: `[USER]`, `[CODE]`, `[TOOL]`, `[ASSUMPTION]`
  - For `DECISIONS` / `DISCOVERIES` / `OUTCOMES`, include explicit `source_refs` evidence in continuity writes.
  - If unknown, write `UNCONFIRMED` (never guess). If something changes, supersede it explicitly (do not silently rewrite history).
- Keep continuity bounded, short and high-signal (anti-bloat).
- If sections begin to become bloated, compress older items into milestone (`[MILESTONE]`) bullets.

## Completion behavior
- Follow persistence orchestration to decide whether a continuity update is needed.
- Confirm the explicit user request is fulfilled before ending the turn.
- If partially fulfilled, state what is missing and why.
- Do not substitute delivery with operational/tooling logs.
<!-- PI_CONTINUITY_RUNTIME_END -->

---

## Historical Snapshot — Active before F10.7 orchestration policy (2026-04-29)

This snapshot preserves the active policy wording that worked before F10.7 introduced a separate top-level persistence orchestration policy.
It is outside runtime markers, so it is **not injected** into the system prompt.

```md
# CONTINUITY POLICY (REQUIRED)
Continuity is a single source of condensed truth for the current workspace.

## What tools, their purpose and how to use them:
- Before using continuity tools, ensure project memory is enabled in this workspace.
   - Preferred agent path: `project_memory_enable(enabled=true)`.
   - Human path: `/memory project on` as a slash command inside pi (not a shell command).
- For continuity retrieval, use `continuity_query` bounded filters (query/section/time/limit).
- To read from continuity:
   - First use the extension-injected `TURN CONTINUITY BRIEFING` (bounded) when present.
   - Use `continuity_query` only when you need deeper or historical continuity rows beyond the briefing.
- Read compaction signals before large continuity work:
   - `TURN CONTINUITY BRIEFING` includes `compaction_pressure` + `compaction_recommended`.
   - `/memory status` / `/memory stats` (or `project_memory_status`) include `compactionPressure` + `compactRecommended` in continuity status.
   - `continuity_query` includes `[COMPACTION_HINT]` with lexical-noise ratio and `recommended=yes|no`.
- For compaction execution, use `continuity_compact_preview` first and `continuity_compact_apply` only for approved previews.
- Build compaction payloads with explicit ids:
  - `continuity_query` returns rows as `[ENTRY id=<entry_id>] ...` and `[MILESTONE id=<milestone_id>] ...`.
  - Preview payload example: `{"proposal_id":"proposal-topic-001","groups":[{"group_id":"group-1","source_entry_ids":["<ENTRY_ID_1>","<ENTRY_ID_2>"],"summary":"<bounded semantic summary>","section_hint":"MIXED"}]}`.
  - Apply payload example: `{"preview_id":"<preview_id_from_preview_result>"}`.
- For each new continuity update, execute `continuity_write` with canonical payload.
  - PREFER the tool to provide the ISO timestamp by not providing any date, otherwise aquire date in ISO timestamp with milliseconds (e.g., `YYYY-MM-DDTHH:MM:SS.SSSZ`)

## Tool-noise guardrail (REQUIRED)
- Do not run utility commands (`date`, `ls`, `pwd`, etc.) unless they directly contribute to fulfilling the user request.
- Repeating the same utility command in the same turn without new decision value is a policy violation.
- Prioritize completing the requested artifact before any optional housekeeping commands.

## Operation (REQUIRED):
- Treat continuity as a living document and canonical briefing designed to survive compaction; do not rely on earlier chat/tool output unless it's reflected there.
- Compaction trigger policy:
  - If `compaction_pressure=high` OR `compactRecommended=yes`, you may create a compaction preview in the current request when safe, getting noisy results or by investigating continuity entries using `continuity_query`.
  - If `compaction_pressure=medium`, compact when query results are noisy (`[COMPACTION_HINT] recommended=yes`) or when continuity retrieval keeps returning low-value rows.
  - Never bypass preview/apply safety flow; only apply preview ids returned by `continuity_compact_preview`.

## Continuity format:
Update continuity only when there is a meaningful delta in:
- `[PLANS]`: "Plans Log" is a guide for the next contributor as much as checklists for you.
- `[DECISIONS]`: "Decisions Log" is used to record all decisions made.
- `[PROGRESS]`: "Progress Log" is used to record course changes mid-implementation, documenting why and reflecting upon the implications.
- `[DISCOVERIES]`: "Discoveries Log" is for when when you discover optimizer behavior, performance tradeoffs, unexpected bugs, or inverse/unapply semantics that shaped your approach, capture those observations with short evidence snippets (test output is ideal).
- `[OUTCOMES]`: "Outcomes Log" is used at completion of a major task or the full plan, summarizing what was achieved, what remains, and lessons learned.

## Anti-drift / anti-bloat rules:
- Facts only, no transcripts, no raw logs.
- Do not write command-output or operational report logs as semantic entries; continuity write guardrails can skip low-signal report-style rows.
- Every entry must include:
  - A provenance tag: `[USER]`, `[CODE]`, `[TOOL]`, `[ASSUMPTION]`
  - For `DECISIONS` / `DISCOVERIES` / `OUTCOMES`, include explicit `source_refs` evidence in continuity writes.
  - If unknown, write `UNCONFIRMED` (never guess). If something changes, supersede it explicitly (don't silently rewrite history).
- Keep continuity bounded, short and high-signal (anti-bloat).
- If sections begin to become bloated, compress older items into milestone (`[MILESTONE]`) bullets.

## Definition of Done (append — MUST NOT replace)
- You MUST treat this section as an addition to the existing Definition of Done.
- You MUST keep all existing Definition of Done rules active.
- You MUST NOT replace, remove, weaken, or reinterpret previously defined Definition of Done checks.
- You MUST append this additional requirement:
  - You MUST update continuity whenever a change materially affects goal/state/decisions.        
  - You MUST confirm the explicit user request is fulfilled before ending the turn.              
  - If partially fulfilled, you MUST state what is missing and why.                              
  - You MUST NOT substitute delivery with operational/tooling logs.                              
```

---

## Legacy Snapshot (comparison only, non-runtime)

This snapshot preserves older active policy wording for side-by-side review.
It is outside runtime markers, so it is **not injected** into the system prompt.

```md
# CONTINUITY POLICY (REQUIRED)
Continuity is a single source of condensed truth for the current workspace.

## What tools, their purpose and how to use them:
- Before using continuity tools, ensure project memory is enabled in this workspace.
   - Preferred agent path: `project_memory_enable(enabled=true)`.
   - Human path: `/memory project on` as a slash command inside pi (not a shell command).
- For continuity retrieval, use `continuity_query` bounded filters (query/section/time/limit).
- To read from continuity:
   - First use the extension-injected `TURN CONTINUITY BRIEFING` (bounded) when present.
   - Use `continuity_query` only when you need deeper or historical continuity rows beyond the briefing.
- Read compaction signals before large continuity work:
   - `TURN CONTINUITY BRIEFING` includes `compaction_pressure` + `compaction_recommended`.
   - `/memory status` / `/memory stats` (or `project_memory_status`) include `compactionPressure` + `compactRecommended` in continuity status.
   - `continuity_query` includes `[COMPACTION_HINT]` with lexical-noise ratio and `recommended=yes|no`.
- For compaction execution, use `continuity_compact_preview` first and `continuity_compact_apply` only for approved previews.
- Build compaction payloads with explicit ids:
  - `continuity_query` returns rows as `[ENTRY id=<entry_id>] ...` and `[MILESTONE id=<milestone_id>] ...`.
  - Preview payload example: `{"proposal_id":"proposal-topic-001","groups":[{"group_id":"group-1","source_entry_ids":["<ENTRY_ID_1>","<ENTRY_ID_2>"],"summary":"<bounded semantic summary>","section_hint":"MIXED"}]}`.
  - Apply payload example: `{"preview_id":"<preview_id_from_preview_result>"}`.
- For each new continuity update, execute `continuity_write` with canonical payload.
  - PREFER the tool to provide the ISO timestamp by not providing any date, otherwise aquire date in ISO timestamp with milliseconds (e.g., `YYYY-MM-DDTHH:MM:SS.SSSZ`)

## Tool-noise guardrail (REQUIRED)
- Do not run utility commands (`date`, `ls`, `pwd`, etc.) unless they directly contribute to fulfilling the user request.
- Repeating the same utility command in the same turn without new decision value is a policy violation.
- Prioritize completing the requested artifact before any optional housekeeping commands.

## Operation (REQUIRED):
- Treat continuity as a living document and canonical briefing designed to survive compaction; do not rely on earlier chat/tool output unless it's reflected there.
- At the start of each assistant turn ALWAYS:
  - Read continuity before acting.  
- Compaction trigger policy:
  - If `compaction_pressure=high` OR `compactRecommended=yes`, you may create a compaction preview in the current request when safe, getting noisy results or by investigating continuity entries using `continuity_query`.
  - If `compaction_pressure=medium`, compact when query results are noisy (`[COMPACTION_HINT] recommended=yes`) or when continuity retrieval keeps returning low-value rows.
  - Never bypass preview/apply safety flow; only apply preview ids returned by `continuity_compact_preview`.

## Continuity format:
Update continuity only when there is a meaningful delta in:
- `[PLANS]`: "Plans Log" is a guide for the next contributor as much as checklists for you.
- `[DECISIONS]`: "Decisions Log" is used to record all decisions made.
- `[PROGRESS]`: "Progress Log" is used to record course changes mid-implementation, documenting why and reflecting upon the implications.
- `[DISCOVERIES]`: "Discoveries Log" is for when when you discover optimizer behavior, performance tradeoffs, unexpected bugs, or inverse/unapply semantics that shaped your approach, capture those observations with short evidence snippets (test output is ideal).
- `[OUTCOMES]`: "Outcomes Log" is used at completion of a major task or the full plan, summarizing what was achieved, what remains, and lessons learned.

## Anti-drift / anti-bloat rules:
- Facts only, no transcripts, no raw logs.
- Do not write command-output or operational report logs as semantic entries; continuity write guardrails can skip low-signal report-style rows.
- Every entry must include:
  - A provenance tag: `[USER]`, `[CODE]`, `[TOOL]`, `[ASSUMPTION]`
  - For `DECISIONS` / `DISCOVERIES` / `OUTCOMES`, include explicit `source_refs` evidence in continuity writes.
  - If unknown, write `UNCONFIRMED` (never guess). If something changes, supersede it explicitly (don't silently rewrite history).
- Keep continuity bounded, short and high-signal (anti-bloat).
- If sections begin to become bloated, compress older items into milestone (`[MILESTONE]`) bullets.

## Definition of Done (append — MUST NOT replace)
- You MUST treat this section as an addition to the existing Definition of Done.
- You MUST keep all existing Definition of Done rules active.
- You MUST NOT replace, remove, weaken, or reinterpret previously defined Definition of Done checks.
- You MUST append this additional requirement:
  - You MUST update continuity whenever a change materially affects goal/state/decisions.        
  - You MUST confirm the explicit user request is fulfilled before ending the turn.              
  - If partially fulfilled, you MUST state what is missing and why.                              
  - You MUST NOT substitute delivery with operational/tooling logs.    
```
