# Papercusp performance audit — 23 September 2026

Audit: **WI-10002792**. Draft plan: **papercusp-log-performance-remediation-2026-09-23** (nine items, not activated). Requested by Avi; conducted directly in this session. This is an assessment and fix proposal, not implementation or deployment.

## Verdict

The strongest measured problems are expensive session search and identity queries, background Git process launches that block the event loop, slow attention-feed computation, context retrieval that misses its useful deadline, and native desktop interaction regressions. Backend regression history has also stopped recording samples.

Start by verifying delivery of **two fixes already in staging**. The live search statement still has the old scan-producing predicate, and actual activity hooks still fail against the live schema. Reimplementing those fixes would duplicate completed work. Next address background execution and measurement reliability, then database/attention/context work and desktop interaction latency.

The evidence does not justify hardware replacement, broad concurrency increases or longer timeouts as first remedies.

## Scope and evidence quality

Measurements were gathered approximately **22:00–22:14 UTC on September 23**; source and prior-work checks continued during report preparation. Tool/route telemetry primarily covers rolling six-hour windows. Journals were read in scoped windows up to 24 hours; high-volume reads were bounded tails. Current database observations and source reads describe a changing shared system.

| Population | Checked | Limits |
|---|---|---|
| Operator and background journals | Active units `papercusp-dev-api`, `papercusp-bg-host`; sync, loop, timeout, shedding, ingest and failure records | Broad warning tails capped at 1,000 lines; not total six-hour incident counts |
| Gateway, MCP proxy, embedding sidecar | Scoped service journals and failure signatures | Proxy reset tail capped; no end-to-end upstream latency distribution |
| Hosted control plane and portal | Hosted control plane, portal backend and portal front-door journals | Hosted/backend tails capped; absence of matching front-door warnings does not prove fast responses |
| Tool telemetry | Six-hour workspace rollup: 254 returned groups within a 500-group request; targeted status/origin/time reads | Stored invocations include failures; deliberately long-running shell/build/wait tools excluded from interactive ranking |
| Route telemetry | Six-hour recorded executions, grouped by route template | Definitions may sample; counts are recorded executions, not guaranteed total traffic; no client render timing |
| PostgreSQL | Statement-counter deltas, actual normalized SQL, indexes, contrasting EXPLAIN plans, connections and waits | Short intervals are not daily totals or p95; no broad load test |
| CPU profiles | Four saved background-host captures; caller ancestry examined in two | Substantial profiler observer effect; not ordinary production CPU shares |
| Desktop | Latest native WDIO runs, measure writer and popup-spec source | Two recorded builds; no new immutable-build acceptance or soak |
| Prior work | September 4 report, related items and three implementation-plan ledgers, source/release comparisons | Historical findings were not assumed still present |
| Unmeasured | Controlled peak load, network shaping, leak/retainer soak, mobile and every remote machine | Explicit remaining coverage; logs cannot prove every possible performance problem has been found |

The edit guard and Git registration identify the `staging` checkout as canonical; the similarly named `papercusp-staging` directory is a linked checkout. This report is written in the canonical tree. Initial source reads and focused tests used the linked checkout; all 21 local source/report references were byte-identical between trees when checked before publication. The first attempted report write there was blocked. Test provenance limitations are recorded below.

Metric definitions were checked at the writer:

- [dev-data.ts](../../packages/operator-core/lib/dev-data.ts) computes tool percentiles from `duration_ms`, excludes marked dispatch-wrapper duplicates and counts statuses other than `ok`/`refused` as errors. Therefore invalid input is included. [projected-tool-deps.ts](../../packages/operator-core/lib/projected-tool-deps.ts) persists dispatch duration and settle time, not flush time.
- [Route telemetry](../../packages/operator-core/lib/endpoint-route/telemetry.ts) measures route start to completion. Its status is a semantic execution status, not a numeric HTTP code. Response-size fields in the ranked cohort were null.
- [pg_hot_queries.ts](../../packages/operator-core/lib/agent-tools/dev/pg_hot_queries.ts) subtracts counters between snapshots. Summed database execution time may exceed wall time because queries overlap; it is not CPU time. The cited interval had no eviction or counter reset.
- [Sync observability](../../packages/operator-core/lib/sync-resolver/resolve-observability.ts) rate-limits warnings per query/kind and carries suppressed counts. Warning counts are not request counts or percentiles.
- [Desktop measure writer](../../tools/perf-test/wdio/perf-report.ts) records outcomes before assertions. The [popup spec](../../tools/perf-test/wdio/specs/plan-popup-open.perf.spec.ts) uses a page-relative interaction mark in the packaged native app, with a 1,500 ms budget.

