# Backend reliability follow-through: diagnostic ledger

Plan: `backend-audit-diagnosis-before-repair-2026-09-13`.
Driver: `WI-10001261`, session `su-6eeda0f9-9087-43b2-b27d-e3856a7cf256`.
Updated: September 14, 2026, approximately 05:11 UTC (September 14 EDT).

This is an execution ledger, not a second completed audit or a repair certificate.
The original report and measurement window remain in
`docs/audits/backend-reliability-2026-09-13.md` and its evidence JSON.
No product repair by this driver is certified here.

## Authority, scope and completion rules

- The owner authorized this session to implement the broader recommendations in
  AUTO through shipped status in
  `session_turn:codex:01a09d53-bfbf-71d0-b849-79f63df8c570:27`.
- The original instruction to complete all diagnosis before implementation remains
  in force:
  `session_turn:codex:01a09cf7-0097-72b3-9640-33de048ca7a6:14`.
- The owner assigned `managed-carry-lifecycle-enforcement-2026-09-13` to another
  agent. Its current driver is `su-c77f160e-1bd4-4436-9090-bb0360873809`;
  `WI-10001256` was released with evidence. This driver must adopt overlapping
  carry evidence, not duplicate that implementation.
- Other existing work is prior art or a dependency, not automatically permission
  to take over an active claim. Inspect current ownership before touching it.
- A draft plan, an accepted request, a live process, a passing local test and a
  repaired affected runtime are different states.
- A diagnosis may close only as reproduced cause, demonstrated intentional
  behavior, verified already-fixed behavior, or a refuted premise with its
  falsifier. Unknown history is not a completed diagnosis by relabeling.

## Complete finding population and next discriminating work

Every F01–F18 identifier occurs exactly once below. “Open” means the diagnostic
obligation is still open; it does not assert that the original symptom is still
present in every running build.

