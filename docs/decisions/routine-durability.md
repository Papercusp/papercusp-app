# Routine substrate durability — decision note

**Date:** 2026-05-01
**Context:** Step 0 of [multi-harness-spawning](../../apps/operator/content/docs/implementation/multi-harness-spawning.mdx).

## Question

Does the routine ticker survive operator process restart?

## Answer

**Effectively yes.** The schedule state lives in Postgres (`routines` table with `next_fire_at`). The in-process ticker (`startRoutineTicker` in `libs/papercusp/libs/db/src/routine-ticker.ts`) just polls `listDueCronRoutines(sql)` every 30s and fires due routines.

When the operator restarts:
- In-flight ticker dies (no in-memory state lost since `next_fire_at` is in PG)
- New operator boot starts a new ticker
- Ticker queries PG, sees what's due, fires anything that should have fired during the downtime

So routines can lose **at most one tick interval** of timing precision (default 30s), not the schedule itself.

## Implication for v2 autoLoop

Routine plugin path is viable for v2 autonomy. Author a `@papercupai/autoloop` plugin that registers a cron routine per harness's `director-config.json:autoIntervalSeconds`. The plugin's handler POSTs `/api/harness/<slug>/invoke?role=director`.

Operator restart durability is acceptable: at-most-one-tick timing slop, schedule preserved.

## Fallback (not needed)

If we needed stronger durability (e.g. operator down for hours, ticks must fire on time), the alternative would be a sidecar daemon process or systemd timer. Not necessary for v1/v2 use cases — operator is expected to be up while users are using it.
