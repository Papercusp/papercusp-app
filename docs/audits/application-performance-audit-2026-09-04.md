# Application performance audit — 4 September 2026

Work item: **WI-2144484**. Scope: Papercusp operator UI, its Tauri shell, Hono asset/API serving, sync queries, PostgreSQL read paths, and performance measurement. This is an audit and recommendation report; product source, database indexes, configuration, and release state were not changed.

**The strongest opportunities are restoring required route styles, loading fewer unused components at startup, and replacing several expensive database reads.** The existing architecture already supplies virtualization, shared query caches, SSE updates, IPC, and performance instruments. Several problems arise where those mechanisms are bypassed or incorrectly integrated.

The source review used the canonical staging tree, including HEAD `f49702d62a` during the audit. Browser probes used the built content served at `:3170`; native verification used the repository's isolated Xvfb/Tauri verifier and its frozen SPA snapshot. Database samples came through the operator's bounded diagnostic tools. Measurements were taken approximately 20:36–21:03 UTC. This is an actively changing shared tree, not a controlled before/after release benchmark.

## Priorities

| Priority | Improvement | Evidence and expected benefit | Scope / confidence |
|---|---|---|---|
| 1 | Restore required Plans styles and verify lazy CSS delivery | Native Tauri confirmed missing CSS, 419 mounted rows, and 20,001 DOM elements. Restoring the existing stylesheet in a hydrated Chromium document reduced 418 rows to 14 and 19,945 DOM elements to 1,051. | Small source change plus real-build regression coverage; defect confirmed in both native Tauri and Chromium. |
| 1 | Index the session-specific activity-report lookup | Six calls averaged 3.807 seconds; EXPLAIN filters session JSON after scanning a time-ordered index. | Focused database migration; high-confidence access-path mismatch. |
| 1 | Split the `/adv` tab implementations | Every tab is statically imported by the route; the loaded route chunk was 1,661,169 bytes. | Moderate frontend change; source and emitted artifact verified. |
| 2 | Reduce coordination history work per agent dossier | Six reads averaged 2.233 seconds and returned 15,672 full message bodies per call. | Moderate backend change; preserve exact unread-message semantics. |
| 2 | Narrow carry-brief queries to this session's candidate items | Eight calls averaged 1.909 seconds; the query correlates comment membership across open unassigned work. | Moderate query rewrite and matching indexes. |
| 2 | Make initial plan/roster responses smaller | `plans.list` returned 1,376,573 bytes; roster responses were about 510 KB. | Extend existing query contracts; preserve cache sharing and scope. |
| 2 | Deduplicate global bootstrap reads and defer hidden launch controls | Seven `/api/auth/me`, three `/api/profile`, and two identical 241 KB launch-options requests were observed during startup. | Small to moderate; existing shared helpers can be reused. |
| 2 | Cache hashed static assets and remove synchronous asset reads | Hashed JS returned no Cache-Control, ETag, or Last-Modified; serving reads whole files synchronously. | Focused Hono change; benefit depends on transport and reload behavior. |
| 2 | Strengthen performance coverage and freshness checks | The backend regression series stopped on 24 August. Current desktop records exist, but recent records do not establish coverage of the failing Plans entry path. | Extend the existing instruments and real-build checks. |

These are priorities, not promised percentage speedups or implementation time estimates. The DOM reduction is the measured effect of an isolated experiment, not an end-to-end latency claim.

## 1. Required CSS is being removed from the initial document

[build-preload-policy.ts](../../apps/operator-vite/build-preload-policy.ts:16) classifies `PlansPane-*.css` and several other component stylesheets as noncritical and removes their stylesheet links from generated HTML. Its comment assumes runtime imports will restore them. On direct `/plans`, including `?portalEmbed=1`, that assumption did not hold in the content-layer probe.

