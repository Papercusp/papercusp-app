# plans:list/attention egress is poll-FREQUENCY, not payload — and deltas cut bytes, not call count
URL: /internal/docs/agent-insights/plans-egress-is-poll-frequency-not-payload

Historical investigation of why plans:list and plans:attention generated high egress. The durable lesson: payload deltas reduce bytes, while invalidation-driven reads reduce call count; measure each separately and attribute traffic at the route/client layer. Current status: the tight poll was replaced by useSyncQuery/SSE plus a 180s drift-repair tick, and later fixes deduped invalidation fanout and need-gated TUI plan fetches. Includes verification queries and transport gotchas.

## ⚠ STATUS CORRECTION — 2026-08-09: the COUNT lever shipped. Read this before acting on anything below.

**This page's analysis is still correct. Its present-tense STATUS claims are not.** It was
written 2026-06-23 and describes a fixed \~4 calls/sec UI poll as a live, unfixed problem. That
poll is gone. Three claims below are now FALSE and are flagged inline where they appear:

* the frontmatter's closing "the count waste is not touched" — it was subsequently touched;
* "The poll cadence is **fixed and decoupled from data change** — it is NOT invalidation-driven";
* "the same \~4/sec, flat-around-the-clock shape".

`plans.list` and `plans.attention` are **invalidation-driven today**: consumed via `useSyncQuery`
(`apps/operator/app/admin/plans/plans-api.ts` L996 / L1184 / L1211), registered as sync-resolver
queries (`sync-resolver/index.ts:3199` / `:3274`), with `notifySyncInvalidate` fired across the
plan write path.

Measured on the **same** `transport='http'` population this page measured:

|                   | this page (2026-06-23)     | measured 2026-08-09       |
| ----------------- | -------------------------- | ------------------------- |
| `plans:attention` | \~4 calls/sec (\~187K/day) | **2,806/24h = 0.032/sec** |
| `plans:list`      | \~4 calls/sec (\~187K/day) | **1,494/24h = 0.017/sec** |

That is a **\~66–125× reduction**, and one client (`pc-admin-plans-ui`) is still \~99.9% / \~95% of
each — the agents were never the load, exactly as this page said.

**The method that settles poll-vs-push — use this, not a raw total.** Compare the **FLOOR in the
quiet hours**, not the peak. A fixed interval has an arithmetic floor independent of activity
(30s ⇒ 120 calls/hr; 180s ⇒ 20/hr). Invalidation-driven traffic has no floor and decays toward
zero when writes stop. Measured here: quiet hours floor at **9 calls/hr, tracking plan-writes
\~1:1** (12:00 → 9 calls / 9 writes; 11:00 → 9 / 10). That single comparison falsifies every fixed
interval in one step, and unlike a raw total it is immune to the "how long was the UI open"
confound.

**What genuinely remains** (both narrow, neither is the poll this page describes):

1. **No debounce/coalesce on invalidation → refetch.** \~3 *identical* calls per burst (161 bursts
   in 6h; all 292 calls in a 3h sample carry one arg shape, `harness: "all"`, `payloadTier: "full"`).
   Upper bound if perfectly coalesced: \~⅔ of \~2,800 calls/day.
2. ~~No drift-repair backstop on these two feeds.~~ **WITHDRAWN — there IS one.**
   `HarnessSyncProvider` runs a **180s** drift-repair tick (`DEFAULT_SSE_DRIFT_REPAIR_MS = 180_000`,
   `HarnessSyncProvider.tsx:57`, the default for `ssePollIntervalMs` at `:211`), which replaced a
   shared 5s `pollIntervalMs`. That tick is the \~180s modal inter-call gap in the measurement
   above. So the backstop exists at the transport layer and covers these feeds. Note this means
   **both halves of the original prescription shipped** — SSE push on the write *and* a long
   drift-repair poll — which is why the only genuine residual left is (1).

**Why this correction was written.** The stale status claims kept a plan item (P-023 of
`semantic-search-fingerprint-coverage-2026-08-03`) looking like live work months after its fix
shipped. An agent acting on this page recorded a decision (D-049) concluding the poll was still
live — reasoning from call VOLUME without opening the client — and had to retract it (D-050) an
hour later. A doc that wrongly reports work as UNDONE fails silently and expensively: nothing
contradicts it, and it diverts effort into rebuilding what exists.

## The mistake this prevents

