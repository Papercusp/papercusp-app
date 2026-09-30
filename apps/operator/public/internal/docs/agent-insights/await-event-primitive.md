# await-event: don't poll or block — register a wake and sleep
URL: /internal/docs/agent-insights/await-event-primitive

The universal subscription primitive (events:await/emit/cancel/status + locks:acquire{wake_on_grant}): durable one-shot wake subscriptions with liveness-adaptive delivery (pty-inject / session-resume / inbox-park). What to await, what never wakes, and the cost discipline.

:::caution\[Superseded — codex now resumes, not parks]
The **"codex sessions park instead of resuming"** gotcha below (formerly the
per-session `CODEX_HOME` "isn't re-derivable yet" claim) is now the OPPOSITE of
the code. Since `turn-lifecycle-control-2026-06-08`, codex wakes **resume**:
`executeWake` derives the per-session home with
`codexHomeForAdvSession(handle.advSessionId)`, recovers the conversation UUID
from that home's rollout via `findCodexRolloutSessionId(home)`, and delivers the
wake through `codex exec resume <uuid> <prompt>` with `env.CODEX_HOME` set
(symbols in `packages/operator-core/lib/events/await/wake-executor.ts`:
`findCodexRolloutSessionId` + `codexHomeForAdvSession` + `resumeCommandFor`).
codex only falls back to park if the home dir is missing or
no session id can be recovered — parking is no longer the default for codex.

Everything else in this runbook still checks out against the code; only that one
gotcha is reversed. The relevant symbols, all in
`packages/operator-core/lib/events/await/wake-executor.ts`, are `resumeCommandFor`
(builds the `codex exec resume <uuid> <prompt>` args), the `codexHomeForAdvSession`
/ `findCodexRolloutSessionId` recovery pair, and the `env.CODEX_HOME` assignment on
the non-PTY resume path — grep the symbol names, not line numbers (they drift as the
file grows; this doc was de-fragilized to symbol anchors on 2026-07-03 for exactly
that reason). (See also the framing note: `events:await {key}` is now named sugar over a unified `events:watch` primitive —
`events:await {key}` == `watch(key, { wake: true, once: true })`, at
`packages/operator-core/lib/agent-tools/events/watch.ts` — the one-shot-wake
semantics are unchanged.)
:::

## What it is

Agents that needed X-to-happen-before-proceeding used to **poll, block, or
pivot blind** — a lock conflict said "pivot/retry", resource waits held the
turn, plan-run completion was a poll-based sweep. As of
`await-event-primitive-2026-06-05` there is ONE primitive:

```
events:await { event: '<key>', note, timeout_sec, on_timeout: 'wake'|'expire' }
→ END YOUR TURN. You are re-invoked when the key fires (or at the deadline).
```

**Default timeout behavior:** As of 2026-07-03, the default `on_timeout` is **'wake'**,
not 'expire' — an undelivered event at the deadline now wakes you with a TIMEOUT marker
(safe-by-default, await-timeout-fallback-defaults-2026-07-03). This means a caller that
sets a `timeout_sec` deadline but forgets to name `on_timeout` will be woken to re-orient
rather than silently lapsing. Every real caller passes 'wake' explicitly, so this changes
no behavior today — it only guards a future caller who forgets.

Sources fire keys with `events:emit { event, summary, payload, to? }` (agents)
or `emitAwaitedEvent(...)` (host code). The layering (plan D-001): the
**source** resolves who an event concerns (a lock grants to ONE waiter and
emits a targeted key; CI-green broadcasts); the **delivery** layer is dumb —
per recipient, honor their declared policy. `wake` re-invokes you (one-shot by
construction — it can never wake-loop); `notify` (topics, follows) goes to your
coord inbox and **never** wakes.

## The delivery ladder (liveness-adaptive, D-003/D-009)

The wake handle is stamped at **registration** (your coord SID →
`adv_sessions`): it can't be fetched at fire time because you're asleep.
On fire, the executor walks:

