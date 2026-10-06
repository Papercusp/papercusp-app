# Grading gate test reuse yield
URL: /internal/docs/agent-insights/gate-test-reuse-yield-grading

Shared procedure for the four reuse-yield acceptance criteria: exact runnable checks, fixed replay populations, live-window evidence, and literal source conflicts.

This is the main procedure for grading `acceptance-gate-test-reuse-yield-2026-10-01`. It uses the existing plan acceptance workflow and exact-file test router. The rubric's individual METHODs remain the per-criterion replication drills. This procedure supplies their shared population, provenance and outcome checks; it does not change a BAR.

## Bind the subject before measuring

Read the current full rubric with `rubrics:get` and the source plan with `plans:get`. Record rubric revision, criteriaHash, barSetHash, plan revision/contentHash, the current R-1 through R-4 text, and Decisions D-003, D-005, D-010, D-011 and the canonical amendment decision. Retrieve one Decision at a time if the plan read defers bodies. Never grade a clipped body as complete.

Pin the implementation and test blobs, committed candidate SHA, runner configuration and run context. Use exact persisted test-run IDs and their provenance; a dirty-tree row, an unscoped run, or a completed test with an unobserved imported source is a partial check, not clean committed acceptance proof. Match the requested files to the executed files and record skips/errors. No rows is UNKNOWN, not zero failures.

For each replay pin the entire eligible proof population, every input pair, selector version, proof-age reference time, drift set and per-lane counters before measuring. Keep the raw references addressable from the grading. Use the same inputs for the before/after sides.

## Verify the runnable checks

Use one exact-file `testing:run` call per owning runner group, with the held work-item attribution and evidence mapping when binding a proof:

* R-1: `packages/operator-core/lib/release/test-pass-reuse-report.test.ts`.
* R-2: `packages/operator-core/lib/__tests__/test-pass-reuse.test.ts` and `packages/operator-core/lib/__tests__/schema-symbol-drift.test.ts`.
* R-3: `packages/operator-core/lib/__tests__/pure-lane-proof-capture.test.ts` and `apps/operator/lib/release/green-checkpoint-pure-proof-capture.test.ts`.
* R-4: `packages/operator-core/lib/__tests__/schema-symbol-drift.test.ts`.

Require exact file matching, completed verdicts, and no skipped tests or errored runner groups. A partial multi-route result cannot certify its missing file. Recover existing rows with `testing:runs` using the exact runGroup; `testing:run-status` may report unknown\_run when a complete terminal manifest is absent even though some per-file PASS rows exist. Rerun the missing file rather than reconstructing a whole matrix. Retain the process/session handle until exit. The native CLI fallback uses the maintained `npm run test:file -- <path>` runner with `PAPERCUSP_TEST_RUN_HARNESS=papercusp`; it is a runnable check until clean source-bound evidence is separately qualified.

These tests exercise counter integrity, selector soundness, schema narrowing and capture sequencing. They do not measure full replay yield, a live soundness window, capture yield or a subsequent full run.

## Measure the four outcomes

### R-1: per-phase reuse yield

Retain the original fixed baseline pair (proofs at `29bf7350`, candidate `599dbeeb`) for phases A/B/C and record each side's per-lane reused count. D-003 contains Avi's explicit choice of an additional Phase-A pair with nested Vitest/config/script differences and no dependency change. Pin that second pair before measuring and report both pairs; judge Phase A with the governing D-003 condition. Do not silently discard the original pair or invent a new comparison.

Resolve each phase's referenced replay and its next full run's exact TEST\_PASS\_REUSE lines. Record full run ID, judged SHA, runtime identity and timestamps. Missing populations, pairs or log lines rate UNKNOWN. A measured failure to satisfy the governing increase condition rates FAIL.

### R-2: dependency invalidation and live soundness

Enumerate every narrowing in P-001 through P-005 and P-007. Map each to a test counterexample for executed-module or main-process-runner input drift and qualify the bound test evidence.

Separately pin the exact P-008 measurement-window boundaries and enumerate the complete reuse-audit invocation population: run IDs, timestamps, audited files and TEST\_PASS\_REUSE\_ALARM outcomes. Preserve the existing 5% sampling rule. Zero real misses requires a nonempty observed qualified window. Empty or incomplete coverage rates UNKNOWN; any real miss rates FAIL. Unit PASS alone cannot settle this outcome.

### R-3: pure-lane capture and subsequent reuse

Resolve the named producer `scripts/lib/pure-lane-proof-capture.mjs/runPureLaneProofCapture` and wrapper `apps/operator/lib/release/green-checkpoint.ts/runPostVerdictPureProofCapture`. Record the exact process identity, runGroup, judged SHA, verdict and promotion-decision timestamps, capture start/end, source=local per-file proof rows and the first subsequent full run's lane-pure reuse line. Require named proofs and nonzero subsequent reuse.

D-011 requires once-after-final-recursion capture; moved HEAD, dirty/unjudged tree or no suite rows yields an explicit skip and no acceptance. The literal BAR requires capture outside the gate run. D-005 specifies a same-process post-verdict phase, not a separate routine. Preserve this disagreement: a local wrapper PASS does not resolve it. If the exact process evidence does not establish the literal BAR, rate that aspect UNKNOWN or FAIL according to the observations. Only an approved canonical BAR amendment may change the promise.

### R-4: both hub reductions

Read the P-007 rationale and replay the original fixed pair with the complete cohort. Independently count proofs invalidated by the generated schema and by the mode catalog. The current BAR requires strict reductions below `1300` and `990`, respectively. Report both measurements and the rationale; missing populations rate UNKNOWN and a measured non-reduction rates FAIL.

D-010 expressly leaves the mode catalog unchanged. Its schema-only finding or another cohort's percentage cannot prove the mode-catalog clause. Keep that source conflict visible until implementation meets the BAR or an approved canonical amendment changes it.

## Use recorded runtime evidence and independent review

This repair lane does not start, rerun, monitor or deploy the current green-checkpoint. Use already-recorded run evidence; request needed evidence once from its registered owner. A live-plane criterion still needs an identified runtime and a qualified loaded build. Do not default to a port or promote unit evidence to live evidence.

After method repair, seek a fresh independent critique against `meta-acceptance-rubric`, tied to the exact current rubric revision/criteriaHash and complete source. The prior amendment approval authorizes its exact patch; it is not meta-rubric vetting or outcome grading. An expired consult without an answer supplies no attestation. Preserve substantive critique, qualify the current attestation, then follow the existing independent grading and rubric-author verdict workflow described in [the plan completion runbook](/internal/docs/agent-insights/acceptance-rubrics-on-every-plan-runbook).

REPLICATION DRILL: a second reader resolves the same pinned rubric, Decisions, source/test blobs, proof cohort, replay pairs and run-window references; repeats the exact-file checks and each outcome measurement; and can reproduce the per-criterion rating without an inferred zero, a substituted cohort, or a weakened falsifier.
