# Limits
URL: /internal/docs/agent-spawning/limits

What the spawn primitive does not do (yet) — the honest list of its edges, with workarounds where they exist.

These are the rough edges. Each one is real, each one has a reason, and each one has a path forward when a use case demands it. Until then they're documented so you can plan around them. (Two former limits — subtree cancel and an over-ceiling queue — are now built; they're noted below as resolved.)

## Cancel can't kill the OS process across restarts

`fleet:cancel` against a spawn this host launched fires the held `AbortController` immediately and the runner tears down the child's process group (SIGTERM → SIGKILL after 2s). Against a spawn that lives only in PG (the operator that launched it has since restarted), there is no live `AbortController` — the durable subtree flip to `cancelled` still happens and its claims/locks release, but the orphaned OS process keeps running until it exits on its own.

**Mitigation:** the heartbeat/reclaim sweep is the durability backstop — a dead host stops heartbeating, so its `running`/`restarting` rows go stale past `RECLAIM_STALE_MS` (5 min) and are reclaimed to `failed`, freeing the concurrency ceiling. It doesn't *kill* a still-running orphan process, but it stops one from wedging the ceiling forever.

An in-process **wedge-reaper** *does* kill local spawns: a spawn this host supervises that is alive but stream-silent past `WEDGE_REAP_SILENT_MS` (default 30 min, flag-gated on `WEDGE_AUTO_REAP`) gets the durable cancel + a local SIGTERM → SIGKILL on each heartbeat tick (D-006). What is unbuilt is specifically the kill of an orphan whose launching host restarted or died — there's no live handle to abort, so the heartbeat reclaim only marks it `failed`, it doesn't kill it. A pid-tracking SIGTERM watcher *for that survived-restart case* remains unbuilt and is no longer the planned path.

## Over-ceiling spawn queues on an await key, not a FIFO

The fleet concurrency ceiling is `maxSimultaneousAgents` (live-editable via `operator:rate_limit_config`, clamped ≤ `RATE_LIMIT_MAX_CEILING` = 64) — not a hardcoded `MAX_CONCURRENT=10`. The **default** is not a flat 16: it is seeded from the host's resource profile — `round(cores × (embeddedPg ? 0.25 : 0.5))`, then clamped down by free RAM (\~0.5 GiB headroom per agent) and halved on battery, finally clamped into `[1, 16]`. So 16 is only the *upper* edge of the derived default (a large native-PG host); a typical laptop/desktop sharing an embedded PG seeds far lower (a 4-core embedded-PG box derives \~1). `RATE_LIMIT_MAX_CEILING` (64) is the separate absolute ceiling the user can set the live config *up to* — not the same as the derived default's `[1, 16]` clamp. When the live `running`/`restarting` count is at the ceiling, `cup:spawn` returns `ok:false` with an `await_event` key (`spawn-slot:freed:<workspace>`) instead of dropping or busy-waiting (D-004).

The effective admission cap can be **lower** than `maxSimultaneousAgents`: the owner's per-pot `maxBees` steering knob (`owner-steering.ts`, key `owner-steering:max-bees` — surfaced in the Mug steering panel) clamps it down to `min(maxSimultaneousAgents, owner maxBees)`. The owner can only *lower* the ceiling, never raise it past the system cap, and the lowered value is what is hard-enforced at admission — spawns past it queue on the same `await_event` key.

**Pattern:** the caller does `events:await { event: await_event }`, ends its turn, and retries the **same** spawn when woken — every slot-free (a completion or a reclaim) broadcasts the wake. It is a broadcast-and-recheck, not a granted-ticket FIFO: woken waiters re-check the ceiling on retry, with the await pump's per-tick resume cap pacing a mass wake. True ordered fairness would need a real queue.

## Subtree cancel — now built in

`fleet:cancel { spawn_id }` is **transitive**: it flips the named node AND every descendant in the durable subtree to `cancelled` in one transaction and releases each one's claims + locks immediately. A node's grandchildren are cancelled, not just its immediate child.

The one residual edge: only descendants this host launched are SIGTERMed in-process; descendants on another operator process get the durable flip + claim/lock release, and the heartbeat sweep reclaims their OS processes. `fleet:tree` shows the subtree before you cancel.

## The concurrency ceiling is durable (PG), shared across processes

The ceiling count is a live `SELECT count(*) … WHERE status IN ('running','restarting')` against `spawned_agents`, not a per-process in-memory counter. Two operator processes serving the same workspace draw from the **same** PG ledger, so the ceiling holds cluster-wide rather than multiplying per process. There is no separate depth or children-per-parent admission cap — the single concurrency ceiling is the only hard backstop (`MAX_TREE_DEPTH=32` in the recursive walks is a cycle guard, not an admission cap). The number that admission actually enforces is `min(maxSimultaneousAgents, owner maxBees)` — the owner's `maxBees` knob can only throttle the fleet *below* the system cap, and that lower value is the durable, hard-enforced ceiling.