| Finding | Current evidence / status | Plan coverage and ownership | Next discriminating evidence |
| --- | --- | --- | --- |
| F01 session-history SQL | Cause reproduced by the maintained private-PG regression, which passed 7/7 with zero skips. Its source covers the uncast control, cast repair, predecessor/successor, named scope, search-to-readMore and exact continuation windows. Default-endpoint reads still failed after this carry; staging self-read succeeded. A demonstrated main-selection gap is recorded below. | P-002 / P-014; gate repair P-013/P-023. Recurrence `EI-23195479465396624`; new gate gap `EI-23210600888560844`. | Complete actual producer/transport and affected-runtime coverage; adopt the saved SQL proof rather than rerunning only to reconstruct it. Main selection must be repaired after the all-diagnosis barrier. |
| F02 busy-boundary deferral | Open. Own host recorded only 144 ms maximum quiet against 1,500 ms, despite native task completion. Deferral counts are not lost-message counts. | P-003 / P-016. Carry-specific boundary repair belongs to the separate carry plan; general wake residue stays here. | Adopt exact carry fixture and native-boundary evidence; test idle repaint versus active reasoning and unsent human input without driving an attended terminal. |
| F03 folded wake completion | Real isolated PTY/control-socket reproduction now confirms B retry suppression after A defers, while fresh C reaches the same ready child. Current source marks B completed at fold admission. This is stronger than the original factory counterexample, not a claim about a particular lost live message. | P-003 / P-015; `EI-23212384525517772`. General delivery/coalescing scope here; coordinate any shared PTY file. | Preserve the reproduction below in maintained host/executor regressions; complete cancellation/crash/replacement scenarios before repair acceptance. |
| F04 missing carry prompt | Open. Original host repeatedly lacked `session-22472/AGENTS.md`; initiating removal was not established. | P-004 / P-016. Adopt carry-plan prerequisite diagnosis and repair evidence. | Trace launch/archive/cleanup ownership and reproduce a missing prerequisite in a disposable fixture; establish safe recovery or explicit blocking while preserving predecessor. |
| F05 reconnect macro | Open. Original episode repeatedly failed at dialog-open or connected-marker checks; exact UI/config/transport cause unresolved. | P-004 / P-016. Reconnect residue belongs here unless explicitly covered by the carry plan. | Inspect retained effective configuration, version and dialog evidence; distinguish missing entry, UI mismatch and transport/auth failure in isolated fixtures. |
| F06 host version lifecycle | Open. A child-only restart does not reload a long-lived parent host. A different host hash alone does not prove a missing fix. | P-004 / P-017. Carry-plan adoption evidence is an external dependency. | Match required behavior to the actual loaded host generation; verify safe attended/headless upgrade and failed-upgrade behavior without blanket restart. |
| F07 corpus deadlines | Open. Original corpus timeouts; an independently authored deadline-chain audit identifies enclosing waits, uncancelled losing work and lack of incremental safe results. | P-005 / P-018. Existing `retrieval-soft-budget-hard-deadline-2026-09-13` and `WI-10001232` must be checked for ownership and reusable evidence. | Separate queue/acquisition/inference/search/rerank latency; distinguish enclosing deadline loss from unavailable data; validate known answers under one scoped deadline. |
| F08 misleading embedder availability | Open. Original timeout construction labeled an unobserved embedder unavailable. | P-005 / P-018; overlap with existing retrieval plan must be resolved before implementation. | Independently delay embedding, SQL and reranking; require unknown for unobserved stages and unavailable only with stage-specific evidence. |
| F09 retrieval completeness and use | Open. Retrieved, admitted, delivered and used are distinct. Existing retrieval audit reports indexing falling behind in its bounded window and a delivered historical pointer not followed by an agent. | P-005 / P-010 / P-018. Reuse retrieval-plan fixtures and preserve consumer scope. | Known-answer predecessor/ID reads, indexing freshness denominator, epoch reset, exclusions and actual delivery/utilization; no inference from low scores alone. |
| F10 scheduler/control starvation | Open, concrete mechanism established below. Due loop is present but critical-pressure policy overrides offered admission to zero. Other delayed routine classes remain to be classified. | P-006 / P-019; this driver's scheduler lane. | Repeated epoch/cohort evidence, correct pressure attribution, sustained-pressure fairness negative control and bounded recovery progress. |
| F11 standing schedule materialization | Open. Original validator named missing standing-action schedules; not every declaration necessarily belongs active in this workspace. | P-006 / P-019. | Enumerate the exact original named set; reconcile declaration, boot/seed, intended scope and active/disabled/on-demand/retired disposition. |
| F12 cancellation/SQL fragments | Open for real-PG and runtime verification. Existing wrapper unit suite passed 11/11, including no eager tagged/unsafe fragment execution and active-query cancellation. These are mock-client tests, not a real-PG regression or proof that historical runtime errors remain current. | P-002 / P-014. | Execute nested fragments and abort-before/during-query through the real isolated wrapper; establish relevant build vintage rather than reopening historical errors alone. |
| F13 hook/receiver skew | Open. Original release rejected the current hook's `role` field; staging accepts it. Existing activity lifecycle unit suite passed 15/15, but directly calls the handler, so it does not establish actual producer-to-projected-receiver compatibility. | P-002 / P-014. | Actual old/new producer-to-projected-receiver matrix with recorded fixtures; establish downstream liveness impact without injecting production hooks. Preserve the isolated-test caveats below. |
| F14 incident identity | Open. Original unique-index failures and repeated title-family filings; related fixes `WI-10001183`, `EI-22536211469362868`, `EI-23198068959671510` are terminal and require verification. | P-007 / P-020. | Real-PG concurrent same/different identity submissions, claimed-content preservation, current runtime replay and stable observation attachment. |
| F15 communication receipts | Open. Transport acceptance, inbox preservation, native start and requested action completion differ. A peer inbox wake started a turn here while the recurring loop still recorded no fire. | P-003 / P-007 / P-015 / P-020. Adopt carry receipt contract without treating it as all communications coverage. | Commit/abort/ACK-loss and retry lifecycle; exact intended native turn count; inbox fallback remains degraded pickup, not completion. |
| F16 governor and loop visibility | Open. Original queue combined waiting and running. Current loop status failed to indicate a never-fired overdue loop; recovery later moved its due time without producing a fire. | P-006 / P-010 / P-021. | Trace writer units and unknowns; classify valid versus stale demand; test zero-fire deadline detection independently of manual agent activity. |
| F17 assurance evidence | Open. Sparse attached evidence does not establish absent tests. Existing `WI-2143001` concerns coverage attribution and must be checked before duplicate work. | P-008 / P-010 / P-021. | Known positive/negative test evidence must update the right surface; enumerate unsupported/waived cases and verify actual gate selection. |
| F18 backups and restore | Open. Original application ledger was old; independent backup mechanisms were not disproven. Related `WI-2145397`, `WI-2146225`, `WI-40561` concern relocated writer/probe/destination and are terminal. | P-009 / P-022. | Inspect current `/mnt/backup/db-dumps`, not abandoned `/mnt/data/Backup`; validate actual artifacts and run an existing isolated restore drill without overwriting production. |

## Loop failure: exact recorded scheduler mechanism

Subject:
`rt_papercusp_loop_su_6eeda0f9_9087_43b2_b27d_e3856a7cf256`,
workspace `papercusp-workspace`, install `papercusp`, tier `durable`.

The arm writer persisted an active 60-second loop at
`2026-09-14T01:24:34.863Z`, initially due at `01:25:34.863Z`.
At approximately `02:05Z`, the reader returned no last fire and zero fire count,
while the target socket was reachable. This establishes successful persistence,
not successful scheduling.

At `03:31:08.083Z` the recovery sweep updated its due time and recorded
`loop_rearmed_reason` as fire-starved. It still did not record a fire.
Moving the due timestamp is not evidence that the blocking policy changed.

The durable DBOS workflow
`sched-.routinesTick-2026-09-14T03:37:30.000Z`, executor `bg-host-3270`,
contains both:

