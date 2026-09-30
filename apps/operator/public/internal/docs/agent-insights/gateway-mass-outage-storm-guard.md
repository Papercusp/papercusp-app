# A correlated gateway outage silently starved the auto-ESC un-wedge past ~10 owners
URL: /internal/docs/agent-insights/gateway-mass-outage-storm-guard

Why interactive sessions stuck on "API error · Retrying … attempt N/10" sometimes never got the auto-ESC un-wedge — two compounding bugs in stall-waker's force-ESC path, not a missing feature.

## Symptom

An interactive `psu`-hosted CLI session (an `su-*` fleet terminal) gets a
gateway/API error and shows Claude Code's own `* API error · Retrying in 0s ·
attempt 1/10` banner. Any message typed while it's in that state sits as a
Claude-Code-native **queued message** ("Press up to edit queued messages") and
never submits. The session never recovers on its own and needs a human to
press Esc.

There **is** an automated fix for this — the inference-gateway `stall-waker`
loop (`gateway-rate-limit-stall-autowake` P-003) force-ESCs ("un-wedges") a
confirmed-idle owner whose turn died on a gateway error, independent of the
capacity-gated wake. But during a correlated gateway-error burst (many owners
stall within the same \~60s window — exactly the "inference gateway has an
error" scenario), the un-wedge silently failed for owners past the \~10th, with
**no warning logged and no faster retry** — it looked, from the inside, like
it had succeeded.

## Root cause (two compounding bugs, not one)

### Bug 1 — the storm guard is keyed by actor only, not actor+target

`turn:interrupt`'s force-mode storm guard (D-009) exists to stop **one
confused/looping agent from hammering one target**: `STORM_MAX = 10` force
interrupts per rolling 60s, counted via
`SELECT count(*) FROM harness_shared.audit_log WHERE actor = $1 AND action IN
(...) AND ts > $2` — i.e. **per actor, across ALL targets**.

`stall-waker` is a single, code-reviewed, fleet-wide recovery **loop**, and
every un-wedge it issues goes through `forceEndTurn({ actor: 'stall-waker',
... })` — the same fixed actor string for every owner it touches. So when a
gateway error correlates across the fleet (many distinct owners stall in the
same tick/window — precisely the scenario this loop exists to recover from),
`stall-waker` legitimately needs to force-ESC more than 10 *different* owners
within 60s. The 11th+ owner's `performInterrupt` call returned
`{ok:false, error:'rate_limited'}` and was refused outright.

Confirmed live via the audit log:

```sql
select action, count(*), count(distinct subject)
from harness_shared.audit_log
where actor = 'stall-waker' and ts > ...
group by action;
-- turn.interrupt_force         318 rows / 25 distinct subjects  (delivered)
-- turn.interrupt_rate_limited    9 rows /  5 distinct subjects  (refused, "recent":10)
```

**Fix**: `interrupt.ts` now computes the storm ceiling per actor
(`stormMaxFor`) — a small allowlist of trusted system-recovery actors
(currently just `'stall-waker'`) gets a much higher ceiling
(`STORM_MAX_SYSTEM_ACTOR`, default 200, env `PAPERCUSP_INTERRUPT_STORM_MAX_SYSTEM`).
An ordinary agent-invoked `turn:interrupt` call is unaffected — still capped
at 10 (still catches a genuinely confused/looping single agent).

### Bug 2 — the refusal (and any other failure) was silently swallowed

This is what made bug 1 invisible and unretried. `performInterrupt` **never
throws** — a refusal, a missing live session, anything — comes back as a
normal `{ok:false, error, reason}` return value ("every failure is a
structured result", by design, per the file's own doc comment).

But `StallWakerDeps.unwedge` was typed `Promise<void>`, and the real
implementation in `stall-waker-loop.ts` was:

```ts
unwedge: async (ownerId) => {
  await forceEndTurn({ actor: 'stall-waker', ... });   // return value discarded
},
```

`StallWaker.tick()` awaited it inside a `try { ... } catch`, and since
`forceEndTurn` never throws, the `try` block **always** "succeeded" — it
logged `stall-waker: fast-ESC un-wedged <owner> ... reachable again` and
armed the per-owner `unwedgeCooldownMs` (45s) **even when nothing was
delivered**. There was no code path that could ever observe or react to a
refused/failed ESC. The owner just sat wedged, silently re-attempted every
cooldown window with the same odds of hitting the (already-too-low) storm cap
again, and no operator-visible signal ever fired.

**Fix**: `unwedge` now returns `Promise<boolean>` — the real implementation
returns `result.ok` (and `console.warn`s the reason on failure);
`StallWaker.tick()` only reports success (`unwedged.push`, the info log) when
`true`, and logs a `warn` ("did NOT land ... owner stays wedged") on `false`.
The attempt cadence (`unwedgeCooldownMs`) is preserved either way — this
fixes *observability and correctness of the reported outcome*, not retry
timing (that's a reasonable follow-up if failures are still observed after
bug 1's fix, but bug 1 should make failures rare).

## Why this matters beyond this one incident

The general trap: **a shared system-service actor identity funnels through a
per-actor rate limiter that was sized for a single misbehaving agent.** Any
future fleet-wide recovery loop that calls `turn:interrupt`/`forceEndTurn`
under one fixed actor name will hit the exact same wall the moment it needs to
act on more than `STORM_MAX` distinct targets inside one window — check
`stormMaxFor`'s allowlist before assuming a new system loop is exempt.

The second trap generalizes too: **`performInterrupt`/`forceEndTurn`
deliberately never throw** (by design, so ordinary callers get a structured
result instead of a rejected promise) — any new caller that only `await`s the
call without reading `.ok` will silently treat every refusal/failure as
success. grep for `forceEndTurn(` before adding a new caller and make sure the
result is actually checked.

## Verify

`packages/operator-core/lib/agent-tools/turn/interrupt.test.ts` — storm-guard
tests (ordinary actor still capped at 10; `stall-waker` exempt at 10 but still
capped at its own higher ceiling).
`packages/operator-core/lib/inference-gateway/stall-waker.test.ts` — the new
regression test asserts `unwedge()` resolving `false` does NOT appear in
`tick().unwedged` and logs a `warn`, not silently swallowed.
