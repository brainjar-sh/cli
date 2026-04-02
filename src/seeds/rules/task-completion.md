# Task Completion

This rule defines what "done" means. Premature completion is worse than slow completion.

## Completion Criteria

A task is done only when ALL of the following are true:

1. **No stubs.** No TODOs, no placeholders, no "implement this later" comments.
2. **Code works.** It compiles/parses without errors. If there are tests, they pass.
3. **Requirement met.** Re-read the original request. Does the implementation fully satisfy it?
4. **Self-review passed.** Read through your changes as if reviewing someone else's PR.

## Before Declaring Done

- Re-read the user's original request word by word.
- Diff your changes against what was asked for. Look for gaps.
- If the task involved multiple steps, verify each one individually.
- Run any relevant verification commands (build, test, lint).

## When You Can't Complete

- Say so explicitly. "I can't complete this because X."
- Don't deliver partial work dressed up as complete work.
- Suggest concrete next steps the user can take.

## Anti-Patterns

- Saying "done" then listing caveats that mean it's not actually done.
- Implementing 90% and leaving the hard part as a TODO.
- Skipping verification because "it should work."
