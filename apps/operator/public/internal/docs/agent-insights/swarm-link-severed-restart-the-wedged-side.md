# A severed hyperswarm link between hive machines does not self-heal — restart the wedged side
URL: /internal/docs/agent-insights/swarm-link-severed-restart-the-wedged-side

After one side of a 2-machine hive restarts, the peer-log/presence-gossip swarm link can sever PERMANENTLY — neither side re-dials/re-announces. Diagnose with the 4-step evidence chain, then restart the WEDGED side (the one that has been up longest), not the fresh one.

A 2-machine hive (e.g. tower ↔ Mac VM) links its two `bg-host`/sidecar processes over a
hyperswarm topic (`topic-gossip:<pot>/hive-presence`) that carries presence gossip, peer-log
federation (coord messages, federated events, delivery receipts, claim specs), and hypercore
replication. **When one side restarts, that link can sever permanently — not a bounded
freeze that self-heals.** Verified live on the tower↔VM rig (session su-18f2f, 2026-07-17
01:4x–03:2xZ EDT); full forensics in EI-13317 and
`docs/plans/CUTOVER-presence-gossip-2026-07-16.md` § LIVE drill scoreboard.

## The failure shape

Earlier observations described this as a "\~13-minute post-restart peer-log freeze" that
self-heals. **That is wrong — or at least not the whole story.** In the live drill:

* A restart pairing where BOTH sides come up fresh (near-simultaneous tower `bg-host` +
  VM sidecar boot) reconnects cleanly within \~100s.
* A restart of only ONE side (the VM sidecar rebooted alone) severed the link at \~22:49
  and it **never re-established on its own**. One transient reconnect existed \~22:57 —
  long enough to replicate a backlog in one direction — then dropped and never returned.
  That transient carried the earlier fleet to believe it was a bounded self-heal; it
  wasn't — it was a lucky, temporary reconnect.
* A second VM sidecar reboot at 23:13 (a fresh dial, fresh announce) still did **not**
  reconnect after 6+ minutes of watching. The surviving side (tower `bg-host`, up since
  22:35) was not accepting/answering discovery even though its own gossip broadcast timer
  kept running against zero channels.
* Only a restart of the **surviving/wedged** side (tower `bg-host` at 23:24) recreated the
  both-sides-fresh configuration and reconnected within \~2 minutes.

So: **a fresh dial from the fresh side cannot rescue a wedged peer.** The side that has
been up the longest since its own last wire/reboot is the one holding stale swarm state,
and only restarting *that* side clears it.

## The signature — confirm this before acting

Don't guess from "coordination seems dark" — confirm the severed-link signature on BOTH
machines before treating it as this failure mode:

1. **Frozen remote presence rows.** `shared_presence` rows for the *other* machine stop
   advancing — their age climbs monotonically instead of re-stamping every few seconds.
   Check both sides (`dev:pg_query` against `shared_presence WHERE pot_slug = '<pot>'`).
2. **Zero open gossip channels, continuously, on both sides.** Grep both processes' logs
   for the topic-gossip broadcast line — it keeps firing on its own timer but reports
   `0 channel(s) open`:
   ```
   [topic-gossip:<pot>/hive-presence] broadcast … 0 channel(s) open
   ```
   This appears on BOTH the fresh side's serve log and the wedged side's `bg-host`
   journal — it is not one-sided.
3. **Frozen inbound apply.** The receiving side's `coord_event_log` (or equivalent
   federated-event ledger) stops advancing — `max(ts)` sticks at the moment of severance.
4. **Zero sockets between the machines.** `ss -tnp` / `ss -aunp` (whichever transport the
   swarm uses) shows no active connection between the two hosts' processes.

**Fastest disambiguator — run the probes FIRST.** `bin/vm-rig/probe-rev.sh` +
`bin/vm-rig/probe-fwd.sh` give a definitive live round-trip verdict in \~15s each; only
when they FAIL does the restart lever below apply. On 2026-07-17 \~20:54Z (su-0e484126)
legs 2–4 all appeared to match — `coord_event_log` remote rows frozen 3.4h,
`hive-presence` gossip broadcasting into `0 channel(s) open`, `ss`/`netstat` showing no
inter-machine sockets — yet both probes PASSED in seconds: the link was fine. The
false reads: the VM had merely stopped *authoring* coord messages after its own
serve.mjs restart (frozen inbound ≠ frozen replication); hyperswarm's UDX rides
**unconnected UDP sockets that `ss`/`netstat` per-peer greps cannot see** (and
`conntrack` may not be installed), so leg 4 needs the probes, not socket greps; and
`dogfood-substrate-status` can report `bootedCount: 0` on the bg-host while the engine
is demonstrably live in-process (outbox draining, corestore fd open — a separate
status-seam false-negative, filed 2026-07-17). Leg 1 is the strong guard: **remote
`shared_presence` rows re-stamping fresh (age \< \~1 min) mean the link is ALIVE** —
never restart through that signal.

Rule out the two usual false leads before concluding it's this bug:

* **The DHT fixture is not the cause.** A dedicated DHT bootstrap/fixture service
  (e.g. `papercup-isolated-dht.service`) staying up across the restart is expected and
  irrelevant — it survives every restart in this failure and is not what's severed.
* **No sibling process is quietly holding the link.** Check adjacent services on the
  surviving machine (e.g. a `dev-api`/`staging-api` journal) for any topic-gossip/swarm
  lines — in the verified drill, they carried none, ruling out a second process as the
  actual link holder.

