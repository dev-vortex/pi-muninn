# Project Memory Runtime Policy Template

**File intent:** define the LLM-facing project-memory usage rules injected at runtime.

This file holds the static policy text that tells the agent when and how to save, search, and distinguish project-specific memory from reusable general memory. It is injected automatically by the extension `before_agent_start` hook and is **not** a user-invoked skill. Update this file when changing agent behavior expectations, not when changing storage or retrieval implementation.

<!-- PI_PROJECT_MEMORY_RUNTIME_START -->
# PROJECT MEMORY USAGE POLICY
Use this policy when persistence orchestration has selected memory as a target.

You have persistent general and project memory across sessions. Previous conversations and decisions can/should be stored and searchable.

- Use `memory_search` to semantically find persisted memory records relevant to the user request.
- Use `memory_recall` when project/topic-scoped browsing is more appropriate than semantic search.
- Use `memory_check_duplicate` before storing, to check if content already exists.

## How to save memory
- Use only payload-target fields in `memory_save`:
  - `project_content` for current-project-specific memory.
  - `general_content` for reusable cross-project memory.
  - Use both fields only when the same user statement contains separate project-specific and reusable facts.
- Optional routing metadata:
  - `project_topic` for `project_content`.
  - `general_topic` for `general_content`.

## When to save memory
- Save only high-signal facts likely to matter later: decisions, constraints, preferences, architecture rationale, and important follow-ups.
- Do not save low-signal operational logs, transient command output, or conversational filler.

## Quality rules
- Keep each memory atomic and explicit about why it matters.
- Include enough surrounding detail so future retrieval is interpretable without this chat transcript.
- If certainty is unknown, state `UNCONFIRMED` in content instead of guessing.
<!-- PI_PROJECT_MEMORY_RUNTIME_END -->

----
## Historical Snapshot — Active before F10.7 orchestration policy (2026-04-29)

This snapshot preserves the active policy wording that worked before F10.7 introduced a separate top-level persistence orchestration policy.
It is outside runtime markers, so it is **not injected** into the system prompt.

```md
# PROJECT MEMORY POLICY (REQUIRED)
You have persistent general and project memory across sessions. Previous conversations and decisions can/should be stored and searchable.

- Use `memory_search` to semantically find past context.
- Use `memory_recall` when project/topic-scoped browsing is more appropriate than semantic search.
- Use `memory_check_duplicate` before storing, to check if content already exist
- Use only payload-target fields in `memory_save`:
  - NEVER save the same memory in both general and project memory.
  - ALWAYS prefer general memory when not clear and if user does not mention a specific project.
  - Use both fields in one call when both scopes should be captured.
  - Use attribute `project_content` for memories related with the current project
  - Use attribute `general_content` for general (non project specific) memories reusable for cross-project
- Optional routing metadata:
  - `project_topic` for `project_content`.
  - `general_topic` for `general_content`.

## When to save memory
- Save only high-signal facts likely to matter later: decisions, constraints, preferences, architecture rationale, and important follow-ups.
- Do not save low-signal operational logs, transient command output, or conversational filler.

## Quality rules
- Keep each memory atomic and explicit about why it matters.
- Include enough context so future retrieval is interpretable without this full chat.
- If certainty is unknown, state `UNCONFIRMED` in content instead of guessing.
```

----
## Legacy Snapshot (comparison only, non-runtime)

This snapshot preserves older active policy wording for side-by-side review.
It is outside runtime markers, so it is **not injected** into the system prompt.

# PROJECT MEMORY POLICY (REQUIRED)
Project memory should retain high-signal context for the active workspace/member and improve future retrieval quality.

## When to read memory first
- Read memory when the user asks about prior decisions, previous attempts, constraints, unresolved TODOs, or "what did we decide"-type questions.
- Prefer `memory_search` for semantic recall of prior context.
- Use `memory_recall` when project/topic-scoped browsing is more appropriate than semantic search.

## When to save memory
- Save only high-signal facts likely to matter later: decisions, constraints, preferences, architecture rationale, and important follow-ups.
- Do not save low-signal operational logs, transient command output, or conversational filler.
- If content may already exist, use `memory_check_duplicate` before storing.

## How to save (payload-target contract)
- Use only payload-target fields in `memory_save`:
  - `project_content` for project/member-local memory (routes to L1).
  - `general_content` for reusable cross-project memory (routes to L3).
  - Use both fields in one call when both scopes should be captured.
- Optional routing metadata:
  - `project_topic` for `project_content`.
  - `general_topic` for `general_content`.
- Never use removed legacy fields: `content`, `scope`, `topic`, `importance`, `project`.

## Quality rules
- Keep each memory atomic and explicit about why it matters.
- Include enough context so future retrieval is interpretable without this full chat.
- If certainty is unknown, state `UNCONFIRMED` in content instead of guessing.

