# Backend reliability audit

## Executive assessment

The platform is doing substantial useful work, but its reliability is not yet adequate for unattended agent operation. The most serious problems occur between stages: a transport accepts a wake that does not start a turn; primary memory retrieval succeeds while contextual retrieval times out; a routine remains active but cannot obtain admission; a source fix exists while a serving process still runs the defective version.

This is not evidence that the entire backend is unavailable or that every deferred message is lost. It is evidence that aggregate success indicators conceal important partial failures. Improving end-to-end completion and recovery is more valuable than adding another general “healthy” indicator.

The highest-priority findings are:

1. **Session-history retrieval is currently broken on the green release endpoint.** A valid `sessions:read` call reproduced a PostgreSQL error. Staging contains the repair; the release source does not.
2. **PTY deferrals are frequent and include genuinely non-converging recovery.** One host repeatedly fails context replacement because its required `AGENTS.md` is missing; another repeatedly fails the same MCP reconnect macro.
3. **A coalesced wake can acquire a false completion state.** A component-level counterexample reproduces a folded delivery remaining “completed” after its parent attempt is deferred.
4. **Optional context retrieval is substantially degraded.** The transcript/work-item corpus leg timed out on 79.4% of recorded initialization recalls in the fixed measurement window.
5. **Scheduler admission and maintenance delays are material.** Even within the permitted `papercusp` scope, active routines were hours overdue. Several are themselves recovery or reconciliation functions.
6. **Incident handling is generating considerable duplicate work.** A narrow seven-day title-family query found 329 records about the same session-read error, including 174 still open.
7. **The evidence needed to certify reliability is incomplete.** The exposed coverage census has very sparse attached evidence, governor health/control fields remain unknown, and the application backup ledger has no successful snapshot newer than September 7.

The recommended order is: restore critical retrieval and truthful delivery accounting; make failed recovery converge; protect scheduler/control-plane progress; then strengthen acceptance tests and evidence coverage. Do not broadly restart agents, relax safety gates, increase concurrency, or extend timeouts in response to this report.

## Scope, method, and limitations

The audit inspected the canonical staging source, selected release-source counterparts, live read-only database aggregates, registered state assessments, the background-host journal, and PTY discovery/event files. It also ran a valid live session-read probe and a pure in-memory coalescing counterexample. No service was restarted, no wake was injected, no configuration was changed, and no product code was edited.

The fixed database measurement window is **September 12, 2026, 23:00 UTC through September 13, 2026, 23:00 UTC**, equivalent to **7:00 p.m. EDT through 7:00 p.m. EDT**. Point-in-time observations were collected around 22:53–23:12 UTC on September 13 and are explicitly snapshots, not continuous availability measurements.

The source checkout advanced during the audit: initial HEAD was `1d46df0059db5950e3ef6717ccfc847cc5bdb036`; a later read was `8333227e6274473e8976e7534fe5115bc71e6a63`. File/function references therefore identify the inspected implementation, not an immutable deployment certification.

Evidence labels used below:

- **Verified current defect:** reproduced directly or supported by current failure records and the responsible source.
- **Verified degradation:** measured impaired behavior, with the full initiating cause not yet isolated.
- **Component counterexample:** deterministic reproduction of a source-level failure path, without asserting that a particular live message was lost.
- **Evidence gap / risk:** the available instrument cannot establish the desired guarantee.
- **Recent incident, current persistence unproven:** historical failures occurred within the window, but are not asserted to be ongoing.

This is a broad operational audit, not a line-by-line proof of every subsystem. It did not conduct destructive crash tests, a database restore, failover exercises, penetration testing, a fleet-wide model-quality evaluation, or full test-suite execution. Cross-machine federation and other projects were not exercised; the current work-scope policy permits work on `papercusp`. Cross-workspace aggregates were deliberate observations of shared backend infrastructure, not changes to those projects.

Distilled measurements and representative probes are retained in [the evidence file](backend-reliability-2026-09-13-evidence.json). Audit work-item: `WI-10001230`.

## What the measurements show

### Backend tool dispatch

The invocation ledger recorded the following outcomes during the fixed 24-hour window:

| Outcome | Dispatch records |
|---|---:|
| `ok` | 371,664 |
| `error` | 3,208 |
| `timeout` | 207 |
| `invalid-input` | 2,834 |
| `refused` | 1,999 |
| `role-not-allowed` | 79 |
| `replayed` | 12 |
| **Total** | **380,003** |

Errors plus timeouts constitute approximately **0.90% of these dispatch records**. This is **not** an application availability percentage: wrapper and child calls can both be logged, rejected inputs are a separate class, and test/probe traffic was not comprehensively excluded. The writer maps dispatch outcomes into these statuses; an `ok` transport/dispatch result is not a universal proof of successful business behavior. Successful dispatches had a recorded p95 duration of approximately **14.2 seconds**.[^S1]

