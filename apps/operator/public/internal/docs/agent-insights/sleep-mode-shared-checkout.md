# Sleep-mode shared-checkout discipline
URL: /internal/docs/agent-insights/sleep-mode-shared-checkout

When working overnight in a shared checkout with parallel agents, every commit must be staged file-by-file with a pre-commit diff check. Skipping this WILL bundle another agent's in-flight work into your commit.

:::caution\[Update 2026-06-08 — the manual-commit sections below are superseded]
Since `git-sync-auto-commit-2026-06-03` + `staging-branch-pipeline-2026-06-06`,
**agents no longer `git add` / `git commit` / `git push` at all** — a background
**git-sync** routine commits the whole shared tree (every agent's work) and pushes
it to `origin/staging` on a schedule; from there green-checkpoint FFs `main`. The
per-edit file-lock `PreToolUse` hook serializes concurrent edits to the same file,
so a peer can't stomp your uncommitted work between ticks. So the "stage
file-by-file / `git diff --cached` before every commit / commit per item / don't
push" mechanics below **no longer apply** — there are no per-agent commits to
leak into. Coordinate via `locks:*` + `coord:*`, not manual staging. The
**non-git** rules in *Things to NOT do in sleep mode* / *What sleep mode is good
for* (don't restart the user's dev server, don't make arch decisions for them,
don't run destructive PG/branch ops, stop when safe work runs out) all still hold.
:::

## What

When the user tells you "I'm sleeping, keep working on the plan," you
are working **without anyone supervising your git operations** in a
checkout that **other agents are editing in parallel**. The classic
shortcut `git add <file>` is unsafe in this mode: another agent may
have touched the same file between your last read and your commit.

The canonical sleep-mode commit sequence:

```bash
git add <files-i-intended-to-stage>
git diff --cached --name-only     # MUST show exactly what you intended
git diff --cached <one-file>      # for a doc edit, eyeball the actual diff
git commit -m "..."
```

The `git diff --cached --name-only` step is non-negotiable. **One
unnecessary line of confirmation prevents a class of bug that's hard
to unwind after the fact.**

## The failure mode you're guarding against

Real overnight incident: I edited the v5 plan doc, committed, and
the commit ended up `78 ++++++++++++++++++++--` instead of the
expected `~10`. Another agent had added a brand-new section
(`§9.0 Insights tab`, `§17 Stat trust tiers`, `§18 User profile`,
multiple D-NNN decisions, multiple P-NNN items) between my read and
my `git add`. `git add <file>` swept it all into my commit; my
commit message claimed "no code changes — pure plan-doc accuracy"
which was *technically* true (no code) but completely missed the
substantive new architecture work riding along.

The damage:

* Author attribution muddied — the other agent's design work shows
  up under my commit hash + message.
* Commit message no longer accurately describes the commit.
* If the other agent's edits had bugs, my commit would have
  "introduced" them in the git log.

## When this is most likely to bite

The danger window is:

1. Long-lived files (plan docs, schema files, monolithic config) that
   multiple agents care about.
2. **Time between read and commit** — the longer you spend composing
   an edit, the larger the window for another agent to drop in.
3. **No checkpoint between thinks** — when you're in flow ("got
   the right edit, commit it") it's easy to skip the verification.

Files most likely to bite (this codebase, today):

* `apps/operator/docs/plans/papercusp-dogfood-v5-2026-05-23.md`
* `apps/operator/package.json`
* `libs/papercusp/libs/db/sql/*.sql`
* Anything in `apps/operator/app/harness/` (paperclip's edit zone)

## The discipline that works

1. **Stage explicitly, never `git add .`** — typing the path is a
   forcing function for "am I really intending to touch this file."
2. **`git diff --cached --name-only` before every commit** — one
   command, \~50ms, catches 100% of stage-leakage.
3. **For any file you touched, also `git diff --cached <path>`** —
   confirms the diff inside the file matches what you intended.
4. **If the diff has more lines than you remember writing, STOP** —
   another agent's work landed. Decide: split the commit, ask the
   user, or call out the bundling in your commit message.
5. **Commit per item, not per session** — small commits limit the
   blast radius of an accidental bundle.

## What to do if you bundle by accident

Don't try to silently fix it. You have two clean options:

**Option A — Note in your next-commit message.** Add a follow-up
commit that explicitly acknowledges the prior commit bundled
unrelated work, listing what wasn't yours. Future readers will
find the trail.

**Option B — Reset + redo (only if you haven't pushed)**:

```bash
git reset --soft HEAD~1                  # un-commit, keep changes staged
git reset HEAD                           # unstage everything
git stash --include-untracked            # safe-park everything
# re-do with explicit staging
git stash pop
```

The user can also help by reviewing your commits before they push;
your acknowledged-bundle commit message is the signal they need.

## Things to NOT do in sleep mode

* **Don't restart the user's running dev server.** The :3055 / :3070
  operator processes are theirs; they're likely mid-session, not
  blocked. Memory has this rule explicitly.
* **Don't make architectural decisions the user should weigh in
  on.** When a code change forces a binary choice (e.g., "delete
  `apps/papercup/` or refactor `schema.ts`"), document the
  diagnosis in the plan and defer. Don't pick.
* **Don't push.** "I trust your judgment" applies to commits, not
  pushes. The user has the final review at wake-up.
* **Don't run destructive operations on shared state.** PG drops,
  branch deletes, force-pushes — these have no undo in a shared
  checkout. If a task tempts you toward one, defer.
* **Don't paper over conflicts you don't understand.** If a `git
  add` shows lines you didn't write, that's a signal — investigate
  the holder.
* **Don't keep working past your usefulness.** When the available
  safe work runs out, write a wrap-up report and stop. The user
  prefers an honest "I paused at X because Y" over a 7am commit
  that needs reverting.

## What sleep mode is good for

* **Incremental migrations** that the user has already scoped (e.g.,
  P-022's batches — 53 names, each batch is a mechanical pattern).
* **Schema additions** that match an already-established pattern in
  the same file.
* **Agent insights / docs** that capture patterns just shipped.
* **Plan-doc accuracy passes** — mark shipped items DONE with commit
  refs (with the stage-leakage check above).
* **Test coverage backfill** for code shipped this session.

## Related

* `feedback_git_status_before_commit_shared_checkout.md` — the
  underlying memory rule this insight expands.
* `feedback_paperclip_collision_race.md` — paperclip-specific case
  of the same hazard.
* Other agent insights in this directory exemplify the discipline:
  small commits, one item per commit, explicit cross-references.
