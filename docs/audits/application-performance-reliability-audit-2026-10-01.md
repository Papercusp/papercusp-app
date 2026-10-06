# Papercusp performance and reliability audit October 1 2026

Papercusp has concrete opportunities to reduce latency and memory costs. The strongest new finding is a recurring global plan-coverage query that scans work items and returns thousands of rows. Context retrieval still times out, and native desktop startup still exceeds its budgets. Existing performance work has resolved several earlier findings, so the next work should extend those changes and finish the remaining remediation lanes.

This report is a read-only assessment requested by Avi. Audit record: **WI-10004874**. The [distilled evidence](application-performance-reliability-audit-2026-10-01-evidence.json) preserves the measurements and their limits. Source inspection used canonical staging, with HEAD `8cfe6fd85b042b7f97c6f5a2cedaa495d1cfbf40` recorded during the audit. Live services and the shared tree can change independently.

## Recommended priorities

| Priority | Action | Evidence | Accountability |
|---|---|---|---|
| P1 | Reduce recurring global coverage scans and hydration | Four calls averaged 1,684.517 ms and returned 7,783 rows each; exact-predicate EXPLAIN chooses a sequential scan | New owned follow-up WI-10004889 |
| P1 | Finish context retrieval deadline and admission work | Fixed one-hour corpus outcomes contain 327 mid-turn and 35 turn-start timeouts | Existing WI-10002828 and remediation P-006 |
| P1 | Finish native startup and popup acceptance | Recorded FCP 5,635 ms and LCP 10,251 ms against 3,000/4,000 ms budgets | Existing live WI-10002829 and P-007 |
| P2 | Reduce bootstrap and coordination tails through phase attribution | Launch options p95 7,041 ms; work-items read p95 8,379 ms | Reuse existing bootstrap and coordination helpers and remediation lanes |
| P2 | Measure retained memory by worker, cache and lifecycle | Operator service PSS 15,390 MiB at one snapshot; sizable later fluctuations | New owned measurement follow-up WI-10004890 |
| P2 | Complete transport recovery and loaded-code provenance work | Recovered handshake stalls and connection-refusal log signatures; proxy vintage warning has limited provenance | Existing WI-10002830 and P-008 |

These are priorities and proposed verification criteria, not promised speedups. No application fix, service restart, deployment, stress test or destructive fault injection was performed.

## Measurements and scope

The audit inspected September 4 and September 23 performance reports, the September 13 backend reliability report, the September 24 memory report, relevant live plan/work-item records, source writers, service probes, retained telemetry, PostgreSQL statistics, bounded journals and service memory.

| Population | Checked | Practical limit |
|---|---|---|
| Backend tools | One-hour recorded rollup, top 20 tools by call count | Selected groups; recorded output bytes and dispatch time are not wire or client-render measurements |
| HTTP routes | One-hour recorded routes with at least ten samples, top twelve by p95 | Route definitions can sample; no complete request census |
| Database | 15.188-second statement delta, actual SQL, exact coverage-query EXPLAIN, connections | Aggregate execution time is not CPU time; no EXPLAIN ANALYZE or sustained load |
| Retrieval | Fixed October 1 13:02–14:02 UTC corpus outcomes; separate rolling phase timings; one worker's embedding ring | Persisted rows only; missing provenance stays unknown; embedding ring covers one of six workers |
| Desktop | Two recorded native WDIO rows, writer/spec source, active owner's saved checks | No new audit-owned native cohort; mixed artifact provenance prevents a current-release attribution |
| Processes | Five named service cgroups, readable smaps PSS, bounded CPU/memory deltas, host pressure | Short observations cannot prove a leak; inaccessible pages and unrelated services are outside coverage |
| Reliability | Service functional probes and latest 1,500 journal lines per selected unit | Tails hit the cap; overlapping signatures are not independent incidents |
| Recovery | Three recent workspace backup receipts and the listing's live-session projection | No restore or failover drill; independent host backup mechanisms are outside this receipt list |
| Not exercised | Peak-concurrency load, long leak soak, network fault injection, full-suite run, every remote machine | This is not exhaustive reliability certification |

