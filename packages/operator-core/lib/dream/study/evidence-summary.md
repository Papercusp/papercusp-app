# Dream study evidence — interim

Measured 2026-09-14T13:47:41.650Z. **Inconclusive; final acceptance remains open.**

19 governed study attempts; $1.614729 accounted, including conservative reservations. This is not invoice cost.

| Model block | Arm | Attempts | Accounted USD |
|---|---|---:|---:|
| Haiku/Sol | structured-pair | 2 | 0.055139 |
| Haiku/Sol | structured-triple | 1 | 0.000000 |
| Haiku/Sol | uniform-pair | 1 | 0.014978 |
| Luna/Sol | structured-pair | 5 | 0.174601 |
| Luna/Sol | structured-triple | 5 | 0.351371 |
| Luna/Sol | uniform-pair | 3 | 0.962295 |
| Luna/Sol | blender | 2 | 0.056345 |

## Observed outcomes

Dream: 17 attempts, 0 accepted review rows, 14 unverified reviews, and 3 attempts without a completed review. Unverified results are not substantive proposal rejections.

Blender: 2 governed cycles, 5 generated ideas, 0 routed ideas. Routing was explicitly deferred in the newer block; its scored-idea artifacts report no survivors.

5 matched A/B pairs were verified against the stored unit IDs. Both members of every completed matched comparison remain unverified; these data do not establish an incremental benefit from C.

## Interpretation

- Four source units and one source snapshot; no domain-general inference
- Model blocks and pre/post infrastructure or prompt-contract windows must remain distinct
- Ordinary Blender uses its production corpus and one ideator, not the Dream source population
- Unequal spend so far; no matched-spend superiority claim
- All phase cost figures exclude unmeasured engineer/reviewer time and local compute dollar valuation
- No substantive rejection should be inferred from an unverified verdict or a missing judgment
- The flat/faceted comparison used different reviewers and cannot isolate representation effects from reviewer effects

- Historical timeout notes claiming never-admitted/local-governor starvation were retracted in EI-22769219749818913: the Codex adapter did not emit onAdmitted. These raw persisted strings do not establish the cause or prove no generation occurred.
- For the original Haiku cycle 36930ec0-0135-4c3d-8261-b9b8f8028545, the recovered driver log records four HTTP 429 rate_limit_error retries before the deadline. This contradicts its persisted never-admitted explanation. The responding hop, pool account, later retry progress and billed usage remain unestablished; retain the USD 0.039173 unknown-call reservation. Evidence is preserved in EI-22756328656642291 comment 203056; source /tmp/dream-study-pair-after-readiness-20260909.log, SHA-256 ea874cd3a74f97ec879eb9d490a8d1e257684a52f54dc487ccf716e080fe5e3c. This historical evidence does not prove current Haiku recovery.

## Infrastructure corrections

- EI-22762141222831537 is closed: the Scout production path now threads the explicit workspaceId through productionScoutRunner, buildScoutCycleDeps, and the default goal-dispatch path. Twelve focused adapter/runner tests passed. This prevents future runs from relying on ambient sentinel scope; it does not reclassify historical study outcomes.
- EI-22769219749818913 is closed: the deadline diagnostics now separate admission and generation budgets, with 49 focused tests passing at the recorded base and the relevant source unchanged at closure. The historical d536051b delay remains un-attributable, and no paid identity was retried.

## Independent calibration review

The six-case AI/domain review is frozen in [the verbatim review artifact](calibration-review-2026-09-14.json) with its exposure disclosure and source-quotation clarification. Original case labels: 4 rejected, 2 unverified, 0 accepted. These are calibration judgments, not executed outcomes.

The duplicate source-packing cases count as one unverified representative family. Across five families, two are intrinsically rejected and three remain unverified. Qualified families remain unknown pending separate novelty/integration assessment; zero accepted cases does not mean zero viable families.

This is exploratory AI review with disclosed incidental aggregate exposure, not pristine blindness, human validation or held-out confirmation. It used approximately 17 reviewer-minutes. No original study outcome, source pin, cost or unknown reservation is rewritten by this report.

## Flat versus faceted representation ablation

The separately pre-registered flat-only AI review is frozen at WI-10001412 post 204651 and preserved in [the comparison result](calibration-flat-faceted-ablation-result-2026-09-14.json). Exact per-case disposition agreement was **2/6 (33.3%)**; four cases changed disposition. Faceted histogram: 0 accept, 4 reject, 2 unverified. Flat histogram: 2 accept, 3 reject, 1 unverified.

Mismatches: 1176a396ed37847cf61c (reject-to-accept); 36908b44cc10514ba38e (unverified-to-accept); 5908803065283e72f93d (unverified-to-reject); 838da71efc0a5d2f4a2d (reject-to-unverified). Both reviewers recognized 1176a396ed37847cf61c and 82152aef5690ace62e79 as one duplicate family. All six flat judgments covered the required decision domains and included decisive source citations.

This is a large descriptive representation/reviewer sensitivity signal, not a causal effect estimate: different AI reviewers judged the two forms, and the faceted reviewer disclosed incidental aggregate exposure after forming judgments. Six calibration cases are not powered evidence, flat `accept` is bounded-experiment qualification rather than global novelty or benefit, and this ablation is not human validation.

## Unblinded novelty and downstream eligibility

The separate unblinded AI/domain review is preserved in [its structured record](calibration-unblinded-review-2026-09-14.json) and WI-40148 posts 204403, 204404, 204405, 204406. It evaluated the three representatives selected before key access: 1176a396ed37847cf61c, 36908b44cc10514ba38e, 5908803065283e72f93d.

Novel bounded local Dream experiments qualified: **0/3**. The first two representatives are exact-family duplicates; the third is a refinement/consolidation of already-articulated prior compositions. All three are engineering-feasible in principle only after their missing product seams and contracts are established.

Downstream-eligible candidates: **0**; downstream trials executed: **0**. The downstream branch is **not applicable under the frozen evidence**, not silently deferred: no candidate passed the prerequisite novelty qualification. A later independent human review may challenge that conclusion, but tests or technical plausibility cannot promote a candidate by themselves.

The discordant flat source-stage judgments do not rewrite this later unblinded novelty result or revive downstream execution: they establish sensitivity and strengthen the need for independent human review. This remains AI review, not human validation or held-out confirmation. “Not novel” does not mean technically impossible or useless; it means these proposals cannot count as new Dream discoveries on the current unblinded evidence.

## Remaining acceptance work

- Independent human validation; the two AI source-stage reviews disagree on four of six exact dispositions
- Independent final acceptance and owner keep/simplify/expand/stop or explicitly inconclusive disposition

## Reproduction and evidence

`PAPERCUSP_WORKSPACE_ID=papercusp-workspace node --import tsx scratchpad/dream-study-2026-09-09/summarize.mts`

The companion [JSON evidence](evidence-summary.json) records each attempt, settled calls and conservative reservations, source-unit coverage, exact paired-run matching, Blender receipts, and outstanding work. The source ledgers are `harness_shared.dream_runs` and `harness_shared.scout_ticks`; `accounting.mts` owns cumulative budget accounting. Historic trial rows are not rewritten.
