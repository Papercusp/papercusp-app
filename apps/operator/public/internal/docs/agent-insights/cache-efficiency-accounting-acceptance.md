# Cache efficiency and accounting — acceptance method
URL: /internal/docs/agent-insights/cache-efficiency-accounting-acceptance

Execution and evidence boundaries for the cache-efficiency acceptance rubric: current source-bound checks, real report populations, strict trial authority, and separate vetting/grading.

## Scope and reuse

This is the execution guide for the existing `cache-efficiency-accounting-acceptance` rubric and plan `cache-efficiency-and-accounting-2026-09-23`. It supplies the missing method reference; it does not replace or change any BAR, threshold, cohort, stop condition, or evidence plane. Reuse the current rubric's per-criterion method, replication drill and structured checks. Reuse [acceptance-rubric vetting](/internal/docs/agent-insights/acceptance-rubric-vetting) for the separate meta-rubric process. The generic vetting guide does not contain this plan's accounting/report boundaries, which is why this plan-specific reference exists.

## Freeze what is being judged

Read `rubrics:get { rubricRef:'cache-efficiency-accounting-acceptance', detail:'full' }` and `plans:get { slug:'cache-efficiency-and-accounting-2026-09-23', mode:'full' }`. Preserve rubric revision, criteriaHash, barSetHash and plan revision/contentHash with the evidence. For a bounded criterion read use the same rubric tool with `projection:{pick:['results[].rubric.criteria[0]']}` (change the index only after reading the complete criterion index). A projected or truncated read is not evidence for omitted criteria. Grade the terminal subject afresh; do not carry an interim rating forward just because the code appears unchanged.

## Obtain authoritative, repeatable evidence

For each current criterion, open every bound file and name the concrete assertion/fixture/branch that can fail for its drift marker. Use the existing root test router: `PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- <one bound test path>`. Preserve its test-run identity, exact command, source/test hashes, log, timestamp and per-test result. Confirm requested files equal matched/executed files and disclose skipped tests. A typecheck or a green unrelated file is insufficient. Use a meaningful historical pre-fix failure or an isolated source-backed counterfactual control where the criterion requires detector evidence; keep both red and corrected-green receipts. Do not mutate the shared tree merely to demonstrate a counterfactual.

Retrieve previous work through `work_items:get { id:'<work-item>', harness:'papercusp', resume:true }`, then the referenced authoritative evidence. A comment or this document is an evidence index, not proof that a test ran. Scorecard evidence must itself contain rerunnable tool arguments/commands and source references, not only a prose assertion, bare count, opaque post number or another card's verdict. Distinguish a historical receipt, a current source-bound result, and an unresolved observation.

## Apply the ten existing criteria

* R-1: exercise parser model continuity, disjoint token categories, duplicate/reset behavior and persistence. Missing model or write categories remain unknown.

* R-2: exercise the real database transaction/watermark and provenance paths, including rollback/replay, incomplete lineage and bounded telemetry privacy.

* R-3: use isolated archived audit fixtures plus the already completed bounded backfill's original-row and before/after partitions. Do not repeat a production backfill for grading. Preserve unavailable rows and distinguish estimated list cost from invoices/subscription spend.

* R-4: judge fork/carry savings, continuity and latency using the actual pre-registered D017 cohort and the current thresholds. Local fixture bytes, arithmetic and scripted startup proofs alone cannot establish native adoption, remote account scope, charged request completeness or savings.

* R-5: judge stable required instructions/tools and bounded changing carry, exact per-cut recovery and continuity. Identify any distinct performance claim as a separate report; do not silently reuse another report's population.

* R-6: require the matched-cadence TTL comparison even when retaining the old policy. Preserve explicit caller intent, marker order/budget, transport limitations and actual tier evidence. A rewrite counter is not a cache hit or saving.

* R-7: use the frozen internal-cache workload/snapshot and paired procedure from the current rubric. Verify independent-worker freshness/isolation and actual rebuild/read work; indexability alone is not an end-to-end timing result.

* R-8: inventory every R-4/R-6/R-7 report and every distinct R-5 performance report. Judge honest completeness of population, costs, quality, latency, exclusions and uncertainty. The owning criterion judges whether its thresholds were attained. Reference shared evidence by identity without counting it twice. Apply D017 cohort/caps only to fork/carry; use the other reports' own frozen protocols.

* R-9: exercise the actual detectors, default behavior and rollback; then verify accepted source/revision and effective policy in each affected deployed process. Local tests do not satisfy deployed/runtime adoption. An unresolved required runtime binding remains unresolved. Include an inventory of durable surfaces against the plan's reuse and scope decisions.

* R-10: separate startup-sharing eligibility from observed provider reuse; retain sequential and cold-concurrent populations and scope/expiry controls. Cite current transport-specific provider guarantees; do not promise one cache write for simultaneous cold launches.

## Preserve the authorization boundary

D017 describes a bounded trial, not a grant to send requests. Before any charge, bind the required frozen manifest, source/writer exclusion, native request/output bounds, serving account scope, independent review and authenticated approval/fresh CAS. The controller must reserve the complete remaining required request population and enforce the first applicable cap/stop. Unknown cost, unpriceable requests, lost source/accounting traceability and an incomplete cohort cannot be relabelled as success. An OAuth request field stripped by normalization is not an enforced native bound.

The existing learning-spend ledger's exact reservations (D048-D050) are conservative storage primitives. USD/resource receipts are not authenticated provider usage. Token/request ceilings remain committed after monetary settlement. Exact monetary settlement rejects mirror accounting and unknown/invalid costs; explicit cost still needs trusted provenance. Do not wire a paid controller that treats those receipts alone as full trial authority.

## Report, vet and grade separately

Give each criterion its own outcome, tested population, checked/not-checked/not-applicable partition, residual limitations and rerunnable evidence. Missing observations are unknown, never invented zero. Report failures, aborted attempts and counterexamples alongside successful samples. A uniform pass distribution deserves an explicit independent check against the measured evidence.

Before new proof binding or grading, verify current acceptance-rubric vetting using `rubrics:get`. The author may grade the rubric against `meta-acceptance-rubric` after outside critique; that is distinct from the independent grading of implemented plan work. Read the old failed vetting audit before replacing it, and do not reuse it as a pass. Method/reference changes can advance the rubric revision even when BAR hashes remain unchanged, so re-read the revision after an amendment and make the new attestation against that exact revision. Only current audited vetting and current adequate per-BAR evidence support later acceptance; this guide is neither.