## Findings

### F1 — Session search forces a wide scan; staging already contains a correction

**P1; mechanism confirmed.** In the interval **22:04:51–22:05:06 UTC**, statement `3939267458425839640` ran four times, consuming **19,899.153 ms total**, **4,974.788 ms/call**, returning 18 rows/call. No counter reset or eviction occurred.

The actual SQL combines indexed `text_tsv @@ plainto_tsquery(...)` with an OR arm applying `position(lower(query) in lower(left(text, 20000)))`. EXPLAIN for a scoped `performance audit` search selected a **parallel sequential scan**. The same dictionary predicate without that substring arm selected **Bitmap Index Scan on session_turns_tsv_idx**. This distinguishes access paths; planner costs are not measured speedups.

The release checkout retains the OR shape. Staging [search/sources.ts](../../packages/operator-core/lib/agent-tools/search/sources.ts) separates indexed primary search from bounded literal-token fill. **EI-24045346484356708 is done in the ledger.**

**Fix and guard:** reuse the staged fix; verify the actual serving build executes it. Preserve literal-token recall, ordering and bounded no-match behavior. Require recall fixtures, actual query plans and comparable timings. Do not blindly reimplement or remove fallback semantics.

### F2 — Activity-hook schema mismatch creates repeated rejected requests

**P1; cause confirmed.** A six-hour classification read returned **10,304** `activity:report` records rejected for `hook_bundle: Unrecognized key: "glance_stale"`, alongside 3,902 successes and separate authorization failures. A later rolling-window read confirmed invalid-input behavior through **22:10:35 UTC**. These are validation failures, not database errors.

The [hook producer](../../apps/operator/scripts/hooks/cc/posttooluse-activity-report.sh) sends this field; the release schema omits it. Staging [activity/report.ts](../../packages/operator-core/lib/agent-tools/activity/report.ts) accepts it, with [contract tests](../../packages/operator-core/lib/agent-tools/activity/report-args-contract.test.ts). **EI-24022555028936462** and related reporter-volume **WI-10002649** are marked done.

**Fix and guard:** verify delivery of the existing compatibility correction, then measure reporter volume and rejection rate. Test real installed producer payloads against the serving schema. Unit tests cannot alone establish compatibility of deployed versions.

### F3 — Git process launches block the background event loop

**P1; sampled blocking path confirmed.** Four saved profiles from approximately **21:21–21:43 UTC** attribute **1.18–1.76 seconds** of sampled self time to native `spawn` in captures lasting about 5.8–6.3 seconds. Caller ancestry identifies `runGitLocalBounded` through repository reconciliation, Git-directory discovery, legacy dependency cleanup and network operations.

The journal associates the latest capture with **papercusp-bg-host**, triggering loop p95 **951.1 ms**, maximum **1,003.5 ms**. The source [run-git-sync.ts](../../packages/operator-core/lib/harness/git-sync/run-git-sync.ts) has a spawner-sidecar path, but deliberately uses local spawn for signal-bearing calls because the sidecar has no cancellation channel. The action forwards its AbortSignal. Profiles establish local execution; they do not independently identify the selecting condition for every launch.

**Fix and guard:** extend the existing spawner seam with cancellation/progress acknowledgment, or equivalent worker execution, preserving actual child termination before lock release. Reuse repository metadata and batch repeated reads where correct. Measure spawn and event-loop latency in representative multi-repository runs; test cancellation and timeout cleanup. Do not strip cancellation to force the sidecar. Prior **WI-1965** is dropped, which does not establish that the current path is fast.

### F4 — The profiler substantially perturbs its own measurements

**P1 for measurement integrity; overhead confirmed.** The same profiles attribute **2.7–3.2 seconds** to `node:inspector` `post`, with ancestry inside `captureCpuProfile`. The next loop record after the 21:43 capture reported a **2,896.2 ms** maximum. That proximity does not allocate all delay to profiling, but the ancestry establishes work in the measurement mechanism.

[event-loop-lag-monitor.ts](../../packages/operator-core/lib/event-loop-lag-monitor.ts) starts/stops the in-process V8 profiler. Existing [safety checks](../../packages/operator-core/lib/doc-claims/loop-profiler-safety-posture.ts) protect opt-in defaults and a saturation ceiling, not a measured low observer cost for the enabled configuration.

