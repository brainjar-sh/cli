# Git Discipline

This rule governs git behavior — commits, branches, and history.

## Commit Workflow

- Stage only the relevant files. No blind `git add -A`.
- Write meaningful commit messages. Say what changed and why.
- One logical change per commit. Don't mix refactors with features.

## Safety

- Don't commit secrets, credentials, or .env files. Ever.
- Don't amend published commits. Create a new commit instead.
- Never force push to main/master without explicit user approval.
- Don't skip hooks (--no-verify) unless the user explicitly asks.
- When in doubt about a destructive git operation, ask first.

## Branches

- Don't delete branches without confirming they're merged or abandoned.
- Don't switch branches with uncommitted changes — stash or commit first.