The important finding is concentration. In this window, `sessions:read` on `port-3070` had **1,716 error records and no `ok` records**, whereas other serving hosts recorded successful reads. A live valid read reproduced the failure. This concentration is far more actionable than the aggregate rate.

### PTY host activity

At **22:57:54 UTC**, the discovery census contained **115 live PIDs**:

- 107 had readable per-owner event files; eight had no event file.
- 67 advertised the hash of the inspected current host script; 48 advertised a different hash.
- 79 had at least one defer/drop event in the sampled window.
- No event file exceeded the 2 MiB per-file read bound; no parsed event line was invalid.

The event window was the later of each host's current start and the preceding 24 hours. This excludes terminated hosts and is not a census of every session that ran that day. A later positive-control census verified the host-process identity and socket existence of all 113 then-surviving discovery entries. Population changes between those reads are expected.

| Event kind | Records at the initial snapshot |
|---|---:|
| `busy-gate-expired` | 1,618 |
| `wake-turn-deferred-for-pending-respawn` | 1,505 |
| `respawn-carry-dropped` | 457 |
| `respawn-rearm-queued` | 610 |
| `respawn-carry-delivered` | 1,818 |
| `inject-mutex-stuck` | 23 |
| `turn-deferred-quota-blocked` | 130 |
| `mcp-reconnect-started` / `mcp-reconnect-failed` | 77 / 77 |

These are event counts, **not distinct lost messages**. One operation can emit several events; a deferred attempt can later succeed; “carry delivered” is not identical to productive work. Event-to-operation correlation is itself an improvement area.[^S2]

## Detailed findings

### F01 — Critical session-history reads fail on the release endpoint

**Priority: P1. Verified current defect; repair present in staging.**

`sessions:read { session: "self", tail: 1, text_limit: 100 }` returned `handler_error: invalid escape string` during the audit. The release query uses:

```sql
substring(text FROM ${textOffset + 1} FOR ${textLimit})
```

The inspected staging query casts both parameters to `::int`. The existing private-PostgreSQL regression test reproduces the uncast error and distinguishes the cast repair. This is a concrete SQL overload-resolution failure, not “bad context” or an agent supplying a malformed tail request.[^S3]

Impact: agents cannot reliably retrieve their own earlier discussion, expand search hits, or reconstruct context after a carry. This causes repeated investigation and dependence on truncated checkpoints.

Recommended improvement:

- Carry the already-existing repair through the normal verified deployment process.
- Add a post-deployment canary that exercises the exact `sessions:search → readMore → sessions:read` contract, including self, named session, and predecessor/successor reads.
- Bind the canary to the serving build and endpoint; a staging pass must not certify the release endpoint.
- Track critical-tool success separately from aggregate tool success.

Acceptance: a known-answer corpus read succeeds on the deployed build and returns exactly the expected source/turn; a deliberately uncast test remains a failing negative control.

### F02 — Busy-gate deferral is a family of conditions, not one fault

**Priority: P1. Verified degradation; individual causes differ.**

The host deliberately waits for a safe boundary before writing a machine turn or replacing a child. This protects in-flight work and human input. The busy gate primarily watches output silence, with a 1,500 ms quiet threshold in the observed events and 180,000 ms busy caps. Current code also accepts specific native Codex completion evidence for warm turns and carry-respawns.[^S2]

A later reason slice contained **824 turn**, **699 carry-respawn**, **85 reset**, and **15 recycle** busy-gate expirations. Some expirations had almost no quiet gap; others reached the threshold before the post-poll recheck invalidated it. Therefore neither “every defer is benign” nor “every defer is a wedged agent” is justified.

At least these classes need separate treatment:

| Class | Interpretation | Appropriate response |
|---|---|---|
| Agent genuinely generating | Normal protective backpressure | Preserve work; resume at a verified boundary |
| Idle TUI repaint | Output activity may not mean active reasoning | Use backend-native turn state |
| Carry already pending | Wake and replacement contend | Coalesce against the exact pending operation |
| Provider/quota block | No usable inference path | Verify account condition and recovery outcome |
| Human text staged | Preserve the person's unsent input | Never force-clear based only on a timer |
| Missing recovery prerequisite | Retrying the same operation cannot succeed | Repair or explicitly block on the prerequisite |

Recommended improvement: unify backend-specific native lifecycle adapters for Claude, Codex, and OMP, retaining output silence only as a conservative fallback. Record the selected boundary proof and why alternatives were unavailable. Do not remove the busy gate or simply shorten its quiet threshold.