[PlansPane.tsx](../../apps/operator/app/_components/plans/PlansPane.tsx:106) imports its stylesheet and already uses [TanStack Virtual](https://tanstack.com/virtual/latest/docs/api/virtualizer). Nevertheless, the loaded document had no PlansPane stylesheet. Computed styles showed `display:block` and `overflow:visible` for elements whose source CSS specifies grid/flex layout and scrolling. With a 1,000-pixel viewport, the list's measured height was approximately 16,175 pixels, so the virtualizer treated the whole list as visible.

The decisive isolated-browser experiment waited for the list to populate, then added a link to the **existing emitted** `PlansPane-33cf053c.css`. No replacement component or source edit was involved:

| Measurement | Before stylesheet | After stylesheet |
|---|---:|---:|
| Mounted plan rows | 418 | 14 |
| Total DOM elements | 19,945 | 1,051 |
| List client height | 16,175 px | 510 px |
| List overflow | visible | auto |

An earlier experiment constrained the viewport artificially to 600 pixels and also reduced the DOM. The deeper stylesheet experiment supersedes my initial hypothesis that the portal's outer height chain was missing: its outer containers were correctly 1,000 pixels tall. That correction is recorded on EI-22365194649464804.

**Native confirmation:** an owned, headless Tauri instance navigated directly to `/plans?portalEmbed=1&ws=papercusp-workspace`. It showed **419 rows, 20,001 DOM elements, a 16,005-pixel list, visible overflow, and no PlansPane stylesheet**. Loading the existing emitted CSS restored `overflow:auto` and a 516-pixel viewport. The immediate native post-style snapshot still had 419 rows, so native row-count convergence was not established by that snapshot; the DOM reduction above is specifically the completed Chromium experiment. Both native runs exited successfully and tore down their own instances. The second run's frozen bundle predates a concurrent shared rebuild, which is recorded rather than represented as final release acceptance.

**Recommendation:** retain required CSS until the actual import graph supports deferral, or create a genuine lazy component boundary that loads its CSS. Test cold direct entry and in-app navigation separately. The regression check should assert computed grid/overflow styles and a bounded number of mounted rows with hundreds of plans. Merely asserting that the HTML filter removed links reproduces the implementation without proving the route still works. Review other filenames in the same exclusion rule, especially InboxPane; their missing-CSS failure has not been independently established here.

## 2. A recurring session lookup needs an index matching its predicate

[conversation-context-projection.ts](../../packages/operator-core/lib/conversation-context-projection.ts:772) retrieves activity-report invocations using workspace, tool name, and:

```sql
COALESCE(args_json->>'session_id', args_json->>'sessionId') = session_id
```

In a 12.665-second `pg_stat_statements` delta sample, this statement executed six times, consumed 22,842.845 milliseconds of cumulative database execution time, and returned no rows. Its average was **3,807.141 milliseconds per call**. The sample had no statement eviction or counter reset; these are interval measurements, not misleading lifetime totals.

A bounded EXPLAIN with a nonexistent session key selected `tool_invocations_invoked_at_cov_idx`. The session predicate appeared as a **Filter**, with no matching Index Cond. The live index inventory did not contain an index for the COALESCE expression.

**Recommendation:** add a selective expression/composite index for this access pattern, preferably restricted to the relevant activity-report tool names if the production query plan can use that predicate. Preserve both session-key spellings and the workspace/default compatibility rule. Validate positive and absent-session lookups with EXPLAIN ANALYZE on an appropriate test dataset, and measure insertion overhead. PostgreSQL documents both the lookup benefit and the write cost of [expression indexes](https://www.postgresql.org/docs/current/indexes-expressional.html).

## 3. `/adv` loads the implementations of every tab

[routes/adv/index.tsx](../../apps/operator-vite/src/routes/adv/index.tsx:8) statically imports Overview, Stats, Conversations, Learning, Frames, Evals, Calendar, Health, History, Work, Create, HUD, and Workflows. A switch determines which tab renders, but static imports still contribute to the route's loading/evaluation cost.

The observed route JS was **1,661,169 bytes**. Separately, the built initial document referenced **191 assets totaling 3,509,150 bytes**, including **1,020,613 bytes of global CSS**. Those are uncompressed emitted bytes, not total application size or a network-speed prediction. The initial-reference total alone fits the current 4.5 MiB budget, which illustrates why that check can pass while a used route remains expensive.

**Recommendation:** keep the default Overview path lean, and load other tab implementations through the existing lazy-with-retry/Suspense facilities. Preserve tab state and navigation behavior. Move genuinely optional styles with their components, and verify their delivery when opened. [React's lazy API](https://react.dev/reference/react/lazy) defers code until the component first renders; removing preload links by filename is not equivalent to establishing that boundary.

Validate cold Overview entry, each first tab visit, and warm revisits against a frozen production SPA. Budget the actual route graph, request count, parse/evaluation work, and loaded CSS, not only the entry document's references.

## 4. Agent dossier reads reconstruct too much coordination history

[readInvolvingOwner](../../packages/operator-core/lib/agent-tools/coordination/messages.ts:1286) reads up to 25,000 JSON message bodies for an owner, including broadcasts. [getAgentCoordState](../../packages/operator-core/lib/adv-agent-detail.ts:1092) uses those bodies to derive latest-message and unread state.

The sampled statement averaged **2,233.468 ms** and **15,672 returned rows per call**, across six calls. This is bounded compared with a whole-log scan, but still substantial work for a small dossier summary. Database execution time does not include all subsequent JSON processing, filtering, and sorting in Node.

**Recommendation:** separate a small latest-message lookup from the unread-state calculation. Reuse or extend the existing cursor/acknowledgement and derived-state surfaces; narrow historical candidates before fetching full bodies. Preserve recipient visibility, broadcasts, birth floors, read receipts, acknowledgement, retraction, and coalescing rules. Arbitrarily lowering the row cap would risk incorrect counts rather than solve the underlying problem.

## 5. Carry briefs should begin with this session's touched items

The `WITH touched` query in [carry-brief.ts](../../packages/operator-core/lib/carry-brief.ts:508) averaged **1,909.061 ms**, across eight calls in the same interval. It walks open, unassigned work items and uses a correlated thread/post existence test to determine which were touched by the session.

**Recommendation:** derive the small set of session-created and session-commented item identifiers first, union/deduplicate those identifiers, then join to work items and apply the remaining filters. Check corresponding author/time and item-reference indexes. Confirm identical results for legacy feature references, terminal states, and both creation/comment provenance.

The same sample also showed advisory-lock calls averaging 1.641 seconds. That figure includes lock waiting and does not establish CPU saturation or identify the responsible transaction. It is a follow-up profiling lead, not evidence that lock semantics should be weakened.

## 6. Initial sync data is larger than many consumers need

A fully instrumented Plans load observed:

| Query | Response bytes |
|---|---:|
| plans.list | 1,376,573 |
| advRoster.list | 509,955 |
| operatorTurns.page | 153,049 |
| plans.attention | 106,249 |
| plans.cleanupRun | 74,116 |
| planWorkActivity.list | 36,992 |

[usePlanList](../../apps/operator/app/admin/plans/plans-api.ts:1396) deliberately requests the archived/legacy superset and filters it locally to share a single cache entry. That avoids a previous duplicate-fetch problem; it should not be casually undone. [PlansPane](../../apps/operator/app/_components/plans/PlansPane.tsx:417) consumes the full roster mainly to count active agents by plan.

**Recommendation:** add a lightweight projection to existing list/roster contracts for counts and visible-row fields. Keep a common normalized cache where appropriate, and fetch detailed records when selected. For long histories, add bounded pages and server-side filtering that preserve existing scope semantics. Measure decoded bytes, parsing/structural-sharing time, and update-to-screen time; transport compression alone does not remove those costs.

The sync stack already has SSE invalidation, shared caching, delta support, concurrency control, and three-minute repair polling. In one approximately ten-second observation, 271 SSE invalidations did **not** become 271 HTTP requests. An invalidation counter must not be presented as a request-storm count.

## 7. Global bootstrap work can be shared and deferred

The content-layer `/adv` trace contained seven `/api/auth/me` requests and three `/api/profile` requests. Plans and Inbox each requested bootstrap launch options twice; a follow-up confirmed identical `agent=claude` and omitted workspace arguments. Each launch-options response was 241,178 bytes.

Shared helpers already exist in [use-current-user.ts](../../apps/operator/app/_components/use-current-user.ts:69) and [profile-pref.ts](../../packages/operator-core/lib/profile-pref.ts:39). Several components independently fetch the same endpoints. [use-su-launch-options.ts](../../apps/operator/app/adv/sessions/use-su-launch-options.ts:240) also performs a per-instance effect fetch.

**Recommendation:** reuse one identity/profile read per appropriate session scope and give launch options a shared query keyed by workspace and agent. Defer launch-dialog data until the dialog is needed, and cancel abandoned reads. Preserve invalidation on user/workspace changes and successful writes.

Browser fallback observations showed several seconds of queue wait before some finite reads were admitted. Those numbers **are not desktop timings**: native verification confirmed the Tauri IPC path uses a 24-request limit, whereas the browser fallback uses two. Do not increase the browser cap indiscriminately; reduce unnecessary demand and verify stream accounting and priority within the existing scheduler.

## 8. Static asset serving leaves avoidable repeated work

[host-spa.ts](../../apps/operator/bin/host-spa.ts:109) synchronously reads complete assets into memory for every response. Its [immutable-cache condition](../../apps/operator/bin/host-spa.ts:307) applies to `/vditor/`, but not Vite's content-hashed `/assets/` output. A live hashed JS response had no Cache-Control, ETag, or Last-Modified header, and reload probes transferred the sampled assets again.

**Recommendation:** use long-lived immutable caching for verified content-hashed filenames, retain fresh shell HTML, and replace synchronous reads with asynchronous serving or a bounded immutable-asset cache. Test replacement builds and old open windows. [MDN's caching guidance](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control) explains why immutable caching belongs on versioned resources.

Compression is deliberately absent from this local host; [host-handler.ts](../../apps/operator/bin/host-handler.ts:45) documents measured CPU costs and the desktop/IPC rationale. Preserve that policy. If assets traverse a real network, evaluate compression at the existing edge proxy and measure that transport separately.

## 9. Expand the existing performance checks

The full database inventory of `perf_regression_snapshots` contained one workspace, `papercusp-workspace`, with its newest row at **2026-08-24 16:46:53 UTC**. That history was about eleven days stale during this audit. Its current writer is [perf-regression-rig.ts](../../packages/operator-core/lib/system-health/perf-regression-rig.ts:543).

Desktop measurements are **not absent**: `desktop_perf_runs` contained 90 rows under the producer's `default` workspace, latest **2026-09-04 17:59:49 UTC**. The two newest records reported command-palette and harness-dock interaction measurements plus host context. They were attached to SHA `e443b3026823fd8b5ff23d9d22b27d61606a3464`, rather than the audited staging snapshot. A workspace-scoped empty read would have produced the wrong conclusion here.

**Recommendation:** add freshness/producer checks to the existing backend series and current-build route assertions to the existing desktop suite. Specifically check cold direct Plans/Inbox entry, computed required styles, bounded mounted rows, first-tab loading, real typed-input responsiveness, and retained-window reload behavior. Report missing measurements as unknown. Keep Chromium content diagnostics, native WebKit results, debug builds, release builds, and field percentiles distinct.

The existing preload-policy tests prove filename filtering, not successful subsequent CSS loading. The eager bundle guard only counts initial referenced files. Those are useful checks, but neither detects the observed route-style failure.

## Measurement limits and exploratory results

These Chromium samples exercised the internal content layer at 1440×1000 with fresh contexts, no CPU/network throttling, and approximately 8.5 seconds of observation. **They are not valid substitutes for the supported Tauri verification path, desktop release budgets, field Web Vitals, or p95 latency.** In particular, the absent IPC bridge changes request scheduling and can cause stalls. They remain useful for inspecting emitted assets, CSS delivery, and DOM behavior.

| Content-layer route | FCP | Last observed LCP | Long tasks, cumulative / maximum | CLS session-window maximum | DOM elements |
|---|---:|---:|---:|---:|---:|
| /plans | 0.927 s | 6.322 s | 2.993 s / 1.177 s | 0.965 | 19,957 |
| /adv | 1.566 s | 6.611 s | 2.878 s / 0.940 s | 0.370 | 2,571 |
| /inbox | 1.156 s | 2.044 s | 0.747 s / 0.235 s | 0.169 | 2,266 |

CLS was computed using the largest burst with the standard one-second gap/five-second window and excluding shifts after recent input, following the [metric definition](https://web.dev/articles/cls). The short observation ends before a complete page session; no interaction percentile was measured. Large sidebar/control shifts warrant native route checks after CSS delivery is corrected.

An earlier resource probe hit Chromium's default 250-entry timing buffer; its byte totals were incomplete and were superseded by probes using a 10,000-entry buffer. One navigation timed out and another showed a backed-up browser fallback queue; their cause was not attributed to host load. PostgreSQL's separate connection snapshot was 242 of 512 server-wide connections, which does not demonstrate pool exhaustion.

Native verification successfully booted two owned headless Tauri instances on Xvfb, confirmed bridge provenance, tested each owned Hono/SPA origin, verified `window.__TAURI_INTERNALS__`, and observed the IPC transport. The initial native route was `/adv?tab=harnesses`; that route did load the Plans stylesheet. The separate direct-entry Plans experiment reproduced its absence, demonstrating why cold entry and prior navigation need separate coverage. In that native direct-entry run, the sync limit was 24, ten queries completed without failures or timeouts, and no recorded queue wait exceeded 250 ms. The multi-second browser fallback queue results therefore must not be attributed to this native run.

No sustained soak, memory-leak proof, peak-concurrency load test, or end-to-end speedup claim is made. No full test suite was run for this documentation-only audit. The implementation order I recommend is: required CSS and its real-route regression test; the targeted session index; `/adv` lazy boundaries; coordination/carry reads; payload and bootstrap reduction; asset serving and broader performance budgets.

## Durable follow-ups

| Reference | Subject |
|---|---|
| EI-22365194649464804 | Plans CSS/layout/virtualization and corrected root cause |
| EI-22364864041747002 | Measured recurring database reads and source/query-plan attribution |
| EI-22364856734606409 | Startup payload, route splitting, and CSS delivery coverage |
| EI-22365555120139128 | Repeated bootstrap reads and transport-specific startup queues |
| EI-22364653803968724 | Hashed asset caching and synchronous serving |
| EI-22365947616851657 | Stale backend performance history and coverage gaps |

The report and native experiment's disposition are recorded on WI-2144484. The recommendations remain implementation work; this report does not mark their defects fixed.