1. **Live managed pty** (pid-matched in pty-bridge) → the wake turn is
   injected directly.
2. **Process exited** → your session is **resumed headless, one turn**
   (`claude --resume <native-id> -p ...`, `codex exec resume <uuid> ...`, or
   modern `omp -r <thread> -p ...`) — spawned **detached**, not into a managed
   pty: a pty resume just sits idle waiting on a TTY nothing drives (Stage-B
   finding, 2026-06-07). The managed-pty injection path survives only as an
   explicit fallback for older OMP builds
   (`PAPERCUSP_OMP_RESUME_VIA_PTY=1`, `wake-executor.ts` `resumeCommandFor`).
   `PAPERCUSP_SID` is re-exported so identity, lock hooks, and your other
   awaits survive. claude resume REQUIRES the native session UUID —
   `--continue` would resume a random peer's conversation on the shared cwd.
   **Exception — a drained cup warm-injected a NEW work-item:** the
   cup-context-efficiency fork
   (`packages/operator-core/lib/events/await/wake-executor-fresh-context.ts`,
   flag `BEE_FRESH_CONTEXT_WARM_INJECT`, default ON) skips `--resume`
   entirely and spawns a **fresh session** for that item instead — the
   grown prior-task transcript is dropped, and continuity rides the
   work-item checkpoint (not the session). Fail-soft: any error there falls
   through to the legacy resume above.
3. **Alive but uninjectable** (a detached terminal — the common psu case, or a
   pid-less session row with fresh presence) → **parked** + a one-time inbox
   nudge; the parked wake converts to a resume when your process exits.
   **If the nudge reaches you while awake and you act on it, ACK it:**
   `events:cancel { delivery_id }` — otherwise you'll also be resumed later
   (a wasted turn).
4. **Nothing live, nothing resumable** → dropped VISIBLY (logged + metered),
   never silently.

Delivery is durable (PG queue, at-least-once + idempotent wake): a host
restart re-claims stuck deliveries; a missed lock-grant NOTIFY is re-derived
from waiter-table truth each 30s sweep.

A **cold-loop** wake (a `loop:arm` session PG-parked with its context already reset to a
carry-note, not a live/resumable process) is injected via `injectPsuHost` with the note run
through `renderColdWakeInjection` (`packages/operator-core/lib/su-cold-loop.ts`) — the
injected text frames the carry-note as the agent's entire working state AND tells it to
refresh the note with `loop:checkpoint` before ending the turn (or call `loop:end` if
done/blocked), so a cold wake can't silently go stale after one cycle.

## Finding the key — `events:catalog` + sugar verbs (2026-07-03)