Acceptance: an idle, continuously repainting TUI accepts a queued wake; a genuinely active turn and a human-staged line remain protected; missing native evidence is reported as unknown rather than idle.

### F03 — Folded wake IDs can be marked completed before their parent succeeds

**Priority: P1. Deterministic component counterexample; live impact not quantified.**

The host's same-source coalescing branch immediately calls `deliveryDedup.markCompleted()` for the folded delivery and returns `coalesced-into-pending-turn`. If the original waiter subsequently expires at the busy gate, the coalescer is cleared and the original pending ID becomes retryable. The folded ID is still completed. The executor explicitly parks `accepted` and `pending-delivery-id`, but other successful confirmation reasons can reach its delivered branch.[^S4]

A pure probe using the actual exported factories reproduced:

```text
first A admitted as waiter: false
B folded into A: true
after A defers:
  A dedup state = null
  B dedup state = completed
```

This is not a full live-delivery reproduction, and it does not prove the loss of a specific user's message. It does establish a false-terminal-state path in the component contract.

Recommended improvement:

- Link every folded ID to its parent operation until a shared terminal outcome exists.
- Propagate success, deferral, cancellation, and failure to all folded IDs atomically.
- Represent `coalesced-pending` as pending in the executor.
- Preserve the relation across host replacement if the retry window spans replacement.

Acceptance: coalesce A/B, defer or crash A before submission, retry B, and observe exactly one eventual native turn—not a suppressed B or a duplicate turn.

### F04 — A missing Codex prompt file causes repeated, unsuccessful carry recovery

**Priority: P1. Verified persistent per-host defect.**

Host `su-d70effba-60a5-47ab-9726-e1a3e7fb76b7` repeatedly logged `respawn-failed`, `reason: argv-build-failed`, naming:

```text
$HOME/.papercusp/su-codex-homes/session-22472/AGENTS.md
```

The file remained absent at inspection while its parent directory existed. Approximately 181 repetitions were observed in the rolling window, including events near both ends of the day.

The launcher reads either its saved base prompt or `AGENTS.md` while constructing a carry. Missing input throws. The host correctly prepares the successor before killing the predecessor, so this failure preserves the existing child. But repeated attempts do not reconstruct the missing prerequisite.[^S5]

Recommended improvement: make prompt provenance recoverable from the canonical render and last verified launch record; preflight it once per failure episode. A failed preflight should produce a durable actionable state, not identical retries indefinitely. Recover the exact intended instruction set rather than silently substituting an arbitrary default.

Acceptance: removal of the base prompt in an isolated fixture either regenerates the correct prompt and completes a carry, or produces one clearly blocked operation while leaving the current child intact. The actor that originally removed this file was not established.

### F05 — MCP reconnect automation repeats a failing terminal macro

**Priority: P1. Verified failed recovery episode; root UI/transport cause unresolved.**

A single Claude host, `su-respawn-2a7d64092bc19a458c439097eaf16747`, recorded 77 reconnect starts and 77 failures in the inspected rolling window. Seventy-five failed at `open-dialog`: the server name never appeared within 8 seconds. Two failed waiting for a connected marker within 20 seconds.

The implementation types `/mcp`, waits for particular visible text, navigates a terminal menu, and checks a connected marker. That is a version-sensitive presentation contract, not a transport-level reconnect API.[^S6]

The observations do not prove all MCP reconnects fail or identify whether this instance has a changed TUI, absent server entry, incomplete repaint capture, or another blocked state. They do prove that this recovery episode was not converging.

Recommended improvement: bounded, episode-aware recovery with exact failure-step evidence; validate server configuration before running the macro; use a backend-supported reconnect interface where available. After a small bounded number of identical macro failures, move to a separately verified recovery path instead of replaying the same inputs indefinitely.

Acceptance: inject representative missing-server, changed-dialog, stale-transport, and failed-auth conditions in isolation. Each must recover or produce a terminal actionable diagnosis. A “reconnect attempted” marker must never certify recovery.

### F06 — Host code and child code have different upgrade lifecycles

**Priority: P1/P2. Verified version skew; not every mismatch is defective.**

At the initial census, 48 of 115 hosts advertised a hash different from the inspected current host script. A carry can replace the agent child without replacing the host process. Current source permits host-code adoption through re-exec only when no human TTY is bridged; this intentionally protects interactive terminal continuity.[^S7]

Consequently, “the fix is deployed” is insufficient for long-lived host behavior. Conversely, a hash mismatch alone does not prove that a host lacks any specific fix.

Recommended improvement: publish a component capability/version matrix—launcher, PTY host, child, proxy, backend—and attach it to recovery decisions. Track which minimum host generation each fix requires. Design a safe, checkpointed interactive-host upgrade path; preserve the current prohibition on indiscriminate re-exec of attended terminals.

