# Reading pipeline state — position, health, and next action
URL: /internal/docs/agent-insights/reading-pipeline-state-position-health-nextaction

dev:pipeline_position answers position, health, and nextAction; this guide also explains candidate identity, what the gate-candidate cell returns and its source.authoritative provenance, sweep exposure, and the path-scoped state-plane handle that links release:trace target.sha back to the gate candidate cell.

import { Aside } from '@astrojs/starlight/components';

## The one call

```
dev:pipeline_position { path: "packages/operator-core/lib/x.ts" }
```

Read `summary` first. It leads with the delivery answer, then reports publication separately:

```
BLOCKED AT COMMITTED → git-sync:run (commit the working tree — the gate cannot see it)
DELIVERY LIVE — packages/…/x.ts @c3b961f32: committed ✓ ·
  origin-publish ✗ (STALLED PUBLISH/DURABILITY side leg — peer visibility and
  off-box recovery are at risk; local staging→main→:3070 delivery is unaffected)
  · main ✓ · deployed ✓
```

Everything after the lead clause is supporting evidence. If you only need the delivery decision,
read `blockedOn` + `nextAction`. If you are diagnosing off-box durability, read the
`plane:'publish'` stage too.

## The four dimensions

### 1. POSITION — where the change sits

`positions.{committedLocal,onStaging,inMain,deployed}`, and per-stage
`stages[].position` (`past | pending | na`).

A position cannot distinguish “not yet” from “this leg is dead.” It also cannot say whether a
leg is on the delivery path. That is why each stage now carries both `health` and `plane`.

A path whose runtime does not use the release checkout (bg-host, gateway, embed-sidecar) is never
carried by staging→main→:3070. Its gate/main/deployed stages are `na`, not `pending`.

### 2. PLANE — delivery vs publication

`stages[].plane` is `delivery | publish`.

* `delivery` stages may populate `blockedOn` and `nextAction`.
* `publish` stages are durability/peer-visibility side legs. They stay loud, keep their own
  `health/detail/lever`, and never claim to block local staging→main→:3070 delivery.

The distinction is conditional, not universal. A normal `push` member still has
`pushed.plane='delivery'`. A `commit-only:bridged` or `commit-only:p2p-only` member commits
locally and publishes through the p2p bridge, so `pushed.plane='publish'`.

This does not downgrade origin health. `origin/staging` is the GitHub-bridge egress watermark;
a freeze is a real data-loss exposure and makes fresh clones/other machines stale. It simply
answers a different question from “can this box judge and deploy its local staging commit?”

### 3. HEALTH — whether the stage is moving

`stages[].health`: `advancing | stalled | disabled | broken | unknown`.

| position                                   | health/plane interpretation                                 |
| ------------------------------------------ | ----------------------------------------------------------- |
| `origin-publish ✗` on a commit-only member | publication/durability incident; delivery continues locally |
| `staging ✗` on a normal pushing member     | delivery has not reached the required staging publication   |
| `deployed ✓`, serving stalled              | bytes landed, but the process still executes older code     |
| `main ✗`, gate not firing                  | delivery is wedged at the gate                              |

`gitSync.status='synced'` is reachable with nothing pushed. Read `gitSync.pushMode`,
`gitSync.pushedRepos`, and (for bridged members) `gitSync.ownHeadPublish`.

### 4. NEXT ACTION — the delivery lever

`blockedOn: StageName | null` + `nextAction: string | null` are derived from pending
`plane:'delivery'` stages only:

| blockedOn | nextAction | meaning                                             |
| --------- | ---------- | --------------------------------------------------- |
| null      | null       | delivery is live; a publish warning may still exist |
| set       | null       | delivery is waiting on a healthy self-advancing leg |
| set       | set        | this is the single delivery action                  |

A publish side leg may have its own `lever`; that remedy is intentionally not promoted into
`nextAction`. Read it from the `pushed` stage when you own the durability incident.

## Candidate identity comes before gate interpretation

Before treating a gate verdict as a verdict on your change, read
`changeInCandidate.judgingContainsPath`. The path-scoped cell is:

```
state:read { cell: "gate.greenCheckpoint.candidate", as: "<repo-relative-path>" }
```

Read `source.authoritative` before acting on the SHA. A run’s own published marker is
authoritative; a checkout-head probe is an inference. `verdictUnknown` hoists anything the
resolver could not determine. Raw SQL and hand-built ancestry checks are fallbacks, not the
primary route.

## Sweep exposure

git-sync commits the whole working tree. `sweepExposure` reports the dirty-path blast radius and
the next sweep time. A multi-file intermediate can become a real candidate, so finish the atomic
set before forcing `git-sync:run`; never read a red landing inside that window without checking
candidate containment.

## Practical routing

| question                                | read                                             |
| --------------------------------------- | ------------------------------------------------ |
| is my change live on this box?          | `blockedOn` + `nextAction`, then `serving`       |
| is off-box publication healthy?         | `stages[name=pushed]` + `gitSync.ownHeadPublish` |
| did a normal pusher reach origin?       | `gitSync.pushedRepos`, not `gitSync.status`      |
| is the gate judging my code?            | `changeInCandidate.judgingContainsPath`          |
| will git-sync sweep a partial refactor? | `sweepExposure`                                  |

## Anti-patterns

* Do not read a publish-plane fault as a delivery outage.
* Do not dismiss a publish-plane fault as harmless: it is a real durability/peer-visibility risk.
* Do not read `deployed ✓` as process liveness.
* Do not infer success from a null or unknown field.
* Do not hand-diff SHAs to replace this resolver unless its authoritative read is unavailable.