1. `list-due-routines`: its recorded output includes the exact subject loop.
2. `routine-dispatch-feedback-epoch`: pressure `critical`, probe `2699` ms,
   generation `133`; queue `routines-loop` has `inFlight=0`,
   `controllerAvailableStarts=1`, but `availableStarts=0`.

Source correspondence:

- `packages/operator-core/lib/dbos/routines-workflow.ts`,
  `evaluateRoutineDispatchEpoch`, overrides critical-pressure starts to zero for
  every queue except `ROUTINES_CRITICAL_QUEUE`.
- The same file's `routinesTickImpl` separately skips targets excluded by
  `shouldFireUnderPoolShed` before claim.
- `libs/papercusp/libs/db/src/routines-runtime.ts`,
  `listDueCronRoutines`, includes active durable cron rows when due.
- `packages/operator-core/lib/harness/routines/loop.ts`,
  `computeTurnsStalled`, exits early below a minimum fire count; it cannot alone
  diagnose a loop that has never fired.

These observations distinguish pre-claim withholding from a missing loop row,
a loop absent from the due list, a full loop queue, and a lost post-submit ACK.
They do **not** yet prove why the database probe was slow or explain every
other agent's failure.

### Repeated evidence, not one transient sample

A read around `03:54Z` grouped retained `routine-dispatch-feedback-epoch`
records in the preceding hour that contained `routines-loop`:

| Pressure | Epochs | Probe range, ms | Empty queue but zero starts | Controller offered starts but override closed |
| --- | ---: | ---: | ---: | ---: |
| critical | 41 | 2082–4003 | 35 | 35 |
| elevated | 14 | 318–1942 | 0 | 0 |
| ok | 4 | 1–101 | 0 | 0 |

This is the specified retained epoch population, not all ticks or a loss rate.
The noncritical samples are positive controls against a permanently full queue.
Some ticks recorded no steps, so “tick SUCCESS” also needs its executed-step
context before interpretation.

The pressure probe itself still needs attribution:
`packages/operator-core/lib/dbos/pool-pressure.ts` measures `Date.now()` elapsed
over a lazy module import and `SELECT 1`, bounded by a `Promise.race`.
Elapsed time can include module loading and event-loop scheduling as well as
connection acquisition/query work. It must not be labeled exclusively database
pool wait without a distinguishing observation.

### Required durable repair properties

The eventual repair must give eligible, reachable loop/control work bounded
progress under sustained pressure while keeping ordinary work backpressured.
It must preserve database safety, fairness, cancellation and exactly-once
execution. Simply increasing concurrency, raising timeouts, rearming the row,
or returning “healthy” is not a fix.

Required negative controls include:

- A fresh active loop that has never fired cannot stay falsely healthy past its
  first-fire objective.
- Critical-pressure epochs cannot indefinitely exclude eligible recovery work
  solely because it belongs to the loop queue.
- A busy native turn or staged human input remains protected.
- Repeated scheduler ticks or recovery attempts cannot duplicate a native turn.
- A request ACK, successful spawn or stored inbox item cannot certify native
  turn completion.

## Existing retrieval work: adopt carefully

`docs/evidence/retrieval-deadline-audit-2026-09-13.md` records a separate owner
approval for a 1,200 ms performance target and one 10,000 ms hard deadline.
It distinguishes tolerating slow success from diagnosing the cause of latency.
This is scoped authority for that effort, not permission to widen unrelated
timeouts here.

The document identifies client-port enclosing deadlines, corpus races that
discard completed results, unforwarded cancellation, second-stage widening,
scope filtering and shared-consumer ownership obligations. Its measurements
are pre-implementation evidence. The plan reader still returned `draft` at
this inspection; neither its prose nor a terminal preparation item proves
product implementation or shipment.

## Activation and next work

### Superseded first grading attempt

Plan revision 9 / D-005 records that independent card
`EI-23207802912043197` **failed** the earlier spec-quality card
`EI-23207223300694459`. The earlier evaluator's pass was not accepted:
its acceptance-provenance statement incorrectly included 42 unaccepted drafts,
and some active clauses bundled independently testable outcomes. The review
work-item `WI-10001295` is terminal; that does not mean the plan passed.
The prior paragraph describing that review as merely pending is superseded.

The source-conversation activation audit was refreshed at sequence 2 for plan
revision 9. No product implementation is certified by that audit.

### Corrected contract set

On September 14, the active clauses for session windows versus SQL-fragment
execution, native-turn safety versus human-input safety, and completed retrieval
results versus truthful unknown stage status were split into separate outcomes.

The 42 seeded AUTO-BAR clauses were then deliberately revised from draft to
active using current revision CAS through the staging tool endpoint. Each now
has one observable contract, a concrete falsifier and a rerunnable inspection
procedure. **The complete original BAR text is preserved verbatim in required
evidence; the shorter behavior does not replace or weaken it.** The source BAR
hash, bar-set hash, rubric revision, evidence plane and acceptance reference
were preserved. Readback verified all 42 revisions, their acceptance actor and
their retained pins; no seeded draft remains.

