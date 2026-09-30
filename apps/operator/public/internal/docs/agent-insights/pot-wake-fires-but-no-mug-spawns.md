# Pot wake fires but no Mug spawns → it's fleet-spawn starvation, not the pot
URL: /internal/docs/agent-insights/pot-wake-fires-but-no-mug-spawns

When a pot's wake fires (lastFiredAt advances) yet placements stay empty and liveAgents:0, the cause is almost always the rate-governor's fleet effective concurrency being saturated — NOT your pot config, the work-item kind, or the operator. Diagnose with dev:rate_governor_status, not by recreating the pot.

:::caution\[Superseded — check the FLAG first; this diagnosis now sends you the wrong way]
This page is the most actively misleading of the retired-tier docs, because its
symptom still reproduces exactly while its cause no longer applies.

Since 2026-08-09 the Mug/Kettle/Cup tier is RETIRED (owner-directed), held off by
`papercusp-mug-kettle-system`, whose default-OFF **is the delivered end state**.
So "pot wake fires but no Mug spawns" is now the EXPECTED, CORRECT behaviour: the
spawn gate refuses the role. `liveAgents: 0` and an empty `placements.items` are
what a healthy retired system looks like.

Follow this page's advice in that state and you will go audit
`dev:rate_governor_status` for a saturation that is not there — the exact
wild-goose chase it was written to prevent, pointed at the wrong quarry.

**Check first:** is `papercusp-mug-kettle-system` OFF? If yes, stop — nothing is
wrong. The gate is at `pot/retired-tier-roles.ts` + the three spawn doors, and
refusals carry the machine-readable code `mug_kettle_retired`.

**Still true:** the rate-governor starvation mechanism itself, and the
`dev:rate_governor_status` diagnostic. Both still apply to **su/fleet** spawn
starvation — the same governor gates those. Read the diagnosis, ignore the Mug.

Canonical account: [The Mug · Kettle · Cup tier is RETIRED](/internal/docs/agent-insights/mug-kettle-cup-tier-is-retired).
:::

## Symptom

You spin up (or own) a pot, seed a deliverable work-item, and `hive_start` /
`hive_wake`. `hive_status` shows the wake **fired** — `lastFiredAt` advances,
`declaredAt` is set — but:

* `placements.items` stays `[]`; the deliverable work-item stays `todo` / unplaced.
* `liveAgents: 0`. No Mug agent, no cup, ever appears in `coord:presence` /
  `fleet:assignments`.
* On teardown, `hive_dissolve` reports `cancelledSpawns: []` (nothing was ever queued).

## The red herrings (don't chase these)

All three of these are tempting and all three were wrong when this was diagnosed
(2026-06-18, `domain-generic-agent-personas` P-016):

1. **"My pot / blueprint is misconfigured."** No — the symptom appears across
   **every** pot in the workspace at once. `hive_list` showed all 14 pots with
   `liveAgents:0`, including `papercup-pot` and `hiveloop-pot` whose wakes had
   fired minutes earlier. A systemic symptom is not a per-pot bug.
2. **"The work-item kind isn't in the placement frontier."** No — re-running with
   a frontier-native `kind:research-task` (family:feature/todo) instead of
   `kind:task` placed nothing either. The Mug never ran, so the frontier was
   never gathered.
3. **"The green operator (:3070) is crash-looping."** Check `ActiveEnterTimestamp`
   — a high `NRestarts` is cumulative; if the operator has been up for hours, the
   crash-loop already settled and a wake that fired *during* that stable window
   still produced no Mug.

## The real cause

Pot Mugs are spawned through the **fleet autonomous-spawn lane**, which is
gated by the rate governor's fleet-wide `maxSimultaneousAgents` / AIMD
**effective** concurrency (see
[rate-limit-governor-activation](/internal/docs/agent-insights/rate-limit-governor-activation)).
When effective concurrency is small (e.g. **1**) and already consumed by other
fleet work (overnight benchmark cups, etc.), there is **no spawn slot** — so the
wake-executor records the wake but the Mug spawn never admits.

## Diagnose it in two calls

* `dev:rate_governor_status` → `fleet: {cap, inFlight, effective, floor}`. If
  `effective` is small and `inFlight >= effective` (saturated), that's the gate.
  In the 2026-06-18 case: `{cap:8, inFlight:1, effective:1, floor:1}` — one slot,
  fully consumed by benchmark runs.
* `hive_list` → if **many** pots show `liveAgents:0` despite recently-fired
  wakes, it's systemic starvation, not your pot.

## Unblock

The lever is the fleet `maxSimultaneousAgents` / effective cap, live-editable via
`operator:rate_limit_config` (or the `/adv` `<FleetRateControl>`). **But raising
it is an owner-gated capacity decision** — a larger pool re-pressures PG and can
re-trigger the oversized-pool wedge (see
[pg-connection-exhaustion-fleet-wedge](/internal/docs/agent-insights/pg-connection-exhaustion-fleet-wedge)),
so don't force it autonomously. Wait for a slot to free, or escalate to the
owner. Do **not** recreate the pot or fiddle the work-item kind — neither is the
problem.