The [tool rollup writer](../../packages/operator-core/lib/dev-data.ts) excludes marked dispatch-wrapper duplicates, computes percentiles from recorded duration, and separates refused calls from other non-ok outcomes. The [route writer](../../packages/operator-core/lib/endpoint-route/telemetry.ts) honors sampling and uses semantic execution status. The [database sampler](../../packages/operator-core/lib/agent-tools/dev/pg_hot_queries.ts) subtracts counters and detects resets/eviction. No eviction occurred in the cited window, although statement occupancy was 99.6 percent of its configured capacity.

Cgroup memory includes caches and descendants. RSS counts shared pages repeatedly; PSS apportions them. CPU percentages below are percentages of one logical core. None of those quantities independently proves the cause of a slow user action.

## What has already changed

The September 4 implementation plan and September 24 memory-reduction plan are shipped in the ledger. The September 23 remediation plan has five terminal items and four remaining lanes. Its stored plan status is ready; the item graph reports ongoing work. The direct work-item read found the desktop item in progress even though the plan's item projection still displayed todo.

Several earlier recommendations should be preserved:

- [The adv route](../../apps/operator-vite/src/routes/adv/index.tsx) now lazily imports its tab bodies.
- [Static serving](../../apps/operator/bin/host-spa.ts) now recognizes hashed immutable assets and streams asset bodies. The shell still has a synchronous HTML read, but this audit did not establish it as a material bottleneck.
- Activity reporting recorded 7,336 calls with zero non-ok/non-refused outcomes in the inspected rollup. The earlier schema-rejection storm was not reproduced by this aggregate.
- Backend performance snapshots are fresh: the newest inspected row was October 1 13:51:44 UTC, with loop-lag p95 65.6 ms and connection saturation 42.8 percent. The old August-only history finding no longer describes this series.
- Three recent workspace backups reported successful database dumps; the newest finished October 1 11:40:05 UTC. Successful receipts establish recent captures, not successful restoration.

Different workloads and windows prevent a controlled before/after speedup claim. The earlier memory report's process-to-live-agent comparisons and swap conclusions were not adopted as current facts.

## Recurring coverage work scans the complete table

**Confirmed costly query and access path; full end-to-end attribution remains open.**

During October 1 13:50:34.463–13:50:49.651 UTC, statement `-2442231371504820178` ran four times and consumed **6,738.066 ms** of aggregate database execution time. It averaged **1,684.517 ms** and **7,783 returned rows** per call.

The actual SQL matches the unfiltered stamp read in [getAllPlanItemCoverage](../../packages/operator-core/lib/plan-item-coverage.ts). It selects several JSON payload fields from work_items using the presence of plan_item, plan_slug and item_id. A read-only EXPLAIN of that exact predicate selects **Seq Scan on work_items**. Planner estimates are not measured timings.

[The fleet assignments reader](../../packages/operator-core/lib/agent-tools/fleet/assignments.ts) starts the global coverage read even when the assignment population is filtered by agent, plan or fleet. Other consumers, including health and cleanup, legitimately require broad coverage. The existing function already accepts planItemRefs, and WI-10002447 fixed the filtered path's stamp-only claim correctness.

**Proposed change:** pass the relevant bounded set where a consumer has one; use existing derived reads, invalidation and projections for truly global consumers. Measure scan, JSON extraction, result hydration and liveness-oracle phases before selecting an index or projection change. Preserve cross-workspace link semantics, terminal-state handling, claim holds and stamp-only claims.

**Guard:** correctness fixtures for those cases, cold/warm/concurrent timings and query plans. Do not report an improvement from planner cost alone. Owned follow-up **WI-10004889** carries the evidence.

## Context retrieval still times out

**Confirmed persisted timeout outcomes; complete phase cause remains unresolved.**