**Note:** the count costs a PG roundtrip per spawn — accepted as the price of a correct, restart-durable, multi-process ceiling.

## `output_tail` is truncated to \~2 KB

When a spawn finishes, the last \~2 KB of output (and, on failure, \~2 KB of stderr) is captured into `spawned_agents.output_tail` / `error_message` (`.slice(-2000)`) for postmortem inspection. Anything beyond that is dropped at write time — full output lives wherever the agent itself logged it.

**Workaround:** for full output, read the operator's per-spawn log. The Intel panel's Spawns tab links to it.

## Reclaim is lazy + periodic, so an orphan row can briefly show "running"

Orphaned active rows are reclaimed opportunistically (on the next spawn through `operator-spawn.ts` — *any* launch path, before its ceiling check) and by a periodic sweep — not the instant a host dies. Between a host's death and the next reclaim, its rows still read `running`/`restarting`, and only after `RECLAIM_STALE_MS` (5 min) of stale heartbeat do they qualify for reclaim at all.

**Workaround:** none needed — the 5-minute staleness window deliberately tolerates a briefly-paused live host (GC, restart-in-progress) so a real spawn isn't reclaimed out from under itself. Reclaim is not purely time-based, either: once a heartbeat is stale past `RECLAIM_STALE_MS`, a same-host candidate is `/proc`-liveness-checked — a still-alive child is kept, its heartbeat re-bumped, **not** reclaimed (EI-85). Only a confirmed-dead child or a row on a host we can't reach is reclaimed to `failed`. So the 5-minute window is the floor; the pid probe is the actual guard against reclaiming a live-but-paused spawn. The Intel panel auto-polls, so a reclaimed row updates within a poll cycle.

The pid-liveness check itself has **two strictness levels** (P-033, `isSpawnProcessAlive(pid, kind)`), keyed on the row's `run_id` class: an ordinary `invoke-once` bee/cup child (`kind:'spawn'`, the default — the case above) requires its `/proc/<pid>/cmdline` to still **name** `invoke-once` (hardened against pid reuse); a `launch-%` row — an IN-PROCESS loopback launch (a `kind:'hive'` Queen/Mug wake or an overwatch loop, which is not a separate spawned child at all, just the long-lived operator/launcher process holding the connection) — uses `kind:'launch'`, a plain any-live-process `/proc` existence check, because that row's liveness genuinely IS "the firing process still exists". Get the kind wrong and you either falsely reclaim a live Queen (too strict) or falsely keep a dead one (too loose) — the sweep picks it from `run_id`, not from the caller.

## Post-restart spawns are read-only history

After restart, `fleet:tree` returns the durable rows (status, exit code, duration, output\_tail) but the spawn itself is gone. You cannot resume it, re-attach to its stream (no controller), or recover output beyond what was tail-captured.

**Workaround:** treat post-restart spawns as immutable history. Launch a fresh spawn if you need new work done.

**Partial mitigation (EI-85, `shouldRelaunchReclaimedSpawn`):** the boot reconcile can now RE-LAUNCH — not resume, a genuinely NEW spawn — a reclaimed row whose role is `mug` (the per-workspace hive driver: re-launches unconditionally, re-firing its hive blueprint) or `cup` (a worker: re-launches iff it carried a work-item that is still non-terminal at reclaim time; a work-item-less or already-terminal cup is reclaimed with nothing to resume, same as before). Every other role still just reclaims to `failed`. This closes the gap between "the host restarted, the Queen died" and "the next routine cadence tick notices" — it does not change the read-only-history fact above (the OLD spawn row/stream/output is still gone forever); it just means a NEW spawn may pick the dropped thread back up automatically, sooner than the ordinary re-placement cadence would.

## Status of each edge

| Edge                                              | Status                                                                                                                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Subtree cancel                                    | ✅ Done — `fleet:cancel` is transitive over the durable subtree                                                                                                                       |
| Cluster-wide caps                                 | ✅ Done — the ceiling is a live PG count, shared across operator processes                                                                                                            |
| Over-ceiling queue                                | ✅ Built as queue+await (`await_event`); a granted-ticket FIFO is the only remaining want                                                                                             |
| Cross-restart cancel (kill the orphan OS process) | ⚠️ Local wedged spawns are auto-killed by the wedge-reaper (`WEDGE_AUTO_REAP`); a survived-restart orphan is only reclaimed to `failed` by heartbeat (frees the ceiling), not killed |
| Post-restart continuity                           | ⚠️ Partially built (EI-85) — a reclaimed `mug`/`cup` row with unfinished work auto-RE-LAUNCHES (a new spawn); the old spawn's row/stream/output is still gone forever (unchanged)    |
| Larger output                                     | Open — stream to a scratch file, store path in `output_ref` instead of the \~2 KB `output_tail` (\~0.5 day)                                                                          |

The spawn primitive is the resting state until a real workflow demands one of the open items.
