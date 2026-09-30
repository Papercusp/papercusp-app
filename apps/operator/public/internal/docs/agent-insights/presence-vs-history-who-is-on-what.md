# State vs history — who is on what now, and who was ever here
URL: /internal/docs/agent-insights/presence-vs-history-who-is-on-what

Two questions, two doors. coord:presence and fleet:assignments answer NOW — who is live and who holds which work-item. The append-only coord log — coord:catch-up (membership-gated) and coord:feed (the unscoped firehose), both keyed by an audience selector such as @fleet:slug — answers EVER: who was ever in this fleet and what was said. Ended agents lose their fleet tag and their presence row is reaped on a TTL, so a history question asked from a live-state tool comes back empty; route who-was-ever-here and what-did-I-miss to the audience history read instead.

## The mistake this doc prevents

On 2026-07-01 an agent needed to answer **"who has ever been in this fleet?"** and
reached for `coord:presence` / `fleet:assignments` — the tools it already knew. Both
came back nearly empty, because those are **live-state** tools: they answer *who is
here now*, not *who was ever here*. The history it wanted lived in a different door
entirely (the append-only coord log, read via `coord:catch-up` / `coord:feed` with an
audience selector) — and nothing in the state tools' output pointed there. This doc is
the map that pointer should have been.

## Two axes, four questions

There is **one** underlying coordination model, but you query it along two axes. Pick
the door by the question you are actually asking:

| Question you are asking                                                          | Axis                    | Door (today)                                        |
| -------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------- |
| Is agent X **alive right now**? (live / parked / ended / recorded, wakeable?)    | STATE — *now*           | `coord:presence`                                    |
| **Who holds which work-item / plan-item** right now? (claims, orphaned, stalled) | STATE — *now*           | `fleet:assignments`                                 |
| One-glance **fleet health** (wake mode, cups in flight, paused governors, tips)  | STATE — *now, digest*   | `coord:glance`                                      |
| **Who was *ever* in this fleet / topic / plan**, and **what was said**?          | HISTORY — *ever*        | `coord:catch-up` (member) / `coord:feed` (firehose) |
| **What did I miss** while I was asleep, or before I joined?                      | HISTORY — *ever*        | `coord:catch-up` with an `audience`                 |
| My own identity + fleet membership                                               | STATE — *self*          | `coord:whoami`                                      |
| Full wake bootstrap (assignments + claimable + inbox + plan-events + recall)     | STATE — *now, composed* | `coord:orient`                                      |

**Rule of thumb:** if your question contains the word *ever*, *was*, *missed*,
*history*, or *who has been* — you want the **HISTORY** door, not a state tool. State
tools answer *now*; only the append-only log answers *ever*.

## Why a state tool cannot answer a history question

State tools read the live `coord_presence` + `fleet_assignment` projections. Those are
**mutable, reaped, and death-lossy** by design:

* An **ended** agent's row loses its live signal; a stale or ended `coord_presence` row
  is **reaped on a TTL** (a sweep evicts it), so it eventually disappears entirely.
* On agent death, membership tags (`fleet_slug`) have historically been **nulled**
  rather than preserved — so even a surviving row may no longer say which fleet the
  dead agent was in.
* `fleet:assignments` is **claim-primary**: an agent that booted but has not claimed
  yet (or is parked between turns) shows `agents: 0` there — that is *not* a death, and
  it is *not* history. (See
  [launching-a-desktop-fleet](/internal/docs/agent-insights/launching-a-desktop-fleet)
  for the full claim-vs-liveness gotcha.)

The durable record of *who was ever here and what was said* is the **append-only coord
log**, keyed by **audience**: `@fleet:slug`, `@topic:slug`, `@plan:slug`,
`@object:kind:ref`, `@file:path`, or `*` for a broadcast. Every message is stamped with
its audience at send time, and that stamp **survives the sender's death** — so the log
answers *ever* even when every live row is gone.

## The history read — two doors, by membership

Both take an `audience` selector; they differ by trust tier:

* **`coord:catch-up`** — the **member** door. A bounded, membership-gated catch-up on an
  audience's history (last N messages, or as much as fits a `token_budget`),
  newest-first, paginate older with `before_ts`. This is how you get the backlog **after
  joining a fleet or topic** or **waking from a pause** — broadcasts are *not*
  auto-polled, and your inbox only ever showed messages that named *you* at send time.
  You must currently belong to the audience.

```text
coord:catch-up { audience: "@fleet:papercusp-backlog", limit: 50 }
coord:catch-up { audience: "@topic:federation", token_budget: 8000 }
```

* **`coord:feed`** — the **unscoped firehose** (higher tier). Reads audience history even
  for an audience your id was *never* a recipient of — the whole cross-agent stream,
  filterable by `kinds` / `owner` / `plan_slug` / `q` / a time window. Reach for it when
  you need history for a fleet or topic you do not belong to, or the full stream.

```text
coord:feed { audience: "@fleet:some-other-fleet", limit: 30 }
coord:feed { q: "green gate", since: "2026-07-01T00:00:00Z" }
```