The resulting set has 70 clauses: 55 active and 15 explicit non-behavioral
exemptions. These are contract states, not completed findings or passing tests.
The staging evaluator returned pass with no structural blockers for exact hash
`4ee4155a9b178e0d7b8a280556ef0286c78aacc131f0ae92c60af66b539dcc3b`.
New terminal spec-quality card `EI-23210288564537863` has **independent
grading-integrity review pending**. Its exact subject is
`spec-set:plan-class-bugfix:4ee4155a9b178e0d7b8a280556ef0286c78aacc131f0ae92c60af66b539dcc3b:806b7bd34648328c`.
The automatic router selected an already-ended session. Its consult
`conv-mu0r5bj8-0000-754c5ae7ed0a4645bf4fa354bc5a6029` expired at
`2026-09-14T04:37:59.048849Z`, with no responder and no posts. A direct wake to
that recipient was refused; nothing was delivered. This corrects any
interpretation of the reservation as a progressing audit. The defect is
registered as `EI-23210715718620697`.

**Temporary mitigation:** review work `WI-10001306` was assigned to the previous
independent reviewer, `su-c77f160e-1bd4-4436-9090-bb0360873809`, whose current
presence was parked rather than ended. A shortened action request was
successfully delivered at `04:46:11Z`, after an oversized request was refused.
Its wake was queued, with `pickupConfirmed:false`; neither actual pickup nor
an independent verdict has yet been verified. Repairing the router's dead
candidate/cascade path remains separate work. Do not reuse the failed card,
self-audit the new one, or activate before the independent pass.

Continue read-only diagnostic preparation while review is pending. After
activation, complete the per-finding diagnostic records and the all-diagnosis
review before repairs, then maintained behavioral regressions and actual
promotion selection, rollout and independent acceptance. This initial
inventory is not all diagnosis complete.

## Retained verification and runtime observations

### Activation update after independent review

The corrected card `EI-23210288564537863` was independently passed by
`EI-23211304171317937`; reviewer `WI-10001306` is complete. D-006 records
that ruling without waiving diagnosis-first. The earlier pending-review
paragraphs above are historical snapshots, superseded by this result.

Activation then exposed a separate revision-pinning issue:
`plans:start` reported `bar_snapshot_rubric_revision_mismatch`. The six BARs
were individually clean, but subject plan revision 10 (after D-006) differed
from rubric revision 2's `barContract.subjectPlanRevision:9`.
`EI-23211441531145933` records the cause and recovery.

Canonical staging activation audit sequence 3 synchronized the rubric to
revision 3 / subject revision 10 while retaining exactly the same BAR-set
hash. Sequence 4 extended source-conversation coverage through turns 32–51
and added M-009 for the repeated owner continuation requests. It preserved
the previous eight mappings, resolved 19 canonical refs, reported zero
unsupplied turns and did not change the rubric again.

This provenance refresh advanced 42 source BAR pins and matching acceptance
references from rubric 2 to 3. Comparing each current clause to its preceding
revision found no change to behavior, behavior class, required evidence,
test layers, mutation requirement, lifecycle or falsifier. Nevertheless the
exact spec-set hash changed, so the old independent pass is not substituted
for a new exact-subject verdict.

New hash:
`04039db9c69d0c1d88e7f48d9169faed9e8e491bdb8a43c884903ca5afde70a0`.
New terminal spec-quality card: `EI-23211811916557156`.
Independent review: `WI-10001308`, accepted by the same independent reviewer
and still pending at this inspection. Do not add a new plan decision merely
to log the pin refresh through the older writer and recreate the mismatch.
The current plan is not yet started.

### F03 real PTY diagnostic: false completed delivery

This diagnostic used the actual `hostThroughPty` implementation with a
disposable Node echo child, fake bridged human IO, unique owner
`diag-f03-bd41689a-0f44-4147-a3b9-9665451bc35b`, and that owner's version-1
UNIX control-socket envelope. No live agent was injected or interrupted.
The child emitted busy output for 2,500 ms; the fixture busy cap was 500 ms.

Observed sequence:

| Step | Host response / observed child outcome |
| --- | --- |
| A arrives during busy output | `accepted` |
| B, same routine with a distinct delivery ID, arrives behind A | `coalesced-into-pending-turn` |
| A exceeds busy cap | Host records deferred/refused; no `ECHO:F03_DIAG` |
| Child becomes idle; retry exact B | `duplicate-delivery-id`; still no `ECHO:F03_DIAG` |
| Fresh C on the same now-idle child | `accepted`, followed by `ECHO:F03_CONTROL` |

The positive control distinguishes retry suppression from a dead child,
unusable socket or universally closed busy gate. The child exited naturally;
both its socket and metadata file were removed. Production host-source
SHA-256 was identical before and after:
`7de9982e468d58d33b1d6e2fb6889c992177d585e0d889d5084b2ef2ba401027`.

