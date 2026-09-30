# Change queue admission and bulk cleanup audit — September 5, 2026

Prepared for owner under **WI-2146744**. This is an audit and recommendation report; it does not authorize or record dispositions of the existing backlog.

**Finding: the backlog combines delivery demand, review work, repeated reports, and stale obligations. Its size proves neither that the system is performing well nor that most changes are worthless. More implementation capacity alone will not resolve it.** Feature/change drain fleets existed: the September 1 final ledger records resuming `feature-change-drain-2026-09-01-v2`, and the September 5 reconciliation concerns the later `nonp2p-feature-change-drain-2026-09-04-v3`. Thus “we never had a fleet draining these” is not the full explanation. This investigation did not reconstruct a complete historical arrivals-versus-completions series and cannot assign a percentage of the backlog to insufficient capacity.

I interpret “change/build” as change-type code work. The canonical work-item kind is `change`; `build` is not a separate kind in the current kind vocabulary. The audit population below is explicitly defined, rather than inferred from a UI label or an active fleet's claim filter.

**The recent audit and what it establishes.** The completed P-003 review is **WI-2146347**, within `feature-change-reconciliation-and-zero-state-clarity-2026-09-05`. The broader driver is **WI-2146291**. Its frozen population at **2026-09-05T17:09:11.920530Z** contains **2,261 unique rows: 2,089 changes and 172 features**. It includes all nonterminal states and excludes observations in workspace `papercusp-workspace`, harness `papercusp`. These are historical snapshot counts, not a current claimable-work count.

I independently joined every disposition to its complete frozen export, verified all 2,261 source SHA-256 hashes and the unique-ID set, and recomputed the outcome totals. The ordered-ID SHA-256 is `62b68aa60cc8e1a93b758b793709878779e0df896b542be518cab1f0977af1de`; the completed disposition file SHA-256 is `57387275469ff54bf367c9271d1e5be785c6e0ba64d573d2c2b0c0de685f18ae`.

| Completed review result | Entire feature/change population | Change rows only |
|---|---:|---:|
| Proposed shared-root consolidation | 197 | 197 |
| Possibly already implemented | 25 | 25 |
| Proposed exact duplicate | 4 | 4 |
| Possibly stale or no longer relevant | 5 | 5 |
| Other plan-completion/supersession candidates | 5 | 2 |
| **All proposed cleanup actions** | **236** | **233** |
| Preserved because no candidate signal was found | 1,363 | 1,350 |
| Preserved for insufficient evidence | 175 | 175 |
| Other preservation decisions | 487 | 331 |
| **Total** | **2,261** | **2,089** |

The **233 change candidates are 11.2% of changes**, but this is a candidate rate, not a confirmed waste rate or an expected number of deletions. Shared-root consolidation can preserve separate remedies and acceptance obligations. P-003 records **zero manual cleanup mutations**; P-004 separately validates current evidence before applying recoverable changes. I did not take over or monitor that fleet's apply lane.

The larger uncertainty is the preserved population: **1,350 changes had no generated cleanup signal**, and another **175 lacked enough evidence to decide**. “Preserve” means the audit did not justify disposal. It does not certify current relevance, implementation readiness, or product value. For example, preserved no-signal **EI-10** still proposes inverting the physical work-items base table, while migration 374 explicitly performs that inversion. Its other trigger obligations and hold still require separate verification; this is a concrete reason for current-code review, not permission to close the whole item.

**A material part of the stock is review work.** Frozen `payload.agentReview` records on changes show **714 pending, 149 revision-requested, and 187 approved**; **1,039 have no such record**. The normal implementation predicate excludes pending and revision-requested work, except revision records submitted by `system:legacy-agent-review`. Four of the 149 have that exception, so **859 changes (41.1%) are excluded by this review rule**. Other holds, dependencies and origin boundaries can further restrict pickup. These buckets overlap the cleanup categories above and must not be added to them. Missing review metadata is not proof of approval or failure: schema vintage and the original filing route matter.

Correction preserved: an intermediate update described all 863 pending/revision rows as implementation-excluded. The exact predicate has four legacy exceptions; 859 is the corrected count.

**What admission already does.** `capture-core.ts` stores feature-shaped improvement captures as `change` plus a payload refinement, so the change stock is not solely approved implementation specifications. It has keyed coalescing, occurrence recording, dedup coverage, and review enrollment. Tool-failure intake has a separate observation/probation path; a single unconfirmed failure need not become runnable work. Freshness routing already covers both bugs and changes. These mechanisms should be extended, not replaced by another queue or a blanket rejection of speculative reports.

The recurring admission promoter and bulk deduplicator share `buildPromoterPrompt` and `persistAdmissionPlan`. Their charter is deliberately **duplication only**: same finding plus same remedy can merge; different remedies and related findings survive. High similarity generates a comparison, not a disposal verdict. The original admission plan's D-001 also defines its census as **unadjudicated similar pairs**, not remaining worthless rows. A falling pair census can result from legitimate keep decisions without removing any work.

Legacy admission `NULL` is deliberately treated as admitted. The frozen changes span June through September; the bulk runner first appears in repository history on August 26. A missing newer field on an older row cannot demonstrate that today's admission failed. Historical cleanup is the appropriate place to re-evaluate those rows against current evidence.

