# A global enforcement floor with a family-scoped write path is unreachable
URL: /internal/docs/agent-insights/enforcement-floors-need-a-write-path

A read-side admission floor can be correct, global, and fully tested while remaining unarmable for half its rows — because nothing can SET the flag it reads. How to tell \"the floor is missing\" from \"the floor can't be armed\".

## The shape

An **admission floor** (a claim-time exclusion) has two halves:

1. a **read** half — the SQL predicate that excludes the row, and
2. a **write** path — some tool that can actually SET the flag the predicate reads.

Ship only the read half and the mechanism looks complete: the predicate is correct,
it is enforced globally, and its tests are green — because tests seed the flag
directly in SQL, never through the tool an agent would use. The floor is
nonetheless **inert for every row nothing can arm**.

## The concrete case (EI-18707466248332421)

`payload.needs_2_machine_rig` excludes rig-only work from single-box self-select.

* **Read half — global and correct.** `crossMachineRigExclusionSql` is applied for
  the feature family inside `claimFloorsWhereSql`, covering both feature-family
  claim entry points, with 8 integration cases in
  `scheduler/get-next-rig-floor.integration.test.ts` (EI-14806).
* **Write path — issue-family only.** `work_items:update` calls `updateWorkItem`
  first; its issue-family-only `unsupported_family` refusal returned early,
  short-circuiting the `mergeWorkItemPayload` flag merges below it — even though
  `mergeWorkItemPayload` supports both families.

So a feature-family row could never carry the flag. WI-3500 (8 placements) and
WI-3496 (6) burned **14 spawns** on legs the repo's own committed scaffold
(`papercusp-desktop/bin/hive-git-drill.sh:295-312`) already declares impossible on
one box. The integration suite was green the whole time.

## Why it gets misdiagnosed

The symptom ("a rig-gated item keeps being served") is identical for
*floor missing* and *floor unarmable*, and the natural conclusion is the first.
EI-18707466248332421 was filed proposing "extend the rig-gate to feature-family" —
work that had already shipped. The cheap disambiguator, in order:

1. **Grep the predicate**, not the feature. Is the exclusion SQL actually composed
   into the claim path for this row's family?
2. **Try the write through the tool an agent would use**, not a direct SQL seed.
   `work_items:update { id: <a feature-family id>, needsTwoMachineRig: true }`
   returning `unsupported_family` *is* the whole bug, in one call.
3. **Check what the tests seed with.** A floor test that INSERTs the flag in SQL
   proves the read half only — it can never catch a missing write path.

## The generalizable rule

> A floor is only as global as its narrowest half. When you add or audit one, assert
> both directions: that a flagged row is excluded, **and** that the flag can be set
> through the real tool for every row class the floor governs.

Corollary for review: a payload tag that is a *claim-admission* concern is
family-agnostic and its write path must be too. Only genuinely
**pipeline-owned columns** (title/body/severity/kind/…) are legitimately
issue-family-scoped — do not let an early column-patch refusal short-circuit an
admission-flag write.
