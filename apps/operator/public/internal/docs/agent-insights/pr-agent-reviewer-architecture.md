# PR agent-reviewer (PR-2) — architecture, safety guard, and the trigger/gate seam
URL: /internal/docs/agent-insights/pr-agent-reviewer-architecture

How the inbound PR agent-reviewer works end-to-end — the daemon triggers it, it reads the PR diff + WI context + repo conventions and emits a structured, safety-guarded report, the report is stored, and the poll daemon's auto-flow gate consumes the recommendation. Covers the deterministic honesty rail (a defective PR is never recommended for approval regardless of the model), the in-process-vs-blueprint trigger seam, the on-demand re-review endpoint, and the jsonb read-portability gotcha. The reviewer NEVER posts/merges — it only produces a recommendation.

## What this is

The inbound side of the fork→PR loop. When a contributor opens a PR on a shared
harness, the **agent-reviewer** reads it and emits a structured report — the
fields `summary`, `recommendation` (one of `approve` / `request_changes` /
`reject`), `rationale`, `risks[]`, and `checksObserved`. The owner reads it
(manual mode) or the poll daemon trusts the `recommendation` (auto mode). It is
the agent half of the owner's "human OR agent review" model
(PLAN-pr-system-completion-dogfood, Phase PR-2).

## The end-to-end flow (who calls what)

```
 new/updated PR on a shared harness
        │
   [PR-1] poll-daemon.ts  (system:pr-poll routine, per-harness, 60s + backoff)
        │  per new/changed PR (last-seen guard):
        │   (a) upsert harness_feature_prs   (WI↔PR row)
        │   (b) refresh pr_check_status_cache (CI signal)
        │   (c) triggerReviewer(...)  ───────────────┐
        │   (d) decideAutoReview(pr, settings)        │
        ▼                                             ▼
   AUTO-FLOW GATE                              [PR-2] runPrReviewTask / runAgentReview
   reportGatesAutoApprove(report)  ◀── reads ──   reviewPr → assembleReport (SAFETY GUARD)
     && decideAutoReview && !revoked && checks-green     │ stored
        │                                                ▼
        ▼                                         pr_review_reports  (+ auto_review_audit)
   tryAutoApprove + tryAutoMerge  [EXISTS]              ▲
        │ on merge                                      │ reads
        ▼                                        [PR-3] PrsTab/PrRow GUI (mapReportRow)
   stampCompletionRefOnMerge → feature shipped
```

Files (all under `packages/operator-core/lib/pr-host/` unless noted):

* `pr-review-report-types.ts` — types + the **pure safety guard** (the heart).
* `agent-reviewer.ts` — `reviewPr` (LLM call, injectable), `runAgentReview`
  (review→store→audit orchestrator), `runPrReviewTask` (the triggered-task entry
  point), `loadRepoConventions`, `defaultLlmRunner`.
* `pr-review-report-store.ts` — `storeReviewReport` / `readLatestReviewReport` /
  `loadFeatureContextForPr` / `writeAgentReviewAudit`.
* `poll-daemon.ts` — PR-1; `defaultTriggerReviewer` + the auto-flow gate.
* `endpoint-route/routes/harness/prs.ts` — the manual review route + the
  `POST …/prs/:number/agent-review` on-demand re-review endpoint.
* DB: migration `319-pr-review-reports.sql` (`pr_review_reports` + the extended
  `auto_review_audit` action CHECK).

## The safety guard is the load-bearing honesty rail

`assembleReport(llmReview, signals)` welds the model's judgment with deterministic
signals computed over the **full** diff. The guard (`applySafetyGuard`) can only
make a recommendation **more** conservative, never less:

* a suspected secret on an ADDED line → floor `reject`
* failing/errored CI checks → floor `request_changes`
* an empty/unfetchable diff → floor `request_changes`
* `result = max(llmSeverity, floor)`