Acceptance: demonstrate that the particular fixed behavior is present in an already-running session, or explicitly report that its host still needs migration.

### F07 — Optional corpus retrieval frequently returns no context because its deadline expires

**Priority: P1. Verified degradation; slow substage not yet isolated.**

The corpus leg searches transcript and work-item material independently of the primary memory block. Its recorded fixed-window outcomes were:

| Entry point | Timed out | Recorded attempts | Timeout share |
|---|---:|---:|---:|
| Initialization | 3,673 | 4,625 | 79.4% |
| Turn start | 621 | 1,633 | 38.0% |
| Claim | 207 | 646 | 32.0% |
| Mid-turn | 3,210 | 13,139 | 24.4% |

The mid-turn denominator includes 58 `no-query` outcomes. These figures describe recorded corpus attempts, not distinct agents or all prompts.

The implementation bounds the whole optional leg at 2 seconds by default and returns an empty `timed-out` outcome. Primary memory results can still be admitted: these timeouts are not equivalent to “memory is down.”[^S8]

Recommended improvement:

- Instrument acquisition, embedding, lexical search, vector search, filtering, and reranking separately.
- Keep the prompt path bounded; do not simply raise the total deadline.
- Reuse query embeddings, warm only required models, prioritize exact-ID/known-item reads, and isolate expensive model work from the request event loop.
- Return useful completed lexical evidence when optional later stages exceed budget, where correctness permits.
- Evaluate answer-bearing retrieval and actual use, not just the number of snippets returned.

Acceptance: replay a representative known-answer set under controlled concurrency; report per-stage latency, deadlines, admitted useful results, and the effect on ordinary tool latency.[^S8]

### F08 — Timeout telemetry can wrongly suggest that the embedder was unavailable

**Priority: P2. Verified diagnostic ambiguity.**

The corpus `empty()` constructor sets `embedderAvailable: false` even for `outcome: timed-out`, where the code has no completed leg report. Sample telemetry then carried `embedder-unavailable` alongside `legs: null`.

This does not establish an embedder outage. The deadline can expire elsewhere. Treating that boolean as a cause would route investigation incorrectly.[^S8]

Recommended improvement: distinguish `available`, `unavailable`, and `not-observed`; retain the last completed stage and elapsed budget. Only emit `embedder-unavailable` when an embedder-specific probe established it.

Acceptance: independently delay the database, embedding, and reranking stages. Each timeout must identify the correct known stage and leave other stages unknown.

### F09 — Context delivery remains difficult to certify end to end

**Priority: P2. Mixed verified gaps and improvement opportunities.**

The session-turn embedding coverage warning delivered during this audit reported **68.2% coverage**. That is a warning from the retrieval instrument, not an independently recounted corpus denominator. Incomplete embedding coverage can reduce semantic recall; lexical fallback may still find the answer.

Primary-memory telemetry is substantially better than a bare hit counter: current writers include score scale, per-leg statistics, admission stages, deduplication, and corpus outcomes. Epochs are being updated; the epoch table showed 124 session records bumped within the preceding day. This contradicts an unsupported claim that compaction epochs are universally inert.

Remaining improvements:

- Display index completeness and freshness by source and client.
- Certify predecessor/successor retrieval with known answers.
- Distinguish “retrieved,” “admitted,” “delivered to native context,” and “used.”
- Preserve exact-ID retrieval when semantic recall degrades.
- Apply separate budgets to human task text, operational messages, and tool-schema boilerplate.
- Tighten tool-discovery metadata delivery: loading a small number of schemas in this audit also brought a very large namespace instruction/index block.

Do not treat reciprocal-rank-fusion scores as cosine similarity, a low admitted count as automatically bad, or budget/dedup filtering as loss. The source explicitly documents why several filters are intentionally selective.[^S9]

### F10 — Active routines can wait hours, including recovery functions

**Priority: P1. Verified lateness; no universal dead-scheduler claim.**

An initial all-workspace snapshot showed 141 of 240 active durable cron rows more than ten minutes past `next_fire_at`. Some projects are deliberately out of the current work scope, so that aggregate is not a count of defects.

A narrower read still found **53 overdue active routines on the exact `papercusp` install slug**. Representative subsequent rows included:

| Routine | Minutes overdue at that read |
|---|---:|
| `work-item-admission-fail-open` | 294 |
| `presence-transition-sweep` | 178 |
| `plan-item-orphan-reconcile` | 174 |
| A `system:loop-wake` routine | 150 |
| `inbox-bulk-resolve` | 144 |
| `personal-vault-import` | 137 |
| `reconcile-silent-halts` | 105 |

