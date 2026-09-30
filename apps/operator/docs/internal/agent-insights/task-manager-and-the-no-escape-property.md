---
title: The task manager — what is running, who asked for it, and why nothing escapes
description: How the cgroup-confined task ledger works, which questions it answers that `ps` cannot, and the three places agents get this wrong.
---

# The task manager, and the "no escape" property

**TL;DR** — `processes:list` tells you *who launched a process, for which work-item,
under what budget, and what it costs*. `ps` and `dev:processes` cannot answer any of
that. Kill things with `processes:kill { taskId }`, never a name pattern.

## The one idea

You cannot keep 813 spawn call sites honest. You do not have to:

> **Cgroup membership is inherited by every descendant, and a process cannot leave
> its cgroup without privileges.**

So the ~dozen processes the operator itself launches go into a named transient scope
`pc-<taskId>.scope` under `papercusp.slice`, and everything they ever spawn — an
agent CLI, the Bash tool it drives, the `npm test` that starts, the vitest workers
that forks, a grandchild that double-forks and reparents to init — is still inside
that cgroup. Confine the ROOTS; the kernel does the rest.

The scope's NAME carries the ledger key, so reconciling "what the kernel is running"
against "what the ledger believes" is a string join rather than a cmdline heuristic.

## What you actually use

| you want | call |
|---|---|
| what is running and WHY | `processes:list` |
| ...cross-checked against the kernel right now | `processes:list { live: true }` |
| what a work-item cost | `processes:list { workItemId, includeEnded: true }` |
| end a task + its whole subtree | `processes:kill { taskId }` |
| relieve pressure without losing work | `processes:freeze { taskId }` (thaw with `resume: true`) |
| cap a runaway without killing it | `processes:limit { taskId, memoryMaxMb }` |
| the human pane | `/admin/tasks` (sibling of `/admin/schedules`) |

## The three mistakes

**1. Treating `processes:list` as a `ps` substitute.** It is not, and it will answer
that question wrong rather than empty. It lists what THIS OPERATOR launched plus
anything found inside our cgroup slice. A process started by hand in a terminal shows
up (if at all) as `foreign` — visible, never controlled. For a real host process list,
plain `ps`/`pgrep` is correct and is never gated. For the six tracked agent kinds,
`dev:processes` is still the right tool and is deliberately unchanged.

**2. Killing by name.** `pkill -f '<binary>'` has twice killed the owner's live
desktop window and peer agents' Xvfb instances, because a pattern match is not an
identity. Both addressing modes here exist to make that impossible:

- `taskId` → `systemctl --user kill pc-<taskId>.scope`. Addressed by CGROUP: takes the
  whole subtree, leaves no orphaned grandchildren, and cannot reach a recycled pid.
- `pid` → signalled ONLY after re-reading `linux:<bootId>:<startTicks>` and confirming
  it still matches what the row recorded. PID wrap happens roughly daily here under
  fleet load; an `identity_mismatch` refusal is the rail working, not a bug.

**3. Reading `confined: false` as an error.** It means the task is ledgered but not
cgroup-isolated — either the systemd probe had not landed when it spawned (the first
job after boot), or this host cannot make user scopes at all. The task still runs and
is still tracked; it just cannot be frozen or re-budgeted, and its kill falls back to
the verified-pid path. Confinement is an enhancement; the job is the user's actual
work, and the task manager must never be the reason a command does not run.

## Reading the states

`pending` → registered, not yet spawned (the row is written BEFORE the fork, so a
crash in that window is visible instead of silent). `running` → alive and accounted
for. `exited` / `killed` / `timed_out` → ended, with a reason. Then the two that carry
real information:

- **`stranded`** — the ledger said running, the kernel disagreed. Deliberately NOT
  folded into `exited`: we never saw an exit code, and reporting a strand as a clean
  completion is exactly the manufactured certainty that makes an inherited
  "job COMPLETED" claim untrustworthy.
- **`unaccounted`** — the no-escape signal. Something is running inside our slice that
  no chokepoint registered: a bypass, or a scope that outlived the row describing it.
  **REPORT-ONLY** — never auto-killed. Until the classification has been right for a
  sustained window, a reaper firing on a false positive is worse than the bypass.

## If you are adding a spawn

A `detached: true` spawn creates a process meant to outlive the call that made it —
the root of a subtree — so `lint:no-unenrolled-spawn` requires it to be enrolled:

- async seam → `managedSpawn` (`task-manager/managed-spawn.ts`);
- sync seam that cannot become async → `beginSyncEnrolment` + `completeSyncEnrolment`
  + `finishSyncEnrolment` (`task-manager/enroll-sync.ts`). The id and confinement
  decision are synchronous; the ledger WRITES are fire-and-forget and can never block
  or fail your spawn.

If the lifetime genuinely is not ours to own — a human terminal window, a
pre-operator bootstrap, a release cut that must survive the restart it performs — add
it to the guard's ALLOWLIST **with a reason**. Silently un-enrolled is the one option
that is not available: it becomes an `unaccounted` alarm on the next reconcile anyway,
just without provenance.

## Why the reconciler sometimes declines to act

`reconcileTick` refuses to close rows when the scan cannot be trusted — a missing
cgroup root, or an owned-pass truncation. Row by row, a bad scan is indistinguishable
from an idle box, so acting on one would mass-strand every live task and report a
fleet-wide outage that never happened. It still records positive confirmations:
absence is untrustworthy, presence is not.

A **foreign**-pass truncation does NOT degrade the verdict. That distinction was
bought the hard way — with one shared process budget, this box's 500+
signature-matching foreign processes exhausted it, set `truncated`, and put the
reconciler into permanent degraded mode where it would never have closed a stranded
row again. A display-only view must never be able to disable the ledger's correctness
path.

## Where it lives

- Ledger: `harness_shared.task_ledger` (migration 696)
- Core: `packages/operator-core/lib/task-manager/` — `types` (naming algebra),
  `reconcile` (pure diff), `scan` (kernel), `cgroup-read` (parsers), `store` (PG),
  `managed-spawn` + `enroll-sync` (chokepoints), `control` (verbs),
  `reconcile-tick` (composition)
- Cadence: `system:task-reconcile`, `tier:ephemeral`, 30s
- Guard: `npm run lint:no-unenrolled-spawn`
- Plan: `task-manager-no-escape-2026-07-27`