So **a defective PR is never recommended for approval regardless of what the LLM
says** — this is a code guarantee, not a model promise, and it's the property the
unit tests pin. `no_tests` and `diff_truncated` are surfaced as **soft risks**
(flagged, not downgraded — docs/refactors legitimately have neither tests nor a
small diff). Crucially the secret/checks scans run over the FULL diff, so
truncating the diff for the model's prompt never weakens the floors.

`checksObserved` is the **deterministic facts** (CI state, mergeable, tests
touched, secret suspected, diff empty/truncated, files changed) — never the
model's opinion; it's easy to talk a model past a red build, so the gate-relevant
facts are computed, not trusted.

## S0 invariant: the reviewer never posts or merges

`reviewPr` / `runAgentReview` / `runPrReviewTask` have **no code path** to
`host.postReview` or `host.merge` — they only PRODUCE a recommendation. Approving

* merging stays in the gated `tryAutoApprove`/`tryAutoMerge` path, which
  additionally requires checks-green + trusted-author + owner auto-mode (+ not a
  revoked contributor). The gate ANDs the agent's `reportGatesAutoApprove(report)`
  (approve-only) with `decideAutoReview(pr, settings)`.

## The trigger seam (in-process vs blueprint)

`poll-daemon.ts` `defaultTriggerReviewer` fires once per new/changed PR (last-seen
guard, so no re-review churn). Preference order:

1. If a pot declares a `pr:review` launch **blueprint** → POST to it (a heavyweight
   Cup agent reviews — opt-in).
2. Otherwise → run `runPrReviewTask` **in-process, fire-and-forget** (the
   deterministic, safety-guarded default). The report lands in `pr_review_reports`
   for the gate + GUI to read on a later poll.

**First-sight + staleness:** the gate treats an **absent** report as "defer" (not
"approve") in auto mode, and `readReport` is **head\_sha-aware** (a report for a
different commit reads as absent ⇒ defer + re-review) — so a PR is never
auto-approved before the agent reviews *this* diff, and a force-push can't ride an
approve on the old diff. (Deferred PRs are excluded from `last_seen` so the next
poll re-checks.)

## On-demand re-review

`POST /api/harness/:slug/prs/:number/agent-review` (`prs.ts`, `auth: 'loopback'`)
runs `runPrReviewTask` now, bypassing the poll cadence — the PR-3 GUI's "Re-review"
action on a stale-report row uses it. Same store path; UPSERT-idempotent per
head\_sha; never posts/merges.

## Gotcha: jsonb reads are NOT portable across pg clients

`pr_review_reports.risks` / `checks_observed` are jsonb written as
`${JSON.stringify(x)}::jsonb` (the house bind — `sql.json` throws on the getOrgPg
client, EI-607). Under a `prepare:false` client (testcontainers, and any
non-auto-decoding client) jsonb reads back as a raw **string**, while prod
getOrgPg auto-parses to an object/array. Any reader MUST decode defensively with
`coerceJson` (see `pg-jsonb.ts`) — `rowToStored` does. Symptom if you forget:
`risks` reads back `[]` and `checksObserved` is a useless string. Caught only by an
integration test against real PG (the unit tests mock the store), which is why
`pr-review-report-store.integration.test.ts` exists.

## Tests

* `pr-review-report-types.test.ts` — the guard (defect→never-approve, secret→reject,
  truncation soft, parse/validate).
* `agent-reviewer.test.ts` — review/orchestrator/task with injected LLM+host+deps
  (never-posts asserted), conventions loading, fallback on LLM failure.
* `pr-review-report-store.integration.test.ts` — the real SQL (UPSERT idempotency,
  per-head\_sha rows, jsonb round-trip, the WI join).
* `github.test.ts` — `getPrDiff` / `getRepoFile`.
* `poll-daemon.test.ts` / `inbound-pipeline.test.ts` — the gate + the real
  `runAgentReview` through the seam.
