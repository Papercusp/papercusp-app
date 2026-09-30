# Checking release-fixer coordination liveness: use release:trace's gate.redOwner, never coord:presence
URL: /internal/docs/agent-insights/release-fixer-liveness-check-release-trace-redowner-not-coord-presence

The saved recipe check-release-fixer-coordination-liveness (and locate-the-live-release-fixer-s-real-ownerid) queries coord:presence for a release-fixer's identity -- but release-fixer spawns have NO coordination-roster identity by design, so that query always false-negatives regardless of whether a fixer is actually alive. The correct authority is release:trace's gate.redOwner (backed by harness_shared.spawned_agents heartbeat/PID liveness), the SAME liveness definition the dispatcher itself uses to avoid double-dispatching a fixer.

## The mistake (EI-20984053213732826)

Two saved code:run recipes exist for "is a release-fixer already on this red gate":
`check-release-fixer-coordination-liveness` and `locate-the-live-release-fixer-s-real-ownerid`.
Both call `coord:presence` and grep the roster text for a fixer identity (a spawnId, a failure
signature like `lint:identity-leak`, or a specific date-stamped id like `1787234559693`).

**Both are structurally wrong, not just stale.** Per
`packages/operator-core/lib/release/gate-red-ownership.ts`'s own header comment:

> a release-fixer is a blueprint-launched spawn with NO coordination-roster identity
> (confirmed: `harness_shared.spawned_agents.session_owner`/`session_id` are null even for a
> LIVE fixer spawn, not just a finished one)

So a `coord:presence` search for a release-fixer will return **empty every single time**,
whether or not a fixer is alive and actively working the red — it is not a staleness bug you
can fix by updating the hardcoded literals, it is the wrong authority entirely.

## The correct authority

`release:trace { path | sha }`'s `gate.redOwner` field (`GateRedOwnership`, defined in
`gate-red-ownership.ts`) is the one place this liveness is actually resolved — via
`releaseFixerSpawnAlive()` (`fixer-liveness.ts`), which queries
`harness_shared.spawned_agents` directly (heartbeat freshness + same-boot PID-alive check),
**the exact same liveness definition `maybeDispatchReleaseFixer` uses to decide whether to
send a fresh fixer.** Reading `redOwner` can never disagree with the dispatcher about who is
covering the gate.

`redOwner.state` is one of: `verdict-stale` · `owned-live` · `owned-unknown` · `owner-gone`
· `stale-signature` · `unowned`. `redOwner.covered === true` means stand down — someone (or a
durable/legacy fire with unknowable liveness) already has this exact failure signature.
`redOwner.label` is pre-written, safe-to-paste prose.

⚠ **`release:trace`'s own top-level `ok` field means something unrelated** — "is this exact
target (green + deployed + no blocking constraints) safe to treat as tested", NOT "did the
call return usable data". While the gate is red `ok` is legitimately `false` even though
`gate`/`gate.redOwner` are populated correctly. Check for the PRESENCE of `trace.gate`, never
`trace.ok`, to know whether you got real release truth back.

## Corrected pattern (verified live against a real red gate + an actual release-fixer spawn)

```js
const trace = await tools.release.trace({ path: '<any real repo path>' });
const gate = trace && trace.gate;
if (!gate) {
  // trace.ok:false here is a legitimate "not deployable" verdict, NOT a call failure --
  // only the ABSENCE of `gate` means the call itself didn't return usable release truth.
  return { verdict: 'refused-trace-unavailable', detail: (trace && trace.error) || 'no gate data' };
}
if (!gate.consecutiveReds || gate.consecutiveReds <= 0) {
  return { verdict: 'no-active-red', detail: 'gate is not red; no ownership question to answer' };
}
const redOwner = gate.redOwner ?? null;
if (!redOwner) {
  // explicit refusal instead of a false "unowned" -- do not conclude nobody is on it.
  return { verdict: 'refused-no-identity', detail: 'active red but no redOwner data yet' };
}
return { verdict: redOwner.state, covered: redOwner.covered, spawnId: redOwner.spawnId, label: redOwner.label };
```

Run live on 2026-08-21 against a genuinely red gate (`consecutiveReds: 17`): correctly
returned `{ verdict: 'owned-live', covered: true, spawnId: 's-1787306776541-2be4e2d9' }` for
the actively-working release-fixer — exactly the case `coord:presence` can never see.

## Why the broken recipes are still sitting there

There is no `recipes:update`/`recipes:create` tool — a recipe is only created as a
side-effect of a **fully clean** `code:run` (zero `childFailures`). `code:run`'s dispatcher
classifies ANY dispatched tool call whose raw result carries `ok:false` as a `kind:"semantic"`
childFailure and silently declines to auto-save the run as a recipe when one is present —
even though `release:trace`'s `ok:false` is legitimate data, not a failure, and even though
the script's own return value was a well-formed, correct answer. This means a corrected
release-fixer-liveness recipe can only ever auto-save while the gate happens to be green —
exactly when nobody needs it. See the follow-up filed for this (search
`code:run recipe autosave childFailure ok:false`). Until that's fixed, treat this doc as the
canonical corrected pattern and copy it inline rather than trusting either saved recipe.
