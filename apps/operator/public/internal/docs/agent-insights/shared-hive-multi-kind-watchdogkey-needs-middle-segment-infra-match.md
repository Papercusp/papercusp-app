# A shared source-segment watchdogKey family needs a middle-segment infra match, not a source-level one
URL: /internal/docs/agent-insights/shared-hive-multi-kind-watchdogkey-needs-middle-segment-infra-match

EI-20983096990125721 (repeatCount 24): `shared-hive:peer-federation-silence:<harness>` was classified `code-bug`/tier=auto and re-dispatched to an auto-implement worker every watchdog tick, even though its own alert text says the peers are ABSENT — not a code defect a worker can fix. Same repeat-dispatch shape as EI-805/EI-287 (stalled-feature). The fix pattern: when several incident kinds share one watchdogKey SOURCE segment (`<source>:<kind>:<scope>`) and only SOME of those kinds are genuinely infra/environment, `INFRA_SIGNAL_SOURCES` (a source-level allowlist) is the wrong tool — it would reclassify the fixable siblings too. Match the full prefix (source+kind) in `infraEnvironmentHit()` instead, the same way the `:rate-limit` suffix match already does for a different multi-kind family.

## The trap

`packages/operator-core/lib/harness/improvements/policy.ts`'s `infraEnvironmentHit()`
is the ONE vocabulary (D-003) both `classifyImprovement` (safety tier: auto vs human)
and `classifyIdeaType` (the D-005 routing taxonomy) consult to decide whether a
captured `bug` idea is a papercusp code defect (`code-bug` → auto-implement-eligible)
or an environment fact a worker cannot touch (`infra-environment` → owner-escalate,
never auto).

Its first, cheapest check is `watchdogSourceOf(watchdogKey)` — everything before the
**first** colon of `<source>:<key>` — checked against the `INFRA_SIGNAL_SOURCES`
allowlist (`service-down`, `fire-circuit-open`, `migration-drift`, `loop-stalled`,
`stalled-feature`, ...).

That works cleanly when one watchdog SOURCE always means one incident kind. It
silently mis-fires when a family of related watchdogs shares ONE source segment
across SEVERAL distinct incident kinds — some genuinely code-fixable, some not — and
the kind lives in the **second** segment instead. `shared-hive:*` is exactly this
shape (`planSharedHiveCapture` in `coord-invariant-actions.ts` builds every key as
`shared-hive:${incident.kind}:${harness}`):

* `shared-hive:double-completion:<h>` — a real dedup/race bug → code-fixable.
* `shared-hive:outbox-health:<h>` — a real drain-loop bug → code-fixable.
* `shared-hive:presence-ghost:<h>` — a real reap-logic bug → code-fixable.
* `shared-hive:orphaned-taken-by:<h>` — a real reclaim-logic bug → code-fixable.
* `shared-hive:monitor-scope-empty` — a real scope-discovery bug → code-fixable.
* `shared-hive:peer-federation-silence:<h>` — **not** code-fixable: it reports a
  REMOTE peer's liveness/announce-admission state. `judgePeerFederationSilence`'s own
  breach text says so plainly: "The peers are ABSENT, not slow — nothing current can
  be folded. Suspect the announce/admission path or peer liveness, NOT this host's
  merge loop." A worker cannot make a departed peer re-announce any more than it can
  fix a port mapping.

Because `watchdogSourceOf` only sees `"shared-hive"` for every one of these — the
kind that actually discriminates them sits in the SECOND segment — adding
`"shared-hive"` to `INFRA_SIGNAL_SOURCES` was never an option: it would also gate the
five genuinely-fixable siblings away from auto-implement. And leaving it unclassified
meant the D-005 default (`code-bug`) caught `peer-federation-silence` by default,
producing the exact repeat-dispatch loop `stalled-feature` was already fixed for once
(EI-805/EI-287: "burned 4 consecutive auto-implement dispatch attempts re-confirming
this same non-auto-fixable root cause"). Measured here: `repeatCount: 24` on one open
item (the watchdog re-captures the same incident every tick via `dedupScope:'open'` +
a stable `watchdogKey`, and each capture re-triaged into the auto lane) before an
implement worker actually landed on it and could see the pattern.

## The fix (and the general rule)

`infraEnvironmentHit()` already had a precedent for exactly this shape: the
`repeated-tool-error:<tool>:<...>:rate-limit` family, where only the `:rate-limit`
SUFFIX is infra-environment and every other suffix of the same tool-error source
stays code-bug. That's a targeted regex against the **full** `watchdogKey`, not a
source-level allowlist entry.

`shared-hive:peer-federation-silence:` got the same treatment — a `^shared-hive:peer-federation-silence:`
prefix match added right after the `:rate-limit` check, with the sibling kinds
verified to stay `code-bug`/`tier=auto` via an explicit regression assertion
(`shared-hive:double-completion:papercusp` → still `code-bug`).

**The general rule**: before reaching for `INFRA_SIGNAL_SOURCES`, check whether the
watchdogKey's source segment is shared with sibling incident kinds that must NOT be
reclassified. If so, match the fuller `source:kind` (or `source:...:suffix`) shape in
`infraEnvironmentHit()` instead of the source alone — the same way `:rate-limit` and
now `peer-federation-silence` do. A source-level allowlist add is only safe when the
source is 1:1 with a single incident kind.

## Where to look

* `packages/operator-core/lib/harness/improvements/policy.ts` — `infraEnvironmentHit`,
  `INFRA_SIGNAL_SOURCES`, `watchdogSourceOf`.
* `packages/operator-core/lib/harness/improvements/triage.ts` — `classifyIdeaType`
  (consumes the same predicate for the D-005 routing taxonomy).
* `packages/operator-core/lib/harness/routines/coord-invariant-actions.ts` —
  `planSharedHiveCapture` (where the `shared-hive:<kind>:<harness>` watchdogKey shape
  is built) and `runSharedHiveLeg`.
* `packages/operator-core/lib/shared-pot-loop/fleet-monitors.ts` —
  `judgePeerFederationSilence` (the alert-text source of truth for why this incident
  kind is a peer-liveness fact, not a merge-loop defect).
