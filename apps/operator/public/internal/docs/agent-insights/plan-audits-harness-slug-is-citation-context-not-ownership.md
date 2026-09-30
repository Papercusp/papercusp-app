# plan_audits.harness_slug is the auditor's citation-context harness, not the plan's owning Hive — don't filter getLatestPlanAudit on row.harnessSlug
URL: /internal/docs/agent-insights/plan-audits-harness-slug-is-citation-context-not-ownership

plans:get silently omitted a real, canonical plan_audits row (EI-21124863090048444) because it filtered getLatestPlanAudit by the plan's Hive-home harness_slug — a value that legitimately disagrees with what plans:audit stores in that same-named column for any Hive with member/sub-harnesses (\"SideStage\"-shaped pots). Two different concepts share one column name; treating them as the same key drops real data with no error.

## The bug (EI-21124863090048444)

`plans:get` surfaces a plan's most recent code-truth audit as `latestAudit`, read via
`getLatestPlanAudit(planSlug, { workspaceId, harnessSlug })`. It passed `row.harnessSlug`
— the plan's **Hive-home** slug, as `resolvePlanScope` collapses any member/sub-harness
caller to it (see [`plan-writers-must-not-re-derive-the-tenant`](/internal/docs/agent-insights/plan-writers-must-not-re-derive-the-tenant)).

But `plans:audit` (`recordPlanAudit`) writes that *same-named* `harness_slug` column with
something else entirely: the **citation-context harness** — whatever `ctx.harnessSlug` the
auditor's session happened to be scoped to when it ran `plans:audit`, UN-collapsed. That
value is needed later, verbatim, so `repoCitationContextForHarness(audit.harnessSlug)` can
re-resolve the audit's citations against the *correct repo root* at ship time
(`plan-acceptance-gate.ts`). For a plan whose Hive has member/sub-harnesses (papercusp's
own `papercusp/libs/generic/*` sub-harnesses, or a member like `sidestage-mobile` under the
`sidestage` Hive — a "SideStage"-shaped pot), the auditor is very often scoped to a member
repo, not the Hive home — so the two values routinely disagree.

`getLatestPlanAudit`'s strict `harness_slug = ${harnessSlug}` filter then matched **zero
rows** against a real, canonical audit — no error, no warning, just an absent `latestAudit`.

## Why this is easy to get wrong

Two genuinely different concepts happen to share one column name:

| concept                | what it identifies                                               | who reads it                                                                      |
| ---------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| plan ownership         | the plan's Hive-home slug (`resolvePlanScope`'s collapsed value) | `harness_plans.harness_slug` — the plan's real PK component                       |
| audit citation-context | which repo the auditor's citations resolve against               | `plan_audits.harness_slug` — read by `repoCitationContextForHarness` at ship time |

`resolvePlanScope`'s doc comment (and `resolvePlanWriteScope`'s three documented
generations of the *writer* version of this mistake) primed the intuition that "a
plan-adjacent `harnessSlug` field should be Hive-collapsed." That intuition is correct for
`harness_plans` and wrong for `plan_audits` — and nothing in either table's shape signals
the difference; you have to trace what each column is actually READ FOR.

Confirming evidence the column is NOT an ownership/scoping key: neither
`recordPlanAudit`'s own `audit_seq` allocation (`MAX(audit_seq)+1 WHERE workspace_id = …
AND plan_slug = …`) nor `getEffectiveItemAudits` (the carry-forward reader) filters by
`harness_slug` at all — both already treat `(workspace_id, plan_slug)` as the audit
ledger's whole scope.

## The fix

`plans:get` now calls `getLatestPlanAudit(row.planSlug, { workspaceId: row.workspaceId })`
— `workspaceId` only, matching the pattern `plan-acceptance-gate.ts`'s ship-gate caller
already used (and which `plan-audits.scope.test.ts` already pinned as "the ambient fallback
for acceptance-gate callers"). `recordPlanAudit` / `repoCitationContextForHarness` /
`plan-acceptance-gate.ts` are untouched — they still need, and still get, the raw
citation-context slug.

`PlanAuditReadScope.harnessSlug` stays available (a real, if rare, need: deliberately
narrowing to one citation-context harness), but its doc comment now says explicitly not to
thread a Hive-collapsed plan-ownership slug through it.

## The rule

Before filtering a read on a column shared with a write path, check what the WRITER
actually put there — not what the column name suggests, and not what a sibling table's
same-named column means. `harness_slug` is not one contract repo-wide; it is redefined
per-table by whoever reads it.