The fixed **13:02–14:02 UTC** window recorded:

| Surface | Corpus ok | Timed out | No query | Not recorded |
|---|---:|---:|---:|---:|
| Mid-turn | 3,011 | 327 | 25 | 81 |
| Turn-start | 331 | 35 | 0 | 8 |
| Initialize | 522 | 0 | 0 | 16 |

These are persisted outcome rows, not every request that could have happened. The [admission writer's types](../../packages/operator-core/lib/memory/recall-stats.ts) distinguish timed-out, failed, disabled and no-query.

A separate rolling-hour read measured retrieval totalMs p95 of **519.9 ms** for initialize, **1,107.0 ms** for mid-turn and **1,938.6 ms** for turn-start. Lexical p95 was **327.5 / 636.1 / 939.7 ms** respectively. The short database sample also measured a memory lexical statement at **253.301 ms/call**, and transcript anchor search at **588.983 ms/call**.

Embedding alone does not explain the complete path: a functional embedding probe completed in 71 ms; one worker's mid-turn embedding ring had p99 921 ms. Queueing, corpus search, lexical ranking, admission and composition need the same request trace.

**A critical interpretation limit:** 520 of 522 initialize corpus-ok rows also had a degraded leg label. A representative row had semantic search run with zero candidates and lexical candidates returned, without callsFailed. A degraded ranking/coverage label is not a timeout rate or proof that a backend never ran. Zero hits and missing provenance are also separate states.

**Proposed change:** finish existing P-006, tracing queue-to-delivered-context work under its real deadline, coalescing valid duplicate work and cancelling obsolete demand. Preserve useful recall and ranking. Validate phase costs, timed-out outcomes and actually delivered context together. Evidence was added to **WI-10002828**.

## Bootstrap and coordination retain long tails

**Latency is measured; a common underlying cause has not been established.**

Selected one-hour tool records:

| Tool | Calls | p50 ms | p95 ms |
|---|---:|---:|---:|
| work_items get | 974 | 51 | 8,379 |
| coord inbox | 273 | 772 | 7,074 |
| coord glance | 638 | 79 | 2,785 |
| tools find | 1,988 | 149 | 1,373 |

Route launch-options recorded **29 executions**, median **4,161 ms**, p95 **7,041 ms**. Turn-start-memory recorded **434**, p95 **4,458.7 ms**. Mid-turn-context recorded **12,265**, median 11 ms and p95 1,959.8 ms, with a 62,282 ms maximum.

These mixed paths cannot be assigned to the coverage scan or to CPU pressure from percentile tables alone.

**Proposed change:** trace auth/identity, connection acquisition, query, projection, serialization and client completion separately. Reuse shared launch-options/identity reads, narrow optional work and extend existing single-flight caches with correct invalidation. Keep obligations and unread-message semantics complete. Longer timeouts would not remove the expensive work.

## Native startup remains outside budget

**Recorded native regressions; current release identity is not established by the selected rows.**

The inspected October 1 **13:01:01.956 UTC** WDIO row recorded:

| Metric | Recorded ms | Budget ms |
|---|---:|---:|
| First contentful paint | 5,635 | 3,000 |
| Largest contentful paint | 10,251 | 4,000 |
| Plan popup open | 1,517 | 1,500 |

The prior selected row, at 11:47 UTC, also failed FCP/LCP. In the 13:01 popup attempt, cumulative phase offsets were request-started 40 ms, response-headers 1,119 ms, response-ready 1,411 ms, data-ready 1,470 ms and preview-rendered 1,501 ms. This points at the data path in that attempt. These overlapping cumulative marks must not be added as independent durations.

The [spec](../../tools/perf-test/wdio/specs/plan-popup-open.perf.spec.ts) writes plan-popup-load-errors from Web Vitals failures.length. Its value two means two load-budget failures, not two network exceptions.

Both selected rows have null build_sha and git_sha. The [publisher](../../tools/perf-test/wdio/perf-report.ts) deliberately clears checkout SHA for named mixed-artifact runs; a binary mtime stamp remains. This is not a basis for charging a particular current release commit with the measured breach.

The live desktop owner's saved checks also retain native cohorts with failures. The owner is continuing newer measurements; the rows above are the audit's selected persisted evidence, not a claim that no newer work exists.

**Proposed change:** complete existing P-007 with exact shell/SPA/API provenance, repeated cold and warm journeys, startup traces and popup phases. Fix the dominant phase, retain the earlier CSS/lazy-tab corrections, and require successful native budgets. Evidence was added to **WI-10002829**; this audit did not launch a duplicate cohort.

## Memory needs retained-state attribution

**A sizable footprint is measured; a memory leak is not proven.**

One service-cgroup smaps snapshot measured:

| Service | Processes | PSS MiB |
|---|---:|---:|
| Release operator | 19 | 15,390.0 |
| Staging API | 3 | 1,544.6 |
| Background host | 2 | 3,030.9 |
| MCP proxy | 6 | 204.7 |
| Inference gateway | 5 | 626.8 |

A later 10.04-second sample with stable main PIDs showed cgroup totals of **10.8 GiB** for release, **2.68 GiB** for staging and **4.22 GiB** for background host. Their in-window changes were **-50.6 / +212.3 / -242.9 MiB**. Largest release worker RSS values were around 1.4–1.5 GiB each. Those quantities differ from the earlier PSS read and demonstrate why a single high number is not leak evidence.

The same short window measured release/staging/background CPU at **119.5 / 65.6 / 158.5 percent of one logical core**. The host has 128 logical CPUs. A host pressure snapshot showed nonzero memory and IO stalls, but this audit did not connect them to particular API slowdowns.

**Proposed next measurement:** compare equivalent idle and ordinary-workload PSS, heap/native allocation, cache ownership and descendant lifetimes across multiple intervals. Look for redundant retained state and unbounded caches before changing worker count or allocator. Reuse the September memory work, which already kept six workers and addressed several allocation/lifecycle problems. Owned investigation **WI-10004890** records the distinction.

## Reliability is stronger than a service up flag

Functional probes reached the operator, staging API and embedding sidecar. The desktop row says its IPC target was unresolved and was not checked; it is not a successful desktop interaction test. Process-local supervisor flap fields also contain explicit zero-default caveats, so they cannot establish that no restart or flap occurred.

The probe's one-hour MCP classification contained **four handshake stalls**, **nine recoveries** and **zero hardFailures under that classifier**. A capped proxy tail contained **54 ECONNREFUSED-category lines**. These are different instruments; lines, retries, recoveries and user-visible failures are not interchangeable counts.

The same service probe raised a proxy code-vintage warning using **mtime fallback**, not a loaded-source hash. A previous related item was closed after reloading the process. Treat the current warning as a provenance investigation until the actual loaded artifact is attested. The durable mechanism should ensure activation follows source/config changes and functional transport checks demonstrate recovery; restarting repeatedly is a mitigation.

Existing **WI-10002830** owns transport/proxy remediation. Current evidence was posted there and sent once to its assignee. No parallel monitor, restart or deployment was started.

## Verification and remaining work

This audit verified claims against source writers, normalized SQL, query plans, saved native outcomes and structured operational reads. The report and evidence were read back; local source links and JSON syntax were checked. No application source changed, so no full application test-suite result is claimed.

The new follow-ups **WI-10004889** and **WI-10004890** were created with an assignee and confirmed in their receipts. Existing retrieval, desktop and proxy findings were added to their existing items. Remaining acceptance/report work stays in remediation P-009.

The next implementation should begin with the recurring coverage read and completion of retrieval/native lanes, followed by bootstrap phase reduction and memory retention measurements. Final comparisons need equivalent workloads and exact runtime provenance. This report does not certify peak load, leak freedom, disaster recovery or shipment.