**Fix and guard:** measure observer overhead on a representative process, prefer external sampling where appropriate, and bound captures by cost as well as lag. Preserve symptom diagnostics. Do not quote these profile shares as normal production CPU utilization or enable more profiling on a saturated process as the first remedy.

### F5 — Identity-lineage reconstruction is repeatedly expensive

**P1/P2; cost confirmed, internal attribution open.** Statement `1528621568186315700` ran five times in the cited **15.245-second** interval: **10,816.412 ms total**, **2,163.282 ms/call**.

[acceptance-author-identity.ts](../../packages/operator-core/lib/acceptance-author-identity.ts), `lineagePartyKeys`, constructs edges from invocation history, sessions, spawns and consult selections, then recursively walks candidate identities. It already avoids naive pairwise N-squared calls. The evidence does not yet distinguish edge extraction, expansion and deduplication cost or prove a particular missing index.

**Fix and guard:** obtain bounded representative EXPLAIN ANALYZE with row/loop counts; narrow/index contributing reads where justified and consider generation-keyed reuse of authoritative edges. Preserve ancestry, consult-source, alias, cycle and evaluator-independence semantics. Require correctness and timing evidence.

### F6 — Small attention responses still pay for full aggregation

**P1/P2; delays and source coupling confirmed.** A six-hour slow-sync read that did not hit its cap contained **15** logged slow `plans.attentionRefs` resolves, maximum **6,487 ms**, and **19** slow `plans.attentionCounts` resolves, maximum **4,450 ms**. These are warnings, not p95.

[sync-resolver/index.ts](../../packages/operator-core/lib/sync-resolver/index.ts) calls shared `plans:attention` and derives the smaller counts/refs. The split reduces wire bytes while retaining server aggregation work. Existing fallback/degraded flags correctly avoid displaying confident zero counts when the result is unknown.

**Fix and guard:** profile underlying sources and invalidations; extend existing cached/single-flight/derived reads to avoid repeated full reconstruction. Preserve cross-harness scope, exact counts and degraded-state honesty. Verify cold, warm, concurrent and invalidation-burst cases.

The same window includes Learning summary failure at **6,760 ms**, Learning reads around 2.9 seconds, roster up to 2.9 seconds, and slow rubric/scorecard reads. Include those in the resolver-cost inventory.

### F7 — Memory retrieval misses useful deadlines and drops context

**P1/P2; degradation confirmed, complete phase attribution open.** Current logs include prompt-build omissions at **2,000 ms**, search phases at **5,000–5,001 ms**, `embedder-unavailable`, degraded session-turn coverage, embedding-budget expiry at 1,500 ms and admission shedding for `at_capacity`/`local_in_flight`. The one-hour tail was capped, so these signatures do not establish complete totals.

Memory lexical statement `3802103855579733629` consumed **3,265.271 ms** over five calls, **653.054 ms/call**. [canonical-store.ts](../../libs/generic/memory/src/canonical-store.ts) scores up to 32 tokens across three projected fields with existing admission/projection controls. That cost alone does not explain every five-second phase.

**Fix and guard:** trace queue, embedding, lexical, corpus, cache and render phases under one end-to-end deadline. Coalesce valid shared work, cancel obsolete demand, validate embedding readiness and measure delivered recall. Preserve scope, quality and ranking; longer deadlines or permanent memory omission are not evidence of a fix.

A separate concrete fallback repeats: `agent-obligations:waiting-on` fails because relation **agent_file_locks does not exist**. Resolve the correct database/table seam rather than retrying that known-broken access every time.

### F8 — Native desktop interaction budgets are failing

**P1/P2; recorded native regressions confirmed.** Both desktop runs in the preceding 24-hour window failed:

| Run (UTC) | Build | Breach |
|---|---|---|
| Sep 23 06:43:44 | `fd4e0ee48511` | Plan popup **4,364 / 1,500 ms**; FCP **3,026 / 3,000 ms**; LCP **4,565 / 4,000 ms** |
| Sep 23 14:43:45 | `2633f4772ec2` | Plan popup **1,798 / 1,500 ms**; one expected Web Vitals metric missing |

The latest run also recorded command palette 211 ms, harness dock 69 ms, conversation load 185 ms and FCP 2,830 ms. Not every measured interaction is slow. These are individual interactions, not field p95; differing builds/conditions prevent a controlled before/after claim.

**Fix and guard:** divide popup time among data acquisition, Vditor preparation, DOM work and paint using the existing native suite. Fix the dominant phase and metric capture. Require repeated build-identified cold/warm runs. Browser fallback is not native acceptance.