The scheduler checks adaptive admission **before** claiming a routine. Held jobs deliberately retain their due timestamp. The background-host journal contained 164 `HELD` dispatch lines and 21 pool-starvation lines in the inspected approximately one-hour interval; one reported an acquire-plus-`SELECT 1` probe of 2,669 ms and restricted dispatch to the critical queue.[^S10]

This supplies a real mechanism for at least part of the delay: the scheduler intentionally withholds starts under feedback/pressure. It does not prove that every late routine shares that cause. A sparse DBOS running queue does not exonerate this pre-enqueue admission layer.

Recommended improvement: expose scheduled, eligible, held, admitted, running, and completed separately, including hold reason, age, controller generation, next retry, and intended policy. Protect bounded recovery/control-plane work from indefinite starvation. Test fairness under sustained pressure, not only single-epoch decisions.

Acceptance: eligible recovery routines make progress within an explicit service objective under sustained ordinary workload; policy-held routines explain their hold without appearing healthy or silently overdue.

### F11 — Some standing actions lack a scheduled materialization

**Priority: P1/P2. Confirmed current alarm; full action list needs disposition.**

The background host logged a routine-validation finding naming 13 registered actions without routine rows. The validator compares registered **standing** actions with scheduled targets, so this is not simply a grep over unused functions.

A read found no matching routine targets for five named examples. For `durable-escalation-orphan-sweep`, source independently declares it standing and includes a seed script explicitly warning that an unexecuted seed leaves the feature inert. Other actions, including project-specific ones, still need an intended-lifecycle review.[^S11]

Recommended improvement: reconcile standing action declarations into idempotent materialization, or explicitly classify genuinely event/on-demand actions as such. Give every missing action an enabled, intentionally disabled, on-demand, or retired disposition. Validate installation and upgrade paths, not just existence of seed scripts.

Acceptance: a fresh isolated boot and an upgrade both produce the intended schedule set; deliberately removing a standing schedule is detected with its exact missing identity. No claim is made that each of the 13 should be activated in this workspace.

### F12 — A recent shared SQL-wrapper regression broke scheduler pulls

**Priority: P2. Recent incident; current persistence not established.**

The rolling 24-hour slice contained 205 `scheduler:get_next` errors with `syntax error at or near "last_released_by"`, across 47 recorded owner identities. The newest observed event was **September 13 at 08:34 UTC**.

The inspected cancellation-wrapper source explains and fixes this exact failure: assimilating a postgres-js fragment as a Promise can execute that fragment as a standalone query. The repair tracks the query for cancellation without observing its thenable methods.[^S12]

Recommended improvement: exercise SQL-fragment composition through the real transaction/cancellation wrapper against isolated PostgreSQL. Test abort-before-acquire, abort-during-query, nested fragments, and cancellation cleanup.

Acceptance: cancellation remains effective without starting fragments independently. Do not reopen this as an ongoing outage solely because older errors remain in the ledger.

### F13 — Client/server schema skew is breaking operational hooks

**Priority: P1/P2. Verified rejected-hook population.**

In the fixed window, `activity:report` had 682 invalid-input records on release build `e66be3c4ff`, across 40 recorded owner identities. The rolling origin split attributed 681 to declared hook traffic. The error rejected `role`; current staging accepts that field, while the inspected release source lacks it.[^S13]

Impact: loss of activity-report events can degrade the evidence used by liveness, progress, and coordination systems. This audit did not demonstrate that these rejected events caused a particular wrongful reclaim.

Recommended improvement: version hook payloads and receiver capabilities; negotiate optional fields or maintain a compatible rollout window. Add an actual hook-to-deployed-receiver contract canary for every supported client.

Acceptance: old/new hook and server combinations either record the event correctly or return a clear compatibility failure without silently disabling operational evidence.

### F14 — Incident capture and closure are not converging on unique operational faults

**Priority: P1/P2. Verified failure and duplicate-record populations.**

The rolling window contained 268 `improvements:capture` unique-constraint failures naming `work_items_watchdog_identity_uq`. These were observed on newer serving builds as well, so this cannot be explained solely by the older release endpoint.

Separately, a seven-day query restricted to `sessions:read`/`invalid escape` title terms found **174 open, 124 done, 27 dropped, and four resolved records**. These are title-family matches, not 329 proven identical root-cause incidents. They nevertheless show substantial repeated filing around a known current failure.[^S14]

Recommended improvement:

- Make the database identity the single atomic upsert authority.
- Return the existing incident after a duplicate race.
- Separate a root-cause incident, new observations, and affected-runtime deployment residue.
- Do not mutate a claimed issue into a materially different report under broad coalescing.
- Close “fixed in staging” separately from “resolved in the affected runtime.”

Acceptance: concurrent same-fault submissions return one incident plus observations, without a constraint error. Distinct faults remain distinct. Repeated reports from an unfixed runtime enrich the existing deployment-residue record.

