---
name: weekly-review
description: Assemble a weekly review from what the bots actually did, not from what they remember doing.
when_to_use: Friday afternoon, or whenever a routine fires the weekly review.
inputs:
  - week start date
  - notes/ directory in the shared workspace
steps:
  - Call routine_list and collect which routines ran this week and their lastStatus.
  - Call memory_read with the query "this week" to pull recent facts from memory.
  - Call fs_list on notes/ and read the three most recent notes.
  - Write notes/weekly-review.md with Wins / Misses / Next week.
  - Call memory_write with scope "shared" for anything the whole team should carry forward.
  - Call task_finish with the three headings as a one-line summary.
validation:
  - notes/weekly-review.md exists and mentions at least one routine by name.
  - Every claim in Wins points at a file or a run that exists.
output: notes/weekly-review.md, plus shared memory updated with anything durable.
approval_notes: Writing notes inside the workspace is LOW risk. Writing to memory is LOW risk. Nothing here needs a human unless a step is added that leaves the workspace.
---

# Weekly review

The whole point is to resist invention: every line under **Wins** has to name a
file or a routine run that actually exists in this installation.

## Shape

```
# Weekly review - <date range>

## Wins
- <thing> (<evidence: file or routine id>)

## Misses
- <thing that was attempted and did not land>

## Next week
- <one or two things, not ten>
```

## Failure mode to avoid

Producing a polished review that is not grounded in run history. If the evidence
is thin, say the week was quiet. A short honest review beats a long invented one.
