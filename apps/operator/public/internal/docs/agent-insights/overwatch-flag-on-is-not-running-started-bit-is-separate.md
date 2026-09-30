# Overwatch (and Mug/pot) flag ON ≠ running — the 'started' control-bit is a separate, persisted switch
URL: /internal/docs/agent-insights/overwatch-flag-on-is-not-running-started-bit-is-separate

Owner flips the papercusp-overwatch flag ON, but overwatch never runs: the routine fires yet produces zero runs. The flag is only the GATE; overwatch:start sets a SEPARATE persisted control-bit (operator_settings KV) that the launch handler also requires. Flag-on without start = gated-open-but-not-armed = a silent no-op. How to spot it, why dev:sessions hides it, and the durable fix.

## Symptom

The `papercusp-overwatch` flag is **ON**, an `overwatch-wake` routine is **active with a next
fire** — yet overwatch never runs. `coord:presence` shows no overwatch agent, `dev:sessions` shows
**zero** overwatch sessions, and the routine's `lastFired` may even be advancing. Everything looks
enabled; nothing happens. (Same shape for the Mug / `hive_started`.)

## The gotcha: a flag and a "started" bit are TWO independent off-switches

Overwatch has **two** gates, and *both* must be satisfied to run:

1. **The flag** `papercusp-overwatch` — the *gate* (checked in `handleOverwatchLaunch` and at the
   spawn chokepoint). Flip it at `/admin/features`.
2. **The persisted `overwatch_started` bit** — the *arm*, set **only** by `overwatch:start`
   (cleared by `overwatch:pause`). Stored in `harness_shared.operator_settings` KV, key
   `overwatch_started:<workspaceId>:<installSlug>` → `'true'|'false'` (`control-state.ts`).

`handleOverwatchLaunch` (`overwatch/loop.ts`) self-gates on **both**:

```ts
if (!(await overwatchEnabled())) return;                        // flag off → skip
if (!(await getOverwatchStarted(workspaceId, installSlug)))     // not started → skip
  return;   // logs "launch skipped — overwatch not started"
```

So **flipping the flag ON does not start overwatch.** If `overwatch_started` was never set (or was
paused, or was orphaned when the workspace got re-keyed), the wake fires, the handler runs, and it
**skips** — a silent no-op. This is the dark-flag shape: enabled on paper, doing nothing.

> The two are decoupled *by design* (`start.ts`: while the flag is OFF, start still persists the
> bit "pre-armed" for the eventual flip). The trap is that there's **no warning** for the inverse —
> flag ON + bit false — so it fails silently.

## Why `dev:sessions` hides it (the red herring that wastes an hour)

When overwatch *does* launch, it goes through the **loopback invoke route**
(`defaultOverwatchFire` → `POST /api/harness/<slug>/invoke?role=overwatch&bpkind=overwatch`), which
records a **tracked invoke session** — **not** a durable-spawn. `dev:sessions` lists spawn/cup
sessions, so a *running* overwatch shows **0 sessions** there. Don't conclude "not running" from
`dev:sessions` for overwatch (or any invoke-route role).

## How to diagnose (the authoritative signals)

* **Is it started?** Read the bit directly:
  `dev:pg_query "SELECT value FROM harness_shared.operator_settings WHERE key='overwatch_started:<ws>:<slug>'"`.
  Absent or `'false'` ⇒ not armed ⇒ every wake skips.
* **Is the launch firing/succeeding?** The real signal is `recordFire`'s row, **not** `dev:sessions`:
  `dev:pg_query "SELECT role,last_status,consecutive_errors,last_fired_at FROM harness_shared.autoloop_state WHERE role='overwatch'"`.
  `last_status='ok'` ⇒ the invoke POST succeeded (overwatch launched). A climbing `consecutive_errors`
  ⇒ the POST is erroring (a real downstream bug). No row / stale ⇒ never fired or always-skipped.
* **Is a wake armed?** `routines:list` → the active `overwatch-wake` row's `nextFireAt`. Watch for
  **duplicate** active rows (stale registrations from prior days) — prune all but the live one.

## The fix

* **Immediate:** run **`overwatch:start`**. It sets `overwatch_started='true'` (PERSISTED — it
  survives restarts; the B-09 liveness watchdog re-arms the wake purely from this bit on every boot),
  sets the cadence, and fires a wake now. Confirm with the `autoloop_state` query above (`last_status`
  flips to `ok`). This is durable — you do **not** need a boot-reconcile to re-assert it.
* **Durable (design choice, prevents the silent trap):** either **(a)** auto-start on the flag's
  OFF→ON edge (flipping the flag expresses intent to run; a later `overwatch:pause` still sticks
  because boot does not re-start — and `overwatch_started` is tri-state: KEY-ABSENT = never-started
  vs `'false'` = deliberately-paused, so auto-start can fire only for the never-started case), and/or
  **(b)** a system-health warning "overwatch flag ON but not started" surfaced at `/admin/features`.

## The lesson (generalizable)

**A feature gated by BOTH a flag and a separate "started"/"armed" control-bit has two independent
off-switches; "enabled" means the AND of them — and the AND is invisible unless you surface it.**
When you add a second gate (a control-bit beside a flag), also add the cross-check: a flag ON with
its arm OFF should *warn*, never *silently no-op*. Otherwise you get the dark-flag trap one level
deeper — the flag audit says "ON ✅", and the thing still does nothing. See also
`overwatch-role-2026-06-15` and the flags discipline in `CLAUDE.md` (a feature that's "enabled" but
does nothing is dead code, however green the flag).
