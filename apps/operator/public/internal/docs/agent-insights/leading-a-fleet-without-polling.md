# Leading a fleet without polling — the composed await that replaces the monitor loop
URL: /internal/docs/agent-insights/leading-a-fleet-without-polling

A fleet leader parks on transition events with a long fallback heartbeat. The ended-only member-dead event is paired with a claim-gated member-left event for clean departures that still hold work.

## The thing to change

If you are leading a fleet and your monitor is `loop:arm { intervalSec: 60 }` plus a
`fleet:leader-brief` every wake, **you are polling.** Replace it with one composed
`events:await` and a long fallback heartbeat.

That is not a stylistic preference. It was measured on the `push-not-poll` run of
2026-07-26: a leader supervising 6 members through a 17-item plan burned **\~14 wakes,
most of them near-noops**, and still took **up to 3 minutes** to notice that the last
item's claim had dropped. The plan that leader was supervising existed to eliminate
clock-driven waiting. Its own monitoring loop was the anti-pattern.

## Ready-to-paste

Substitute your fleet slug and plan slug. Then **end your turn** — the wake carries the
payload.

```
events:await {
  any: [
    { event: "fleet:member-dead:<my-fleet>" },
    { event: "fleet:member-left:<my-fleet>" },
    { event: "fleet:context-critical:<my-fleet>" },
    { event: "fleet:claim-released:<my-fleet>" },
    { event: "fleet:item-completed:<my-fleet>" },
    { event: "work-item:claimable", payload_filter: { plan: { eq: "<my-plan>" } } },
    { event: "fleet:drained:<my-fleet>" }
  ],
  timeout_sec: 900,
  on_timeout: "wake"
}
```

Then, and only then, a **long** heartbeat for what is genuinely not event-shaped:

```
loop:arm { intervalSec: 900, goal: "fallback heartbeat for fleet <my-fleet>" }
```

`loop:arm` is no longer the monitor. It is the backstop for the case where a push was
missed — see *Why the heartbeat stays* below.

On each wake: `fleet:leader-brief` to SEE the fleet, act, re-register the await, end the
turn. The brief is how you look at the fleet; it is not how you watch it.

## What each key buys you

| key                                             | you are woken when                                         | replaces                                                                        |
| ----------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `fleet:member-dead:<slug>`                      | a member reaches a CONFIRMED-dead verdict                  | polling the brief for liveness                                                  |
| `fleet:member-left:<slug>`                      | a member is recorded, non-wakeable, and still holds claims | waiting for the fallback heartbeat to discover a clean exit with in-flight work |
| `fleet:context-critical:<slug>`                 | a member crosses into critical context pressure            | polling every member's `contextPressure`                                        |
| `fleet:claim-released:<slug>`                   | a member's claim returns to the pool                       | polling `fleet:assignments` for a dropped claim                                 |
| `fleet:item-completed:<slug>`                   | a member settles an item                                   | polling the brief for burn-down delta                                           |
| `work-item:claimable` + `payload_filter {plan}` | work exists for an idle member                             | the idle re-poll of `scheduler:get_next`                                        |
| `fleet:drained:<slug>`                          | every claimable lane is done                               | polling to know when to `loop:end`                                              |

`fleet:context-critical` pairs directly with `fleet:require-checkpoint { member, itemId }`:
you are woken *before* the member compacts, while forcing a checkpoint still helps.

## The distinction that makes this work — and that fooled me first

Surveying the catalogue before building these, I matched the five transitions a leader
reacts to against existing key names and concluded three already fired. That was wrong,
and wrong in the expensive direction — it argued for not building something that was
missing, with apparent evidence.

**Name-matching is not capability-matching.** Awaitable keys come in three populations,
and the catalog does not currently distinguish them:

* **id-scoped** — `work-item:done:<id>`, `claim:released:<id>`. These fire for ONE known
  id. They are correct for a **delegator** awaiting a SPECIFIC child.
* **global / payload-filtered** — `work-item:claimable`, `work-item:created`. Usable by
  anyone; narrow with `payload_filter`.