**Existing cleanup improvements deserve credit.** `work-queue-resolution-improvement-2026-08-31` records its eight implementation items complete, with plan status awaiting acceptance when read. Current source includes resumable batch checkpoints, model/account preflight and a canary, explicit failure outcomes, independent merge-quality fixtures, and fail-open re-review tracking. The September 5 identity fix also makes bulk merges retain a keyed canonical and refuse conflicting stable producer identities. This audit verified source and ledger evidence; it does not claim a fresh production bulk run or final plan acceptance.

**Recommendations must apply to both new intake and historical cleanup.**

| Standard | New intake / promotion | Historical bulk cleanup |
|---|---|---|
| Establish the actual remaining problem | Use the existing review/freshness route to require current evidence, affected behavior, intended outcome and an acceptance check before ordinary build pickup. Keep uncertain reports in observation/review with an accountable next action. | Check full bodies against current code, plans and applicable completion evidence, including samples from “no signal.” Missing evidence preserves uncertainty; it does not mean “good” or “obsolete.” |
| Represent one recurring problem coherently | Coalesce repeated occurrences under stable producer/problem identity. Repeated caller mistakes may justify a usability or documentation change, but repetition alone does not prove a server defect. | Preserve occurrence history, unique evidence, distinct remedies and acceptance obligations under the surviving root. Retain/reconcile every producer identity so the next emission does not recreate the removed row. |
| Enforce the same mutation safeguards | Before a merge, re-read and validate both rows, current claims, holds, origin, review restrictions, dependencies and the canonical survivor. | Invoke the same shared pre-apply check. Bind a verdict to the evidence and row versions actually judged; defer or re-review if either changed. Preserve both reference directions and make every transition recoverable. |
| Separate queue states and allocate the right capacity | Report awaiting review, awaiting revision, validated/claimable, active, blocked and terminal separately. Staff review as well as implementation. | Reclassify survivors into those same states. “Reviewed by dedup” must not silently become “approved to build”; a paused/spec-empty fleet must not report a drained corpus. |
| Measure useful throughput | Measure cohort arrivals, review completion, first-claim delay including never-claimed aging, and verified delivery. Adjust producer/reviewer/worker capacity from those measurements. | Report unique rows actually changed, confirmed merges, preserved obligations, invalidated decisions, reopens/recurrence and cost. Keep pair adjudications separate from successful row mutations. |

**The concrete parity gap.** The manual reconciliation plan already requires full current evidence, claims, origin, holds and bidirectional references in R-5/R-6/R-7. The automated bulk input currently selects title, summary, status, kind, admission, keys and creation time; it does not carry those complete protections. After model judging, the shared merge-any-admission SQL conditions the terminal transition on workspace/harness/id and nonterminal status. It does not itself establish the manual audit's current-row eligibility/evidence contract. A transaction and a non-increasing pair census do not provide that contract.

This is a **source-confirmed safeguard gap**, not a claim that a live protected row was wrongly closed. Follow-up **EI-22458055788060997**, “Apply shared live-row and evidence safeguards to admission and bulk dedup merges,” is filed in the existing agent-review lifecycle. It explicitly requires the common persistence seam to protect **both recurring admission and bulk cleanup**, reuses existing policies and identity logic, and calls for regression cases covering claim/hold/origin/scope changes after judgment, unsupported terminal canonicals, unique obligations, incoming references and keyed recurrence. It is proposed work, not an implemented fix.

The recommended sequence is to finish the already-owned evidence-backed reconciliation, implement that shared parity requirement through the existing review process, then size ongoing review and build capacity from separately measured queues. A new blanket merit-scoring gate is not supported by this audit: the original design recorded weaker agreement on merit than on duplication, and the recent review did not perform a complete value assessment.

**Evidence and verification.**

- [Frozen census](../../scratchpad/feature-change-reconciliation-and-zero-state-clarity-2026-09-05-p002-census.md) and [completed per-row dispositions](../../scratchpad/feature-change-reconciliation-and-zero-state-clarity-2026-09-05-p003-dispositions.json). The older P-003 prose review is an interim document; the completed JSON and WI-2146347 supply final coverage.
- [September 1 final ledger](../../scratchpad/feature-change-dedup-supersession-audit-2026-09-01-p004-final-ledger.md), used for the prior fleet/disposition history. September 5's census corrects its older exact-title/fuzzy candidate headlines.
- [Canonical work-item mapping](../../packages/operator-core/lib/work-items.ts), [review exclusion predicate](../../packages/operator-core/lib/harness/improvements/agent-review-policy.ts), [review writer](../../packages/operator-core/lib/harness/improvements/agent-review.ts), [capture writer](../../packages/operator-core/lib/harness/improvements/capture-core.ts), [freshness policy](../../packages/operator-core/lib/work-item-claim-freshness.ts).
- [Admission semantics](../../packages/operator-core/lib/work-items-admission.ts), [shared prompt and merge writer](../../packages/operator-core/lib/work-items-admission-promoter.ts), [bulk runner and identity guard](../../packages/operator-core/lib/work-items-admission-bulk-dedup.ts), [census writer](../../packages/operator-core/lib/work-items-admission-census.ts), [merge-quality gate](../../packages/operator-core/lib/work-items-admission-merge-quality.ts).
- [Migration 374](../../libs/papercusp/libs/db/sql/374-work-items-unify-base-table.sql) supports the limited EI-10 counterexample; it does not establish completion of every obligation in that item.

Verification was read-only artifact/hash/census recomputation and source/plan/ledger inspection. No application behavior was changed and no application test suite or deployment was claimed. The two records added were the audit task and the shared-safeguard proposal; an incidental tool-timeout report was filed separately in non-claimable observation probation as EI-22457763240156039. No existing feature/change row was disposed of by this audit.
