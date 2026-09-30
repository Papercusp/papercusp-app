# A plan's body + template_data must be ONE atomic withPlanLock write — two sequential lock transactions leave a half-state (EI-11070)
URL: /internal/docs/agent-insights/plan-body-plus-template-data-need-one-atomic-withplanlock-write

proposeRubric wrote the plan body in one withPlanLock transaction and the validated template_data jsonb in a SECOND — non-atomic: a crash or busy advisory lock on the second write (heavily-parallel fleet) after the first committed left a fresh body/status with STALE template_data, while the caller still reported ok. withPlanLock already supports the combined form (newBody + templateData in one mutator return, as ratifyRubric uses). Also: the confidently-filed root cause (a null first-arg 'store') was WRONG — that arg is intentionally unused.

## What

A `template: rubric` plan carries its narrative in the **body** (`content` column,
frontmatter → title/status/template) and its structured fields (criteria, ratingScale,
methodRef, description, proposedBy/ratifiedBy) in the **`template_data`** jsonb column.
`proposeRubric` used to persist these in **two separate `withPlanLock` transactions**:

1. Write 1 — upsert the body (mutator ignores `current`, always returns `newBody`).
2. Write 2 — a structured-only `template_data` write (`newBody: null`), whose mutator
   **gated on `current === null`** and, on that branch, returned `{ newBody: null, value: false }`.

Reported symptom (EI-11070): `rubrics:propose` returned `ok: true` and echoed the full
new rubric, but the DB row kept its **stale** criteria / rating-scale / description while
`status` + `updated_at` **did** change. i.e. Write 1 landed, Write 2 didn't.

## Why it's a bug

The two-write split is **non-atomic**. Write 1 commits its own transaction *before*
Write 2 begins. On this heavily-parallel fleet, Write 2 can hit a **busy advisory lock**
(another writer on the same plan) and throw — *after* the body already committed — leaving
a fresh body/status with **stale template\_data**. That is exactly the reported half-state.
Write 2's `current === null` branch was additionally a **silent no-op**: it returned
`value: false`, which `proposeRubric` ignored, so a "wrote nothing" outcome was reported as
success — the same silent-persist-failure class as the memory/telemetry bugs found the same
week.

**The confidently-filed root cause was WRONG — reproduce before trusting it.** The original
EI-11070 hypothesis blamed `proposeRubric` passing `null` as `withPlanLock`'s first argument
(the "store/ctx"). That argument is **intentionally unused** (`_ctx` in `with-plan-lock.ts` —
the PG advisory lock needs no identity), so `null` vs a real `ctx` changes nothing. And on a
re-propose the row already exists, so Write 2's `current` is non-null and the skip branch
**cannot fire**. The symptom did not reproduce in a fresh testcontainer *or* live on `:3070`.
Don't carry a plausible-but-unverified root cause into a fix — reproduce, or say plainly you
couldn't.

## The fix / the rule

**A logical write that spans the body AND `template_data` must be ONE atomic `withPlanLock`
call.** `withPlanLock` already supports the combined form: return
`{ newBody, templateData: { data }, value }` from a single mutator and it writes both in the
same locked transaction with **one** version bump (see the `writesTemplateData && (cur || newBody !== null)`
path). `ratifyRubric` already does this (flips frontmatter status AND stamps `ratifiedBy`
atomically). `proposeRubric` now does too:

```ts
const result = await withPlanLock<true>(
  null,
  { slug: input.rubricId, intent: `rubrics:propose ${input.rubricId}`, ...scope },
  async () => ({ newBody: body, templateData: { data: templateData }, value: true }),
);
```

With `newBody` non-null the `template_data` guard passes unconditionally, so it can never lag
the body, and there is no `current === null` skip branch to silently no-op through.

**Regression signature = the version bump count.** A fresh propose is now a **single** bump
(version `1`); a re-propose bumps by exactly `1` (→ `2`). The old two-write split bumped by
**2** each time (body, then a separate template\_data write → `2` and `4`). The regression test
`re-propose PERSISTS changed template_data (EI-11070 regression)` asserts both the raw
`template_data` jsonb changed *and* the single-bump count, so a regression back to the split
form fails loudly.

## Generalize

Any time a durable record has two facets that must move together (a body column + a jsonb
sidecar, two columns with an invariant between them), write them in **one** locked
transaction — never "write A, then write B" across two lock acquisitions. Two acquisitions =
two commit points = a window where a throw/busy leaves the record half-updated. If your
lock/upsert helper offers a combined form, use it; if it doesn't, that's the feature to add,
not a second transaction.
