# Work-queue bulk cleanup audit (2026-10-01)

> **Corrections (2026-10-01, same session, after re-reading the writers):**
>
> 1. **Plans cleanup is not blocked by its review runs.** `createRun` gates on `getRunningRun`
>    (`pending`/`running` only), and so does migration 915's single-flight index. Only the
>    **inbox-resolve** scheduled action gates on `getActiveRun`, which counts `review`
>    (`inbox-bulk-resolve-action.ts`). Plans cleanup is dead because its recurring sweep never
>    fires: template `plan-cleanup-recurring-sweep-2026-09-01` is a draft. That is tracked as
>    WI-10004728 in plan `plan-cleanup-system-repair-2026-10-01`. So dismissing the two
>    plan-cleanup review runs closes stale review lists but does not restart Plans cleanup.
> 2. **Fail-open does cover every harness.** The production fail-open runs at
>    `scope:'workspace'`. The `heldByScope` rows are held deliberately by the workspace
>    work-scope policy (`enforce`, `allowHarnesses: [papercusp, portal]`).
>    - 9 of the 23 held rows belong to other pots (`sb-devboard-hive`, `hello-world-3-pot`,
>      `recipe-app`), and the policy holds those on purpose.
>    - The real defect is the other 14. They are papercusp learning-loop bugs that were homed
>      to `operator:papercusp-workspace` in a single burst (2026-09-25 20:37:06–07Z), and that
>      harness is outside the allow-list.
>
>    WI-10004723 is re-scoped to that defect. Mechanism 5 below is superseded.

**Question** [owner 2026-10-01, directive #1172]: "Is the work queue bulk cleanup feature working well? Give it a thorough audit"
**Audit work-item:** WI-10004704. This was a read-only audit: nothing in the subject was changed.

## Scope

- **Primary subject:** the work-queue admission gate and staged bulk dedup, from plan
  `work-queue-admission-and-bulk-dedup-2026-08-24` (shipped 2026-08-30). It covers:
  - born-pending admission
  - the 30-minute promoter and the fail-open backstop
  - staged bulk dedup and its census ratchet
  - the hourly delta sweep
  - the daily digest
  - the durable-park audit
  - the daily plan-schedule
- **Secondary subject:** the Inbox and Plans bulk resolvers (`attention_bulk_runs`, kinds
  `inbox-resolve` and `plan-cleanup`). On 2026-09-30, the owner asked to "re-enable all ... bulk plan
  review and bulk work queue review loops just for our papercusp pot" (owner-typed,
  21:16 EDT). Last night's session re-armed these loops under WI-10004483.

## Verdict: no

The admission gate is running. The cleanup is not:

- The only part doing real work is the promoter. Since last night's re-arm it promotes almost
  nothing, and roughly 98% of new filings get in through fail-open without review.
- The backlog dedup has not run since 2026-09-05. In its whole life it has merged 0 items.
- Its census is 26 days stale, and the daily digest has been blocked for 18 days in a row.
- The Inbox resolver has silently created no run in 37 days.

## Component scorecard

| Component | What it should do | What was measured | Status |
|---|---|---|---|
| Promoter (30 min) | Judge duplicates; promote clean rows without a model call | 2,215 ticks total: 1,878 complete, 332 failed, 5 stuck `running`. From Sep 16 to Oct 1 02:00Z there were zero promoter ticks (paused); only fail-open ran. Since the re-arm: 17 ticks, 3 promoted, 1 merged. Each tick takes 9–11 minutes and re-judges the same pairs the merge guard already refused | Degraded |
| Fail-open | Release pending items after more than 2 missed ticks, so queue work never starves | Works for the `papercusp` harness (204 released today). It never releases other harnesses: 23 items are held (`heldByScope`), the oldest for 13 days | Partial |
| Re-review of fail-open rows | Review within the 1 h SLO | 2,155 pending, 2,116 overdue, oldest about 26 days. 1,023 rows were closed without ever being dedup-checked. 302 re-reviewed in total | Failing |
| Bulk dedup stages | Converging passes; census goes down after every stage | 12 stages ever. The last one (2026-09-05) failed when the DB was in recovery mode and was never retried. Only 2 stages completed with real batches: 3,270 pairs judged, **0 merges**. One stage returned the same verdict for all pairs (1500/1500 `r-related`) | Not running |
| Census | Re-run after every stage; produce a trend line | Last run 2026-09-05: 57,777 unadjudicated pairs at ≥0.85 similarity, across 4,424 items. This cannot be compared with the Aug 30 reading of 18,789: embedding coverage was 66% then and 99.8% now | Stale (26 days) |
| Daily digest | Daily root-cause digest | 18 consecutive days `blocked: census-coverage-mismatch` | Dead |
| Delta sweep (hourly) | Root-cause delta sweep | 311 complete, 116 failed. Last run 09:12Z today | Running |
| Durable-park audit (daily) | Reconcile claims, leases and parks (D-023) | 41 complete. Last run 07:50Z today. One row is stuck `running` | Running |
| Daily plan-schedule | Recurring lane P-023 | Every run clones the **shipped** plan. All 19 items start `done`, and the run is superseded within about 7 s. 21 runs so far, no work done | No-op |
| Inbox resolver (`inbox-resolve`) | 15-minute backstop plus a weekly sweep | 9 runs ever, all on 2026-08-24. Every run since is blocked by run `bulk-ef1590f9`, which has sat in `review` since 08-24 | Dead (silent) |
| Plans cleanup (`plan-cleanup`) | Weekly sweep | Last run 2026-09-06. ~~Blocked by 2 runs sitting in `review`~~ **Corrected 2026-10-01 (see Corrections):** the review runs do not block it; the recurring sweep never fires (WI-10004728) | Dead (silent) |

