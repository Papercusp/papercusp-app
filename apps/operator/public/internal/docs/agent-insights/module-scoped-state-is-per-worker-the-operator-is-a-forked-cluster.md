# A module-scoped Map is not shared state — the operator is a forked cluster
URL: /internal/docs/agent-insights/module-scoped-state-is-per-worker-the-operator-is-a-forked-cluster

Two HTTP requests that must hand something to each other cannot use a module-scoped Map: the :3070 operator forks N request workers (16 on this box) with N separate heaps, so the reader lands on the writer's worker about 1 time in N. It survives code review AND its own green unit suite, because a unit test has exactly one heap — and it presents as 'works sometimes', which is the worst failure shape there is. Includes the discrimination test (same request or not), why ~415 other module-scoped Maps in operator-core are NOT bugs (a cache miss recomputes; a handshake miss silently changes behavior), and the DELETE … RETURNING fix shape.

## The one-line version

**A module-scoped `Map` is per-WORKER state, not per-SERVICE state.** If the code that writes it
and the code that reads it run in two different HTTP requests, the read misses roughly
`(N-1)/N` of the time — on this box, **15 times out of 16**.

Not "a race". Not "a cache invalidation problem". The two halves of the handshake simply never
share a heap.

## What it looked like (WI-6756, leg 2)

`carry-respawn-marker.ts` exists to stop one specific data loss: when an agent self-compacts,
`session:request-compaction` relaunches its CLI on a carry document. The dying child fires the
ordinary SessionEnd lifecycle hook, which POSTs `activity:report`, which unconditionally
releases every work-item lease the owner holds. Same owner, back in seconds — not a death. So
request-compaction *marks* "a respawn is expected for this owner", and the SessionEnd path
*consumes* the mark and skips the release.

Both halves are HTTP requests to `:3070`. The marker was a module-scoped `Map`. Its own header
justified that choice explicitly:

> both execute in-process on the SAME operator

True of the **service**. False of the **process**. The mark landed in worker A's heap; the
SessionEnd POST was accepted by worker B, which saw nothing and released everything.

The damage was quiet in the worst way: `releaseAllWorkItemLeasesForOwner` stamps
`last_released_by` with **the owner itself**, so downstream the loss reads as a deliberate,
voluntary release by the agent. A live agent keeps working items a peer is now free to claim.

## The second confirmed instance — and why it matters to *you*, today

`capability:bash`'s job registry is a module-scoped `Map` (`bash-jobs.ts:99`). You start a
background job with one call and read it with a *different* call, so `capability:bash_output`
can land on a worker that has never heard of your `bash_id`.

The trap is not the miss — it is the **explanation you get back**. The tool decides between
`stranded_by_operator_restart` and `job_process_gone` by comparing **operator uptime to the log's
age**, a test that cannot tell a cross-worker miss from a restart. So on a 16-worker host it will
tell you, confidently, that some other agent restarted the operator — for a job that is running
fine on a sibling worker. The file's own comment names only the restart cause, which is how the
cluster half stayed invisible.

**What to do about it right now:** treat that verdict as a *hypothesis*, and settle it against the
OS, which has no worker-affinity problem:

```bash
ps -eo args | grep -F '<a literal fragment of your command>'   # grep -F, exact
```

A hit means the job is alive and the verdict was wrong. No hit means it really is gone. The log
tail you get back is trustworthy either way — it comes from a deterministic on-disk path, not from
the `Map` — and P-008's durable `taskId` + cgroup scope are the other half of the rescue. It is the
*verdict* that is unsound, not the whole tool.

## Why it survived review *and* a green unit suite

Two independent reasons, and both are general:

1. **A unit test has exactly one heap.** The test file imports the module once; mark-then-consume
   is trivially co-located. There is no test you can write in-process that fails. The suite was
   green and *correct* — it was measuring a topology that does not exist in production.
2. **The default is single-process.** `PAPERCUSP_CLUSTER_WORKERS` is default-OFF (`1` ⇒ one
   process, see `cluster-fork.ts`). A developer running the operator locally never reproduces it.

