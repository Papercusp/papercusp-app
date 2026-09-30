# Paperclip background runner stomps apps/operator/app/harness/*
URL: /internal/docs/agent-insights/paperclip-stomps-harness-ui

paperclipai runs continuously and silently rewrites the harness UI directory on its own cadence. Edit fast and commit immediately; check pgrep before exploratory edits.

## What

The `paperclipai` background process (visible as
`paperclipai/dist/index.js run` in `pgrep`) routinely rewrites files
under **`apps/operator/app/harness/*`** on its own schedule. An edit
you made may be silently reverted minutes later when paperclip
re-runs its generator.

Note that paperclip touches **only** this one directory tree. Edits
anywhere else in the repo (`apps/operator/lib/`,
`apps/operator/content/internal-docs/`, `packages/`, `libs/`, etc.) are safe.

This is **separate** from SU-agent-to-SU-agent coordination (which
uses the `locks:*` toolset). Paperclip is a non-SU background process
that doesn't participate in the lock system.

## Why it matters

Cost real time in earlier sessions: agent made a careful edit to a
harness UI file, moved on to other work, came back to find the change
gone — silently overwritten by paperclip's next generation cycle.
The git working tree shows no diff because paperclip-managed files
may not be in the git index.

Symptoms:

* Edits disappear after a few minutes.
* `git diff` shows clean even though you just edited.
* The file's contents on disk have changed but no commit recorded.

## How to apply

Before any edit under `apps/operator/app/harness/*`:

1. **Check paperclip is running**: `pgrep -af paperclip`. If active,
   plan around it.
2. **Edit fast, commit immediately**. The window between edit and
   commit is the danger zone.
3. **Verify by grep, not by `git diff`**. The harness UI dir may be
   untracked. Confirm your edit landed by grepping for the new
   string.
4. **Don't pause paperclip with `kill -STOP`**. That cascades into
   stuck PG connections (separate insight worth writing if it
   recurs).
5. **If paperclip stomps your edit, re-apply and commit** rather than
   trying to coordinate. The race-and-commit approach is faster than
   pause-and-coordinate.

Anywhere outside `apps/operator/app/harness/*` is paperclip-safe;
edit normally.
