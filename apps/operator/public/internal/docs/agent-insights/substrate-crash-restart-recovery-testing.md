# Live-testing substrate crash/restart recovery: the embedded-PG dynamic-port trap + the SIGKILL→WAL→rejoin pattern
URL: /internal/docs/agent-insights/substrate-crash-restart-recovery-testing

How to crash-test a real packaged Papercusp instance and verify federation recovers — the embedded Postgres picks a NEW port on every boot (never hardcode the pre-crash port), the whole-session SIGKILL takes the embedded PG with it (one cycle covers instance-restart AND embedded-PG WAL recovery), and a path-scoped pgrep is mandatory because sibling test pairs share `inst-a/` in their cmdlines.

## Context

Shared-pot release-testing Brief S (substrate durability & crash/restart
recovery). Two layers: a deterministic integration test for the drain/merge
recovery LOGIC (`crash-recovery-drain.integration.test.ts`), and a LIVE cycle on
the real packaged `.deb` pair to prove it on the binary. The live cycle has three
traps that cost real time; this is the runbook.

## Trap 1 — the embedded Postgres picks a NEW port on every boot

The embedded-postgres-server binds a **fresh dynamic port each time the instance
boots**. After you SIGKILL + restart an instance, its PG is **NOT** on the
pre-crash port. A verification script that hardcodes the original port (e.g. from
the standup's `instances.env`) will hang forever waiting for a port that never
comes back — even though the instance rebooted fine.

**Find the live port by data-dir path, every time:**

```bash
# the restarted instance's embedded PG port (NOT the old one):
APORT=$(pgrep -af "embedded-pg-data" | grep "$WORK/inst-a/" \
        | grep -oE "\-p [0-9]+" | awk '{print $2}' | head -1)
psql "postgresql://harness_admin:harness_admin_pwd@localhost:$APORT/papercusp" ...
```

## Trap 2 — `grep inst-a/` matches OTHER test pairs' instances

Multiple live pairs run concurrently (e.g. your Brief-S pair under
`~/.papercusp-brief-s-live` and a co-running A-003 witness under
`/tmp/a003-rewitness/matrix`). Both have `…/inst-a/…embedded-pg-data` in their
cmdlines, so a bare `grep "inst-a/"` returns the WRONG pair's PG port (I queried
the sibling pair and saw "no F-CRASH rows" — a false alarm). **Always filter by
the full `$WORK` path**, never just `inst-a/`. The teardown `stop.sh`
(`pkill -9 -f "$WORK"`) is correctly path-scoped — mirror that discipline in every
pgrep/psql.

## Trap 3 — one whole-session SIGKILL covers BOTH #3 and #2

The smoke harness launches each instance with `setsid` (own session). The embedded
Postgres, code-server, operator, and desktop are all in that session. So:

```bash
PGPID=$(pgrep -f "embedded-pg-data -p <PORT>" | head -1)
SESS=$(ps -o sess= -p "$PGPID" | tr -d ' ')
pkill -9 -s "$SESS"            # kills the WHOLE instance incl. its embedded PG
```

This single hard kill is the **session's real failure mode** (a process/box kill
that takes everything) and exercises BOTH the instance restart (#3) **and** the
embedded-PG hard-crash + WAL recovery (#2) in one cycle — the embedded PG is
`-9`'d and WAL-recovers its data dir on the next boot. A "kill ONLY the PG, keep
the instance" fault is a narrower, lower-value variant.

## The restart + verification pattern

Restart re-uses the persisted on-disk state (`HOME=$WORK/inst-a` holds the
embedded-PG data dir + the corestore peer logs), so re-running the harness's
`fed_local_launch` on the same HOME is a real reboot:

```bash
source papercusp-desktop/bin/lib/federation-asserts.sh
fed_local_launch "$WORK/inst-a" "$WORK/inst-a.log" "$WORK/pkg/usr/bin/papercusp-desktop" \
  "$DISPLAY_NUM" GH_TOKEN="$(gh auth token --user papercupai)" \
  PAPERCUSP_DHT_BOOTSTRAP="$BOOTSTRAP" PAPERCUSP_CUPBOARD_URL="http://127.0.0.1:9"
```

Then verify recovery via the embedded PG `origin` column (federation is confirmed
when a write on A lands `origin='remote'` on B):

1. **No loss:** the restarted A's PG still holds its pre-crash rows (WAL recovery).
2. **Topic re-join:** `inst-a.log` shows `[swarm] joined topic … harness=<pot>-pot`
   **AND** `harness=<member-slug>` — i.e. the pot-HOME harness re-joins on
   restart, not just the member (post-A-003 the owner must re-boot the pot-home
   harness onto the topic — assert both).
3. **Resume:** a FRESH post-restart write on A crosses to B `origin='remote'` (the
   outbox drained + the topic round-trips again). Expect \~2 s.

## The drain-resume contract (the deterministic side)

The outbox drain (`outbox-drain.ts`) is AT-LEAST-ONCE: a row's `drained_at` is
stamped ONLY after `handle.append` resolves; if append throws (a crash), the error
propagates and that row + all later rows stay undrained for the next pass. So a
crash mid-drain leaves a partially-drained outbox; restart re-drains the tail with
no loss. A crash BETWEEN append and the `drained_at` UPDATE re-appends a DUPLICATE
op on restart — which is harmless because the projection's `fed_ts`/HLC LWW guard
(`EXCLUDED.fed_hlc >= stored.fed_hlc`, mig-314) makes the re-apply idempotent. To
unit-test the crash deterministically, wrap `handle.append` in a Proxy that throws
after K rows — no real process kill needed (see `crash-recovery-drain.integration.test.ts`).

## HLC survives restart (no D-001 post-restart)

The mig-314 HLC clock (`hlc_clock`) is a **PG-persisted singleton table**, not
process memory — so it survives a restart. A `hlc_recv()` of a future HLC persists;
a post-restart `hlc_now()` continues strictly-greater (never regresses to
wall-clock), which is what stops a D-001-class divergence after a reboot. Verify by
asserting `hlc_now()` after a future `hlc_recv()` stays at the future ms across a
simulated restart; neuter by `UPDATE hlc_clock SET last_ms=0` to confirm the
assertion catches a regressed clock.