Root cause correspondence: the host's fold branch immediately calls
`deliveryDedup.markCompleted(B)` and returns. Parent A's deferred cleanup
clears only A's pending entry; it has no relation through which to clear B.
The executor explicitly parks `accepted` and `pending-delivery-id`, not
`coalesced-into-pending-turn`. The existing successful-coalescing integration
case omits delivery IDs, and separate dedup factory tests do not exercise
this composition.

This is diagnostic evidence, not a shipped regression or a repair. The
maintained regression must cover deferred/crashed/cancelled parent outcomes,
retry B, exactly one eventual native turn, and host replacement within the
retry window. Earlier attempts failed at fixture source encoding or omitted
the protocol version; they are **not** product-failure evidence. In
particular, the first ENOENT did not establish a product socket-race defect.

- Maintained test:
  `packages/operator-core/lib/agent-tools/sessions/read.integration.test.ts`.
  Saved run `task0mu0pzmkop8yvzh1raw`, bash handle `eec645d8-549`, log
  `.papercusp/scratch/bash-eec645d8-549.log`: 7/7 passed, zero skips, one
  requested/executed file. The earlier checkpoint records tested HEAD
  `03d0fc4691` and no uncommitted changes to the tested file before/after.
  Adopt this proof rather than rerunning only to reconstruct it.
- Post-carry default `sessions:read {session:"self",tail:5}` again failed with
  `invalid escape string`; that occurrence coalesced onto
  `EI-23195479465396624`.
- Explicit `ptool --url=http://127.0.0.1:3170 --transport=http` successfully
  read the current self-session. The staging scorecard emitter identifies
  loaded build `e0070449ea9fbb10f00d6d9d812bf31ed0dcc3b8`, started
  `2026-09-14T04:10:37.000Z`. These observations establish a usable staging
  tool path, not release deployment or background-host readiness.
- The carry's last successful operation and flight record identify the
  pre-boundary compaction request and its activity report. There is no new
  product edit in that recorded blind window.

### Main-promotion selection: demonstrated gap, not missing test

The documented read-only selector was executed with exactly these changed paths:

```text
packages/operator-core/lib/agent-tools/sessions/read.ts
packages/operator-core/lib/agent-tools/sessions/read.integration.test.ts
```

`node scripts/affected-tests.mjs --changed-paths <the two paths> --print-affected`
exited zero and selected the operator-core unit lanes and applicable lints,
but no integration task. The same probe with `--integration` is a positive
control: it selected operator-core `test:integration`. Both outputs were
untruncated; their complete task lists are retained in
`.papercusp/scratch/bash-26df0ab1-19a.log` and
`.papercusp/scratch/bash-2ffd8f4d-28d.log`.

The writer explains the difference: `scripts/affected-tests.mjs` adds the broad
integration task only when `runIntegration` is true. The root `test:affected`
command does not pass that flag. Operator-core's ordinary configurations use
the unit layer, whose shared config in `libs/test-config/src/vitest-config.ts`
excludes integration-test suffixes. A positional test filter cannot reverse
that exclusion.

`EI-23210600888560844` records the scoped repair under P-013/P-023: reuse the
existing focused invariant-guard integration venue, with selection tests for
relevant source/test/fixture/config/submodule triggers and fail-closed
execution. Do not turn on the entire integration sweep as a shortcut. No
current release verdict was read, rerun or changed by these source-selector
probes.

### Existing cancellation and activity tests

Run `0mu0rhce31kypv2ktsh` / bash `3222fd44-60e`, retained log
`.papercusp/scratch/bash-3222fd44-60e.log`, completed with exit zero through
the maintained `npm run test:file` router:

- `packages/operator-core/lib/pg-bounded-txn.test.ts`: 11 passed.
- `packages/operator-core/lib/agent-tools/activity/report-lifecycle.test.ts`:
  15 passed.
- Router: two requested, two executed, 26 passed, zero skips. Tested HEAD
  `a6bf58a90c0673a21800e66dccfe50ffd588c7f7`; the two test files were clean.
  Before/after hashes for both tests and both production source files were
  identical.

These tests do not complete F12/F13 diagnosis. The wrapper test uses a fake
thenable client; the activity test bypasses projected schema dispatch and
mocks the persistence/lifecycle seams. The output also reports unit-PG guards
rejecting carry/reset marker reads, followed by the handler's fallback path.
No real database connection was permitted by those guards. That warning
cannot be represented as successful testing of the true carry-marker path,
nor does it establish a production outage.

## P-001 continuation inventory — September 14, 05:52 UTC

Independent review `WI-10001308` is complete. Card
`EI-23212685237920927` passed the exact refreshed subject of
`EI-23211811916557156`, hash
`04039db9c69d0c1d88e7f48d9169faed9e8e491bdb8a43c884903ca5afde70a0`.
This supersedes the pending-review statements above. D-006 remains the
governing decision; no new decision was added to churn the acceptance pins.
The source-conversation audit at sequence 4 remains the recovery reference;
the latest owner instruction is to continue, with no change of scope or route.