### F15 — Communication completion and failure timing need stronger semantics

**Priority: P1/P2. Verified outcome ambiguity and deadline failures.**

The wake ledger distinguishes useful channels, but several share `status: delivered`. A rolling snapshot included 4,809 `suppressed-redundant`, 761 `psu-socket-inject`, 352 `coalesced`, and 335 `inbox` deliveries. These mean different things. Suppression can be correct when the message was already surfaced; inbox fallback preserves content but cannot guarantee that an otherwise sleeping agent starts a turn.

Current code does improve on historical early-ACK behavior: `accepted` and `pending-delivery-id` stay parked. After eight parked attempts, it can fall back to the inbox. That prevents infinite transport retry but leaves an end-to-end wake liveness question.[^S15]

The fixed invocation window also recorded 42 `coord:send` timeouts, with a median recorded duration around 74.8 seconds. Some errors explicitly say the handler returned after its signal had aborted. That is not proof that the underlying message write failed; retrying an ambiguous write without stable identity risks duplicates.

Recommended improvement: a reusable delivery lifecycle with immutable operation ID and separate acceptance, durable storage, submission, native turn start, content surfacing, and requested acknowledgment/action completion. Use explicit deadlines and terminal dispositions per stage; preserve current inbox fallback as degraded delivery, not proof of pickup.

Acceptance: sender interruption after commit, ACK loss, busy deferral, coalescing, cancellation, and host replacement must each produce one traceable outcome without duplicate execution.

### F16 — Governor “queue” mixes waiting with running; health/control lenses are unknown

**Priority: P2. Verified observability limitation.**

The governor state reported a growing backlog while health, admission, and recovery were unknown. The writer explains why: the system-health bridge publishes the queue population but has no authoritative controller or recovery decision to publish.

The queue depth includes `queued`, `eligible`, `leased`, **and `running`** receipts. It must not be described as “all these requests are waiting.” A follow-up state split did identify genuine waiting: 71 process receipts queued with an oldest enqueue age of 5.76 hours, and seven agent receipts queued with an oldest age of 7.17 hours. Whether those oldest receipts still represent valid demand was not established.[^S16]

Recommended improvement: separate waiting and executing counts; retain owner liveness, lease state, cancellation, and demand validity; publish controller/health/recovery observations from their actual owners. Do not infer current admission capacity from a queue-only snapshot.

Acceptance: a long-running admitted task does not inflate waiting-time alerts; expired/cancelled demand does not look actionable; unknown control state remains visibly unknown.

### F17 — The coverage system cannot currently support a broad reliability certification

**Priority: P1/P2. Evidence gap, not proof that almost all code is untested.**

The exposed coverage assessment reported 2,066 censused surfaces, eight with an evidence basis, 2,058 below the configured floor without waivers, and 254 unobservable surfaces. The writer defines evidence as observed traffic or authored evidence attached to the census.[^S17]

Those numbers do **not** establish that 2,058 surfaces have no tests. They show that the assurance/evidence system cannot currently demonstrate their coverage. Generating thousands of new tests before verifying evidence ingestion would risk treating an instrumentation gap as a test gap.

Recommended improvement: first map representative existing tests to census evidence and verify persistence from an isolated test environment. Then prioritize contract and failure-path coverage for the components in this report.

Acceptance: a known test run changes the correct surface's evidence; a negative control does not. Unobservable surface kinds are explicit and cannot be silently counted as covered.

### F18 — Backup freshness and restore readiness are not established by the available ledger

**Priority: P1 verification task. Evidence gap / freshness risk.**

The most recent application backup row for `papercusp-workspace` was successful, had an associated snapshot, and recorded `db_dump_ok: true`; it finished **September 7, 2026 at 17:45:11 UTC**. Earlier rows were also successful. The application's health reader uses this ledger for backup freshness.[^S18]

This is a six-day-old application-ledger success, **not proof that every backup mechanism has failed since then**. Standing incident context explicitly warns that an older database-backup alarm was false. No restore was performed in this audit, and independent destination freshness was not established.

Recommended improvement: reconcile application snapshots, database dumps, and independent backup jobs; define their expected cadence and ownership; verify the latest artifacts at the destination. Run an isolated restore drill that verifies schema, representative content, and restart behavior, then publish recovery-point and recovery-time evidence.

Acceptance: a fresh artifact is independently readable and restores a usable system. A successful snapshot record alone is insufficient.

## Cross-system improvements

### 1. Measure completed user/agent journeys

Keep the existing detailed ledgers, but use them to measure outcomes such as:

