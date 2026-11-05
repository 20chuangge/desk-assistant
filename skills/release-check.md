---
name: release-check
description: Walk the workspace and run the read-only checks before anything ships.
when_to_use: Before a release, before handing work over, or when asked "is this ready?".
inputs:
  - project directory inside the shared workspace
steps:
  - Call fs_list on the project directory to confirm the expected files are present.
  - Call shell with "node --version" to record the runtime the checks will run on.
  - Call shell with a read-only check command, for example "node --test" if the project has tests.
  - Write notes/release-check.md with Command / Exit code / Output for each command.
  - Call task_finish with "ready" or "not ready" and the first failing check.
validation:
  - Every command in notes/release-check.md has a recorded exit code.
  - The summary says ready only when every exit code is 0.
output: notes/release-check.md and a one-line verdict.
approval_notes: shell is MEDIUM risk, so by default a human approves each command and can read it first. Denylisted commands (rm -rf, sudo, shutdown, curl | bash) are HIGH risk and are refused outright on unattended runs.
---

# Release check

Read-only checks only. This skill never fixes anything; it reports.

## Why a human approves each command

The shell tool is the one place where a confused model could do real damage.
Approving each command is the cost of that; it is a cheap cost, and skipping it
is how the interesting incidents happen.

## Output shape

```
| command | exit | note |
|---|---|---|
| node --version | 0 | v20.x |
| node --test | 1 | 2 failing |
```

Verdict line: `ready` or `not ready (node --test)`.
