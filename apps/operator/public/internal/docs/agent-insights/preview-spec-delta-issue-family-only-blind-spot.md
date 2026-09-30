# A claimability \"oracle\" that shares floor logic can still disagree by CLAIM FAMILY
URL: /internal/docs/agent-insights/preview-spec-delta-issue-family-only-blind-spot

scheduler:preview_spec_delta reused the same floor predicates as scheduler:get_next and still reported a confident false zero for a feature-family item, because it queries a different candidate POPULATION (issue-family only) — the \"same oracle\" claim covered floors, not family coverage.

## What happened

`scheduler:preview_spec_delta` (engine: `readClaimSpecDelta` in
`packages/operator-core/lib/scheduler/get-next.ts`) reported `currentClaimable: 0` and
`proposedClaimable: 0` for a fleet's stored claim spec — including for a second preview whose
`proposed` spec named three specific ids by id-filter. Seconds later, `scheduler:get_next`
claimed one of those exact ids under the exact same stored spec revision. No state changed in
between. See EI-21177555351818650.

Root cause: the three named ids (WI-40469/WI-40491/WI-40500) were all `item_kind = 'feature'`
rows. `readClaimSpecDelta`'s candidate subquery
(`issueClaimCandidateSubquery`) is hard-scoped to
`WHERE wi.item_kind IN ('bug', 'change', 'task')` — issue-family only. It never queries the
feature-family table at all. `scheduler:get_next`'s real claim ladder
(`getNextWorkItem`) is NOT scoped that way: its tier 1/2 claims from the
feature-family table, tier 3 (only) uses the same issue-family subquery. So a feature-family row
is genuinely claimable via `get_next` while `preview_spec_delta` — and every other reader of
`readClaimSpecDelta`/`issueClaimCandidateSubquery` — structurally cannot see it and reports a
confident, indistinguishable-from-real zero.

## Why this was easy to trust wrongly

The tool's own doc comment (correctly) says it "reuses the SAME `issueClaimCandidateSubquery` +
the SAME `ALL_ISSUE_CLAIM_FLOORS_PASS` bar every other claimability read uses" — true for the
FLOOR predicates (untaken, claim-hold, cooldown, blocked-deps, …), which really cannot drift
between this preview and the real claim because they share one exported SQL fragment. But
sharing the floor logic says nothing about sharing the candidate POPULATION. "Same oracle" reads
as "will never disagree with get\_next" — it actually means "will never disagree with get\_next
about a row both of them consider at all". A caller has no way to tell those two claims apart
from the tool's result alone; a `0` looks identical whether it means "genuinely 0 admissible" or
"0 issue-family rows admissible, and I never looked at anything else".

## The recurring shape (this is not a one-off)

This is the SAME blind spot, hit before in a sibling surface and fixed there with the
established pattern:

* `EI-18741395910746959` — `scheduler:get_next`'s OWN miss diagnosis
  (`buildMissDiagnosis` in `packages/operator-core/lib/agent-tools/scheduler/get_next.ts`) had the
  identical issue-family-only blind spot for its `pendingUnclaimed`/`readyUnclaimed`/
  `excludedBreakdown` numbers. Fixed with `specIsIssueFamilyOnly` / `specKindFilterValues` +
  a `familyScopeNote` appended whenever the caller's spec does not restrict exclusively to
  issue-family kinds.
* `fleet-scope-admission.ts`'s `nonIssueSpecEmpty` gate (search
  `EI-19393442073558754`) applies the exact same `specIsIssueFamilyOnly` judgment to avoid
  reading a plan-scoped spec's expected issue-family `0` as a spec-authoring bug.
* `EI-21177555351818650` (this insight) is the THIRD independent instance — `preview_spec_delta`
  had no such guard at all until this fix.

**If you are adding or reviewing a NEW reader of `readClaimSpecDelta` /
`issueClaimCandidateSubquery` / `aggregateIssueClaimExclusions` / `listIssueClaimableRows`, ask
whether its caller's spec is guaranteed issue-family-only.** If not, the reading needs the same
`specIsIssueFamilyOnly` guard — copy the pattern, don't rediscover the incident.

## The fix applied here

`preview_spec_delta.ts` gained `deltaFamilyScopeIncomplete(currentSpec, proposedSpec)` — true
whenever EITHER side's own `kind` filter does not restrict exclusively to issue-family kinds.
When true, a `FAMILY_SCOPE_BLIND_SPOT_WARNING` is prepended to the tool's `warnings` array (read
first) and a `familyScopeIncomplete: boolean` field is added to the response for programmatic
callers, so a false zero can never present as indistinguishable from a genuine one. This does
NOT make the counts exhaustive — it makes the incompleteness impossible to miss. A real fix that
also covers feature-family candidates in the SAME snapshot would need a materially larger change
to the delta engine (unioning a feature-family candidate population with a compatible row shape
into the existing temp-table snapshot) and was judged out of scope for this fix.

## Takeaway

"Shares the floor logic with the real claim path" and "covers the same candidate population as
the real claim path" are two DIFFERENT guarantees. A tool's doc comment asserting the first can
be entirely true while a caller reasonably (and wrongly) assumes the second. When you build or
review a claimability-style oracle, state BOTH guarantees explicitly, and if the population is
narrower than the real claim door's, make that narrowing loud in the result — not just in a code
comment nobody reading the tool's output will ever see.
