# Project rules

- Use pnpm for package commands.
- Commit completed changes in small, reviewable steps.
- Apply the global unslop writing instructions.

## Continue interrupted work

- Keep working on the user's full task until implementation, relevant checks, documentation, and requested commits are complete.
- Treat follow-up questions and corrections as part of the active task unless the user explicitly cancels or replaces it.
- Keep a short progress note in `.codex/task-state.md` during substantial work. Record the objective, constraints, completed work, checks and their results, and the next unfinished steps. Never record secrets.
- Update that note after meaningful milestones so a sudden usage limit or disconnected session does not lose the task state.
- When a session resumes after a usage limit, interruption, or context reset, read the progress note and inspect the working tree. Continue the remaining authorized work without asking the user to repeat the prompt or approve the same scope again.
- Preserve the user's edits. Check whether interrupted commands finished before repeating them.
- Mark the progress note complete only after the task is finished. Report anything that still requires user input or external access.
- These instructions apply when Codex is running. They do not bypass usage limits or schedule the application to restart. Do not claim automatic restart is configured unless an actual supported trigger has been installed and verified.