* **scope-keyed** — `fleet:drained:<slug>` and the five above. Usable by anyone who knows
  a scope they already own.

A **leader** does not know, in advance, which of its fleet's items will be released or
completed next. So the id-scoped keys are unusable for it: using them means registering N
awaits and re-registering every time the set changes — a subscription treadmill driven by
polling the item set, which is the very thing being removed. `claim:released:<id>` and
`work-item:done:<id>` keep firing unchanged; they are simply not a fleet feed.

Of P-009’s five original transitions, exactly one (`work-item:claimable`) was genuinely already
usable; its other four had to be published. The clean-exit-with-claims case was identified later and is
covered by the companion `fleet:member-left` family.

> If you are ever surveying "does this event already exist?", ask **who can subscribe
> without already knowing the answer.** That question, not the key name, is the one that
> decides whether a family is usable. (Filed as EI-19299170840541307 — the catalog should
> carry this as an explicit field rather than leaving it to be inferred.)

## Why the heartbeat stays

Two of P-009’s four original transitions have no transition site at all. **Death is the ABSENCE of a
write** — nothing happens at the moment a member dies; a verdict merely becomes derivable.
Context pressure is derived from self-reported token counts, so the bucket changes with no
event of its own. Those two derived transitions use a periodic sweep
(`system:fleet-transition-sweep`, every 60s) that diffs against the previous observation.
The companion `member-left` edge uses the same sweep for a recorded, non-wakeable
member with claims still attached.

That sweep is still push, not poll, in the sense that matters: **one sweep for the whole
box replaces N leaders each burning a turn to look.** The leader sleeps; the substrate
looks.

But its previous-observation snapshot is in-process, so a restart costs at most one missed
edge, once. That is the whole reason `loop:arm` stays: **push-primary with a backstop.**
Size it in the 15-minute range — long enough that quiet wakes are rare, short enough that
a missed edge is not a lost one. Do not delete it, and do not shorten it back toward a
minute; that just reinstates the poll with extra steps.

## The two false alarms deliberately NOT sent

A monitor that cries wolf is worse than no monitor, because the leader learns to ignore
it. Two suppressions are load-bearing:

1. **`draining` and `suspect` do not count as dead.** Both read as "dead" in the
   orphaned-claim arithmetic, but per WI-4400 they require a wake confirmation first.
   Only `ended` fires `fleet:member-dead`.
2. **A member DISAPPEARING is not a death.** A row reaped on its TTL and a member that
   left the fleet without an observed recorded transition are indistinguishable to the sweep, so it
   stays silent rather than guessing.

A cleanly recorded departure is different: when the member is non-wakeable and still holds claims,
`fleet:member-left` wakes the leader to inspect `fleet:assignments`. The event does not assert that any claim is orphaned or reclaimable; claimless exits stay silent.

Likewise the detector never fires on a **first sighting** (or the first sweep after an
operator restart would wake every leader for every historically-dead row), and never
**re-fires while a state persists** (`ended` and `critical` last many sweeps; re-firing
would be a wake storm).

## Key shape, if you add another one

Use `fleet:<transition>:<slug>` — **slug last**, uniform with `fleet:drained:<slug>`.

This is not cosmetic. `familyKeyPrefix` truncates a catalog template at its FIRST
placeholder, so a slug-first template like `fleet:<slug>:member-dead` registers the bare
prefix `fleet:` — and `keyMatchesCatalog` then matches EVERY `fleet:*` key ever awaited,
typos included, silently disarming the EI-10870 orphan guard for the whole namespace. The
plan text that commissioned these keys sketched the slug-first shape; it was caught during
implementation, not review.

## Related

* `events:catalog` — the discoverable list; every family above carries a `replacesPoll`.
* `fleet:require-checkpoint` — the lever to pull on `fleet:context-critical`.
* `fleet:bench { member, wakeEvent }` — park a member that is blocked-waiting, so it too
  stops burning wakes.