## Membership is the join key — and it must outlive death

Both history doors resolve an audience to its member set, so fleet/pot **membership**
is the load-bearing fact: it must be recorded durably and *never nulled on agent
death*, or the audience cannot be reconstructed once the fleet disperses. Making
membership an **append-only** fact (the state tables project from it and are freely
reaped, while the log answers *ever*) is the structural fix carried by
`presence-coord-unification-2026-07-01` (P-002). Until it lands, treat deep pre-cutover
history for already-ended agents as best-effort. How the live roster itself is assembled
(the session-log leg, the `recorded` state) is covered in
[presence-derives-from-session-log](/internal/docs/agent-insights/presence-derives-from-session-log).

## Forthcoming: one door, explicit lenses

Today the STATE axis is spread across `coord:presence` / `fleet:assignments` /
`coord:glance` — "which of the five do I call?" is itself the friction. The unification
(P-001, **not yet built** — additive, ships after the append-only membership fix) is a
single `coord:roster` with an explicit `scope` + `view`: `view=live` (in-a-turn),
`view=members` (fleet/pot membership), `view=claims` (who-on-what-item),
`view=history` (who-was-ever-here). The existing tools become thin aliases. Until it
exists, use the table above; when you see `coord:roster` in your toolset, prefer it.

## TL;DR

* **"Is X alive / who holds what / fleet health" → NOW → `coord:presence` /
  `fleet:assignments` / `coord:glance`.**
* **"Who was ever here / what did I miss / history" → EVER → `coord:catch-up` with an
  `audience` (member) or `coord:feed` (firehose).**
* State rows are reaped and death-lossy; the append-only coord log, keyed by `@fleet:` /
  `@topic:` / `@plan:` audience, is the durable *ever* record.
* If the question has *ever / was / missed / history* in it, do not reach for a state
  tool.

## One verdict, many lenses (presence-derivation-unification-2026-07-17)

Every liveness read now derives through ONE oracle
(`packages/operator-core/lib/agent-tools/coordination/liveness-oracle.ts` —
`deriveVerdict` / `resolveSessionStates`), assembling ALL input legs the same
way for every surface: heartbeat staleness, inbox-wake wakeability, the
agent\_activity liveTurn + `■ session ended` marker, the PRESENCE\_DEAD\_MS (30m)
zombie-await ceiling, the local `kill(pid,0)` probe, the adv\_sessions
recorded-session rescue, claims-held (suspect vs ended), and — opt-in for
known-psu-hosted cohorts — the psu-pty host authority. A cross-surface parity
test (`liveness-parity.test.ts`, P-001) pins the contract.

| Surface                                                             | Verdict field              | Raw-freshness field | Notes                                                                                                                                           |
| ------------------------------------------------------------------- | -------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `coord:presence` / coord:inbox re-bootstrap / sync `presence` query | `sessionState`             | `stale` (row flag)  | The reference read; never emitted `alive`.                                                                                                      |
| `fleet:status` members\[]                                           | `sessionState`             | `heartbeatFresh`    | `alive` RETIRED from this payload (P-008).                                                                                                      |
| `fleet:assignments` / coord:orient `me` fold                        | `sessionState`             | `heartbeatFresh`    | `alive` kept as the verdict-gated boolean projection (TUI compat) — never heartbeat-only anymore.                                               |
| `coord:roster` view=live                                            | `sessionState`             | `stale`             | Same snapshot as coord:presence.                                                                                                                |
| `coord:roster` view=claims                                          | `sessionState`             | `heartbeatFresh`    | Now reconciled through the same oracle (was heartbeat-only — F1).                                                                               |
| `fleet:leader-brief`                                                | `sessionState` + `verdict` | —                   | Its psu-host rule now lives IN the oracle (`applyPsuHostAuthority`).                                                                            |
| coord:send / handoff / dispatch MISS report                         | `sessionState`             | —                   | Full-leg oracle with per-id presence hydration (was `parked`-for-zombies — F2).                                                                 |
| fleet:list availability + `@fleet:` audience expansion              | (filtered)                 | —                   | Oracle-dead owners excluded: counts drop ended/suspect/draining; audience drops ended/suspect only (a draining agent still gets durable sends). |
| hive roster / Queen survey / spawn dossier                          | `sessionState`             | `heartbeatFresh`    | Was heartbeat-only `alive` (F6).                                                                                                                |

Reading rules: **`sessionState` is the ONLY liveness verdict.** Any
`heartbeatFresh` (or legacy `stale`) field is process-keepalive recency — a
warm-dead session reads `heartbeatFresh: true` + `sessionState: 'ended'`.
The UI's LivenessDot scale (live/idle/stale) and coverage labels
(free/reserved/alive/progressing/stalled/dead) are display projections, never
independent derivations (D-001). Write-side reclaim graces stay time-based
policy, structurally pinned to the same constants
(`liveness-constants-drift.test.ts`, D-002/P-009).