- a scheduled job becomes eligible, starts, and completes;
- a required wake starts the intended native turn;
- a context search returns an answer-bearing source and that source can be expanded;
- a carry preserves the task and resumes productive work;
- a failure report returns a stable incident identity;
- a backup restores usable data.

Define explicit service objectives for each journey. A tool success rate, healthy HTTP endpoint, or live PID is not a substitute.

### 2. Make recovery fail differently when its premise changes

Repeated missing-file and reconnect-macro failures show the value of episode-aware recovery. After repeated identical failures, record the stable cause, suppress redundant retries, and invoke a genuinely different verified recovery path—or clearly expose an actionable block. Do not merely restart the same loop with the same broken inputs.

### 3. Keep control-plane progress independent of ordinary work

The project already separates critical, loop, release, heavy, and fleet-control queues. Preserve and validate that isolation rather than adding a parallel scheduler. Test whether admission/recovery logic still permits bounded control progress during sustained database or event-loop pressure.

A current stable free-memory reading does not disprove earlier pool delay; conversely, a slow pool probe does not identify the workload creating it. Capture causal timing and attribution before tuning capacity.

### 4. Roll out contracts across actual processes

Treat hooks, launchers, proxies, PTY hosts, background workers, and HTTP workers as separate deployment targets. Record running generation, supported payload version, and required migration capability. Build compatibility tests across old/new pairs, and verify the specific target that still exhibits the fault.

### 5. Reduce diagnostic noise without hiding failures

Use one condition identity and one accountable incident, with observations attached. Scope default recall to the current task; avoid repeatedly delivering the entire policy/runbook index when one schema is requested. Clearly label stale facts, historical fixes, missing evidence, and fallback outcomes.

This should reduce both context cost and false remediation. It must not be implemented by suppressing current faults or silently discarding evidence.

## Recommended execution order

| Order | Work package | Main result | Verification |
|---|---|---|---|
| 1 | Critical retrieval and hook compatibility | Release session reads and activity reporting work | Deployed known-answer and actual-hook canaries |
| 2 | PTY delivery accounting | Folded IDs cannot falsely complete | Parent defer/crash/cancel tests with exact native-turn receipts |
| 3 | Recovery convergence | Missing prompt and repeated reconnect episodes recover or block once | Isolated prerequisite/UI/transport fault tests |
| 4 | Host version lifecycle | Existing sessions receive applicable host fixes safely | Running-generation and behavioral proof |
| 5 | Context latency/completeness | Corpus context succeeds within bounded prompt budgets | Known-answer replay with per-stage timing |
| 6 | Scheduler admission and materialization | Recovery work progresses; standing actions have explicit dispositions | Sustained-pressure fairness and fresh-boot tests |
| 7 | Incident deduplication and lifecycle | One fault produces one accountable incident | Concurrent write/race and runtime-residue tests |
| 8 | Assurance, governor visibility, backup restore | Reliability claims have independently verifiable evidence | Coverage-ingestion controls and isolated restore |

Each package should extend the existing implementation. The recommendations do not require a replacement scheduler, another communication bus, or a new memory platform.

## What should be preserved

Several mechanisms are doing the right thing and should not be removed during remediation:

- Human-input and active-turn protection before PTY injection or replacement.
- Preparation of a successor before terminating its predecessor.
- Explicit unknown/fallback states in the state plane.
- Separate primary-memory and optional-corpus telemetry.
- Score-scale attribution and staged admission metrics.
- Durable delivery identities, retry bounds, and content-preserving inbox fallback.
- Critical/control queue isolation and pre-claim pressure handling.
- A separate external observer for PTY wedges.
- Database-side timeout/cancellation mechanisms and real-PostgreSQL regression tests.

The problem is incomplete composition and proof of these mechanisms, not an absence of reliability engineering.

## Coverage record

| Area | Audit coverage | Not established |
|---|---|---|
| Backend tools/database | Fixed-window outcomes, serving-build split, SQL source and live read reproduction | Complete business-operation success rate; causal attribution of every slow query |
| Scheduler | Declaration census, due jobs, admission source, DBOS occupancy, background journal | Every late job's disposition; sustained fairness/load-test results |
| PTY/wakes/carry | Live-host events, source paths, failed episodes, component counterexample | Unique lost-message rate; all terminated hosts; destructive restart safety |
| Context retrieval | Primary/corpus outcomes, admission semantics, epochs, session-read failure | Full relevance evaluation; independently recounted embedding coverage |
| Communication | Executor/ACK/fallback/coalescing semantics, timeout and outcome records | End-to-end user acknowledgment SLA; every transport/client |
| Recovery/monitoring | Wedge detection, repeated failed repair, governor state, missing schedules | Independent certification of every detector's precision |
| Testing | Exposed census and its evidence definitions; existing regression source | Full-suite pass, all integration tests, complete coverage |
| Backup/storage recovery | Application-ledger latest successful snapshots and health reader | Destination-wide freshness, restored data integrity, RPO/RTO |
| Security/federation/platforms | Relevant local delivery safety boundaries reviewed | Penetration testing, cross-machine partitions, Windows/macOS reliability |

