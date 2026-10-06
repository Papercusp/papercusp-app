# Acceptance grading runbook — portable identity packages
URL: /internal/docs/agent-insights/portable-identity-packages-acceptance-runbook

Grading procedure for acceptance-portable-identity-packages-2026-09-26: pin the rubric and plan revision, spot-check the completion audit blobs, run each tree-plane bar check file one per call against its scope map, probe the deployed R-9 bar, and the traps (R-4 removed with P-008, :3070 vs tree, dirty-tree passes, non-unique AUTO-BAR ids).

# Acceptance grading runbook: portable identity packages

This is the rubric-level method for `acceptance-portable-identity-packages-2026-09-26` (plan `portable-identity-packages-2026-09-26`). Read the current rubric from the store before grading (`rubrics:get { rubricRef, detail:'full' }`). Each criterion's own `verification.method`, `check.files` and per-bar scope map (scope token -> file + `it()` title) are authoritative for that bar. This page gives the shared procedure and the traps that make a wrong grade look right.

A passing scorecard is one complete observation of the current rubric revision, filed by a non-implementer. **Healthy** means the bar's model (its one atomic pass floor) holds and none of its numbered BROKEN markers holds. **Degraded** means the floor holds but a required scope token has no current observation. **Broken** means the floor fails or any one numbered marker holds. **Unknown** means you cannot get the evidence without guessing, for example when a probe is unreadable. Never rate an unreadable probe healthy.

## 1. Pin the subject

1. Record the rubric revision and the plan version you grade (`plans:get { slug }` gives `version`). A grade on an older rubric revision does not count. Any rubric edit invalidates earlier gradings.
2. Read the plan's Decisions, especially D-011 (follow-up deferral), D-037, D-042, D-043 and D-044. **R-4 does not exist on this rubric.** P-008 was dropped and deferred to WI-10004263 (D-043), and its bar left in the batched amend. Do not grade the plan for P-008's behaviour.
3. Record the commit that contains the accepted code for each bar's check files: `TZ=UTC git log -1 --date=iso-strict-local --format='%cd %H' -- <path>`. Do not use `git rev-parse HEAD`.

## 2. Spot-check the completion audit

The code-truth audit is in `harness_shared.plan_audits` (`audit_kind='completion'`, scoped by `workspace_id` and `plan_slug`; there is one row per `plans:audit` call, so read the latest row for each item). Each item's citations carry a stored blob SHA. For a sample of at least one citation per bar's plan item, compare it with the current blob:

```bash
git rev-parse HEAD:<cited path>
```

A differing blob does not by itself mean the audit is wrong: the file may have moved on since. It does mean that citation is not evidence of the current tree, so re-read the cited lines before relying on them.

## 3. Tree-plane bars (R-1, R-2, R-3, R-5, R-6, R-7, R-8, R-10, R-11)

Run every file in the criterion's `check.files` yourself, **one file per invocation**:

```
testing:run { files: ['<one path>'] }
```

A multi-file Vitest run can abort during collection when one file crashes, and then reports a result for files that never ran. A `matched=0` or `TEST_FILE_ROUTE_ERROR` result means nothing was measured, so rate it unknown, not healthy.

Then, for each scope token in the bar's scope map, confirm that the named `it()` title exists in the named file and passed in your run. A scope token whose test is missing, skipped or `.todo` leaves the bar degraded at best.

Bar-specific notes:

* **R-5 (bounded synchronous contributions).** The Claude-and-Codex-sinks token needs both host shapes. `identity-hook-sinks.test.ts` has a case that sends a Codex call and asserts it gets the verdict a Claude call gets. Check that it asserts the verdict, not only that the call returns.
* **R-10 (fail-closed worn deny predicates).** This bar was split from R-5 in rubric rev 3. The floor is that an unevaluable deny predicate refuses the call **and the refusal names the identity and the rule**. A refusal that names neither is broken, not degraded.
* **R-11 (exactly-once reactions per wearer).** This bar was split from R-6 in rev 3. Check two-wearer dedupe *and* attribution: two wearers of one event must each get one dispatch attributed to themselves, not one shared dispatch.
* **R-5 and R-10 unit layer.** From rev 5 both bars list `requiredTestLayers: ['integration','unit']`. Some of their scope cases are covered only by unit files: `state-template-reader.test.ts`, `identity-hook-sinks.test.ts`, `dispatcher.test.ts` and `sync-hook-rules.test.ts`. Run those files and rate them. They are not optional extras beside the integration files.
* **R-1 vs R-8 on attach.** R-1 owns parity between launch and mid-session attach. From rev 5, R-8 marker (3) covers only features missing **at launch**. A declared feature that is present at launch but missing after a mid-session attach fails R-1, not R-8.
* **R-8 (independent portability).** `cupboard/third-party-portability.integration.test.ts` installs a package authored outside the first-party tree into a clean workspace, with no registry pre-seeding. Check that the fixture's author is not first-party and that the async-hook leg fires. D-042 and D-044 record why a bundled event key must be claimed at install; without that claim, the async hook is inert.

## 4. The deployed-plane bar (R-9)

R-9 has no test, and no test result can satisfy it. From rubric rev 5 its `check` is a `kind:'probe'` that `scorecards:emit` runs for you when you rate R-9. Follow the criterion's method exactly:

1. `dev:pipeline_position { path:'packages/operator-core/lib/blueprint/compile-packages.ts', marker:"resolveInstalledEvent(request.ref, only('event'))" }`. `servingRuntimes[0]` must be the `release-operator` row, and it must read `containsChange: true` with `method: 'blob'`. This is the value the probe checks. Do **not** use `serving.startedSinceCodeChange`. It compares the process start time with the file's mtime, so it turns false as soon as anyone edits the file after the deploy, even while the accepted code is still live.
2. `state:read { cell:'deploy.3070.sha' }` names the serving sha. For each accepted path, `git rev-parse <sha>:<path>` must equal the accepted blob. This blob equality is the rating basis. Ancestry (`merge-base --is-ancestor`) is not a containment test.
3. `state:read { cell:'gate.greenCheckpoint.verdict' }` must be green for a candidate that contains those blobs, and `plans:get` must show no force or waiver on the plan.

If the deploy has not landed yet, R-9 is unknown, not broken. Say so in the evidence. `scorecards:emit` refuses a rating it cannot check: an `error` or `unknown` probe result (for example `result_too_large`, which applies above 16,000 bytes) blocks the emit. A `stale` result means `containsChange` is not yet true.

## 5. Traps

* **Your MCP calls run the released build on `:3070`, not the working tree.** A tree-plane bar is proven by running the test files, not by calling the tool that the change modified.
* **A pass at tip is not proof about the committed blob.** `testing:run` runs the working tree. If the router's provenance banner marks a check file DIRTY or UNTRACKED, compare it with the committed blob before you cite the run.
* **Spec ids like `AUTO-BAR-R-5-P-013` are not globally unique** across plans. When you read evidence bindings by SQL, scope by `plan_slug`.
* **Do not grade from the implementer's checkpoints or work-item prose.** Treat them as leads, and rerun what they claim.