### F9 — Backend regression history stopped despite an enabled flag

**P1; detector failure confirmed, exact producer-stop cause open.** A complete grouped read found **5,934** backend history rows in one workspace, latest **2026-08-24 16:46:53.652 UTC**. The calling process resolves `papercusp-perf-regression-rig` to **true**; this is not attestation of every sibling process's flag cache.

[perf-regression-rig.ts](../../packages/operator-core/lib/system-health/perf-regression-rig.ts) is invoked from the improvements watchdog. Flag-read failure can return early; persistence failures are recorded as notes. A configured flag does not prove execution or persistence.

**Fix and guard:** trace collector invocation, process-local flag, dependencies and write; add independent freshness detection within existing health infrastructure. Test stopped producer, failed dependencies/inserts and missing metrics. Reuse open **EI-22365947616851657**. A manual sample would hide rather than fix the failure.

Desktop history is distinct and current: **146** rows under workspace **default**, newest September 23. A workspace-only query would falsely report its absence.

### F10 — Interactive coordination and bootstrap have long tails

**P2; latency confirmed, per-stage cause open.** A six-hour stored invocation sample:

| Tool | Calls | p50 | p95 |
|---|---:|---:|---:|
| coord:orient | 202 | 17.177 s | 46.126 s |
| coord:presence | 342 | 2.636 s | 29.519 s |
| coord:inbox | 621 | 1.709 s | 22.315 s |
| sessions:search | 308 | 1.604 s | 21.668 s |
| work_items:get | 1,466 | 0.381 s | 8.552 s |

Recorded routes show bootstrap-role p95 **45.006 s** (40 records), resumable sessions **10.795 s** (57), and turn-start-memory **6.681 s** (858). Heartbeats have 82,405 recorded executions, median 10 ms but p95 3.132 s. These mixed paths cannot all be attributed to one query or CPU cause.

**Fix and guard:** attribute dispatch/auth, acquisition, reads, projection and serialization, then remove measured repeated work using existing batching/caches. Test realistic large coordination populations without dropping required obligations/context.

Historical amplification: `accounts:status` returned approximately **58.9 MB across 1,868 calls**, attributed to one caller in a six-hour sample. Follow-up found its newest record at **19:19:10 UTC**, none in the final hour. This is historical polling, not a current storm. Identify its consumer before changing refresh behavior.

### F11 — Repeated background failures and long migration waits

**P2 investigation; observations confirmed, not every wait is a defect.** A capped warning tail spanning approximately 21:06–22:06 contains **516 Git-sync**, **148 loop-lag** and **61 routine-shed** lines. These are retained line categories, not total incidents. Repeated ref-announcement failures name substrate migration readiness. One ingestion pass reported 4,696 files scanned for 14 new turns in 10,252 ms. Those are workload-reduction leads, not proof every scan is unnecessary.

A database snapshot showed three boot-migration clients waiting on advisory locks, one around 15 minutes. `pg_blocking_pids` identified idle connection **2976968**, application **pcbackup**, holding **papercusp:backup:migration-rendezvous**. [db-boot-migrate.ts](../../packages/operator-core/lib/db-boot-migrate.ts) and [backup code](../../packages/backup/src/workspace-backup.ts) intentionally serialize this boundary. An idle backup SQL connection does not prove its external backup stopped progressing.

**Fix direction:** establish producer progress, make wait/progress visible, coalesce repeated prerequisite failures and reuse readiness state. Preserve the backup boundary. No holder was killed and no migration or release action was taken.

One separate `psql` DO block had been scanning text columns across harness_shared for over **3,500 seconds**. Its visible body establishes broad diagnostic work, not its share of the app slowdown. Bound forensic reads and distinguish diagnostic demand from application traffic.

### F12 — Gateway/proxy/portal failures require correlation

**P2 investigation.** Gateway logs show upstream fetch failures and stalled/aborted responses across accounts; some explicitly cite downstream closure, which can be caller cancellation. MCP proxy logs contain repeated paired client socket-reset messages. Neither count is a count of independent failed user actions.

Portal backend logs include **Failed to invoke barrier: Connection timed out** and **portal_watchdog_notify_failed:portal_systemd_notify_exit_1**, including **22:10:10 UTC**. Hosted-control-plane logs mention in-process embedding fallback; that warning alone does not establish resource pressure.

**Fix direction:** correlate request IDs, admission, upstream stages and client cancellation; inspect the systemd-notify barrier and scheduling path. Reuse gateway stage telemetry and current health checks. Preserve retry/cancellation semantics; do not add blanket retries to side-effecting calls.

