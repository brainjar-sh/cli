# Context Recovery

This rule governs behavior after context compaction, session resume, or any situation where prior conversation may be lost.

## After Context Loss

1. **Re-read the task plan.** Check todo lists, plan files, and any task-tracking artifacts.
2. **Check recent changes.** Run `git diff` and `git log --oneline -10` to see what's been done.
3. **Re-read active files.** Open files you're currently modifying — don't rely on memory of their contents.
4. **Summarize state.** Briefly state what's done, what's in progress, and what's next before continuing work.

## Rules

- Never continue from memory alone after compaction. Always re-ground in artifacts.
- If you can't determine the current state, ask the user rather than guessing.
- Treat every post-compaction turn as if you're a new engineer picking up someone else's work.
- The task isn't "remember what we were doing" — it's "figure out what needs doing next."