Seeing `plans:list` at \~340GB/7d (the #1 read-byte tool, \~25× the next) and concluding the
fix is **payload size** (a slim projection / TOON re-encode) or that the **rows-delta rollout
fully solves it**. Both miss the shape of the traffic.

## What's actually true (measured `harness_shared.tool_invocations`)

* **It's \~100% the desktop UI, not agents.** `transport='http'` ≈ 560K calls each for
  `plans:list` and `plans:attention` over 3d; `transport='mcp'` (LLM/agent) was **\<100**. The
  340GB is UI polling, not tool calls in agent context. (So a token/encoding optimization on the
  agent path — TOON, slim args — buys \~nothing here; the payload is already >16KB so it falls
  back to plain JSON anyway.)
* **\~4 calls/sec EACH, in lockstep.** Hour-by-hour the two tools have near-identical counts —
  one UI poll cycle fetches both. Steady around the clock.
  ⚠ **STALE (2026-08-09)** — no longer \~4/sec and no longer steady: `plans:attention` is
  0.032/sec, `plans:list` 0.017/sec, and hourly volume now swings 9 → 228 because it tracks plan
  WRITES, not a clock. See the status correction at the top.
* **\~500–2000:1 read:write ratio.** In a representative window: \~13–15K reads/hour vs **6–27
  plan-table writes/hour**. The data changes once every few minutes; the UI re-reads it \~4×/sec.
  **\~99.9% of reads are byte-identical to the previous one.** The poll cadence is **fixed and
  decoupled from data change** — it is NOT invalidation-driven.
  ⚠ **STALE (2026-08-09)** — it IS invalidation-driven now (`useSyncQuery` +
  `notifySyncInvalidate`), so the cadence is COUPLED to writes. No TIGHT fixed poll remains; what
  is left is the deliberate **180s** drift-repair backstop (`DEFAULT_SSE_DRIFT_REPAIR_MS`), i.e.
  exactly the "long drift-repair poll" this page prescribes. Proof the tight poll is gone: quiet
  hours floor at 9 calls/hr tracking writes \~1:1 — below even a 180s tick's 20/hr, and far below
  the \~14,400/hr a 4/sec poll would produce.

## The two independent levers (don't conflate)

1. **BYTES — the rows-delta / `not_modified` protocol.** `FLAGS.SYNC_RESOURCE_DELTA` graduated
   default-ON 2026-06-23; `resource-delta-config.ts` registers both `plans.list`
   (`itemKeyField:'slug'`) and `plans.attention` (`itemKeyField:'key'`); the client lists both in
   `DELTA_RESOURCES` (`sync-delta-codec.ts`). A cursor-sending client gets `not_modified` (or a
   one-group/one-row delta) instead of the full \~400–600KB. This collapses the \~99.9% unchanged
   reads and is the correct fix for the byte volume. **It will not show in
   `tool_invocations.output_size`** — that column records the full computed tool result; the delta
   saving happens in the rest-query handler *after* the tool returns. Measure the win at the HTTP/
   wire layer, not in `tool_invocations`. (`plans:attention`'s payload was already cut \~20× by its
   earlier delta exemplar — avg \~12MB→\~550KB after 2026-06-20 — visible in `avg(output_size)`,
   because that was a payload *shape* change, not the wire delta.)

2. **COUNT — the poll cadence.** Deltas make each of the \~4/sec calls *cheap on the wire*, and
   `cachedRead` (see \[caching-an-expensive-tool-read]) makes each *cheap on the server*, but
   **the call still happens** — a full tool invocation + cache lookup + delta computation + round
   trip, \~13K/hour/tool, almost all returning "nothing changed." With a \~1000:1 read:write ratio,
   a fixed \~4/sec poll is the wrong model. The lever is to drive these reads from **invalidation**
   (an SSE push on the rare plan write) plus a **long** drift-repair poll — not a tight fixed
   interval. This is independent of the delta work and is the larger remaining structural waste.

## How to verify / re-measure

```sql
-- transport split (is it UI or agents?)
SELECT tool_name, transport, count(*)
FROM harness_shared.tool_invocations
WHERE tool_name IN ('plans:list','plans:attention') AND invoked_at > now() - interval '3 days'
GROUP BY 1,2 ORDER BY 3 DESC;

-- the read:write ratio (the decisive number)
SELECT date_trunc('hour', invoked_at) hr,
  count(*) FILTER (WHERE tool_name IN ('plans:list','plans:attention')) AS reads,
  count(*) FILTER (WHERE tool_name ~ '^(plans:set-status|plans:add-item|plans:edit|plans:new|work_items:set_state)') AS writes
FROM harness_shared.tool_invocations
WHERE invoked_at > now() - interval '2 hours' GROUP BY 1 ORDER BY 1 DESC;
```

If `reads ≫ writes` and the per-hour read count is flat around the clock, the bottleneck is poll
cadence (lever 2), not payload (handled by lever 1). Tracked as **EI-2661** (egress) / **WI-545**
(move the UI poll onto an SSE/sync delta or `not_modified`).

## Re-verified 2026-07-02 — diagnosis still holds; two new code additions don't change it

Re-ran this doc's own SQL against current `tool_invocations`: still **\~570K `plans:list` /
\~568K `plans:attention` HTTP calls / 3d** (`transport='mcp'` still \<100 for both), still a
**\~500:1 read:write ratio** (21,731 reads vs. 44 matched writes over a 2h sample), still flat
around the clock. Lever 2 (poll cadence) is **not yet addressed** — the numbers are essentially
unchanged from this doc's original 2026-06-23 measurement.

Two things changed in the anchored code since then, neither of which moves the byte/count
conclusions above (both land on the negligible **agent/MCP** path, not the dominant UI path):

* `plans:list` gained server-side `compact` / `order` / `limit` / `createdSince` / `updatedSince`
  args (Build P-005, 2026-06-21) — lets an agent fetch a cheap, filtered directory scan instead of
  every plan. The UI's `plans.list` sync resource does not pass these, so the \~340GB UI figure is
  unaffected; this is a lever for the \<100-calls/3d agent slice only.
* `plans:attention` gained per-tier payload shaping (`attention-shape.ts`,
  context-trimming-tiers-2026-07-01 P-021) — trims a trimmed/standard MCP-tier caller to group
  summaries + top-N items instead of the full \~1.09MB average payload. The HTTP/sync path (what
  the UI reads, `ctx_tier`-less) still gets the full untrimmed shape, so again this targets the
  agent path this doc already found "buys \~nothing" on the dominant traffic.
* `plans:attention`'s \~10 sources also now run concurrently (`Promise.all`, infra-perf-robustness-
  audit-2026-06-18 P-005) instead of sequentially — a latency fix (p50 \~2s → lower), not a call-
  count or byte-volume change; each poll is still one full aggregation.

