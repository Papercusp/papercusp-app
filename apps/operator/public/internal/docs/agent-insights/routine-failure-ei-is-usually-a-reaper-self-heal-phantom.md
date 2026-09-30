# A \"routine is failing\" EI is usually a reaper self-heal phantom
URL: /internal/docs/agent-insights/routine-failure-ei-is-usually-a-reaper-self-heal-phantom

Triage runbook: a routine-failure watchdog EI whose last_error_source is dbos-executor-reaper is a self-heal breadcrumb, not a genuine failure — check source + active before treating it as real.

The self-improvement watchdog files a `bug` EI titled **"Background routine `\<name>` is failing"**
whenever a routine carries a non-empty `metadata.last_error` (`collectRoutineFailureSignals`,
`watchdog.ts`). Most of these are **phantoms**, and multiple auto-implement workers have each
independently re-diagnosed the same class (EI-5950, EI-6061, EI-6081, EI-6083, … 25+). Read this
before touching one.

## The trap

`dbos-executor-reaper.ts` recovers a stuck `routineFire` and, as a **self-heal breadcrumb**,
stamps the routine with:

```
metadata.last_error        = "DBOS routineFire produced no DBOS operation output;
                              executor reaper cancelled the stuck fire and requeued the routine"
metadata.last_error_source = "dbos-executor-reaper"
```

This marker means *"I recovered this routine"* — **NOT** that the routine failed. The
`collectRoutineFailureSignals` collector is now **source-aware** (`routineFailureSignalsFromRows`,
`watchdog.ts`): for a `dbos-executor-reaper`-tagged error it **suppresses** the signal when recovery
is proven — the routine is a loop (a real wedge is caught by the separate loop-stalled collector),
OR its `next_fire_at` is a concrete FUTURE timestamp, OR it fired within the last 30 min
(`last_fired_at` newer than `RECENT_FIRE_PROOF_MS`, WI-3098 — added because `next_fire_at` alone
raced the collection instant, firing EI-7771 as a false positive for `cross-pot-outbox-drain`). So
most self-heal markers no longer mint an EI. What still **leaks through** (and mints one) is an
**active**, non-loop, reaper-marked routine with NEITHER a future `next_fire_at` NOR a recent
`last_fired_at` — a low-cadence routine that hasn't re-fired since the requeue still reads as failing.
`clearStaleReaperLastError` only wipes the marker on the routine's **next successful fire**, so a
low-cadence routine carries it (and the phantom) between fires. (Note the collector query filters
`WHERE active = true`, so a fully **deactivated** routine is never selected and can't re-file at
all — see the `active = false` triage row below.)

## Triage in one query

```sql
select active, metadata->>'last_error_source' as src, last_fired_at,
       metadata->>'last_error_at' as err_at
  from harness_shared.routines where name = '<routine-name>';
```

It is a **phantom** (resolve `fixed`, evidence-it's-gone) when any of:

* `src = 'dbos-executor-reaper'` (a self-heal marker, not an action failure), **and**
* `active = false` — `collectRoutineFailureSignals` filters `WHERE active = true`, so an inactive
  routine can never re-file; the EI is structurally dead, **or**
* `last_fired_at > last_error_at` — the routine already fired successfully after the marker.

`loop-su-*` routines are per-session self-wake loops (`loop:arm`); when the session ends the loop
goes `active=false, next_fire_at=infinity` — a normal lifecycle, not a wedge.

## When it is NOT a phantom

* `last_error_source` is absent (git-sync `recordOutcome`) or `'runner'` (a system action that
  **threw**) → a genuine failure; treat it as real.
* `metadata.reaped_count` is high (≥3 consecutive reaps, never self-heals) → a genuinely wedged
  routine the reaper keeps cancelling; the `git-sync-stall-watchdog` alarms on this on purpose.

  **Caveat (2026-07-09, WI-3519):** before the fast-orphan guard fix in
  `reapDeadExecutorWorkflows`, a **healthy, busy** `routines-critical` queue could
  drive `reaped_count` to triple digits (`oddsmith` 114, `quartermaster` 100) with
  nothing actually wedged — `dbos.workflow_queue` holds zero rows in this DBOS
  version, so the old fast-orphan `NOT EXISTS (... workflow_queue ...)` check was
  vacuous and reaped every OTHER fire waiting behind two slow-but-progressing
  ones. The reaper now also requires the **queue itself** to look dead (no
  sibling `PENDING`/recently-terminal workflow on the same `queue_name`) before
  it fast-orphan-reaps, so a high `reaped_count` should be reliable again going
  forward — but a spike recorded **before** this fix landed is not evidence of a
  genuine wedge on its own; cross-check whether the queue had other fires
  actively progressing at the time (see
  [the deploy-pipeline dead-executor-dedup doc](/internal/docs/agent-insights/deploy-pipeline-silent-stall-dead-executor-dedup)).

## The durable class fix is a STOP surface

The collector is now **partially source-aware** (EI-6172 / WI-3098): reaper self-heal markers are
suppressed when recovery is proven (loop, future `next_fire_at`, or `last_fired_at` within 30 min —
see above), which auto-filters most phantoms. The residual hardening — suppressing even a
stale-marked low-cadence routine that hasn't re-fired yet (e.g. keying on `reaped_count >= N` rather
than only re-fire recency) — still lives in `watchdog.ts` / `dbos-executor-reaper.ts`, both
auto-implement **protected surfaces**. Route any such change to a human (tracked via EI-6061); resolve
the individual residual phantom instances `fixed` with the query evidence above.