## Prior work and reuse

[The September 4 audit](application-performance-audit-2026-09-04.md) led to a shipped seven-item implementation plan. Current source confirms PlansPane is no longer in the stylesheet exclusion list, adv tabs use lazy imports, and hashed-asset cache handling exists. The live database now has the activity-report session lookup indexes previously missing. These improvements are not relisted as current unfixed defects.

The July 26 database-remediation plan is shipped. The desktop-performance-suite plan remains **awaiting-acceptance** despite twelve terminal implementation items. Its old Next text still cites live-run establishment while fresh WDIO records now exist. Reconcile acceptance with current evidence; neither stale prose nor terminal item count proves acceptance complete. The two related acceptance-plan records returned by dedup are superseded. The new draft is a follow-on, not a reopening of those historical plans.

## Proposed execution order

| Item | Work | Acceptance |
|---|---|---|
| P-001 | Restore backend measurements and freshness checks (F9) | Actual producer samples; stopped/failed-producer tests |
| P-002 | Verify delivery of existing search/schema fixes (F1–F2) | Serving behavior, indexed plan, recall and real hook compatibility |
| P-003 | Fix background launch blocking and profiler overhead (F3–F4) | Cancellation-safe lifecycle and comparable loop/spawn timings |
| P-004 | Optimize lineage and lexical DB work (F5, F7) | Representative plans/timings plus correctness |
| P-005 | Reduce attention and coordination work (F6, F10) | Cold/warm/concurrent tests, exact counts and invalidation |
| P-006 | Deliver useful memory within deadlines (F7) | Recall coverage, bounded queues/work, readiness/cancellation tests |
| P-007 | Fix native popup and metrics (F8) | Existing 1,500/3,000/4,000 ms budgets on identified native builds |
| P-008 | Resolve infrastructure/work-amplification leads (F11–F12) | Mechanism or justified non-defect disposition per lead |
| P-009 | Comparative verification and final shipment evidence | Account for preceding items, comparable windows, native acceptance and explicit gaps |

P-001 and P-002 are immediate priorities; independent source preparation can proceed alongside them. P-009 depends on disposition of P-001 through P-008. The plan has requirements and an explicit bar-to-work mapping and remains draft. Dependencies are specified in the proposal text; the platform refused the typed dependency update while AUDIT mode was active, so wiring that scheduler dependency is an explicit activation task. No implementation was started.

Reuse current telemetry, regression rig, cached reads, spawner sidecar, memory admission and native suites. No parallel metrics service or scheduler is proposed. Preserve file claims and existing LIVE_GATE_OPS ownership; final shipping is separate from source/test completion. New latency targets should be chosen from representative baselines, not invented percentage promises.

## Verification and reproducibility

Existing focused tests were run:

```text
npm run test:file -- packages/operator-core/lib/agent-tools/activity/report-args-contract.test.ts packages/operator-core/lib/agent-tools/search/sources.integration.test.ts
```

**Observed: six schema-contract tests and 53 search integration tests passed, zero skipped.** The wrapper reported HEAD movement from **66db949386** to **509f7b0b56**, with imported-source provenance unknown. Tests ran in the linked checkout described above. This is an observed source check, not immutable-build or deployed acceptance. Rerun acceptance against an identified build.

Saved CPU profiles used:

```text
$HOME/.papercusp/loop-profiles/loop-saturation-1790198491622-pid2210775-p95_600ms.cpuprofile
$HOME/.papercusp/loop-profiles/loop-saturation-1790198845288-pid2210775-p95_669ms.cpuprofile
$HOME/.papercusp/loop-profiles/loop-saturation-1790199209874-pid2210775-p95_635ms.cpuprofile
$HOME/.papercusp/loop-profiles/loop-saturation-1790199813370-pid2210775-p95_951ms.cpuprofile
```

Profiles are retention-managed; their observed totals/ancestry are preserved in this report. Query IDs and log timestamps locate observations but are not immutable lifetime guarantees. WI-10002792 records the checkpoint and artifact reference. Source links identify relevant writers and mechanisms.

No application source/configuration, indexes, migration state or release state was changed. Remaining unknowns are internal lineage cost allocation, full memory phase attribution, all causes of API stalls, backup progress, upstream failure causes, current native-build acceptance and peak/remote/leak behavior. The draft explicitly carries these forward. The audit and proposal are complete; the app is not claimed fixed.