`HarnessSyncProvider.tsx`'s SSE transport already runs an invalidation-driven refresh with a
180s drift-repair backstop (`DEFAULT_SSE_DRIFT_REPAIR_MS`, replacing what was a shared 5s
`pollIntervalMs`) — but that landed 2026-06-10, *before* this doc's original 2026-06-23
measurement, and the re-measurement above shows the same \~4/sec, flat-around-the-clock shape

:::note\[⚠ STALE (2026-08-09) — and the open question below is now ANSWERED]
The "same \~4/sec, flat-around-the-clock shape" no longer holds: volume has fallen \~66–125× to
0.032/sec (`plans:attention`) and 0.017/sec (`plans:list`), and it is no longer flat — it tracks
plan WRITES. The question this paragraph poses ("something else is generating it") therefore has
no phenomenon left to explain: the traffic is invalidation-driven plus the deliberate 180s
`DEFAULT_SSE_DRIFT_REPAIR_MS` tick. The paragraph is kept as the historical record of the 2026-06
state. See the status correction at the top of this page.
:::

regardless. So the still-live traffic is not explained by "SSE hasn't gotten the long-drift-repair
fix yet" — something else (many concurrent open sessions each on their own drift-repair tick,
frequent SSE→POLLING fallback, or another caller entirely) is generating it. That's a genuine open
question this doc can't resolve from a snapshot query; re-run the SQL above with a `spawn_id` /
`role` breakdown to attribute it before assuming "it's the desktop UI" without checking.

## Root cause found + FIXED 2026-07-02 (WI-840, third pass) — the raw PG-trigger bridge bypassed the dedupe entirely

