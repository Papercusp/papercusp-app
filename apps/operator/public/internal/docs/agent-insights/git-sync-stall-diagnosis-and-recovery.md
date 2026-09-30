# git-sync stall — diagnose the 3 failure modes and recover safely
URL: /internal/docs/agent-insights/git-sync-stall-diagnosis-and-recovery

HEAD frozen + dirty climbing + work not reaching origin has THREE distinct causes (bg-host event-loop wedge / PG lock-statement-timeout contention / auto-rebase tree-revert). They need DIFFERENT responses — restarting a lock-contention stall is wrong. Snapshot first, restart only a wedge, never double-restart.

## What

git-sync (the background routine that commits the whole shared tree + pushes to
`origin/staging` on a schedule) can STALL — HEAD frozen for many minutes, the
dirty-file count climbing, fleet work + deploys not reaching origin. It bit the
fleet repeatedly on 2026-06-19/20 (one stall held HEAD \~3h; another blocked
deploys \~6h). There are **three distinct causes** with **different fixes** — and
the wrong fix (e.g. restarting a lock-contention stall) wastes time or churns the
substrate. Diagnose first.

You do NOT `git commit` to fix this (git-sync owns the commit + push). You
diagnose, optionally protect the work with a kopia snapshot, and either restart
the bg-host (mode 1) or wait/route (modes 2/3).

## Diagnose: which of the 3 modes?

Run these read-only checks (replace the path with the canonical tree):

```
cd /home/dev/papercupai-workspace/papercup
git log -1 --format='%h %cr'          # how stale is HEAD?
git status --porcelain | wc -l        # dirty count (climbing?)
journalctl --user -u papercup-bg-host.service -n 1 --no-pager   # is it logging NOW?
journalctl --user -u papercup-bg-host.service --since '-6min' --no-pager | grep -i git-sync
```

### Mode 1 — bg-host EVENT-LOOP WEDGE  (→ RESTART)

* Signature: `systemctl --user is-active papercup-bg-host` says **active**, but
  the journal has produced **NO output for minutes** — the last lines are a run
  of `[event-loop-lag] high loop delay` then silence. The PID is alive but the
  event loop is hung, so NO routine ticks (git-sync, green-checkpoint, all dead).
* Root cause (recurring): the `mem0` better-sqlite3 **ABI mismatch** (the bg-host
  runs a different Node than the dev-api but they share one `node_modules`, so a
  memory-touching routine hangs the loop) and/or CPU saturation. Durable fix is
  the infra lane (pin one Node ABI — "A3").
* FIX: restart the bg-host (see Recover, below). It un-wedges and flushes the
  whole backlog. It is restorative + survivable — it does NOT touch the working
  tree, the substrate replays from PG, and the bg-host self-recycles routinely.

### Mode 2 — PG LOCK / STATEMENT-TIMEOUT contention  (→ WAIT, do NOT restart)

* Signature: the bg-host **IS logging recently** (not silent) and git-sync **IS
  running** every tick, but failing with:
  `[git-sync] lock infra unavailable (git-sync): workspace "..." contended (pg 57014: lock/statement timeout)`
  `pg 57014` = statement\_timeout/query\_canceled. PG itself is healthy
  (`dev:pg_health` \~40% saturation, no stuck holder) — the lock-acquire query is
  timing out under load.
* It is **intermittent + self-recovering**: once contention eases, git-sync gets
  the lock and commits the whole backlog at once (dirty → 0). A restart does NOT
  fix the underlying PG contention and is unnecessary.
* Now mitigated by retry-with-backoff on pg 57014 (EI-1720 →
  `acquireWithContentionRetry`). If it stalls for MINUTES under sustained load,
  route to the PG-perf lane (the `coord_event_log` hot-path), don't restart.

### Mode 3 — the tree "REVERTED TO CLEAN"  (→ recover from the stash branch)

* Signature: uncommitted work VANISHED (working tree clean, edits gone).
* This is NOT silent data loss. `harness/auto-rebase.ts` on a rebase conflict
  does `rebase --abort` then **pushes your WIP to a `wip/conflict-F-<id>-<ts>`
  branch + writes a `harness_escalations` row** BEFORE resetting. git-sync itself
  is merge-based (fetch→merge→push) and does NOT reset the tree.
* RECOVER: `git branch -a | grep wip/conflict` — your edits are on that branch.
  (Gap: the reset is not loudly surfaced to the working agent, so it LOOKS like
  loss → wasted re-work. A coord-notify on auto-rebase reset would close it.)

## Recover (Mode 1 — the restart)

1. **Protect the work FIRST** (independent of git): take a kopia snapshot so the
   dirty tree is restorable even if something resets it —
   `backup:snapshot_create { reason: 'pre_destructive', note: '...' }`.
   (kopia also auto-snapshots \~every 5 min, so the work is rarely truly at risk.)
2. **Claim it + announce — ONE restart, not many.** Post "restarting bg-host" so
   a peer does not restart concurrently (the double-restart lesson — harmless but
   wasteful; coordinate). If a peer says they are on it, stand down.
3. `systemctl --user restart papercup-bg-host.service`
4. **Verify it un-wedged + flushed** (do not assume): the journal resumes routine
   ticks; then poll HEAD until it advances past the frozen sha and
   `git status -sb` shows `staging...origin/staging` with no drift (committed AND
   pushed), dirty → 0. A background `until`-loop poll is the clean way to wait.
5. Note the root cause stays unfixed (mem0 ABI / A3) — it CAN re-wedge under
   sustained load. The restart is a band-aid; the durable fix is the infra lane.

## Gotchas

* A bg-host that is `active` is NOT proof it is healthy — a wedged event loop
  keeps the PID alive. The real liveness signal is **recent journal output**.
* Do not `git reset`/`checkout`/`clean` the canonical tree to "fix" a stall — you
  will destroy peers' uncommitted work. git-sync converges on its own once
  un-wedged.
* The release `:3070` lagging is a SEPARATE thing — that is the green-checkpoint
  cadence (hourly FF of green `main`), not git-sync. Check `/admin/git`.

## Refs

* EI-1720 (git-sync lock retry/backoff), the bg-host mem0-ABI wedge (infra-fail-fast
  "A3"), `harness/auto-rebase.ts` (the wip/conflict stash), `backup:snapshot_create`.
