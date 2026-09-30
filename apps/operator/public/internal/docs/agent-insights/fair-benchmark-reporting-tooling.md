# Fair cross-arm benchmark reporting — use the bench-metrics tooling, mind the same-denominator trap
URL: /internal/docs/agent-insights/fair-benchmark-reporting-tooling

Before reporting any benchmark arm comparison, use buildCapabilityAttribution + buildFairnessAudit (@papercusp/bench-metrics) — they encode the binding fairness criteria so you don't hand-roll them and hit the C1 denominator trap.

import { Aside } from '@astrojs/starlight/components';

When you compare benchmark arms (capability injection, coordination topology, or a system-vs-reference run), **do not hand-roll the scoring + the audit table** — two tested, domain-free helpers in `@papercusp/bench-metrics` encode the [binding fairness standard](/internal/docs/benchmarks/fairness-criteria) so every benchmark reports identically.

## The two helpers

* **`buildCapabilityAttribution(rows, opts)`** — fixed-control per-arm lift (pass\@1 for boolean suites, `metric:'meanScore'` for continuous suites like SwarmBench/AgentsNet/rubric), cost-normalized (`costRatio` + `paretoDominates`, D-008/C3), CI-non-overlap significance, and per-task unlocked/regressed buckets. `buildCrossSuiteAttribution` rolls many suites into the headline matrix. `formatRunAttributionMarkdown` (operator-core) renders the owner-facing artifact; `report-cli <runId> --attribution` writes it.
* **`buildFairnessAudit(rows, {referenceArm?})`** — auto-fills the mandatory **C1–C10 pre-claim audit table** from the run's `TaskRunResult` rows: C1 same task-set + same-denominator, C3 iso-budget-or-disclosed (with `$/task` + `calls/task`), C6 per-arm coverage parity (flags ASYMMETRIC infra), C8 N + seeds; C2/C5 are config-consistency → `NEEDS-EVIDENCE` (telemetry/env are manual); C4/C7/C9 are manual. `allClear` is true only when every criterion is PASS/N-A. `formatFairnessAuditMarkdown` renders the table.

Both consume any arm's stored `TaskRunResult` rows, so topology arms and capability-injection arms report through the same path. Plug in your suite; don't re-derive the statistics.

## The trap they save you from (C1 same-denominator)

The single most common way to fake a benchmark win is to score each arm only on the tasks **it** produced output for. If arm A infra-fails 8 of 30 tasks and you score it `resolved/22` while arm B is scored `resolved/30`, A's denominator silently shrank — an unfair comparison (the 2026-06-17 su-vs-mini-swe run did exactly this and over-claimed).

`buildCapabilityAttribution` **defaults to `sameDenominator: true`**: both arms scored over the **union-N**, where a task an arm did not resolve (empty output, infra-failed, or absent) counts as `false`. The familiar exclude-infra view (what `aggregateArm`/`buildSuiteReport` compute — the METR "an infra error is not a capability failure" discipline) is correct for **one** arm's capability headline but is only the **labelled secondary** view here (`sameDenominator: false`); it flatters the weaker-coverage arm in a cross-arm comparison. The per-arm `ArmCoverage` (produced / infraOnly / absent) is the C6 audit evidence.

So: a clean run with no infra failures reads identically under both modes; the modes only diverge when coverage is asymmetric — exactly when fairness matters.

## The other trap (C4) — was the capability actually EXERCISED?

The second-most-common way to report a phantom win: an arm that *looks* different in config but whose agents never actually used the thing under test. A tau2 **+memory** arm reported a "lift" that was retracted (plan `benchmark-capability-injection-redesign-2026-06-17` D-022) — root cause: the agent made **zero** `memory_search`/`remember` calls (the capability is discretionary and opus simply never invoked it), so +memory ≡ vanilla and the "lift" was noise. Same trap for a coordination topology: a `dist-broadcast` arm that "beat" `su-independent` is meaningless if its agents never actually broadcast.

C4 is **not** satisfied by config (the arm being *configured* with the capability) — it needs **positive telemetry evidence that the capability ran**:

* **Coordination topologies:** the run driver (`run-topology.ts`) surfaces `armMeta.coordCalls` per task — the count of coordination tool calls the agents actually made. A coordination arm (broadcast / peer-review / blackboard / huddle / ensemble) whose rows show `coordCalls ≈ 0` is **C4 NEEDS-EVIDENCE**: the topology was never exercised, so the delta is variance, not capability. (A `worker` in a central/no-coord arm legitimately reports 0.)
* **Capability injection (memory, tools, …):** count the capability's own tool calls from `agent_usage_samples` before trusting a lift; zero calls ⇒ the arm is its own control.
* **Clean scoping is part of "exercised":** a capability wired to the wrong scope silently no-ops. `memory:search` scopes by `harness_slug`, **not** `hive_slug` — passing the pot slug returns workspace noise, not the arm's recall. Verify the capability reads/writes the scope you think it does.

Pre-flight the run on a 1–2 task probe and confirm the capability-exercised telemetry is non-zero **before** any big spend or claim. `buildFairnessAudit` marks C4 `NEEDS-EVIDENCE` by default — supply the `coordCalls`/tool-call evidence to clear it; never hand-wave past it.

## The seam-contract trap (emit only CANONICAL grader statuses)

If your `CloneGradeSeam.grade` returns a non-canonical `graderStatus` (anything outside `passed` / `failed` / `error` / `timeout`), the topology row-builder (`run-topology.ts` → `coerceGraderStatus`) coerces it to `'error'`, and bench-metrics' `isScored()` treats `graderStatus:'error'` as **infra** — so the row is EXCLUDED from the exclude-infra "valid" denominator. A genuine capability-fail you labelled cleverly (e.g. `'empty-diff'` for "the agent produced no patch") thus vanishes from the denominator, flattering the arm — the same C1 denominator-shrink, one layer down.

Map every grade outcome to a CANONICAL status, and keep the nuance in `detail`:

* **genuine capability-fail** (empty/invalid output, wrong answer) → `graderStatus: 'failed'`, `resolved: false` — scored, counts under BOTH denominators. SWE-bench scores an empty patch as a fail, not infra.
* **genuine infra** (clone / extract / grader crash, timeout) → `graderStatus: 'error'` / `'timeout'`, `resolved: null` — reconciled `false` in the C1 headline, excluded from the exclude-infra view (correct: it carries no capability signal).

Caught live: the SWE-Pro seam (the P-003 reference the other suites copy) returned `'empty-diff'`, which coerced to infra and would have dropped empty-patch fails from the valid denominator — fixed to canonical `'failed'` + `detail.reason:'empty-diff'` (plan `benchmark-capability-injection-redesign-2026-06-17` D-023).

## Pointers

* Standard: [benchmarks/fairness-criteria](/internal/docs/benchmarks/fairness-criteria) (C1–C10 + the worked cautionary audit).
* Code: `libs/generic/bench-metrics/src/{capability-attribution,fairness-audit}.ts`; operator-core `lib/external-bench/report/capability-attribution-report.ts`.
* Design rationale: plan `benchmark-capability-injection-redesign-2026-06-17` D-014/D-016/D-017.
