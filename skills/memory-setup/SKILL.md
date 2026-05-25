---
name: memory-setup
description: Configure memory for Pi Muninn from scratch. Use when asked to "set up memory", "configure memory", or when `/memory` and `/memory project` are not ready.
---

# Memory Setup

Help the user set up Pi Muninn (`@dev-vortex/pi-muninn`) without assuming they understand memory internals.

Use simple language:

- **Personal memory**: reusable preferences and facts about the user.
- **Project memory**: facts that apply only to the current repository.
- **Handoff notes**: current work state, decisions, and next steps.

## 1) Check that memory is installed

Ask the user to run:

```text
/memory status
```

If `/memory` is missing, tell them to install the package:

```bash
pi install npm:@dev-vortex/pi-muninn
```

## 2) Enable project memory

From the project repository, ask the user to run:

```text
/memory project on
/memory project status
```

Explain the result in plain terms: project memory is now available for this repository.

## 3) Check user identity

Ask the user to run:

```text
/memory project user status
```

If the identity is missing, unstable, or not the identity they want to use, ask them to set it explicitly:

```text
/memory project user set <your name or email>
```

Use a stable name or email. Do not invent one for the user.

## 4) Explain the local files

Project memory uses this folder:

```text
.agent/memory/
```

Important files:

| File | Meaning | Commit guidance |
|---|---|---|
| `<your-user-id>.db` | The user's project memory and handoff notes. | Commit only if the team intentionally shares project memory files and the identity is stable. |
| `cache.db` | Rebuildable search data. | Do not commit. |
| `pi-muninn.config.json` | Local project-memory settings; may contain the user's memory id. | Do not commit. Sharing it can make teammates write to the same DB file. |
| `.gitignore` | Local safety rules generated for this folder. | Do not commit. |

If `.agent/memory/.gitignore` is missing after setup, ask the user to run:

```text
/memory project status
```

If it is still missing, report that as a setup problem instead of telling the user to commit memory files.

## 5) Refresh project search data when needed

If project memory search looks stale, ask the user to run:

```text
/memory project index rebuild
```

Then check:

```text
/memory project index status
```

## 6) Daily usage guidance

Tell the user they can work normally. The assistant should:

- save project-specific decisions to project memory,
- save reusable preferences to personal memory,
- record handoff notes when work changes direction,
- use focused lookup only when the short automatic briefing is not enough.

Do not tell users to run maintainer/test-only commands.

## Public command quick reference

| Command | Purpose |
|---|---|
| `/memory status` | Shows whether memory is available and whether project memory is active. |
| `/memory on` | Turns memory on. |
| `/memory off` | Turns memory off. |
| `/memory search <query>` | Searches saved memory for a word, phrase, or question. |
| `/memory stats` | Shows memory counts and health information. |
| `/memory project` | Shows project-memory status and a short help summary. |
| `/memory project help` | Lists available public project-memory commands. |
| `/memory project on` | Enables project memory for the current repository. |
| `/memory project off` | Disables project memory without deleting saved files. |
| `/memory project status` | Shows project memory health, storage, identity, and handoff-note status. |
| `/memory project set <project name>` | Sets the project name used by memory. |
| `/memory project search <query>` | Searches only the current project memory. |
| `/memory project user status` | Shows which user identity is used for project memory files. |
| `/memory project user set <your name or email>` | Sets a stable identity so your project memory uses the right DB file. |
| `/memory project user auto` | Returns project-memory identity detection to automatic mode. |
| `/memory project index status` | Shows whether project search data is healthy and up to date. |
| `/memory project index rebuild` | Rebuilds project search data from saved project memory. |
| `/memory project promote status` | Shows reusable project lessons that may be ready to save as personal memory. |
| `/memory project promote dry-run` | Previews promotion without changing memory. |
| `/memory project promote run` | Saves accepted reusable project lessons into personal memory. |
| `/memory project promote validate` | Checks promotion state and reports issues. |


## Safety reminders

- Do not commit `pi-muninn.config.json`.
- Do not commit `cache.db`.
- Do not commit another user's DB file.
- Do not ask users to paste secrets into memory.
- When unsure whether something should be saved as memory, ask the user first.
