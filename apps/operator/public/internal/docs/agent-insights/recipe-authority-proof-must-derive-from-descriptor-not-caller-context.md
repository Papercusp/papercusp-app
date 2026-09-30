# Recipe authority proofs: derive context from the script's own refs, never echo caller context
URL: /internal/docs/agent-insights/recipe-authority-proof-must-derive-from-descriptor-not-caller-context

EI-21163571260786543: buildRecipeAuthorityRecommendation echoed the caller's live/supplied context into the returned proof, so an unbound (or under-detected) recipe could be recommended with a proof that falsely advertised binding to the caller's own lane. Also: static call-arg analysis cannot fold a `const X = 'literal'; foo({key: X})` reference back to its literal value — only a whole-script text scan can.

## What happened

`recipes:search` recommended `goal-mode-e2e-post-boundary-activity-rubric-authorship-histogram-for-subject` — a
recipe whose script hardcoded ONE grading run's agent id and time window into a
`sessions:timeline({ owner: SUBJ, since })` call — with an authority proof whose `context` showed the
**current caller's own live subject and harness**. `recipes:get` showed the actual script still froze a
completely different agent id and a months-old window. Running the advertised `runArgs` would have silently
queried the wrong agent's history under a stale time boundary, while looking exactly like a proof scoped to
the caller's own lane.

## Root cause 1 (the fix): proof.context echoed the caller, not the recipe

`buildRecipeAuthorityRecommendation` built the returned proof like this:

```ts
context: normalizeRecipeAuthorityContext(resolveOperatorScopeLane(descriptor, input.context)),
```

`input.context` is the **caller's own live/supplied context** — `recipes:search` always populates it with the
caller's live workspace/fleet/harness, and a caller may add its own `items`/`resources` too (e.g. "recipes
relevant to my current goal subject"). The match check above it (`recipeAuthorityMatches(descriptor,
input.context, …)`) only requires `input.context` to be a **superset** of what the descriptor actually needs
(`hasAll(descriptor.refs.items, callerItems)`, etc.) — so a recipe with FEWER (or zero) bound identities than
the caller happened to supply still passed the match check, and then had the caller's *extra*, unrelated
dimensions echoed straight into the "proof" as if the recipe were bound to them.

For a `descriptor.bound === false` recipe (no recognized identity in its script at all) this is worst-case: the
proof claimed a binding that was **entirely fabricated** from the caller's own session, while the script's real
identity (frozen inside the script, invisible to the authority model) was completely different.

**The fix**: build `proof.context` from `recipeAuthorityContextFromRefs(descriptor.refs)` — the recipe's own
bound refs — never from `input.context`. This function already existed and was already used correctly on the
`recipes:get` → `recipes:run` (authority-metadata) path; `recipes:search`'s recommendation path was the one
place that deviated. For an unbound recipe this now returns `{}`, so a context-free recipe is recommended
truthfully (no fabricated binding) instead of looking scoped to whichever caller happened to search for it.
This also subsumed and removed the `resolveOperatorScopeLane` special case (rewriting a caller-carried `'*'`
harness sentinel) — the harness value is now always read from `descriptor.refs.harnesses`, so the sentinel
is never echoed into a stored proof in the first place.

**The generalizable lesson**: when a "proof"/"recommendation"/"binding" object is built from *both* a subject
(here: the recipe script) *and* a context (here: the caller's session), always derive the returned artifact's
claimed scope from what was **verified about the subject**, never from the raw context that merely had to be
*compatible* with it. A pass/fail match check is not the same operation as "compute what this thing is bound
to" — conflating them lets an under-specified subject silently inherit the checker's context.

## Root cause 2 (a detection gap, left open — not itself "fixed" here)

The specific script's `owner: SUBJ` literal (`su-<uuid>`) happened to already be caught by
`findVolatileCoordinationOwnerId` — a **whole-script text regex scan** for the `su-` id shape, unrelated to
call-argument inspection. That check exists at all only because of a *different*, earlier fix (landed after
the sha this bug was originally observed against). It does **not** generalize: the exact same script shape
with a non-`su-`-prefixed frozen agent id (e.g. a different agent-kind prefix, or an opaque session id) sails
through every existing detector as `unresolved: false, bound: false` — confirmed live via a repro test. Root
cause 1's fix closes the *advertisement* half of that gap (such a script can no longer be falsely shown as
bound to the caller's lane), but the descriptor still can't structurally recognize "this script depends on ONE
specific historical agent identity" for an arbitrary id shape. Widening detection further (e.g. a namespace-
agnostic `owner`/`assignee`-keyed check) is a separate, larger change with real false-positive risk across the
tool catalog and was deliberately left out of this fix's self-inline scope.

## A parser limitation worth knowing if you touch this area

`@papercusp/tooldef`'s static call-arg reader (`readStaticValue` in `parse-check.ts`) resolves literal
expressions (string/number/boolean/null/array-literal/object-literal) directly in a call's arguments — it does
**not** fold a bare identifier back to a `const` declared elsewhere in the script. So:

```ts
const SUBJ = 'su-6e9985dd-...';
await tools.sessions.timeline({ owner: SUBJ, since: '...' });
```

`collectArgs`/`inspectCall` (which work over the call's *parsed args object*) never see `owner` at all — the
property is dropped as unresolvable, and the call is marked `dynamicArgs: true`. Any KEY-based authority check
(like `VOLATILE_COORDINATION_ARG_KEYS`) is therefore blind to this exact, extremely common recipe-authoring
pattern (hoisting a frozen identity into a named `const` for readability). Only a **script-text-level** scan
(like `findVolatileCoordinationOwnerId` / `findVolatileRunArtifactLiteral`) can see it, because it operates on
the raw source rather than the parsed call graph. Keep this in mind before assuming a `collectArgs`/`inspectCall`
key-set addition will catch a hoisted-`const` variant of the pattern it's meant to guard.

## Where to look

* `packages/operator-core/lib/recipe-authority.ts` — `buildRecipeAuthorityRecommendation`,
  `recipeAuthorityContextFromRefs`, `findVolatileCoordinationOwnerId`.
* `packages/operator-core/lib/recipe-authority.test.ts` — the EI-21163571260786543 regression tests (both the
  su-id case and the general non-catchable-identity case).
* `libs/generic/tooldef/src/code-orchestration/parse-check.ts` — `readStaticValue` (the identifier-folding gap).
