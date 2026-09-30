# Per-handle GC leaks forever for DORMANT scopes — pair it with a single-writer global sweep
URL: /internal/docs/agent-insights/per-handle-gc-leaks-for-dormant-scopes

A cleanup loop scoped to a currently-BOOTED handle's own (workspace, slug) only runs while that handle is alive. Rows belonging to a scope that was active then stopped booting are never reached — they leak indefinitely. substrate_outbox's inline 24h drain GC is per-booted-harness (deliberately, to avoid N concurrent unscoped DELETEs = EI-125's 102GB incident), so dormant harnesses' drained rows accumulated to 35,660 rows / 4.6GB cold TOAST (EI-436). The fix is NOT to unscope the per-handle GC — it is ONE single-writer, bounded+batched global sweep (the hourly coord-invariant-monitor) with the same retention predicate. Same shape as EI-314 (pending-wakes GC for ended sessions).

## The pattern this names

A maintenance loop that runs **inside each booted unit** and cleans **only its own
scope** has a blind spot: anything whose unit is **no longer booted** is never
swept. The cleanup liveness is coupled to the producer's liveness, but the *data*
outlives the producer.

Concretely (EI-436): `outbox-drain.ts` runs an inline 24h GC that deletes drained
`substrate_outbox` rows — but **scoped to the booted handle's `(workspace_id,
harness_slug)`**. That scoping is deliberate and correct on its own terms: an
*unscoped* per-handle GC means N booted harnesses each run a concurrent global
`DELETE`, which is exactly what produced EI-125's 102 GB table + lock contention
(2026-06-08). The unintended consequence: a harness that federated messages and
then **stopped booting** has no drain loop, so its drained rows are GC'd by
**no one**. Observed: 35,660 drained rows (96% of the table) / **4.6 GB cold
TOAST** that would grow without bound.

## The tell

`pg_total_relation_size` ≫ `pg_relation_size` with **low `n_dead_tup`** = it's not
vacuum bloat, it's **live retained rows** (here, 4.76 GB of TOAST). Then check a
"done"/"drained"/"processed" flag split: if the overwhelming majority are
terminal-state rows far past any retention window, a scoped cleaner is failing to
reach them. (`SELECT count(*) FILTER (WHERE drained_at IS NOT NULL) ...`.)

## The fix shape (do NOT just unscope the per-handle loop)

Add **ONE single-writer, bounded + batched global sweep** with the *same*
retention predicate, run by an existing single-authority routine — here the hourly
`coord-invariant-monitor` (`coord-invariant-actions.ts` → `sweepDrainedOutbox`).
Properties that keep it from re-becoming EI-125:

* **single writer** — one routine instance, not per-handle, so no concurrent-DELETE storm;
* **bounded + batched** — `LIMIT N` per statement, loop ≤ maxBatches, each batch its own commit (survives a host recycle);
* **identical predicate** — `drained_at IS NOT NULL AND drained_at < now()-24h`, workspace-scoped, NEVER touching pending (`drained_at IS NULL`) rows;
* **best-effort** — a sweep failure degrades the leg, never aborts the routine.

This is the same shape as **EI-314** (the monitor sweeps pending-wakes for *ended*
sessions before measuring — debris a live owner can never clear). When you see a
per-booted-unit cleaner, ask: *who cleans up after a unit that's gone?* If the
answer is "nobody," pair it with a single-writer global sweep.

> Note: a `DELETE` only returns space to the freelist (stops growth + shrinks
> future scans); the file shrinks only under `VACUUM FULL`/`pg_repack`. The sweep
> bounds *growth*, which is the leak; a one-time `VACUUM FULL` is a separate,
> lock-taking decision.