No product remediation is included in this audit. Identified issues remain proposed work unless an existing fix is explicitly noted.

## Sources

Private repository and runtime sources were inspected September 13, 2026. Runtime results are preserved in the accompanying evidence file and the audit work-item. Source line positions may move as the shared staging tree advances.

[^S1]: `libs/generic/tooldef/src/dispatch-stack.ts`, `recordTelemetry`; `packages/operator-core/lib/dev-data.ts`, `telemetryRollup`; `harness_shared.tool_invocations`, fixed-window aggregates.
[^S2]: `apps/operator/scripts/psu-pty-host.mjs`, `makeAgentBusyGate`, `runGatedDelivery`, native completion helpers; `packages/operator-core/lib/events/await/psu-pty-discovery.ts`; live `~/.papercusp/psu-pty/*.json` and per-owner event files.
[^S3]: `packages/operator-core/lib/agent-tools/sessions/read.ts`, substring query (staging approximately line 279; release counterpart approximately line 252); `read.integration.test.ts`, “reproduces the uncast escape error and distinguishes the integer repair”; audit's live `sessions:read` result.
[^S4]: `apps/operator/scripts/psu-pty-host.mjs`, same-source coalescing/`markCompleted`, `makeDeliveryDedup`, and deferred cleanup; `packages/operator-core/lib/events/await/wake-executor.ts`, `injectPsuHostWake`; pure-factory probe in evidence.
[^S5]: `apps/operator/scripts/psu-launcher.mjs`, `mintCarryRespawnArgs`; `psu-pty-host.mjs`, successor preparation/`argv-build-failed`; named host's event file and missing-file stat.
[^S6]: `apps/operator/scripts/psu-pty-host.mjs`, `runMcpReconnectMacro` and `mcp-reconnect` branch; named Claude host's event file.
[^S7]: `apps/operator/scripts/psu-pty-host.mjs`, `hashHostScript`, frozen host version, `shouldAdoptHostCode`; discovery-file advertised versions.
[^S8]: `packages/operator-core/lib/memory/corpus-recall-io.ts`, timeout functions, `empty`, `withBound` outcome; `memory/recall-stats.ts`, corpus admission schema; `harness_shared.memory_recall_stats`.
[^S9]: `packages/operator-core/lib/memory/recall-stats.ts`, score scale and `ADMISSION_STAGE_DESIGN_INTENT`; `memory_session_epochs`; delivered corpus coverage warning; docs search result scope/leg diagnostics.
[^S10]: `packages/operator-core/lib/dbos/routines-workflow.ts`, `evaluateRoutineDispatchEpoch` and pre-claim admission loop; `harness_shared.routines`; `dbos.workflow_status`; `papercusp-bg-host.service` journal.
[^S11]: `packages/operator-core/lib/startup/validate-active-routines.ts`, standing-action validation; `harness/routines/durable-escalation-orphan-sweep-action.ts`; `seed-durable-escalation-orphan-sweep-routine.ts`; current routine target query and journal alarm.
[^S12]: `packages/operator-core/lib/pg-bounded-txn.ts`, `cancellableTransaction`/`track`; scheduler error records in `tool_invocations`.
[^S13]: `packages/operator-core/lib/agent-tools/activity/report.ts`, staging and release schemas; hook-origin rejection records.
[^S14]: `packages/operator-core/lib/harness/improvements/capture-core.ts`, watchdog identity helpers and recovery tests; capture failure records; scoped `work_items` title-family aggregate.
[^S15]: `packages/operator-core/lib/events/await/engine.ts`, parked-attempt exhaustion and `markDeliveryDelivered`; `wake-executor.ts`, confirmation handling; `event_wake_deliveries` and `coord:send` invocation records.
[^S16]: `packages/operator-core/lib/resource-governor/queue.ts`, `readGovernorQueuePopulation`; `state-snapshot.ts`; `system-health/compute.ts`, `publishGovernorStateSnapshot`; registered governor assessments and receipt-state split.
[^S17]: `packages/operator-core/lib/agent-tools/testing/coverage.ts`, evidence definitions and `assembleCoverage`; `cell-registrations.ts`, coverage assessment; `state:read testing.coverage.floor`.
[^S18]: `packages/operator-core/lib/system-health/compute.ts`, backup freshness reader; `harness_shared.backup_snapshots`; standing fact `dead-end:backup-alarm-EI-10733-false-positive` treated as historical context, not present backup proof.