And because it works `1/N` of the time, the symptom is *intermittent*, so it gets triaged as
flakiness rather than as a defect with a mechanism.

## The discrimination test

One question, and it is not about `Map` at all:

> **Is the WRITER in the same HTTP request as the READER?**

* **Same request** (or same tick, same call stack) → module scope is fine.
* **Different requests** → module scope is wrong, however short the TTL.

"Different requests" includes every case where an *external* process is the one that comes back:
a CLI child's lifecycle hook, a wake delivered by `papercup-bg-host`, a webhook, a retry.

## Why \~415 other module-scoped Maps are not 415 bugs

`operator-core/lib` has \~415 module-scoped `Map`/`Set` declarations. Most are fine, and it matters
to say *why*, or this insight turns into a witch-hunt:

| shape                                                                     | miss behavior                          | verdict                                         |
| ------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------- |
| **cache** (`hivePolicyCache`, `tenantScopeCache`, …)                      | recompute                              | fine — correct, just slower                     |
| **registry populated at import** (`CELLS`, `REGISTRY`, `DIRECT_ELIGIBLE`) | n/a — every worker builds the same one | fine                                            |
| **event-handler `Set`** (`coord-inbox-bus`, `agent-activity-bus`)         | n/a — intra-process by construction    | fine                                            |
| **dedup / in-flight guard** (`sweepInFlight`, `seedInFlight`)             | duplicate work                         | **degraded** — usually tolerable, worth knowing |
| **cross-request handshake** (`carry-respawn-marker`)                      | silently different behavior            | **broken**                                      |

The dangerous shape is narrow and nameable: **state whose ABSENCE is read as a decision.** A cache
miss recomputes the same answer; a handshake miss takes the *other* branch and nothing errors.

## The fix shape

A short-TTL Postgres table, with **atomic check-and-clear**:

* `INSERT … ON CONFLICT DO UPDATE` to mark (and to refresh an existing mark).
* **`DELETE … RETURNING` to consume** — this is the load-bearing part. It makes the mark
  single-use *across all workers*: two workers racing the same mark cannot both win, because
  only one `DELETE` returns a row.
* Judge expiry on the **returned** row, so an expired mark is still cleaned up rather than left
  to accumulate.
* Swallow store errors **toward today's behavior** (a failed consume ⇒ the ordinary path runs; a
  failed mark never throws). A durable marker must not be able to strand what the in-memory one
  merely failed to protect.

This is what the repo storage policy already tells you — *"no module-scoped TTL `Map`s"*. This
page is the reason it says so.

## Check the topology yourself

```bash
pgrep -P "$(systemctl --user show -p MainPID --value papercup-dev-api.service)" | wc -l
```

16 on this box. The **primary serves no HTTP** — it runs the background machinery
(substrate/DBOS/git-sync); each worker binds its own `SO_REUSEPORT` socket so the *kernel*
spreads accepts across them (`hono-host.ts`, P3-2). There is **no client affinity**: two
consecutive requests from the same client land on whichever workers the kernel picks.

## The tell in the log

```
[activity:report] session-end lease release for su-…: released 3 item(s) [WI-…]      ← the bug
[activity:report] session-end lease release SKIPPED for su-…: a carry-respawn is expected  ← fixed
```

If you are debugging anything that "works about one time in sixteen", check for a module-scoped
`Map` before you look for a race.

## Related

* The sibling leg of the same bug — a **cold-loop reset wake** (`psu-socket-reset` /
  `psu-socket-recycle`) is also a same-owner continuation, but it is injected by
  `papercup-bg-host` which never marks at all, so it needs a *different* signal
  (`session-reset-continuation.ts`, which reads `harness_shared.event_wake_deliveries`). Two
  legs, two signals — neither one covers the other.
* `agent-state-stamp-cluster.ts` — an earlier case where cross-worker state had to be solved
  explicitly.
* **WI-6818** — the class sweep: the "did it happen anywhere else" pass over
  `packages/operator-core/lib/**`, with the triage rules and the known candidates. Two instances are
  confirmed so far (`carry-respawn-marker`, fixed; `bash-jobs`, outstanding); the rest is unswept.
