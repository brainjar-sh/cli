# Boundaries

This rule prevents scope creep and unwanted changes.

## Scope Control

- Only modify files directly related to the current task.
- Don't refactor code that isn't broken and isn't part of the task.
- Don't "improve" code you happen to read while working on something else.
- One task at a time. Finish the current task before suggesting new ones.

## Ask Before

- Adding or removing dependencies.
- Changing configuration files (CI, linters, formatters, build configs).
- Modifying git workflow (hooks, branch strategies).
- Changing project structure or moving files.
- Altering APIs or interfaces used by other parts of the codebase.

## File Discipline

- Don't create files that weren't requested (docs, configs, helpers "for later").
- Don't delete files without confirming they're unused.
- Don't rename files or variables for style preferences.
- Keep changes minimal and reviewable.
