---
name: workspace-sweep
description: Turn "what is going on in the shared workspace" into a short note somebody can read in 30 seconds.
when_to_use: When the human asks for a status update, a recap, or what changed recently.
inputs:
  - workspace path (defaults to the shared workspace root)
steps:
  - Call fs_list on the workspace root and read the names and modification times.
  - Pick the two files that look most load-bearing (newest, or named plan/todo/README) and call fs_read on each.
  - Write notes/status.md with three sections: What changed / What is blocked / Next step.
  - Call task_finish with the path you wrote and the single most important line.
validation:
  - notes/status.md exists in the workspace.
  - The note is shorter than 40 lines and names at least one concrete file.
output: A markdown note at notes/status.md plus a one-line summary in chat.
approval_notes: Everything here is inside the shared workspace, so every call is LOW risk and runs without approval. Nothing outside workspace/ is touched.
---

# Workspace sweep

A deliberately small procedure. The value is in the shape of the note, not in
how much it collects.

## Why three sections

- **What changed** gives the human a delta without re-reading the files.
- **What is blocked** is the only section that ever needs action.
- **Next step** forces a recommendation instead of a status report.

## Anti-patterns

- Listing every file. If there are more than ten, summarise the shape instead.
- Reading the whole workspace. Two files is the budget.
- Writing the note outside `workspace/`. That escalates to a HIGH approval for
  no reason.
