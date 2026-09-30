# Ship-main greening — system audit (2026-09-22)
URL: /internal/docs/agent-insights/ship-main-greening-system-audit-2026-09-22

Owner-facing audit of the ship-main greening program: failure taxonomy, reconciled plan scorecard, sufficiency verdict, and prioritized roadmap.

# Ship-main greening — system audit (2026-09-22)

**Program:** `ship-main-greening-program-2026-09-15` · **Item:** P-040 (WI-10002308) · **Original author:** su-4aba3409 (took the program over 18:20Z from su-14342fa6) · **Continuation:** su-3340afad, owner-directed recovery of session `66d8cb1b-0dc3-4068-bec8-d2506bbf5554`.

**FINAL SYSTEM AUDIT.** Sections 1–7 preserve the predecessor's historical 19:31Z–19:45Z observations unless explicitly corrected below; they are not claims about current live state. Source audits are the completions and comments on P-032…P-039 (WI-10002300…WI-10002307). The successor's separately measured continuation is in section 8. P-031 is terminal and its exact tested SHA is live on `:3070`; whole-program acceptance remains a separate independent judgment after this publication.

***

## 0. Verification provenance at publication

This document was reconciled against its writers immediately before publication. Readers should know exactly which claims were re-measured and which were inherited.

**Re-verified at the writer for this publication:**

* Green/deploy outcome — `deploy.3070.sha` = `80521d598f9dc9dd983519be19c95a0a0dd832ba`, identical to the certified green pin; `gate.greenCheckpoint.verdict` green; `WI-2144525` measured `done`. (§1, §7 row 0, §8)
* §4 scorecard — every plan item it names re-read via `plans:items`: P-031 `done`; P-012/P-015/P-021/P-022 `dropped`; P-040 `todo`. Totals reconcile to the plan's own `counts.items` of 30.
* §7 roadmap — all 14 cited `WI-`/`EI-` refs re-read individually: 12 open and unassigned, 2 terminal. The "eight of nine ranked items" claim in §1 was confirmed, not carried.
* All 47 governing plan decisions were scanned (with a positive control on the extractor) for any ruling governing this publication.

**Corrected during this pass:** §1 and §7 row 0 still described P-031's deployment as in progress, having been written before the green landed. Both now state the verified outcome.

**Inherited, NOT independently re-derived:** the analysis in §2 (chronology), §3 (failure taxonomy), §5 (design assessment) and §6 (target architecture) is the prior investigators' work, carried forward on their evidence. It is not re-measured here, and should be read as their finding rather than as re-verified fact.

***

## 1. Verdict

**The freeze-and-converge redesign addresses repeated candidate replacement, but it does not by itself guarantee sustained green `main`.** P-032 found that the queue reducers preserve the frozen candidate and path-exact admission isolates repairs. That finding is narrower than a universal claim that candidate identity can never change: P-032 also filed an unguarded CREATE-write race, and the successor confirmed that write seam remains in source. The observed residual classes are:

1. **Instruments that report "fine" when they did not measure.** This is the dominant residual class, found independently by all five audits and again today (§3, T2).
2. **Admissions that bring a file in without the files that depend on it.** This caused today's red (§3, T4).
3. **Repair-driver continuity and scheduler recovery are separate failure modes.** A lost fixer leaves engineering work without a driver; a dead gate process can separately retain the scheduler's deduplication reservation. The latter's fallback is a wall-clock cap of 185 minutes from the fire's creation, not a timer measured from the fixer's death (§3, T3).
4. **Flaky tests** that can turn a correct repair red (§3, T5).

**Current-plan sufficiency:** necessary but **not sufficient**. P-037's verdict holds on today's evidence.

Finishing P-031 **did** restore green `main` once. Re-verified at the writers for this publication rather than inherited from the draft: `deploy.3070.sha` = `80521d598f9dc9dd983519be19c95a0a0dd832ba`, identical to the certified green pin; `gate.greenCheckpoint.verdict` green; `WI-2144525` now `done`. `git.mainBehindStaging` reads `true`, which is ordinary post-promotion drift as the shared tree keeps moving, not a contradiction of the green pin.

