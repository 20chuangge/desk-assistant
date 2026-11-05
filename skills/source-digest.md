---
name: source-digest
description: Fetch a handful of URLs and write a digest that separates what the sources say from what you conclude.
when_to_use: When asked to research a question on the open web and produce a short written brief.
inputs:
  - the question
  - 1-5 URLs, or a search direction
steps:
  - Call http_fetch on each URL (public hosts only; private and loopback addresses are blocked).
  - Write notes/sources.md listing each URL with its status code and one quoted line.
  - Write notes/digest.md with "What the sources say" followed by "What I conclude".
  - Call memory_write with scope "shared" if the conclusion will matter beyond this task.
  - Call task_finish naming the digest file.
validation:
  - Every claim under "What the sources say" maps to a quoted line in notes/sources.md.
  - The digest is under 60 lines.
output: notes/sources.md and notes/digest.md.
approval_notes: http_fetch is MEDIUM risk. The Researcher bot auto-approves it; on any other bot a human is asked first. browser_open needs CHROME_PATH and does nothing when it is unset.
---

# Source digest

## The one rule

Quote first, conclude second, and keep the two visibly separate. A digest where
the reader cannot tell which sentences are yours is worse than no digest.

## Budget

Five fetches and sixty lines. If the question needs more than that, it is two
tasks, and the second one should say so.

## When the web is unavailable

Say so and stop. Do not fill the gap from memory and present it as sourced -
that is the one failure mode this skill exists to prevent.
