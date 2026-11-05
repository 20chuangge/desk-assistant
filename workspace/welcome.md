# The shared workspace

Every bot sees this directory. A file written by one bot is immediately visible
to the others and to you - that is the "one computer" part of the product.

A few rules the bots are told to follow:

- **Write here, not outside.** `workspace/` is the shared desk. Anything outside
  it is somebody else's data, so writing there is HIGH risk and always asks you.
- **Notes beat chat.** If a decision matters tomorrow, put it in a file under
  `notes/` so the next bot does not have to guess.
- **Memory is per bot.** Each bot keeps its own `MEMORY.md`; the only thing they
  all share is a small facts file at `data/memory/shared.md`.

## What is here

| Path | What it is |
| --- | --- |
| `welcome.md` | This file. |
| `notes/` | Working notes written by the bots. Created on first write. |

## Things worth trying

1. Ask Chief to *list the files in the workspace* - it lists, writes
   `notes/plan.md`, and saves a memory entry.
2. Ask Ops to *write a note outside the workspace* - an approval card appears,
   and the write only happens if you click Approve.
3. Ask Chief to *hand off to the researcher* - the Researcher runs its own turn,
   with its own tools and its own memory, and the reply comes back to Chief.
4. Create a routine below, then hit **Test** and watch a run appear in the
   history.