That outcome **confirms** the verdict rather than overturning it: restoring green once was always the reachable part. Keeping it green needs the roadmap in §7, and eight of the nine ranked items in it remain open and unassigned — re-measured item-by-item against live work-item state at publication (14 cited refs read; 12 open and unassigned, 2 terminal), not carried over from the previous draft.

***

## 2. Chronology

| when (UTC)             | what happened                                                                                                                                                                                                                                                                                                                                        | source                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 09-15                  | Program created: scope and authority (D-001), route (D-002); P-016 found to be the most expensive plan, not the closest to shipping (D-005)                                                                                                                                                                                                          | plan decisions                                                       |
| 09-16 → 09-17          | **13 decisions (D-006…D-018) spent on rubric-amendment mechanics** (R-7 driftMarkers, amendment budgets, a dead rubric author orphaning an acceptance chain)                                                                                                                                                                                         | plan decisions                                                       |
| 09-18                  | `main` promoted four times (02:40, 03:26, 14:45, 21:48)                                                                                                                                                                                                                                                                                              | `git reflog main`                                                    |
| 09-19                  | Owner-approved single-tracker consolidation (D-019). `test-suite-recovery-2026-08-27` and `ship-main-greening-plans-2026-08-29` superseded into this plan. `main` promoted at 02:08 and 18:48                                                                                                                                                        | D-019, reflog                                                        |
| 09-20 → 09-21          | Acceptance-carry state machine (D-021…D-023)                                                                                                                                                                                                                                                                                                         | plan decisions                                                       |
| 09-22 01:35            | `main` → `e78b2e905f`, the gate's own canonical green run (D-027)                                                                                                                                                                                                                                                                                    | reflog                                                               |
| 09-22 07:55            | `main` → `be8396c6dd`, an admission onto frozen lineage `247e3140e590`. **This was the last promotion at the predecessor's 19:31Z–19:45Z observation**                                                                                                                                                                                               | predecessor's reflog and `:3070 /api/health` reading                 |
| 09-22 (day)            | **22 decisions (D-024…D-045) in one day**: routine starvation traced to shared concurrency-4 lane exhaustion (D-030); admission semantics (D-036…D-039); four ship items dropped because their subject plans were superseded (D-040, D-041); acceptance-bar pin explained (D-043); per-item code-truth audit found never run, then completed (D-044) | plan decisions                                                       |
| 09-22 14:38            | Whole-file admission of `turn-start-orientation.ts` plus its coverage test, without the files that depend on it → repairHead `65b5ce0c` red on `lint:tsc`, `lane-pure`, `lane-stateful`, `web`                                                                                                                                                       | repairTickLegs; D-045                                                |
| 09-22 18:12            | Program leader su-14342fa6 permanently broken by a mid-session model switch (WI-10002455); program taken over at 18:20                                                                                                                                                                                                                               | WI-10002455                                                          |
| 09-22 \~18:35          | 13-path same-commit set admitted from `7f0e0753` → repairHead `f3123367` (ready-to-verify)                                                                                                                                                                                                                                                           | D-045                                                                |
| 09-22 19:23            | Scheduled gate run starts and sets up `f3123367` (verified from the run's own log)                                                                                                                                                                                                                                                                   | checkpoint log                                                       |
| 09-22 23:25 → 23:59    | Ordinary gate run `ea701146-3fb3-4690-9c72-8c907e0a0403` judges repair head `80521d59`: 5,235 CI ledger rows, zero failures; `AFFECTED_TESTS_RESULT status=passed`, 11,204 executed / 10 skipped; final trailer records `green=true promoted=true reason=advanced advancedTo=80521d598f9d`                                                           | test ledger; checkpoint log                                          |
| 09-23 00:00 EDT onward | Release trigger launches the specialized exact-pin live certification for `80521d59`; at the successor's 01:50Z read it had rebuilt clean source, closed the certified-source window on the same head, passed content-matrix as documented `PASS-971`, and was running the from-repo leg                                                             | systemd unit + `/tmp/papercup-live-release-certification.log`; D-047 |

**Historical measurement, not current:** the predecessor recorded `main` **229 commits behind** `staging` (and 0 ahead) during 19:31Z–19:45Z. P-038 recorded 22 at 03:4xZ. The successor has not re-measured these counts and does not use them as evidence of current delay.

***

## 3. Failure taxonomy

| class                                                   | what it looks like                                                                                                             | status                                                                                                                                                                                                                            | evidence                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T1 Candidate churn**                                  | Every red re-cuts from a newer tip and brings in new breakage faster than fixes land                                           | **Reducer/admission mechanism sound per P-032; CREATE-write race remains open.** Do not generalize reducer immutability into a concurrency-wide guarantee.                                                                        | P-032; EI-23934249424304800; successor source check at 21:55Z                                                                                                                                                                                                                                                                                                                                                           |
| **T2 Unmeasured renders as benign** (invariant **I-1**) | A status, alarm or check shows "fine / idle / passed" when it did not measure                                                  | **Open, dominant.** Seen in all five audits and again today                                                                                                                                                                       | P-032 (3 fail-open sites), P-033 WI-10002319, P-036 WI-10002316 + WI-10002315, **new today: WI-10002456** (admission precheck reports `passed` with `ran:false`); **EI-23992017168581423** (the gate ownership cell reported *unowned* while I actively held the gate-lane item, and its safe-action text would have recruited a duplicate fixer; fixed at 19:41Z by linking WI-2144525 to `gate-red-streak:papercusp`) |
| **T3 Continuity and scheduler liveness**                | A missing repair driver leaves fixes unworked; a dead gate process can independently pin a scheduler deduplication reservation | **Distinct mechanisms.** The scheduler fallback uses a 185-minute cap from fire creation. The predecessor reported a failed fixer dispatch; the successor now holds the repair work and has measured an active ordinary gate run. | P-034; WI-10002314; `dbos/dbos-executor-reaper.ts`; section 8                                                                                                                                                                                                                                                                                                                                                           |
| **T4 Admission missing dependent files**                | A hot file is admitted without the tests and consumers that depend on its shape                                                | **Open, manual rule only** (D-045). The import-closure check does not see type consumers or co-changed tests                                                                                                                      | D-045; 65b5ce0c legs                                                                                                                                                                                                                                                                                                                                                                                                    |
| **T5 Flaky verdicts**                                   | A correct repair may turn red on a timing-sensitive test                                                                       | **Open; rates unverified**                                                                                                                                                                                                        | WI-10002457 remains open for `testing-run-store.test.ts`. **Correction at 21:34Z:** EI-21248107939974231 is a checkpoint-harvest observation about WI-40946 descriptor inheritance, not a `pc-heavy.test.ts` flake. The inherited `pc-heavy` citation and both percentage claims are withdrawn pending test-ledger evidence.                                                                                            |
| **T6 Process churn around acceptance**                  | Decisions, reviewers and amendment budgets spent on acceptance mechanics, including on items that could never ship             | **Partly contained** by D-040/D-041 drops                                                                                                                                                                                         | D-006…D-018; D-040                                                                                                                                                                                                                                                                                                                                                                                                      |
| **T7 Shared-lane starvation**                           | Routines starve on a shared concurrency-4 lane                                                                                 | Ratified cause (D-030)                                                                                                                                                                                                            | D-030                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **T8 Stale carried claims**                             | A number or cause carried across sessions is repeated as if observed                                                           | **Recurring.** 4 retractions this program                                                                                                                                                                                         | 426-commit claim (P-037 → retracted by P-038); salvage `2T<deadline` (P-035 → falsified by P-039; EI-21434759422783893 fixed 08-25); D-027 → D-029; D-038 → D-039                                                                                                                                                                                                                                                       |

***

## 4. Reconciled plan scorecard

**Immediately before this publication: 30 items · 25 done · 4 dropped · P-040 the sole live item.** P-031 is terminal; publishing this document is P-040's deliverable.

* **Dropped (4):** P-012, P-015 (D-040), P-021, P-022 (D-041). All ship-another-plan items whose subject plans were superseded into this one, so they could never legitimately complete.
* **Done:** P-031 reached exact ordinary-scheduler green, main promotion, exact-pin live certification, automatic deployment, and tested/deployed/live parity at `80521d598f`.
* **Publishing now:** P-040, this document.
* **Code-truth completion audit** for all 28 terminal items: done (D-044).

***

## 5. Design assessment (P-038, reconciled)

| subsystem                      | verdict                                                                           | reconciliation                                                                                                                                                                                                                                                                                                                         |
| ------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1 frozen-candidate core       | **Keep**                                                                          | Confirmed. The lineage held through the bad admission and repair, and the gate advanced `80521d59`. The live disposition is now `none` because the frozen lineage converged; it was not retired.                                                                                                                                       |
| S2 dependency-generation store | **Keep; simplify retention**                                                      | WI-10002317 and WI-10002319 still open                                                                                                                                                                                                                                                                                                 |
| S3 scheduler                   | **Simplify**: keep the safety bound, improve dead-process recovery and visibility | Successor re-read confirms `DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS = 185 min`, deliberately above `SELF_WATCHDOG_MS = 180 min`. The writer applies the cap from creation and checks DBOS step records, not stdout or time since death.                                                                                                |
| S4 suite / verdict             | **Simplify** (**the REDESIGN part is withdrawn**)                                 | P-038's redesign target, the salvage budget gate, was already fixed (EI-21434759422783893 done 08-25; falsified by P-039)                                                                                                                                                                                                              |
| S5 observability               | **Redesign, bounded**                                                             | P-036/P-038's historical census found 13 alarm-deduplication families and distinguished renamed `stallAlerted` from honestly named `watchdogAlerted`. The successor has not repeated that complete census. It directly re-verified the actionable writer: `stalled: gateHealth.stallAlerted === true` in `git-pipeline-stats.ts:1463`. |

**Cross-cutting invariant I-1:** an unmeasured or unknown state must never look the same as a benign measured one.

***

## 6. Target architecture

1. **Keep the frozen, immutable candidate with hunk-exact admission** as the core.
2. **Make I-1 a checked contract, not a convention.** Every gate status surface is three-valued (measured-good / measured-bad / not measured), the way `state:read` cells already carry `unknown` in band. Add a guard test that fails when a dedup or alarm bit is projected under a health-state name, and when a check result says `passed` without `ran:true`.
3. **Derive the admission set, don't hand-list it.** Admission computes the dependent files (importers, type consumers, and tests changed in the same source commit) and refuses an incomplete set. D-045 becomes a mechanism.
4. **Make driver loss visible and recover scheduler reservations safely.** A failed fixer dispatch must get a driver. Separately, preserve the gate's healthy-run timing chain while adding proof-of-death recovery and a shorter visibility bound for scheduler deduplication reservations (R3).
5. **The retention reclaimer runs independently of checkouts** (R5/R6).
6. **Flakes are quarantined with an owner** rather than re-judged by luck.

***

## 7. Prioritized roadmap (statuses re-read this turn)

| # | item                                                 | what                                                                                                                                                   | live status                                                                                                                                                                                                                             |
| - | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 | P-031 / WI-2144525                                   | Finish the frozen lineage, obtain a green full-suite verdict and prove promotion/deployment                                                            | **DONE** — `WI-2144525` measured `done`; green promotion proven **and deployed**. Verified at the writers, not from §8 prose: `deploy.3070.sha` = `80521d598f9dc9dd983519be19c95a0a0dd832ba` = certified green pin, behind-pin `0` (§8) |
| 1 | WI-10002316 + WI-10002315 (P-039 R2)                 | Stop showing an alarm dedup bit as health; show release-trigger stall in `release:deploy status`                                                       | open, unassigned                                                                                                                                                                                                                        |
| 2 | EI-22447780816671038 + WI-10002456                   | Admission derives its dependent files (T4) and never reports `passed` without running (T2)                                                             | Both open, unassigned at the successor's 21:33Z read                                                                                                                                                                                    |
| 3 | WI-10002314 (R3)                                     | Separate the 185 min reap bound from a short visibility bound                                                                                          | open, unassigned                                                                                                                                                                                                                        |
| 4 | WI-10002457                                          | Timing-sensitive `testing-run-store.test.ts` failure                                                                                                   | open, unassigned at 21:33Z; the inherited `pc-heavy` reference was incorrect and is not evidence                                                                                                                                        |
| 5 | EI-23934249424304800 (R4)                            | Compare-and-set protection on the frozen-candidate CREATE write (one argument)                                                                         | open, unassigned                                                                                                                                                                                                                        |
| 6 | WI-10002319 (R5), WI-10002317 (R6)                   | Retention: quarantines that are never collected; dead-pid lease with no age backstop                                                                   | open, unassigned                                                                                                                                                                                                                        |
| 7 | EI-23934090024105590 (R7), EI-23933505851740962 (R8) | Stale salvage comment; `tools:invoke` arg-encoding no-op                                                                                               | open, unassigned                                                                                                                                                                                                                        |
| 8 | EI-23703586803892464 (R9)                            | Identity stale-artifact lockout. P-039 said fund only after its prediction had a chance to fail; it has recurred since (see CLAUDE.md, repeatCount 7+) | open, unassigned                                                                                                                                                                                                                        |
| — | EI-23917645695738835 (P-039 R1)                      | Freeze-and-converge strands a repair queue forever                                                                                                     | **DONE** (closed 15:49Z today, after P-039 ranked it)                                                                                                                                                                                   |
| — | D-034 / D-035 titles                                 | Governing rulings filed under bisect-probe titles, so nobody can find them                                                                             | process fix; not yet done                                                                                                                                                                                                               |

***

## 8. Live-greening status

### Successor recovery and admission (21:27Z–21:34Z)

The owner explicitly requested autonomous continuation of session `66d8cb1b-0dc3-4068-bec8-d2506bbf5554` through the whole plan's shipment. The first checked claim operation returned `holder-session-ended` and transferred WI-2144525/P-031 and WI-10002308/P-040 to su-3340afad. Later managed-respawn recovery temporarily placed the items elsewhere; P-031 was reclaimed only after its holder was measured ended/not wakeable, and the temporary P-040 holder explicitly released it back. Owner-directed AUTO remains registered.

The predecessor's R6 operation `repair-precheck-e8ff0cf80505-cd05f10ddd56-mud6dubl-gmwhyt` was read directly as `status:passed`, `verdict.ran:true`. Its results recorded all three test files passing:

| path                                                                              | exit | recorded duration |
| --------------------------------------------------------------------------------- | ---- | ----------------- |
| `packages/operator-core/lib/agent-tools/plans/acceptance-drain-lifecycle.test.ts` | 0    | 39,561 ms         |
| `apps/operator/scripts/hooks/cc/__tests__/bash-resource-gate.test.ts`             | 0    | 169,082 ms        |
| `packages/operator-core/lib/agent-tools/capability/bash-jobs.test.ts`             | 0    | 64,828 ms         |

The four admitted paths are those three test files plus `apps/operator/scripts/hooks/cc/pretooluse-bash-resource-gate.sh`. All were pinned to source commit `05f4f3213bfd2019e7eb9cc279c5eedc8aaae2f7`.

The successor admission is `a64a2f7bc1d7854167ad69935f1031fea3684765`. Its Git tree is `cc53de0358145825373749f306b896819c872310`, identical to predecessor-tested commit `cd05f10ddd56866eabfbf3cba273aa9eeefab260`. The different actor/reason changes the commit identity, not the tested source tree. `release:repair-queue` confirmed `admitted:true`, `persisted:true`, `auditRecorded:true`, with phase `ready-to-verify`; frozen candidate `e8ff0cf8050563d82fd832ee9b345de6bad73bb3` was unchanged.

The successor's own R6 operation `repair-precheck-e8ff0cf80505-a64a2f7bc1d7-mud6t3y6-dzf4qr` reported `passed` but **`ran:false`**, reason `checkpoint-tree-busy`. That result is **not additional testing**. It reproduces the already-filed observability defect WI-10002456. The evidence above is the predecessor's executed pre-check plus exact tree identity, not the skipped pre-check label.

At 21:32Z, the pipeline reader reported a live ordinary gate run judging **old head `f3123367d5581ef089bfa823eba4b71a9ea7bd4b`**, while the queue held **new head `a64a2f7bc1d7854167ad69935f1031fea3684765`** ready for its next verification. These are distinct generations. No green verdict or shipment of the new head is claimed.

### Completion state at publication

* Exact-pin live certification and deployed `:3070` provenance for green `80521d598f9dc9dd983519be19c95a0a0dd832ba`: **complete**.
* Final refreshed audit publication and source reconciliation: **this publication**.
* Program acceptance remains after implementation: preserve R-4 verbatim and disclose the predecessor's **two** manual checkpoint-run deviations per D-042; keep the D-043 BAR projection repair sequence; obtain vetted-rubric, independent-grade, and author-verdict evidence before shipment.

The successful `80521d59` run carried non-empty Vitest evidence but **did not execute Cargo**: its log has no `>>> Running cargo tests`, `report-cargo-tests`, or Cargo `test result:` marker. D-032's same-run Vitest+Cargo ruling names P-004 carried by P-021; D-041 subsequently dropped P-021 because its subject plan was superseded. This audit records the missing Cargo measurement rather than importing unrelated rows. Whether that historical clause still affects whole-program acceptance is for the independent grader; it is not a P-031 acceptance condition.

The successor has issued no manual checkpoint-run, queue retirement, tip convergence, or force-deploy.

### First bounded-wait progress check (21:51Z)

The first exact-candidate wait expired without a verdict. This was not counted as a failed gate. The current run was still the older `f3123367` generation; admitted `a64a2f7` remained `ready-to-verify`.

The durable test ledger had advanced from row 19042162 (pass, 21:36:53Z) to row 19042187 (`test-file-exit-codes.test.ts`, skip, 21:46:14Z). A read-only process-tree sample at 21:51:50Z found the same gate parent, PID 2274309, with active test workers; surviving processes accumulated 677 CPU ticks over two seconds. This is evidence of execution activity, not a claim that the suite will pass or a resource-bottleneck diagnosis. No healthy run was canceled.

Additional source reconciliation during this wait:

* `apps/operator/lib/release/green-checkpoint.ts:11390` creates a queue and calls `deps.writeFrozenRepairQueue(repairQueue)` without an expected-absence argument.
* `packages/operator-core/lib/harness/routines/release-actions.ts:5418` implements a tri-state compare-and-set predicate: omitted expectation has no predicate; `null` means the row must have no queue. This corroborates the already-filed CREATE-write finding; reachability is still not measured here.
* `packages/operator-core/lib/dbos/dbos-executor-reaper.ts:76` and its surrounding writer commentary establish the 185-minute creation-time cap and its ordering above the 180-minute watchdog.
* `packages/operator-core/lib/git-pipeline-stats.ts:1463` still derives `stalled` from the alarm-deduplication flag. The historical 13-family census is attributed to its source audit rather than presented as a new census.

### Second bounded-wait result and successor head (22:08Z–22:12Z)

The older `f3123367` run ended `repair-in-progress`, without a promoted green verdict. The terminal ledger's failed `acceptance-drain-lifecycle.test.ts` row 19043325 (21:44:22Z) compares expected `blocked` with actual `due`; that is the old-head fixture failure already repaired in admitted `a64a2f7`, not evidence that the admitted fix failed.

While that old run was executing, su-e8f7f7d3 admitted one additional path onto `a64a2f7`: `packages/operator-core/lib/agent-obligation-owner-directives.test.ts`, producing `80521d598f9dc9dd983519be19c95a0a0dd832ba`. The successor independently checked ancestry and the full diff: a single five-line hunk injects `waitingOn: async () => []` into the test's dependency fixture. Earlier repair paths are unchanged. Admission source is `20597e2ef66a4f4769670e3b150d7bacd6d3a249`; the peer's diagnosis and evidence are on WI-10002394, comment 1140719. Its pre-check did not run because the checkpoint tree was occupied, so the upcoming full verdict remains necessary.

The queue's newer head changes the wait target: an exact-SHA wait on `a64a2f7` must not silently continue waiting for a commit the scheduler will no longer judge. The next wait follows `80521d59`, with explicit ancestry verification preserving the earlier repair evidence.

A peer message suggested a new run started at 22:06:36Z. The successor did **not** treat that as measured execution of `80521d59`: at 22:10:59Z the integration-root run-lock was absent and the checkpoint checkout still held `f3123367`. The routine's next scheduled fire was 22:22:37Z. This provenance correction was returned to the peer.

One additional known detector defect appeared in the status result: the terminal marker contained `3645166SERVICE_RESULT`, `3645166EXIT_CODE`, and `3645166EXIT_STATUS`. These malformed values cannot establish an OOM or termination signal. The writer at `packages/operator-core/lib/release-checkpoint-launch.ts:1865` contains doubled dollar-sign variable references; the existing finding is EI-23929296328688459 and received this occurrence's evidence. No root-cause claim about the run's termination rests on that marker.

### Green verdict and promotion (23:25Z–23:59Z)

Ordinary run `ea701146-3fb3-4690-9c72-8c907e0a0403` judged `80521d598f9dc9dd983519be19c95a0a0dd832ba`. The exact run-group rollup contains **5,235 CI files, 0 failures, 0 failed files**, spanning 23:25:12Z–23:59:28Z. The run's own log records `AFFECTED_TESTS_RESULT status=passed tasks=39 failed=0 quarantinedFailed=0 timedOutTasks=0 undeterminedTasks=0 testsExecuted=11204 testsSkipped=10`.

The terminal log trailers are explicit:

* `GATE_PROMOTION candidate=80521d598f9d green=true promoted=false reason=decision-pending`
* `GATE_PROMOTION candidate=80521d598f9d green=true promoted=true reason=advanced advancedTo=80521d598f9d`

That is promotion proof, not merely a green event. The same log does not contain a Cargo execution marker, as disclosed above.

### Exact-pin certification and retraction of a false blocker (01:50Z)

The seventh P-031 holder filed WI-10002525 after sampling generic hourly gate rows whose `certification_target_sha` was empty, concluding that no exact pin could ever be certified. That conclusion was false and is retracted in WI-10002525 comments 1141094/1141095 and plan decision D-047; the item is dropped.

Measured instead: `papercup-live-release-certification` was active/running (PID 3652899, started 20:00:11 EDT). Its specialized log showed clean source `HEAD=80521d598f`, `dirty-files=0`; the certified-source window closed after the build at the same head and zero dirty files; content-matrix reached the documented `PASS-971` classification; from-repo was actively running. Historical specialized bank rows also carry non-empty target SHAs. Empty target SHA in an ordinary freshness record is therefore not evidence that the specialized launch lost its target.

No source change, manual checkpoint, queue retirement, convergence command, or force deploy was performed. The exact-pin certification and automatic deploy both completed successfully.

### Deployment and live verification (02:17Z–02:19Z)

The automatic deploy consumed the certified green pin without a manual trigger. Its mandatory pre-deploy snapshot `77429` completed `ok` (`dbDumpOk:true`, Kopia snapshot `92a9c81468f517669e82d1127319ccaf`), the release checkout swapped to `80521d59`, the host bundle and preflight passed, migrations reported `applied 0 of 991 known migration(s)`, and the unit restarted at 02:17:22Z. The detached deploy terminal recorded `exitCode:0` at 02:19:19Z.

Final authoritative reads:

* `release:deploy`: `deployedSha = greenPinSha = 80521d598f9dc9dd983519be19c95a0a0dd832ba`, behind green pin `0`; exact live certification `certified:true`.
* `release:trace`: target committed locally, on staging, in main, and deployed; `testedSha = deployedSha = targetSha`, state `matched`.
* `GET :3070/api/health`: `ok:true`, `sha:"80521d598f"`.
* P-031 spec adequacy: mutation/repaired pair test-run rows `19042037`/`19042035`, terminal scorecard `EI-24018352217903321`, independent grading-integrity audit `EI-24018489437706708`, both passing.

The current green-checkpoint may judge later staging commits red; that does not alter the immutable fact proved here: exact green pin `80521d59` was tested, certified, promoted, and deployed before the later candidate.