## Mechanisms: the loops that keep it broken

1. **A run waiting for review blocks every scheduled run, and does so silently (WI-10004720).**
   `getActiveRun()` treats `review` as an active phase. The scheduled action then returns
   without logging anything. The result is about 3,500 silent no-op fires since Aug 24.
2. **Nothing drives the bulk dedup on a schedule (WI-10004722).** Census and bulk stages run only
   on demand (D-014), so the census goes stale. The digest's census-coverage gate can then never
   be met, so the digest stays blocked. Nobody re-runs a stage, so the loop never closes.
3. **The "scheduled bulk step" is an illusion (WI-10004721).** The daily plan-schedule
   instantiates the shipped plan as its own template. Every item starts `done`, so it can never
   produce work. D-023's real recurring cleanup is the separate durable-park audit routine.
4. **The promoter wastes its runs on items it can never move (WI-10004724).** It re-judges pairs
   that a merge guard permanently refuses: remote-owned, review-gated, snapshot-drift. Those
   refusals are not remembered, so each tick re-spends about 10 minutes of model time. Fail-open
   (on :15/:45) meanwhile admits the queue unreviewed.
5. **Fail-open does not cover every harness (WI-10004723).** Only `papercusp` has a promoter.
   Items born pending in other harnesses stay invisible to claimers indefinitely.
6. **Pausing for spend turned the gate into a pass-through (WI-10004725).** The Sep 15 pause
   stopped the whole promoter routine, including its deterministic no-model path. For 15 days
   every filing got in unreviewed. The re-review debt has not been paid down since.
7. **The ledger overstates in-flight work (WI-10004726).** Promoter and park-audit rows stuck in
   `running` are never reaped.

## Already-open related items (not re-filed)

- EI-24748271744431899 and EI-24748402416720917: the promoter is failing today
  (`CONNECTION_CLOSED` / codex upstream terminated).
- EI-24202859815816937: fleet child tasks are born pending and sit idle for 40–50 minutes.
- EI-22190822851012325: account starvation silently degrades the promoter.
- EI-22639929041140173 and EI-22404907641589474: friction from the born-pending floor.

## Disclosed at ship and not re-verified here

The shipped plan's own Now block lists three caveats:

- The ratchet's `ok:true` is a hardcoded literal.
- Steady-state fail-open was 23.9%.
- The model-policy importer guard cannot see the admission actions.

## Ranked recommendations

1. **Unblock the Inbox and Plans resolvers (WI-10004720).** Stop treating `review` as blocking
   scheduled runs, or make the block loud. The 3 stale review runs also need an owner disposition.
2. **Give bulk dedup a recurring driver (WI-10004722).** It needs a scheduled census plus a
   bounded stage, and the digest must recover once the census is fresh. Retire the no-op
   plan-schedule (WI-10004721).
3. **Make the promoter effective (WI-10004724, WI-10004725).** Remember permanent guard refusals,
   and size the tick so the promoter wins against fail-open. Separate the no-model promote path
   from the LLM spend pause.
4. **Extend fail-open to every harness that creates born-pending items (WI-10004723).**
5. **Decide the backfill policy for the review debt (WI-10004725).** This includes whether the
   1,023 already-closed rows need review at all.
6. **Add a reaper for stuck ledger rows (WI-10004726).**

## Owner-only decisions

- What to do with the 3 stale review runs:
  - inbox-resolve `bulk-ef1590f9`: 143 recommendations from Aug 24
  - plan-cleanup `bulk-7d35ee41`: 13 recommendations
  - plan-cleanup `bulk-bc6d1eeb`: 26 recommendations

  Accepting or dismissing them unblocks the schedule today.
- How much LLM spend to put toward the re-review backfill and toward resuming bulk stages. Two
  sources apply:
  - the routine rows' pause record, tagged `[owner 2026-09-15]`. It was recorded by an
    agent and not re-verified in this audit.
  - the owner's re-enable request on 2026-09-30, which is verified owner-typed.

## Coverage record

**In scope:** 11 components (see the scorecard).

**Checked:** all 11, using these sources:

- `admission_runs`: by kind, status, day, mode and detail
- `attention_bulk_runs` and items
- `routines`
- the plan and its 21 template runs
- the live `work_items` admission distribution
- the writers for the census, held, fail-open and `getActiveRun` values

**Not checked:**

- UI surfaces: the admin stats page and InboxBulkReport. They were not exercised in a headless
  run.
- The ratchet-hardcode claim was not re-read in code.
- Unit tests were not run.
- The 1500/1500 uniform verdict was not re-judged.
- The correctness of the inbox-resolve recommendations was not sampled.
- The issue dedup scan was bounded to 25–40 rows, with `work_items:create`'s dedup guard as the
  second check.

**Measurement caveats:**

- `held` is a per-tick count of unchanged items, not a count of unique items.
- Census totals are not comparable across runs, because embedding coverage changed between them.

**Residue:** WI-10004720, WI-10004721, WI-10004722, WI-10004723, WI-10004724, WI-10004725,
WI-10004726. All are assigned to su-b5bfd66d, pending a remediation route.