Two prior scoping passes (2026-07-02, `su-af6170b0`) confirmed the traffic was real and ruled out
`spawn_id`-based attribution (every unauth/SU-bearer HTTP request mints a fresh `ephemeral-<16hex>`
spawn\_id — 1:1 with request count, so it can't distinguish "one session polling" from "many
sessions"), but did not find the actual mechanism. This pass did, by reading
`libs/generic/sync/src/server/invalidation-bus.ts` end to end instead of only the client:

* **The traffic source is confirmed to be `pc-admin-plans-ui`** (`packages/operator-core/lib/
  endpoint-route/routes/admin/plans.ts`'s synthetic client id for `/api/admin/plans/*` — the Plans
  admin dashboard, `apps/operator/app/admin/plans/PlansClient.tsx`), via `useSyncQuery('plans.list' | 'plans.attention', …)` — **already on the SSE architecture**, exactly as this doc's line 104
  says. It is NOT bespoke `fetch + setInterval` polling.
* **The actual driver: `harness_shared.harness_plans` is bridged to 8 query names**
  (`plans.list`, `.get`, `.items`, `.attention`, `.search`, `.byHive`, `.schedule`,
  `.scheduledOccurrences` — `sync-resolver/table-to-query-names.ts`), all full-bust (bare-string,
  no scoping registered yet for this table). A Postgres trigger fires `<schema>.harness_plans.
  changed` on **every row write** — and with dozens of concurrent fleet agents each calling
  `plans:set-now` / `plans:set-status` / `plans:add-item` / etc. across the workspace, that's a
  near-continuous write stream (not the \~10-30/hour this doc measured on 2026-06-23, when fleet
  concurrency was far lower — write volume scales with **agent count**, not human viewers).
* **The bug: `notifyInvalidate()`'s 90s source-side dedupe (`invalidation-bus.ts`'s
  `dedupeWindowMs`, meant to "collapse a chatty per-row reconcile") only covered EXPLICIT
  `notifySyncInvalidate(...)` call sites in application code.** The PG-trigger-bridged path
  (`onMessage()` → `bridge()` → `fanout()`) called `fanout()` **directly**, bypassing the dedupe
  map entirely — so every one of those 8 bridged full-bust targets fanned out, unthrottled, on
  every single `harness_plans` row write, to every live SSE subscriber (every open Plans-admin
  tab/window). That is the poll-shaped traffic this doc measured: it isn't a poll at all, it's an
  invalidation storm whose rate tracks fleet write-rate 1:1 — which is why it never showed up as
  "SSE fell back to POLLING" (line 108's hypothesis) and stayed flat/high regardless of the 2026-06-10
  drift-repair fix (that fix only bounds the SAFETY-NET tick; it can't bound invalidation-driven
  refetches, because those were never throttled at all).
* **Fix landed**: `invalidation-bus.ts` now runs bridge-synthesized targets through the SAME
  dedupe helper (`shouldFanout`, extracted from `notifyInvalidate`'s inline check) as explicit
  calls, keyed by `name + JSON(args)` — so a full-bust target throttles to ≤1 fanout per
  `dedupeWindowMs` (default 90s) regardless of how many rows in the bridged table were written in
  that window, while a *scoped* `{name, args}` bridge target (once any table registers one — none
  do yet) still fires per distinct key, since different args produce different dedupe keys. This
  is generic to the whole bridge registry, not plans-specific — every table→query-name mapping in
  `table-to-query-names.ts` gets the same protection. Verified via new unit tests in
  `invalidation-bus.test.ts` (bridged full-bust dedupe / per-target independence / scoped-target
  non-cross-suppression) and a full `npm run test:affected` run (no regressions). Not yet
  re-measured against live `tool_invocations` post-deploy — the fix reduces invalidation *count*
  server-side; re-run this doc's SQL a few hours after it ships to confirm the `plans:list`/
  `plans:attention` HTTP call rate actually drops, and to see whether another bridged table now
  dominates instead (any hot table under sustained multi-agent write load had the exact same
  unthrottled-bridge exposure until this fix).

## Re-measured 2026-07-03 (su-6c9e4, EI-7028) — WI-840 landed; today's dominant traffic is the pui dock via the ADMIN PROXY, not the sync path

Post-WI-840 re-measurement, with a **route-level** attribution this doc's earlier passes lacked
(`harness_shared.route_invocations` — records method+path+principal per HTTP request, where
`tool_invocations` cannot distinguish the two proxies because BOTH stamp `uiClientId:
pc-admin-plans-ui` via the shared plans-read dispatcher):

* **The sync rest-query path is now QUIET** — zero `/rest-query*` route invocations in the
  measured hour. WI-840's bridge dedupe is deployed and the invalidation-storm-driven UI
  refetch traffic this doc's third pass diagnosed is gone from the route log.
* **Today's dominant traffic: `GET /admin/plans/:verb` — 1,090 req/hr, `principal_kind=system`,
  bearer-token.** That is **`apps/tui` (the pui dock)**: `client.rs` `plans_list()` /
  `attention_typed()` GET `admin/plans/list|attention`, driven by `main.rs refetch_all` (every
  panel, on SSE-invalidate + a 60s safety net) — and the desktop dock runs **5–9 pui processes**
  (`pui chat`, two `brain-view`s, `dock-driver`, `wake-pane`, …), each with its own loop. At
  \~1.18MB per attention response and \~555KB per list response that is the \~50GB/day residual.
* **Verified NOT the desktop webviews**: fetch-taps + `performance` resource entries in both
  live Tauri webviews show zero rest-query/admin-plans calls; neither visible page subscribes
  plans queries.
* **The rows-delta client seam (SYNC\_RESOURCE\_DELTA, P-006) is live and the server half is
  PROVEN** — a cursor round-trip against `/api/zero-harness/rest-query-batch` returns
  `mode:delta` at **8.8KB vs 1.18MB full (134x)** — but it only covers the sync path, which is
  no longer the traffic. Do not verify it via `tool_invocations.metadata deltaMode`: that field
  records the TOOL-layer delta, not the wire negotiation (always reads `full` on this path).
* **Fix direction for the pui residual** (EI-7028): the trimmed payload shape ALREADY EXISTS
  server-side (`attention-shape.ts` `shapePlansAttention(data, tier)`, built for MCP ctx-tiers) —
  expose an opt-in `?tier=trimmed` on the `/admin/plans/:verb` proxy and have pui pass it
  (its panes render top-N items, not 1.18MB); and/or move `refetch_all`'s plans reads onto the
  delta-negotiated sync endpoint. Beware `apps/tui/src/models.rs` typed parsing when changing
  the shape. **Update 2026-07-26:** the batch endpoint named above is deprecated and client-less
  (drop-sync-batcher-2026-07-25) — the same delta negotiation lives on `GET /rest-query`
  (`?delta=<cursor>`, `?delta=` cold), so target that, not `rest-query-batch`.
* Meta-gotcha that stalled this diagnosis: the deleted polling transport's `batch-fetcher.ts`
  (deleted 2026-07-26; the delta wiring now lives in its replacement,
  `libs/generic/sync/src/transports/polling/query-fetcher.ts`)
  contained a raw NUL byte (cache-key delimiter), so ripgrep classified it BINARY and every
  content search skipped it — the delta wiring looked absent when it wasn't. Fixed to the
  escaped form (backslash-u0000) 2026-07-03; if a file's matches mysteriously don't appear,
  check for NUL bytes.

## Fixed 2026-07-03 (su-6c9e4, EI-7028) — pui pinned panes now fetch only what they render; `?payloadTier=` already works on the admin proxy

Two findings closed this out:

1. **The payload-tier lever already works end-to-end over the admin proxy — no
   server change was ever needed.** `payloadTier` is a FRAMEWORK-RESERVED
   per-call arg (`extractPayloadTier` in `libs/generic/tooldef/src/payload-tier.ts`
   strips it from raw input BEFORE schema validation), and the proxy's
   `bodyFromSearchParams` forwards unknown query params verbatim into the tool
   body. Live-verified on `:3070`:
   `GET /api/admin/plans/attention` 1.10MB → `?payloadTier=standard` **40KB
   (27x)** → `?payloadTier=trimmed` **21.5KB (51x)**; `/list` 521KB →
   standard **87KB (6x)**. This works for ANY shaped tool on any HTTP dispatch
   path — remember it before building a new "trim this endpoint" param.
2. **The pui fix that landed is need-gating, not tier-switching** (zero UX /
   parse-shape risk): a pinned dock pane (`dock-driver`→Fleet, `wake-pane`,
   `prompt/mail/work-pane`→AgentCtx, `network/pot-pane`→Network,
   `plans-pane`→PlansBoard) runs the FULL `refetch_all` but renders ONE tab —
   8+ live panes were each pulling 1.1MB attention + 0.52MB list per
   SSE-invalidate/60s tick for tabs they can never draw (\~50GB/day).
   `apps/tui/src/main.rs` now gates the two fat fetches on
   `pane_fetches_plans` / `pane_fetches_attention` (pure fns, unit-tested):
   attention is Inbox-only (OS notifications ride `attention.notify` SSE, not
   this poll); plans stay for Fleet/PlansBoard/Plans/Inbox pins. Expected
   residual: \~2 panes × 0.52MB ≈ low single GB/day. Full workbench
   (pinned=None) is byte-identical. Binary installed to `~/.cargo/bin/pui`
   2026-07-03; live panes pick it up on the next dock relaunch — verify via
   `route_invocations` req/hr on `GET /admin/plans/:verb` afterwards.

## Current-behavior note (2026-07-08) — `plans.get` is now a scoped bridge target, not full-bust

The WI-840 section above (2026-07-02) says `harness_plans` bridges to "8 query names, all
full-bust ... no scoping registered yet for this table," and the 2026-07-03 section repeats
"once any table registers one — none do yet." **That is no longer accurate.** EI-7433
(migration 507's plan-slug natural-key fallback) registered `plans.get` as a **scoped**
bridge target in `table-to-query-names.ts`: `{ name: 'plans.get', scope: planSlugScope }`,
keyed off the plan\_slug carried on the `harness_plans` change event, matching the one live
`useSyncQuery('plans.get', …)` consumer's `{ slug, mode:'full', ...harness? }` subscription
shape. A `plans.get` write now dedupes/fans-out per-slug instead of full-busting every open
plan-detail subscriber.

This does **not** change any conclusion above about `plans:list` / `plans:attention` — those
two (plus `.items`, `.search`, `.byHive`, `.schedule`, `.scheduledOccurrences`) remain
bare-string full-bust entries in the same table; `plans.get` was never the dominant traffic
this doc tracks. It only corrects the "none do yet" claim, since `resolveBridgeTarget` /
`shouldFanout`'s scoped-vs-full-bust branch (the `WI-840` fix section above) is now exercised
in production, not merely a code path with zero live users.

## Re-diagnosed 2026-07-10 (su-9fde7, WI-3776/P-011, plan `fleet-deltas-leader-primitives-2026-07-10` D-008) — SYNC\_RESOURCE\_DELTA is ON and irrelevant to this traffic; the admin proxy is structurally outside its wire; residual waste is N independent pui processes each full-refetching on the same SSE burst

A sibling plan (D-004 of `fleet-deltas-leader-primitives-2026-07-10`) re-raised this exact
traffic after noticing `FLAGS.SYNC_RESOURCE_DELTA` reads **ON** yet the \~50GB/wk full-snapshot
cost (this doc's 2026-07-03 finding) persists — framed as "an enabled delta path that doesn't
engage." This pass confirms *why*, extending rather than re-measuring the 2026-07-03 route-level
finding above (`route_invocations` was unreachable live this pass due to unrelated host
instability, so this is a code-path proof):

* **The admin proxy (`/api/admin/plans/list|attention`, `dispatchRead` in
  `packages/operator-core/lib/endpoint-route/routes/admin/plans.ts`) dispatches IN-PROCESS via
  `handleHttpToolRequest` — a code path structurally separate from the `@papercusp/sync`
  rest-query path that `SYNC_RESOURCE_DELTA`'s client codec (`sync-delta-codec.ts`,
  `resource-delta-config.ts`) actually wires cursor negotiation into.** There is no code path
  connecting the two, so the flag being ON can never engage for this caller — D-004's own
  framing ("verify via the Tauri agent-e2e rig") was built on a mistaken premise inherited from
  believing the desktop webview was still the source; it was already ruled out on 2026-07-03
  (line 180 above) and remains ruled out.
* **`tool_invocations` genuinely cannot discriminate this from the in-process sync-resolver
  call** (both stamp the same synthetic `pc-admin-plans-ui` client id via the shared
  `read-dispatch.ts`) — this doc's 2026-07-03 section already established that `route_invocations`
  is the only telemetry that can, and that conclusion held again here: it's the same `pui`
  terminal-dock caller as 2026-07-03/EI-7028, not a new one.
* **The residual waste EI-7028 didn't fully close**: pane-gating (`pane_fetches_plans`) stops an
  individual pui *process* from fetching panes it can't render, but does nothing about **multiple
  pui processes on one machine** (Fleet / PlansBoard / Plans / Inbox-pinned panes, …) each
  independently subscribing to the same operator SSE-invalidate stream and, on one debounced
  signal, each independently issuing its own full `refetch_all`. Observed live: two `plans:list`
  calls 11ms apart, identical args — pure same-machine duplicate work, invisible to per-process
  pane-gating.
* **Fix**: `apps/tui/src/shared_cache.rs` (new) — a small, protocol-agnostic stand-in for the
  cursor/ETag negotiation this admin proxy structurally cannot do: a short-lived
  (3s), on-disk, atomic-write (temp+rename), best-effort cache at `~/.papercusp/cache/<key>.json`
  shared by every local `pui` process. `client.rs`'s `plans_list()` checks it before issuing the
  real HTTP GET and writes through after. Collapses an N-process SSE-triggered burst into 1 real
  fetch + (N-1) free local reads, at the cost of ≤3s extra staleness — well inside the existing
  250ms SSE debounce + 60s safety-net poll. `attention_typed()` deliberately left untouched
  (\~0 calls/30min live, already Inbox-gated since EI-7028) — a natural next target for the same
  pattern. 7 new unit tests (`cargo test --bin pui shared_cache`), all green; `cargo build --bin
  pui` clean.
* **RE-MEASURED LIVE 2026-07-10 \~15:10Z — it works** (P-011/WI-3776, re-verified independently by
  the fleet leader rather than taken on the closer's word). The rebuilt sidecar binary
  (`papercusp-desktop/src-tauri/sidecar/bin/pui`, mtime 09:59:46 EDT — after `shared_cache.rs`)
  was confirmed to *actually contain* the fix via `strings … | grep plans-list-standard-v1`, and
  the live `plans-pane` processes relaunched onto it at 10:24:34. On `route_invocations`
  (`path='/admin/plans/:verb'`), split at that relaunch: near-duplicate rate **16.09% → 0.89%**
  (\<50ms gap, 48h before-window; the item's own \<1s-gap read: 26.0% → 2.7%). **Crucially, call
  VOLUME held steady across the split** (19→28→24→38 per 10-min bucket) — that is what rules out
  the obvious confound, since the WI-3792 host storm was receding at the same moment and, had the
  docks merely died, the burst rate would have collapsed on its own. Caveat: the post window is
  \~40min / 112 calls with the host still draining, so the exact magnitude carries a ± from fleet
  concurrency; EI-9130 (a `deltaServed` marker) exists to make this directly attributable next
  time.
* **Reusable lesson #2 — a 7-day rolling telemetry window BACKDATES an already-landed fix into a
  fresh "opportunity."** `fleet-deltas-leader-primitives-2026-07-10` D-003 (written 2026-07-10
  \~04:40Z) ranked this traffic as "\~50 GB/week of byte-identical re-fetches", and that figure
  propagated unchecked into the P-011 item text, WI-3776's title, and an owner-facing report.
  Per-**day** telemetry shows it was already false when written: `plans:attention` collapsed \~4
  orders of magnitude on **07-04** (19–22 GB/day → 8.7 MB/day) and `plans:list` bytes \~17× on
  **07-05** (10.1 GB → 582 MB) — i.e. the **2026-07-03** EI-7028 poll-frequency/Inbox-gating fix,
  the very fix this document describes, had already retired the elephant. The 7d window was simply
  still carrying the two pre-fix days that held essentially all the volume. Current run-rate is
  \~0.6 GB/week, making `shared_cache.rs` worth \~150–200 MB/week: a real, well-tested win, roughly
  two orders of magnitude smaller than advertised. **Rank optimization work by a CURRENT run-rate
  (last 1h / last 24h), and plot per-day before quoting any multi-day total — otherwise you will
  measure a corpse and bill it to the future.** (Recorded as D-009 on that plan.)
* **Reusable lesson**: this is the third time in this doc a delta/optimization mechanism turned
  out to be inert on its actual dominant caller — TOOL\_DELTA\_PROTOCOL was ON but nothing sent
  `_meta.delta` (2026-07-10 morning finding, `fleet-deltas-leader-primitives-2026-07-10` D-003),
  SYNC\_RESOURCE\_DELTA was ON but wired to a caller that was never the traffic source (this
  section). **Before trusting a flag/mechanism state, trace the actual caller's code path to the
  mechanism — a flag being ON proves the mechanism *exists*, not that the specific traffic in
  question flows through it.**