## The recovery lever: restart the WEDGED side, not the fresh one

Once the signature is confirmed, the fix is a targeted restart of the side that has been
up longest since its own presence loop last wired (its OWN `shared_presence` self-rows
will be stamped only at that old wire time, not recently) — typically the tower
`bg-host`, since the VM sidecar is the one that usually gets bounced during normal work.
Restarting the already-fresh side again (another VM reboot) does nothing — proven: a
fresh VM re-dial could not reach the stale tower `bg-host` for 6+ minutes, while a tower
`bg-host` restart reconnected in \~2 minutes.

```
dev:restart { target: 'bg-host', confirm: true, authorize: true, reason: 'reload the background host with updated code' }
```

Coordinate this restart — it freezes the coordination rails for the duration of the
swarm rejoin (observed \~13 minutes in the ordinary case; see EI-13307 on the missing
coalescing/debounce for repeated `bg-host` restarts, which can chain these freezes back
to back if multiple agents restart it independently within that window). Announce a
fleet hold before firing it, same as any other `bg-host` restart.

## When the wedged side is a machine `dev:restart` cannot reach (the mac rig)

`dev:restart { target: 'bg-host' }` only reaches operators this host supervises. The **mac
rig** runs a standalone sidecar operator started by hand, so no tool restarts it — and
because it had **no boot script**, restarting it meant reconstructing \~30 environment
variables by hand from `ps -E`. That is not a footnote: it is *why* the mac sat severed from
**Mon Jul 27 to Aug 2** while the documented lever existed. The recovery step nobody could
perform is the one that never happens.

There is now a script for it, generated from the live process environment. Resolve the rig's
ssh target from the machine-local rig config rather than hardcoding it (the login differs per
machine), and let `~` expand on the remote side:

```bash
MAC_RIG="$(cat ~/.papercusp/mac-rig-ssh 2>/dev/null || echo '<rig-user>@<rig-host>')"
ssh "$MAC_RIG" 'bash ~/boot-headless-mac.sh'
```

Three traps are baked into that script because each one produced a **confidently wrong
verdict** the first time through. They generalize to any hand-rolled restart wrapper:

1. **The operator is a PAIR, and `pgrep -f` matches both.** An `--ensure` supervisor plus a
   child it forks (observed `46125` + `46242`). Killing only `pgrep … | head -1` orphans the
   child — and since the orphan's pid is *lower* than the newly launched one, the post-launch
   `pgrep … | head -1` latches onto the **orphan** and reports `LAUNCHED … STILL-ALIVE` while
   the real boot failed. Kill **all** matches, then hard-gate on the match set being empty;
   that gate is what makes the post-launch pid lookup sound *by construction*.
2. **`pgrep -f '<path>'` does not mean "the process running that path".** It matches any
   process whose argv merely *contains* the string — including the `perl` detach wrapper,
   whose argv carries the target path and which exits after \~1s. Watching that wrapper exit
   reports `DIED early` for an operator that came up perfectly healthy (observed: reported
   dead while `45523`/`45696` served `:3070` fine). Filter by interpreter, not by substring:
   `ps -o comm= -p "$p"` and keep only `*node*`.
3. **A live process is not a live service — and a live service is not a live link.** Make the
   success verdict the health endpoint (`:3070/api/health` → 200), never `kill -0`. Then note
   that health 200 still says **nothing** about the swarm link. Confirm the actual recovery by
   **data**: a fresh `harness_shared.shared_presence` row for that machine.

```sql
SELECT machine_label, count(*) AS rows,
       min(round(extract(epoch from (now() - last_seen_at)))) AS newest_age_sec
FROM harness_shared.shared_presence GROUP BY machine_label;
```

Rows for the recovered machine, re-stamping at a few tens of seconds, are the verdict.
(2026-08-02: `1 → 4` rows, three fresh `Avis-iMac` rows appearing beside Win; the logs agreed,
flipping from `peer_connected(signalling-only) relayed=true` via a public IP to
`peer_data_path_up … relayed=false`.) Note the column names — this table has
`machine_label`/`last_seen_at`, **no** `owner_id`.

> The through-line for all three: **never let a process-existence check stand in for a
> service-liveness check**, and treat a confident verdict from your own tooling as a
> hypothesis until independent state agrees. These failed in *opposite* directions — one
> false success, one false failure — from a single root cause, which is why fixing only the
> direction that bit you first leaves the bug live.

## Data is safe — this is an availability outage, not a data-loss one

While severed, remote agents are unaddressable and cross-machine coordination is fully
dark (presence gossip, peer-log federation, delivery receipts, claim specs) — but nothing
is lost. Backlog catch-up across the rejoin is lossless: a delivery receipt authored
during the severed window federated intact once the link reconnected. Treat this purely
as an availability problem to fix quickly, not as a data-recovery problem.

## What's still open

The underlying swarm rejoin/re-announce lifecycle bug — why the surviving side neither
re-announces nor re-dials after a peer drops — is tracked as **EI-13317** (root-cause fix
pending; suspected area: announce-refresh cadence vs. connection lifetime, and whether the
gossip channel and hypercore replication share reconnect logic, since the one transient
22:57 reconnect carried replication but zero gossip channels). The related restart-storm
issue (repeated `bg-host` restarts during a drill compounding the outage because
`dev:restart` doesn't coalesce `bg-host` targets the way it does `staging`) is tracked as
**EI-13307**. Until EI-13317 lands a durable fix, treat every persistent (>5 min) severed
link the same way: confirm the signature, then restart the wedged side.