The primitive's remaining friction was **discoverability**, not mechanics: agents kept
polling (`dev:pipeline_position`, `dev:build_status`, re-reading a peer's status) because
they never found the event key that already fires. `event-await-discoverability-and-coverage-2026-07-03`
closes that gap with two additions layered on top of the same `registerAwait` path — neither
is a second subscription system:

* **`events:catalog`** renders the awaitable-key registry
  (`packages/operator-core/lib/events/await/catalog.ts` — the single source of truth): each
  row names the family, the key template + a ready `events:await` example, who emits it,
  whether it fires **today** (`awaitable_now`), the poll it replaces, and its sugar verb. Check
  it *before* you poll. As of this doc's last verify every catalogued key is landed
  (`exists: true` / `awaitable_now: true` for the whole table — the Phase-2 keys that were
  still "catalogued but not wired" (`plan-item:done:<id>`, `claim:released:<id>`,
  `fleet:drained:<slug>`, `service:up|down:<name>`, `session:compacted:<owner>`) all fired their
  emitters since); `awaitable_now` stays the field to check for any *future* addition still
  being wired, not a currently-true caveat. Each row also carries `live_awaiters` — how many
  agents are registered on that key **right now** (EI-9000, 2026-07-10) — and, by default,
  `events:catalog` also lists live **announced gates** (EI-9270 — the leader-declared keys from
  `events:emit { announce: true }` below) visible to your fleet/plan/harness, each with its
  fired/latched state.
* **Named sugar verbs** (`packages/operator-core/lib/agent-tools/events/sugar.ts`) —
  `deploy:await`, `checkpoint:await`, `work-item:await`, `service:await-up`, `git-sync:await`,
  `plan-item:await`, `fleet:await-drained`, etc. — are thin, tool-list-discoverable wrappers
  that build the correctly-shaped key from the catalog and then call the exact same
  `registerAwait`/`startAwaitSweeper` path as raw `events:await`. Dual-outcome verbs (deploy,
  checkpoint) arm both the success and failure keys at once since the two are mutually
  exclusive, so the agent wakes either way with no double-wake risk. Since EI-7646
  (2026-07-05) `checkpoint:await` arms the **pipeline-scoped** pair
  (`release:green:<pipeline>` / `green-checkpoint:red:<pipeline>`) by default — `<pipeline>`
  defaults to the current dev pipeline (`devDeployState()` → `checkpointPipelineName`, the
  repo basename of the integration root; both in `sugar.ts`); pass `pipeline` to target
  another, or `global: true` for the global keys, which fire on EVERY co-hosted pipeline's
  verdict (you must then lineage-check `payload.pipeline`/`payload.sha` yourself). The gate
  dual-emits, so the global names still fire.

Flow: `events:catalog` (find the key) → `events:await { event }` or its sugar verb → end your
turn. This does not change the delivery ladder or cost discipline below — it's purely a
findability layer over the same primitive.

## Pattern awaits — wake on a FAMILY, not one key (P-201, 2026-07-03)

`events:await { event }` also accepts a **pattern**, not just an exact key
(`packages/operator-core/lib/events/await/pattern.ts`): a raw glob (`work-item:done:*`,
`service:up:*` — `*` matches any run of characters) or a friendly macro — `@plan:<slug>`
expands to `plan-item:done:<slug>:*` (any item in that plan finished), `@fleet:<slug>` expands
to `fleet:*:<slug>` (any fleet event for that slug). `isPattern`/`expandPatternMacro` classify
and expand at registration (`events:await.ts`); `assertUsablePattern` rejects a too-broad glob
(fewer than 3 literal, non-`*`/`:` characters) so nobody accidentally wakes on nearly every
emit. One await now covers "any lane item finished" instead of N one-per-item awaits.

Matching reuses `@papercusp/rules`' mingo-backed `matches` operator — the same leaf evaluator
the ECA reaction engine's `when` uses — so pattern semantics stay consistent with rule
conditions rather than a second hand-rolled matcher (`keyMatchesPattern` in `pattern.ts`).
`store.fireAwaitsForKey` fetches the small set of ACTIVE pattern rows (`event_key LIKE
'%*%'`, partial-indexed by `event_awaits_pattern_active`, migration 480) on every emit and
matches them against the fired key in JS; a matching one-shot pattern claims atomically
(mirrors the exact-key once-row claim — a race between two matching emits can never
double-fire the same registration), a matching standing pattern fires without consuming. A
pattern await is itself one-shot by default: it wakes on the FIRST matching key, then you
re-register if you want the next match too.

## Declared gates — announce-first, so a late joiner still catches the fire (EI-9270, 2026-07-10)

For a **hand-minted** key two agents agree on ad hoc (no catalog family), the old advice was
"agree on a string, one side awaits, the other emits" — but a key re-typed from a chat message
drifts (a near-miss), and an agent that registers its `events:await` **after** the emit already
fired waits forever on a key that will never fire again. `events:emit { announce: true }` fixes
both:

```
events:emit { event: 'phase3-open', announce: true }
→ { announced: true, event: 'fleet:<your-fleet>:phase3-open', ... }
```

This **declares** the gate — writes a discoverable, LATCHED row (`registerAnnouncement` in
`store.ts`; `AwaitPolicy` gained a third value, `'announce'`, which is never a delivery target —
every wake/notify path excludes it) instead of firing it. The key is **auto-scoped** from your
narrowest context (fleet → plan → global, `defaultAnnounceScope`/`buildAnnouncedKey` in
`announce-key.ts`) so two fleets both declaring `phase3-open` never collide on the flat rendezvous
namespace (WI-3575). Members discover the declaration via `events:catalog` / `coord:orient` and
copy the **returned** key into `events:await` — never re-type it. When you actually fire it later
with a normal `events:emit { event: '<the returned key>' }`, that emit **also stamps the latch**:
an `events:await` registered on that exact key **after** the fire gets `{ already_fired: true,
fired_at, advice: "... do not wait, proceed now" }` immediately instead of a wait that can never
resolve — the await-after-emit race is closed.

**Near-miss guard (`event-key-nearmiss-guard`):** `events:await` on a key with **zero** active
declarations, and `events:emit` that reaches **zero** waiters (`waiters:0`, no `to[]`), both run a
best-effort, time-bounded (`findNearMissKeys`, \~1s budget) scan for an active near-identical key —
another agent's live await, or a declared-but-unfired gate — and surface it as advisory `near_miss`
/ `near_misses` in the result, with the exact fix ("re-await/re-emit it EXACTLY"). This is
diagnostic only; it never changes what actually fired or registered.

**Payload filters (EI-8998):** both `events:await` and `watch:create` accept an optional
`payload_filter` — a `@papercusp/rules` `DataCondition` (the same `MatchMap`/`all`/`any`/`not`
vocabulary an ECA rule's `when` uses) evaluated against the emitted **payload**, in addition to the
key/pattern match. It turns "wake me when `queue_depth` crosses a threshold" from a bespoke exact
key into `events:await { event: 'some-global-key', payload_filter: { queue_depth: { lt: 5 } } }` —
useful on a `payloadFiltered: true` catalog family (e.g. `release:deployed`, `work-item:created`)
whose real emit is global and carries the subject in the payload, not the key. A filter that never
matches the emitter's actual payload shape silently never fires — check the emitter's payload shape
first (`events:catalog`'s `describe` names it).

## The unified `watch:create` primitive + predicate watches (P-008, 2026-07-10)

`events:await` and `topics:subscribe` are both thin sugar presets over one underlying primitive,
`watch:create(pattern, { wake, once, min_sleep_sec, urgency, timeout_sec, mode, targetKind,
predicate, payload_filter })` (`unify-watch-primitive-2026-06-06`, tool at
`packages/operator-core/lib/agent-tools/events/watch.ts`):

```
events:await {key}       == watch:create(key,   { wake: true,  once: true  })
topics:subscribe {topic} == watch:create(topic,  { wake: false, once: false })
```

`wake: false` (the default) is the **inject** path — a standing subscription delivered to your
coord inbox, zero token cost, no re-invoke. `wake: true` is the durable liveness-adaptive re-invoke
ladder described above. Two additions ride this same registration surface:

* **`targetKind: 'event'` inject subscriptions (WI-4014 Part 2):** `wake: false` normally targets a
  curated **topic** slug; `targetKind: 'event'` instead subscribes to an **exact event key** —
  every future `events:emit` on that key lands in your inbox as a standing, no-token-cost
  subscription (no wake, ever). Retract with `events:unsubscribe`.
* **Predicate watches (P-008):** `watch:create { predicate: { tool, args, path, op, value },
  interval_sec }, wake: true` polls a **read-only** projected tool every `interval_sec` (15–3600s,
  default 60) **under the caller's own role envelope** (the role gate is re-enforced on every poll,
  audited — a predicate poll can only ever observe, never mutate), extracts `path` (a dot-path into
  the tool result, e.g. `counts.open`), compares it against `value` with `op` (`eq | ne | gt | gte |
  lt | lte | exists | contains`), and fires your wake on the **false→true edge** via the same
  `emitAwaitedEvent` path as any other key — so floors, coalescing, `once`, timeout-wake, and
  delivery are unchanged. This kills the "poll the same watermark every wake" pattern
  (`packages/operator-core/lib/events/await/predicate-watch.ts`, migration 541; the poller ticks
  every 10s and self-deactivates after 5 consecutive poll errors, emitting a `predicateError`
  payload so the waiter wakes instead of dangling).
  * **Dedup (`fleet-reliability-verification-2026-07-10` P-004):** registering an **identical**
    predicate (same scope/tool/args/path/op/value/interval\_sec/once) as an already-active one JOINS
    that poller instead of starting a second — the response carries `deduped.joined_watch_id`. This
    closed a real incident: two agents each independently polling the same watermark SQL \~12+ times
    in one night.
  * Registration runs **one inline eval** immediately — a broken tool/role/args fails loudly at
    registration time (not on the first poll tick), and an already-true predicate fires the wake on
    registration instead of waiting one interval.

`payload_filter` is wake-path-only (it filters which await rows fire; an inject subscription has no
per-emit matching step to hook it into) — passing it with `wake: false` throws loudly, same as
passing `predicate` with `wake: false`.

## Cross-machine event federation (P-009, `cross-machine-coord-parity`)

`events:emit { event, scope: 'hive' }` additionally federates the fire to **every machine** of the
workspace's shared Hive: each peer machine re-fires the key into **its own local** await store, so
a remote machine's `events:await` on the same key wakes too (lock grants, artifact-ready,
staging-advanced — rendezvous beyond a plain inbox notify). It requires a resolvable Hive scope
(from `ctx.harnessSlug`, else the workspace's single shared Hive) — the result reports
`federated: true/false` plus `federation_error` (`no_hive_scope` / `ambiguous_hive_scope` /
`payload_too_large_dropped`, >8KiB) when it can't. Best-effort: the **local** emit already happened
before federation is attempted, so a federation miss never loses the local wake. `scope: 'local'`
(the default) is today's machine-local-only behavior.

## The patterns

* **Blocked on a file lock:** `locks:acquire { paths, intent, wake_on_grant: true }`
  → returns `queued_for_wake` + a ticket — end your turn. The wake carries your
  `lock_id` with the TTL **already running**: edit, then `locks:release`. The
  old "pivot/retry" advice is retired.
* **Blocked on a peer:** they tell you a key (or you agree on one) → you
  `events:await`, they `events:emit`. Built-in keys that fire today:
  `work-item:done:<id>`, `work-item:unblocked:<id>` (last blocker settled),
  `plan-run:finished:<runId>`, `plan:draft-ready:<slug>`,
  `conversation:answered:<id>` (coord:ask's miss path names it),
  `release:green` (plus the pipeline-scoped `release:green:<pipeline>` /
  `green-checkpoint:red:<pipeline>` — prefer the scoped keys on a box hosting
  several pipelines, EI-7646), `release:deployed` / `release:deploy-failed`,
  `escalation:resolved:<msgId>`, `handoff:accepted:<msgId>`,
  `rate-limit:paused/reset:gym-judge|gym-ab`, `lock:grant:<ticket>`,
  `work-item:created:<severity>` (payload-filtered global key, EI-8296),
  `git-sync:committed:<sha>`, `service:up|down:<name>`, `claim:released:<id>`,
  `fleet:drained:<slug>`. Check `events:catalog` for the full, current registry — its
  rows now also carry `live_awaiters` (EI-9000: how many agents are actually listening
  RIGHT NOW, not just whether the key is wired).
* **Directed-wake honesty (`coord:send`):** a `coord:send { wake:'required', to:[agent] }`
  that reaches a wakeable addressee but wakes nobody returns **`recipient_absent: true`** —
  a loud miss to act on (they're not running: spawn fresh or pick another addressee), not
  a silent `woken:0`. Use `wake:'optimistic'` when a durable backstop (the Mug survey,
  the inbox itself) catches a miss — and **name that backstop via the `backstop` arg**
  (e.g. `backstop: 'mug-survey re-dispatches'`). Without a declared `backstop`, an
  optimistic miss is now reported just as loudly as a required one (`recipient_absent` +
  the missed agents' fresh `sessionState`) — silence must be consciously claimed, never a
  default; don't pass a fake backstop just to silence the warning, that recreates the
  dead-drop trap. Legacy `wake:true` coerces to `'required'`; broadcast (`*`/`human`) is
  exempt (never wakeable). (directed-wake-honesty-2026-06-14, FF#1)
* **`events:emit` is honest, not strict (D-001):** emit is fire-and-forget
  broadcast — a fact-announcer (`release:green`, `work-item:done:<id>`) doesn't
  know who's listening, so "nobody awaiting" is the normal, correct case. It
  returns an honest `{ woken, notified }` count; the discipline is to **read the
  count** when you care that someone heard you (a `woken:0` means no live waiter
  yet), NOT to expect emit to throw. There is deliberately no strict mode on
  emit — that's the directed-wake-honesty fix for emit (vs `coord:send`'s loud
  `recipient_absent` for a *directed* wake). (directed-wake-honesty-2026-06-14)
* **Wake-at-reset for a rate limit:** you hold a `retryAfterMs` →
  `events:await { event: 'rate-limit:reset:<scope>', timeout_sec: ceil(ms/1000), on_timeout: 'wake' }`
  — the deadline IS the reset wake; an earlier reset emit just arrives sooner.
* **"Re-verify after the next deploy":** await `release:deployed` instead of
  hand-tracking the deferral.

## Cost discipline (D-007) — and what NOT to await

A wake = a re-invocation = a turn = tokens. Hence: `notify` is the default and
never wakes; `wake` requires the explicit verb; wakes are **metered**
(`events:status { meter: true }` — per-agent counts by channel = the
wake-storm detector); mass unblocks re-admit paced (per-tick resume cap +
per-agent single-flight + the fleet governor's `await-wake` admission scope).
Don't await sub-minute bounded waits (just block — a wake costs more than the
wait), ambient interest (that's `topics:subscribe`), or recurring schedules
(the pot/routines own time-wakes; an await is one-shot).

## Gotchas

* **Workspace scoping is normalized.** Awaits/deliveries live in the ONE coord
  workspace regardless of your identity's scoping — an early build registered
  '\*'-scoped awaits that never matched system emits. Event keys embed
  globally-unique ids, so one namespace is collision-free by construction.
* **Exact key by default; glob/macro only if you opt in (P-201).** A plain key
  (`work-item:done:WI-12`) matches only the literal string, same as before. `*` or a
  leading `@` makes it a **pattern** (see "Pattern awaits" above) — don't put a literal `*`
  in an exact key, it will be parsed as a wildcard.
* The store + engine live at
  `packages/operator-core/lib/events/await/` (migration 163:
  `event_awaits` + `event_wake_deliveries`; migration 480: the partial index backing pattern
  candidate lookups); the awaitable-key registry is
  `packages/operator-core/lib/events/await/catalog.ts` (the source `events:catalog` +
  every sugar verb read from); pattern matching is
  `packages/operator-core/lib/events/await/pattern.ts`; declared-gate scoping/keying is
  `packages/operator-core/lib/events/await/announce-key.ts` (EI-9270); predicate watches are
  `packages/operator-core/lib/events/await/predicate-watch.ts` (P-008, migration 541); the unified
  registration tool is `packages/operator-core/lib/agent-tools/events/watch.ts`; the lock bridge at
  `packages/operator-core/lib/agent-tools/locks/lock-grant-bridge.ts`. **Timeout constants
  are unified:** `AWAIT_DEFAULT_TIMEOUT_SEC` (30min, was 4h) and `AWAIT_MAX_TIMEOUT_SEC` (7d) live in
  `packages/operator-core/lib/events/await/types.ts` and are imported by all callers
  (`events:await`, `watch:create`, sugar verbs, the pump) to keep them consistent
  (await-timeout-fallback-defaults-2026-07-03).