`plans:start` approved the plan and materialized its work items. Its final
admission response was nevertheless `floor-gated`, so it is not recorded as a
successful automatic pull. Current plan status is `ready`, version 12 after
the generated Promoted block. The canonical `plan_items:claim` door then
successfully claimed P-001 / `WI-10001315` for this explicitly assigned
SELF/AUTO session. The floor counter only identifies exclusion by the shared
claim predicate; it does not identify which individual predicate fired.
No floor was disabled and no plan dependency was removed.

The matrix near the start of this document remains the F01–F18 population.
Its next-procedure column is the read-only experiment plan. The following
register makes its diagnostic ownership concrete without treating an
inventory as completed diagnosis:

| Diagnostic record | Findings / follow-up | Existing work to adopt or distinguish |
| --- | --- | --- |
| P-002 / WI-10001316 | F01, F12, F13 query and hook contracts | Saved private-PG session proof; EI-22734497115199029 source repair; EI-23202546557685868 independently repeated the same seven tests successfully and changed no source. |
| P-003 / WI-10001317 | F02, F03, F15 wake lifecycle | EI-23212384525517772 real-host counterexample; carry-specific boundaries belong to WI-10001256. |
| P-004 / WI-10001318 | F04, F05, F06 recovery and versions | WI-10001256 remains assigned to su-c77f160e-1bd4-4436-9090-bb0360873809. Adopt its verified evidence; retain general reconnect/host residue here. |
| P-005 / WI-10001319 | F07, F08, F09 retrieval | WI-10001232 remains assigned to su-8ee55568-a37b-4b6b-84f3-e02e11c10d86. Its checkpoint preserves retrieval behind a newer owner-directed GitNexus priority; it is not completed or abandoned. Read the existing deadline audit and coordinate any implementation overlap. |
| P-006 / WI-10001320 | F10, F11, F16 scheduler and demand | Preserve the exact loop/epoch proof above; classify other routine causes individually. |
| P-007 / WI-10001321 | F14, F15 incident identity and writes | WI-10001183, EI-22536211469362868 and EI-23198068959671510 are terminal source-fix candidates, not proof of current runtime resolution. |
| P-008 / WI-10001322 | F17 regression selection and evidence | EI-23210600888560844 owns the demonstrated main-selection gap; WI-2143001 is open and unassigned for coverage attribution. |
| P-009 / WI-10001323 | F18 recovery artifacts | WI-2145397, WI-2146225 and WI-40561 are terminal prior art for probe/destination/writer changes. Recheck current artifacts and isolate any restore. |
| P-010 / WI-10001324 | F09, F16, F17 plus workflow follow-up | Waiting/running semantics, report bookkeeping authorization, no-event hosts, stale facts and oversized discovery metadata remain explicit diagnostic obligations. |

Permitted workspace scope was read from `workspace:work_scope_status`:
enforced `papercusp` only. No other project's ambient alarm expands this
mission. Production reads are observational; writes, aborts, fault injection
and restore experiments use disposable fixtures. Live gate operations are
reserved for the later shipment lane and its ownership check.

The authoritative input report and evidence JSON were re-read. At source
HEAD `bf50b6fef61c9e5f561021cfb7b42fdd74b88700`, their SHA-256 values were
`0ea02471af876683ffc9cbeb066a2409567980f63476ed4c9f10f524b970e903`
and `6dfdd8e2285ab81d45bd95537822768a0bbf4846127a12867cce6885169549c8`.
The inspected PTY host still has the exact hash of the real F03 reproduction.
Current source fingerprints for the next query/hook experiments are:

| Source | SHA-256 |
| --- | --- |
| packages/operator-core/lib/agent-tools/sessions/read.ts | bc10cf90ce350216413f79264e6368d4addb9e025181bb9fa65f7e031ffd79d0 |
| packages/operator-core/lib/pg-bounded-txn.ts | f88f255f5fefc8ed72efdcadc8dd0da1951bd37571f1a2d6804f7b653c502858 |
| packages/operator-core/lib/agent-tools/activity/report.ts | da70dad393979f26da1df5d8a6aeab6b9a4c1caffa85905a47fc8556390650e4 |

A default-endpoint `sessions:read` still reproduced `invalid escape string`
during this continuation; the explicit staging endpoint returned the current
and predecessor transcript. The occurrence coalesced onto
`EI-23214099637699228`. This establishes endpoint behavior, not the precise
currently loaded revision of every server or a shipment verdict.

No production repair, instrumentation, configuration or recovery operation
has been performed by this driver. P-011/P-012 stay closed until the remaining
diagnostic records contain their distinguishing evidence. In particular,
real-PG cancellation, actual projected hook compatibility, backup restore and
causal pressure attribution are still open; inventory completion cannot
substitute for them.

## F12 real PostgreSQL diagnosis — September 14, 06:03 UTC

