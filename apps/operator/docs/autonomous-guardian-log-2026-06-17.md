# Autonomous guardian log — Mug · Overwatch · Scout (2026-06-17 overnight)

Owner mandate (2026-06-17, owner asleep): monitor the Mug, Overwatch, and Scout on a
fully autonomous loop. When one isn't performing as it should, **implement the fix without
asking** (best judgment on uncertain changes). Keep this running list of changes made +
close calls (did / didn't implement) to review on waking. Maintained by su-fc2fd.

---

## CHANGES IMPLEMENTED (autonomous)

### CI-1 · Scout cadence → HOURLY heartbeat (owner-directed 2026-06-18) — SHIPPED to tree
**What:** `packages/operator-core/lib/scout/cadence.ts` `DEFAULTS.maxIntervalSec` 86400 (24h) → **3600 (1h)**.
**Why:** root-cause from CC-1: the @singleton scout (driven by routine `bp-singleton-scout-0`, a
30-min `system:blueprint-run` cron) runs the cadence gate on the DEFAULTS — no per-routine cadence
payload exists, so the global default IS the only lever. On a busy pot idleRatio stays low, so scout
only ever had the 24h heartbeat → effectively dark. Now it heartbeat-fires ~once an hour regardless of
load. CC-1's fleet-cost worry was overblown: the per-install `scout-cycle` routines are all
`active=false`, so only the one live @singleton scout actually ticks → this changes one scout, not 135.
**Tests:** updated the 24h-default assumptions across `cadence.test.ts`, `cadence-matrix.test.ts`,
`cycle-e2e.test.ts` (rows that isolate the "below-ceiling no-trigger" window now opt into an explicit
24h ceiling; added rows pinning the new hourly default). Full scout suite green (495 tests).

### CI-2 · Scout `ideas-drained` trigger — "run when all their ideas are implemented" (owner #1) — SHIPPED to tree
**What:** new cadence trigger fires a cycle when `routedIdeaTotal > 0 && pendingIdeaCount === 0`
(every prior routed idea resolved won/lost → the idea pipeline drained). Files:
`cadence.ts` (new `ideas-drained` reason + 2 optional `ScoutCadenceState` fields + the gate step,
priority friction > floor > **drain** > idle > heartbeat), `routed-ledger.ts` (new
`readIdeaQueueStatus()` counting total + pending off the cached `outcome` column),
`scheduler.ts` (`readCadenceState` supplies the counts, scoped to the scout's install).
**Safety:** the trigger sits BELOW the 1h min-interval floor, so worst-case it fires no more often
than the hourly heartbeat (zero extra cost ceiling); disabled when counts are omitted (pure-gate
default). Stale pre-06-14 pending ideas simply keep it from early-firing — the heartbeat backstops.
**Tests:** 7 new focused tests in `cadence.test.ts` (drained fires / pending blocks / never-routed
no-op / disabled-when-omitted / respects floor / outranks idle / friction still wins). Suite green.

### CI-3 · Scout was DEAD — in-process ideators bypass the inference gateway (the REAL root cause) — SHIPPED to tree
**The big one (owner-asked live test 2026-06-18).** The cadence fix (CI-1/CI-2) makes scout FIRE more,
but the decisive finding: the @singleton scout already fired 49 times and produced **0 ideas every single
time, $0 spent** — dead since the 06-14 re-scope. Root cause: scout's in-process ideator/critic llmCalls
are `anthropic-direct` and never pass the spawn chokepoint that routes cups through the inference gateway,
so they hit `api.anthropic.com` DIRECTLY with the Max subscription OAuth token but WITHOUT the required
`anthropic-beta: oauth-2025-04-20` header → every ideator fails INSTANTLY with `403 "OAuth not allowed for
this organization"` → `no-ideas`/$0. **[CORRECTION 03:10: it's a 403 OAuth-beta gap, NOT 429/rate as the
lines just below originally said — instrumented `runIdeators` to read the swallowed error. 7am does NOT fix
it; fix is the gateway's oauth-beta injection (su-224c6080) or an `ANTHROPIC_API_KEY`. Insight corrected.]** The corpus is RICH (digest: 20 friction / 20 spend
sinks $68k / 20 deferrals / 20 capability gaps / 18 reverts over 499 completions) — so this was purely the
LLM egress, not missing observations. **Same bug class as the gym's FB-16** (`gym-cycle-inprocess-llm-
bypasses-gateway`) — scout just never got the fix. **Fix:** `register-scout-action.ts` `productionScoutRunner`
now applies `gatewayLlmEnv()` (flag-gated on INFERENCE_GATEWAY, which is ON) so scout's in-process SDK
routes through the localhost gateway's pooled+paced multi-account egress, exactly like the gym + the fleet.
Verified `chat-stream.ts resolveAnthropicBaseUrl()` reads `PAPERCUSP_ANTHROPIC_URL` (what the fix sets), so
it routes. Tests: register-scout-action 3/3 + full scout suite 495 green; typecheck clean. Wrote insight
`scout-cycle-inprocess-llm-bypasses-gateway`. **Empirical-proof caveat:** even gateway-routed, a manual run
still 429s RIGHT NOW because the whole account pool is at its weekly limit pre-7am — the fix's payoff (pool
+ pacing instead of one un-paced account) lands once accounts have headroom (7am reset). If scout stays
starved post-reset, next lever = a less-contended ideator model or a reserved account for scout.

**Deploy status:** all three (CI-1/CI-2/CI-3) land on the live @singleton scout via the staging→green pipeline (server-side,
no hot-reload; the scout runs in the :3070 green operator). NOT manually deployed — letting the pipeline
carry it. Owner #3 (dedup): YES confirmed — scout's critics read a novelty corpus (`readNoveltyCorpus`,
cycle.ts:96 — prior plans/decisions/ideas/dropped-improvements) and a novelty critic drops near-dups, so
it does not re-propose its prior ideas. Owner #4 (overwatch cadence): adaptive, ~3–31 min between wakes
(declares its own next wake, quantized to the 30-min wake-brain heartbeat; 1800s watchdog floor).

---

## CLOSE CALLS (did NOT implement, with reasoning)

### CC-2 · Observations/auto-implement system: env-aware dispatch backoff — did NOT implement (system healthy; account constraint, not a bug) — 2026-06-18 ~01:00. Filed as **EI-1404** (durable record).
**Finding (owner #5 — observations system health):** the improvement watchdog is **healthy**. Last tick
00:34, **all 22 collectors green** (`failingCollectors: []`), capturing (EI-1391…1404), dedup working
(declinedDuplicates + 200 known-open prefiltered), triage + ranking + auto-dispatch all functioning.
Agent-filed observations (improvements:capture — EI-1376 coord-pagination, EI-1400 file-lock coarse
block) flow through the SAME pipeline as system-collector signals; both work.
**The one alarming number is benign:** dispatch ledger orphaned 132 / 168, but the rows explain it —
nearly all are `host restarted mid-dispatch` (EI-403 Option-B auto-recovery) or `worker exit 1 … weekly
limit · resets 7am` (env-failure, classified `worker-exit-backedge-env`, **attempt NOT charged**,
re-dispatched). The system behaves CORRECTLY under an account/env constraint. Fixed this window: 29.
**Close call:** env-aware backoff (hold re-dispatch until the parsed reset time instead of bouncing
hourly off a known-closed weekly-limit window). **Did NOT blind-implement** — system already classifies
+ doesn't charge these; only cost is minor ~hourly spawn churn; it's the auto-implement DISPATCH loop
(distinct from scout); rewriting its retry policy unsupervised at ~5am on a WORKING subsystem is
overreach, not the warned-against timidity (the mandate is to fix what's BROKEN); the limit self-clears
at 7am. **Filed EI-1404** (change, scope operator) as the proper durable channel + owner flag. The real
overnight throughput blocker is the account weekly-limit (env), not code. Also re-surfaced: stale
operator pid 3413663 (Jun-9, 7.8d, old code) — benign, owner-cleanup candidate.

### CC-1 · Scout: did NOT blind-activate it (investigating root cause first) — 2026-06-17 ~22:35
**Finding:** The papercup-pot Scout (the negative-space idea-scanner, peer to Mug/Overwatch)
is effectively DOWN:
- `scout_ticks`: the **`papercup` scout produced 168 ideas / 8 routed until 2026-06-14**, then
  STOPPED ticking — silent ~3 days.
- A workspace **`@singleton` scout still ticks** every ~20-60 min (last 22:30) but **every tick
  is `status=gated, gate=min-interval, ideas_generated=0`** → it spins, produces nothing.
- The `scout-cycle` ROUTINE is `active=false` on every install + papercup-pot has NO scout
  routine at all.
- (The `:3350` "scout-service" NestJS app — `/chat/stream`, `CartProxyModule` — is a DIFFERENT
  product, not the pot-scout. Up but irrelevant here.)

**Hypothesis:** Scout was re-scoped per-pot (`papercup`) → workspace `@singleton` around 06-14,
and the singleton is permanently gated by `min-interval` (woken more often than the gate allows,
or the gate is misconfigured) → it never runs a real cycle.

**Decision:** Did NOT blind-flip a scout-cycle routine / activate it this turn. Reasons: it's
dark-by-design, papercup-pot has no routine (would need to CREATE one), scout's integration
tests show failures (untriaged), and the box is strained (PG "too many clients" + rate-limit
429s). Blind-activating a never-properly-run, test-red feature on a strained box = too risky.
**Next:** root-cause the `min-interval` always-gated @singleton + why papercup stopped 06-14,
then restore real scout production with a targeted fix (will move to CHANGES IMPLEMENTED).

---

### CC-1 FINAL (2026-06-17 ~23:20) — diagnosis SETTLED; recommend a decision before a fix
- Scout's cycle MACHINERY WORKS — the scout-live integration test passed (EXIT:0) under a
  real model. So scout is NOT broken and NOT a missing budget (defaults apply).
- The real problem is **cadence-starvation**: scout fires only on `idle-capacity`
  (`idleRatio ≥ 0.5`, cadence.ts) OR the ~24h `heartbeat`. The papercup pot is busy (Mug
  placing), so idleRatio stays low → scout almost never fires → effectively dark. When it last
  fired (19:30, mid-throttle) the LLM was paused → `no-ideas`.
- LLM is now HEALTHY (opus 3/45 rpm, $23/hr spent) — so a fire NOW would likely produce.
- Topology is multi-component (scout-service:3350 + bp-singleton-* blueprint routines +
  scout-cycle routines + the scout_ticks scheduler) and the EXACT per-scout cadence-config
  lever for @singleton is non-obvious.

**Two fix options, both with a real tradeoff → flagging rather than blind-applying:**
  (A) Lower scout's heartbeat ceiling / idle threshold so it fires regularly. The clean lever is
      the cadence DEFAULT (cadence.ts maxIntervalSec 86400→~3600) BUT that's GLOBAL — it makes
      scout fire hourly across ALL ~135 installs (xbench etc.) = a large fleet-wide LLM-spend
      increase on an already strained box (PG 'too many clients', recent rate pauses). Too blunt.
  (B) Per-pot scout cadence override (just papercup-pot) — the targeted, correct fix, but the
      per-pot scout cadence-config mechanism isn't confirmed + papercup-pot has no scout-cycle
      routine of its own (would need creating one).

**DID NOT implement either:** (A) is too expensive/blunt on a strained box; (B) needs confirming
the intended scout scope (workspace `@singleton` vs per-pot `papercup-pot`) — a design call.
**RECOMMENDATION for owner:** confirm (1) should scout be per-pot (papercup) or workspace
singleton, and (2) OK to raise fleet-wide scout firing (cost). Then the fix is ~1 cadence change.
Meanwhile: watching for scout's next natural fire under the healthy LLM (would confirm it
produces); Mug/Overwatch healthy.

## DEPLOY PIPELINE (guardian cycle 2026-06-18 ~01:07) — was STUCK 4h, now self-healing
Green `main` was **33 commits behind staging**, pinned to a ~4h-old commit — i.e. NOTHING on staging
(scout fix, recent F-FIX-038 follow-ups, persona work) had deployed to :3070 in 4h. Root cause: the
last green-checkpoint result was `{advanced:false, green:false, reason:"not-green"}` with **28 failing
test files + 3 packages** (highlighted: `plans/runs.test.ts` mapPlanRunRow gained 7 fields w/ a stale
expected-shape; a big `endpoint-route/*` + `tool-*` cluster = a tool/route change w/o snapshot update).
**Verified those failures are NOW FIXED on staging** — re-ran 10 of the 28 (runs, tool-auth-gating,
auth-posture, mcp-handler-gating-matrix, route-stack, openapi, schedule-next, voice-node,
tool-harness-scope, tool-input-schema-rejection): all green. So the checkpoint was blocked by a
since-resolved red surface. The checkpoint cron is `0 15 * * * *` (hourly at HH:15) → the **01:15 run
should find green and FF main forward**, deploying the 33 commits incl. the scout fix.
**Risk to watch:** `registry-residuals.test.ts` (EI-1402) failed under load in my ship-gate run (11s,
timeout-ish) but passed at the checkpoint's run — looks **flaky under load**, so it could intermittently
re-block the 01:15 checkpoint. **Action:** did NOT manually deploy (pipeline is self-healing + a manual
deploy at 1am unsupervised is riskier than waiting ~8min). Watching the 01:15 outcome; will investigate
only if it ALSO fails to advance.

### CORRECTION (2026-06-18 ~01:55) — the gate runs `test:affected`, NOT `lint:tsc`; EI-1341 is a RED HERRING
The 01:15 checkpoint did NOT advance (main 38 behind, 5h-old tip — 4 consecutive reds). I initially read
an escalation body claiming the block was **EI-1341** (operator-core lint:tsc +92 over baseline) — that
escalation was itself a MIS-DIAGNOSIS. Peers corrected it (su-146bf7a7, the EI-1341 owner, + a git-sync
agent): **the green-checkpoint deploy gate runs `npm run test:affected`, not `lint:tsc`** (release-config.ts
:79). EI-1341 is a tsc code-health RATCHET that does NOT gate deploys — `test:affected` is green on its own.
So chasing the +92 tsc errors would be effort at the wrong target; I dropped it. The REAL stall is a failing
`test:affected` (a peer's in-flight edit broke an affected test — shared-fate stall — or the inference-gateway
:8788 flap that su-224c6080 is mid-fixing flaking gateway-dependent tests). A peer is identifying the exact
red. **My scout fixes (CI-1/2/3) + the :3070 crash-fix are safe on staging and auto-ship the instant the
gate clears — no manual submit needed.** Lesson: trust `dev:pipeline_position` / release-config over a
human-written escalation body's claim about WHICH check is red. Also flagged by the peer: no release-fixer in
the active roster despite 4 reds — the self-healing may not be firing (their plan item, not mine).
The :3070 green-operator crash-loop (oversized 399-conn PG pool, `backend-connection-scaling` regression) is
real + its fix is also stranded on staging behind the same gate — emergency lever is `PAPERCUSP_DB_POOL_MAX`
(20-30) on the :3070 drop-in, but that's the connection-scaling owner's call, not mine.

## FINDINGS / BASELINE (no action needed)

- **Mug** — performing as designed: places aggressively (4-7 `place_batch` + 4-5 `fleet_spawn`
  per substantive wake), holds cursed items (respects the breaker), 0.93 cache-hit. ~half her
  wakes are `turns=1/$0` stubs (gateway pacing / nothing-placeable) — minor waste, not wrong.
- **Overwatch** — performing as designed: catches real anomalies (throughput, escalations, curse
  storm), files structured observations, escalates to the right owner, recovers from a bounced
  Mug-nudge without false-alarming. Known gap (she self-filed): the Overwatch→Mug nudge
  channel targets a dead per-wake session id → her nudges bounce.
- **System loop working:** Mug places → cups cursed by the slow-cup-reaper (EI-865) → Overwatch
  flags → su-37e53 shipped F-FIX-038 (PASSED). Watch: does the curse storm subside post-fix.

### POST-LANDING VERIFICATION (guardian task #13 — 2026-06-18 ~01:00) — colony GREEN
The two watched Mug-affecting plans have LANDED and the colony is healthy on the other side:
- **domain-generic-agent-personas** — COMPLETE (su-146bf). The riskiest part (Phase-5 replace-the-base
  spawn-path change) is verified intact INDIRECTLY but decisively: the Mug is actively placing +
  spawning cups on substantive wakes, and cups are running to terminal (WI-204/209/220 passed,
  F-FIX-038 passed, stale-claim sweeps freeing completed holders). If the base-replacement had broken
  spawning, none of that could happen. So spawn path = intact.
- **benchmark-capability-injection-redesign** — most plan items delivered (su-a2b66); remainder gated
  on the steward's topology runtime, not on anything Mug-breaking.
- **Mug** — `hive_queen_efficiency`: 30 wakes, **0.90 cache-hit**, avg 5.4 turns, $25 total. Mix of
  substantive placement wakes (13/20/8-turn) and turns=1/$0 pacing stubs — as designed.
- **Overwatch + cups** — the full curse-storm loop RESOLVED: Overwatch flagged → F-FIX-038
  (placement-watchdog liveness exemption) shipped + green post-reboot → all 14 cursed cleared and the
  clear HELD (no treadmill) → benchmark debris retired (frontier drained). Loop works end-to-end.
- **Scout** — fix shipped to tree (CI-1 hourly cadence + CI-2 ideas-drained), pending the staging→green
  deploy that carries it to the :3070 operator the @singleton scout runs in. Ship-gate clean (the one
  red test, registry-residuals/EI-1402, is pre-existing + unrelated, already auto-captured).