The historical SQL-fragment fix works through the actual `boundedOrgTxn`
implementation against `createFreshTestDb`'s disposable PostgreSQL. The same
probe revealed a separate current cancellation defect,
`EI-23215250155547960`, which remains assigned to this driver for P-014 after
the diagnosis barrier.

Source fingerprint: `packages/operator-core/lib/pg-bounded-txn.ts`
SHA-256 `f88f255f5fefc8ed72efdcadc8dd0da1951bd37571f1a2d6804f7b653c502858`.
The probe imported that file directly from canonical staging. The capture
tool's automatic old-serving-build warning is not this probe's runtime:
these observations concern current source running in a disposable Node child.

### Distinguishing procedures and observations

| Procedure | Observation | Interpretation |
| --- | --- | --- |
| Explicitly await a standalone `id = 1` fragment as the historical negative control. | PostgreSQL rejects it with 42601. | The control reaches the parser; this is not an unavailable database. |
| Construct nested tagged fragments through the wrapper with a live signal, allow a turn of the event loop, then await only the outer query. | Expected rows `[1,2]`; no independent fragment execution. | The existing no-assimilation repair works on real PostgreSQL. |
| Call `boundedOrgTxn` with a signal already aborted, observing its returned rejection with `assert.rejects`. | Default Node child exits 1 with the abort reason. | Caller error handling does not consume every rejection the wrapper creates. |
| Repeat with a diagnostic-only `unhandledRejection` listener. | Callback never runs; caller receives its expected rejection; the listener separately receives exactly `Error: f12-before`. | Distinguishes an unobserved sibling promise from an uncaught caller assertion or database failure. |
| Reserve the only connection, queue the bounded transaction, abort, then release the connection. | Callback never runs; caller receives the expected reason; listener separately receives `Error: f12-queued`. | The same defect occurs when the signal becomes aborted during acquisition. |
| Insert a row in a bounded transaction and start `pg_sleep(10)`; verify that exact sleep is active from another connection before aborting. | Abort propagates; subsequent query sees zero inserted rows. This sample reached rollback verification 9 ms after abort. | Active-query cancellation and atomic rollback work; this timing is one sample, not a service objective. |
| Compare parameterized `unsafe` fragments embedded in a tagged outer query with raw `postgres.begin` and with the wrapper. | Both reject with 08P01; both accept the corresponding unparameterized raw fragment and return `[2]`. | Refutes wrapper-specific causation for that additional diagnostic error. Use supported fragment composition in the maintained guard. |

The initiating defect is in `cancellableTransaction`: an already-aborted
signal synchronously rejects its new `abort` promise. The surrounding
transaction callback then calls `assertNotAborted` and throws before reaching
the `Promise.race` that would observe that promise. Its `finally` cleans the
listener/set but does not observe the rejected sibling. The outer transaction
rejection can therefore be handled while Node still receives an unhandled
rejection. The alternative hypothesis—caller failed to observe the returned
transaction—is contradicted by the simultaneous handled result and separate
unhandled event in both before-start/acquisition cases.

Smallest proposed repair: establish observation of the abort promise before
any early throw, preserving its eventual race behavior and cancellation
reason. Do not suppress unrelated errors or remove cancellation. Required
maintained regression: a subprocess using default unhandled-rejection policy
must exit successfully after handling a pre-aborted transaction; also cover
queued-acquisition abort, no callback side effects, active-query rollback,
nested tagged fragments and supported raw fragments. The current mock unit
tests did not exercise an already-aborted signal and did not catch this class.

### Reproducible evidence and cleanup

- Initial crash: task `0mu0twuqz1lptl3v3gi`,
  `.papercusp/scratch/bash-10f571f9-157.log`.
- Observer/control run: task `0mu0u0ghlw37h9rmcdn`,
  `.papercusp/scratch/bash-4975dca6-5cf.log`, exit zero.
- Queued-abort/raw-wrapper comparison: task `0mu0u5fwc99ec4p1iia`,
  `.papercusp/scratch/bash-b7f32be9-2f3.log`, exit zero.
- Task `0mu0tz4r91fb8nepntr` was a JavaScript payload syntax error and is
  **not product evidence**. Task `0mu0u40o03d87h1tn1f` reached the unsupported
  parameterized-raw-fragment case; its ambiguity is resolved by the paired
  raw/wrapped control above, recorded on `EI-23215570897517168`.

The observer run removed the initial crash's exact test database,
`backend-f12-diag_ed5e06f505b9`, and its own
`backend-f12-diag_59c9a5819f06`. Later probes printed
`DISPOSABLE_DATABASE_DROPPED` from their `finally` cleanup. No production
database, agent terminal or service was modified. The diagnostic observer is
confined to the child; it is not a product mitigation or repair.

P-001's inventory terminal attempt was refused for missing current
spec-test-adequacy evidence on its three AUTO-BAR clauses. No terminal state
was written. The document validation remains valid, but P-001 is still held
and the full F01–F18 diagnosis/repair mission is unfinished.

## F13 producer compatibility and remaining proof

Task `0mu0u6xo1amdoub15bt`, log
`.papercusp/scratch/bash-320d2960-6d8.log`, executed the actual Python
producer body from `pretooluse-activity-report.sh`. Only its input/token/HTTP
dependencies were stubbed, so no installed hook, credential or live activity
row was touched. Claude and Codex payloads were each exercised with and
without the optional launch role. All four passed the current receiver's
Standard Schema validator. A role-omitted old-schema control accepted the
two older payloads and rejected the two role-bearing payloads. The current
projected schema advertises `role`.

This establishes the actual producer's compatibility difference. It does
not yet establish projected dispatch, persistence, OMP's producer, or a
deployed receiver's behavior. The next maintained experiment must connect
these seams in the existing activity integration fixture. Do not report the
entire F13 combination matrix or downstream liveness impact as verified.

Source fingerprints: producer
`0147fc36af45beddd6348af4969dbc9e5828806baabe67cee09f529367e621d5`;
receiver `da70dad393979f26da1df5d8a6aeab6b9a4c1caffa85905a47fc8556390650e4`.

## Carry evidence adoption: exact peer record and exclusions

The carry owner's response is recorded on `WI-10001256`, comment **204430**
(September 14, 06:04 UTC). It names these reusable artifacts:

- F02: `managed-carry-lifecycle-enforcement-2026-09-13#D-004`,
  `WI-10001278` / commit `bb83dab4bbc856c0baa2ed839e0e7f6572909be2`.
  Output-silence deferral and native Codex compaction are distinct boundary
  mechanisms. Historical per-expiration causes remain heterogeneous.
- F04: `WI-10001290` verifies truthful carry outcomes and native-first-turn
  proof. It **does not implement prompt regeneration**. The actor that removed
  `session-22472/AGENTS.md` remains unknown; this finding cannot close by
  adopting truthful failure reporting alone.
- F06: `WI-10001279` / commit
  `e15837ff5f07d0df41081411163b6f8c6da6e19b` protects against competing live
  hosts stealing a socket. It **does not safely re-exec an attended host**.
  Required behavior must still be checked on each affected running host.

These are peer-supplied evidence references with explicit limits, not this
driver's independent re-execution or a blanket carry certification. Read the
named completions before adopting their proof into final diagnoses. The
peer's implementation ownership is unchanged.

## F18 current artifact preflight and restore next step

The current writer `apps/operator/scripts/systemd/papercusp-db-backup.sh`
uses `/mnt/backup/db-dumps` and authoritative `papercusp-state` plus
`papercusp-transcript` tiers. The state tier contains schema and operational
data; the transcript tier supplies the separately excluded archive tables.
The transcript tier's local-only policy is an explicit existing ruling, not
a defect inferred from missing Kopia enrollment.

At the September 14 approximately 06:06 UTC preflight, `STATUS.json` reported
`ok:true`, no failed entries, and `lastRunIso:2026-09-14T01:29:18-04:00`.
The writer sets this timestamp/last-success epoch after completing its cycle;
it is not the snapshot time of every individual tier. Both tiers were listed
as dumped. The actual archive checks returned:

| Archive | Directory mtime UTC | Apparent bytes | pg_restore list |
| --- | --- | ---: | --- |
| papercusp-state | 2026-09-14T05:04:36.645577Z | 44,497,928,010 | readable; 15,331 TOC entries |
| papercusp-transcript | 2026-09-14T05:16:32.144567Z | 84,763,500,430 | readable; 86 TOC entries |

Directory mtime and successful TOC listing establish neither transactional
capture time nor restored contents. The current independent backup path
therefore contradicts a claim of universally stale backups, while the
original application-ledger observation remains a different instrument.

Available space was measured on all relevant volumes (approximately 125 GB
root, 214 GB `/mnt/data`, 242 GB `/mnt/backup`); these are transient preflight
values, not permission to start an unbounded restore. Read the maintained
runbook `agent-insights/pg-backup-restore-drill-runbook` and
`packages/backup/scripts/restore-pg-dump.sh`. The latter supports the actual
directory archive and checks readability as the restoring OS user. Its
default target is native PostgreSQL; supply an explicitly disposable target
for this plan's experiment. Its prose's older dump path is historical.

No restore has run in this continuation. Next: preserve an immutable tier
snapshot or verify the writer cannot replace it mid-read; create the isolated
target with adequate space and the required extension/role environment; run
the maintained restore path; verify schema plus content-sensitive checks and
startup, accounting for live data that changed since capture; then clean up.
Do not equate `pg_restore -l`, row counts, or the restore script's exit code
with complete restoration.

At the last loop-status read, this session's 60-second loop remained active
with `fireCount:0`, `lastFiredAt:null`, and `stalled:false`. Manual work and a
peer inbox wake do not prove recurring continuation. The scheduler/control
defect and its missing zero-fire detector remain open under F10/F16; the loop
was not rearmed to hide its age.
