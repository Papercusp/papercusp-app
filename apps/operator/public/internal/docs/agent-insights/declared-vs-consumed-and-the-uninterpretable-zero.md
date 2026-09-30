# Auditing reachability: the declared-vs-consumed grep, and why a metric with no producer must say uninterpretable
URL: /internal/docs/agent-insights/declared-vs-consumed-and-the-uninterpretable-zero

Two cheap, reusable probes for the defect class unit tests structurally cannot see — a field that is declared and validated at one end and reached by nothing at the other. (1) A declared-vs-consumed grep is a 3-line, high-yield audit on any registry field: it separated WI-6444's 6 declaration sites + 1 validator from its 0 consumers. (2) A metric whose input plane is empty must report a third verdict — uninterpretable/no-data — never a clean zero, because 'nothing wrote it' and 'we looked at nothing' both render as 0 and mean opposite things. Plus the recursion that keeps biting: a probe nobody runs is the same defect as a producer nobody reads, one level up — all five of this plane's own lints shipped as orphaned npm scripts.

## The defect class

The unified agent-state plane shipped 33 items with **green unit tests** and then
produced **eight defects those tests could not see**. Every one had the same
shape:

> A field, column, or channel that is **declared and validated at one end** and
> **reached by nothing at the other.**

A unit test catches neither half, because *both halves are individually correct
and individually tested*. The defect lives in the **join** between them — and the
join is not expressible in the type system. Half of it exists only in production
data.

Two canonical instances, exact mirror images of each other:

|                                                          | declared                                      | consumed                                  | verdict             |
| -------------------------------------------------------- | --------------------------------------------- | ----------------------------------------- | ------------------- |
| **WI-6444** — `unknownHoist` on `CellSpec`               | 6 cell registrations + 1 validator            | **0 readers**                             | written, never read |
| **WI-6465** — `kind='assumption'`, `depends_on`, `claim` | consumers exist (a detector, a stamp, a read) | **0 producers**, 0 rows of 2,180 all-time | read, never written |

The two probes below are what catch each direction. They are cheap, they are
general to any registry field in this repo, and neither requires new tests.

## Probe 1 — the declared-vs-consumed grep

**The claim, stated honestly: three lines of grep separated WI-6444's 6
declaration sites and 1 validator from its 0 consumers.** As a *discovery* tool
on a field you are suspicious of, that is the whole cost, and the yield is high
enough that it is worth running on any field you are about to add to a shared
type.

```bash
# For a field you just declared — does anything WRITE it, and anything READ it,
# outside the module that declares it and outside tests?
rg -n --type ts '\bunknownHoist\b' -g '!*.test.ts' -g '!_retired/**'
```

Read the hits and ask the two questions separately: *is there a non-test writer?*
and *is there a non-test reader in a different module?* If either answer is no,
you have the WI-6444 shape.

### ⚠ But do NOT promote that grep to a gate unchanged — it is green on WI-6444 for four independent reasons

This is the part that matters, and each reason had to be closed separately in
`scripts/check-declared-consumed.mjs`. A name-only grep that "passes when it finds
hits" is a **vacuous pass**:

1. **A declaration is not a use.** `unknownHoist?: string` inside an interface is
   itself a hit — the gate counts the very declaration whose consumption is in
   question as evidence that it is consumed. Closed structurally: a property
   inside an `interface`/`type` body is a DECLARATION; outside it, a WRITE.
2. **A comment is not a use.** And this is not a nicety — **the single densest
   concentration of a field's name in this codebase is the prose explaining it.**
   An un-stripped sweep is therefore *most* confident exactly where a field is
   best documented and least used.
3. **The declaring module is not a consumer.** `validateCellSpec` reads
   `spec.unknownHoist` twice, in the file that declares it. Count that, and the
   sweep stays green even after you delete the real emission — i.e. it fails to
   re-derive the one bug it exists for. **A type validating its own field proves
   the field is well-formed, never that anyone wants it.**
4. **Retired code is not a consumer.** A read from `_retired/` is a read by
   something deliberately not deployed.

**And a fifth, which is Probe 2 wearing static clothes:** if the field is
*renamed*, its row matches zero declarations. "No reader and no writer" is then
not a defect report — it is the gate describing a target that has **ceased to
exist**. Reporting it as a defect sends someone hunting a consumer for a field
that is gone; reporting it as a pass is a green tick over an unwatched surface.
It needs its own verdict (`not-declared`), like `no-data` below.

## Probe 2 — a metric with no producer must report *uninterpretable*, never zero

**The rule:** when a count's input plane could be empty, a two-verdict
(pass/fail) report is wrong in the most dangerous direction, because **two
completely different situations both render as `0`**:

* **(a) the table holds 170,000 rows and none carry the field** → **NO PRODUCER.**
  A real defect. This is exactly WI-6465.
* **(b) the table is empty** — fresh database, pruned window, new install →
  **NO DATA.** Says nothing whatsoever about the producer.

Collapsing them costs you either way: reporting (b) as a failure trains everyone
to ignore the gate on a fresh box; reporting it as a pass is a **green tick that
means "we looked at nothing."**

So emit **three** verdicts, and make the third neither pass nor fail:

```
4 producing · 0 DEAD · 4 known-unbuilt · 0 no-data
```

`no-data` is `unknown` — reported separately and loudly. This is the same
discipline `cell-contract.ts` applies when it reserves an enumerated unknown
rather than collapsing it into a boolean.

**The payoff is not hypothetical: WI-6465 was findable only because the
measurement module refused to round its zero up to a pass.** A clean `0%`
adoption number would have read as "nobody uses it yet" instead of "this vertical
was never built."

One corollary worth stating, because it is the failure this rule prevents at the
next layer: a metric whose *interpretability* depends on a second, currently-dead
metric must say so. `clarification-rate = 0` is ambiguous **by construction** —
equally consistent with agents having enough context and with agents guessing
instead of asking — and is readable only alongside `acted-on-stale-or-wrong-value`,
which is uninterpretable while `depends_on` has no producer. The honest move is to
record it as blocked, not to treat the zero as a pass.

## The recursion: a probe nobody runs is a producer nobody reads

This is the shape that kept recurring across the whole audit, and it is worth
holding onto because it is self-similar.

The plan that built these probes built **five** of them. When it came time to fold
them into the release gate, a repo-wide grep found **zero references to any of
them outside comments and one test.** All five were **orphaned npm scripts.** The
probes built to catch "declared but never reached" were themselves declared and
never reached.

> **A probe nobody runs is the same defect as a producer nobody reads, one level
> up.** Apply Probe 1 to your own guard: after you add `lint:<thing>` to
> `package.json`, grep for its own name. If the only hits are the definition and
> its docstring, you have built the exact thing you were auditing for.

Three sightings of the same shape in one plan: a plane unreachable by intent, a
layer structurally redundant with the projection agents already used, and the
plane's own guards unwired.

### Where such a check belongs — and why `test:affected` can never host it

A census asks *"did a producer write a row in the last 7 days?"* That is a **state
fact, not a code fact**. It flips pass→fail with an **empty diff**, so no
affected-set selection can ever reach it.

This is one step stronger than the `lint:design-primitives` precedent, which is
merely diff-*independent*; this is diff-**invisible**. **Any check whose input is
live state rather than source belongs in an unconditional gate leg**, never in
affected-test selection. These five run as `legs.lintPlane` in
`apps/operator/lib/release/green-checkpoint.ts` under the signature
`lint:plane-integrity`.

### Two traps when wiring your own guard into a gate

* **A leg that skips an absent script reports green while checking nothing.** The
  gate legitimately skips scripts a subject hive does not define — so a *renamed*
  script leaves the leg passing vacuously: the going-quiet failure the probe
  exists to stop, reintroduced one level up. Assert every gated script actually
  exists in the root `package.json`, and pin test-file lists through
  `scripts/test-files.mjs`, which hard-fails a zero or partial match.
* **⛔ Never add a live-probing check to a CI/gate mapping.**
  `scripts/check-cell-live-matrix.ts` carries a header warning saying exactly this:
  it drives reads against running operators on `:3170`/`:3070`, which the isolated
  checkpoint tree does not have. Gating it would fail every read and **red-pin
  `main` for the entire fleet**. It looks like the natural fifth member of the
  set; it is excluded on purpose and pinned shut by a test.

## Corollary: verify the DENOMINATOR includes the thing you are verifying

The same defect bites the moment you try to check your own work, and it is worth
its own reflex because the green looks completely ordinary.

**A lint that walks `git ls-files` is structurally blind to a brand-new file.**
This doc's own first verification run is the example: both corpus lints reported

```
✓ normative-insight frontmatter valid — 89 normative of 630 agent-insight doc(s).
```

…while this `.mdx` sat on disk **untracked**. `630` was exactly the pre-existing
corpus count. The tick meant *"we checked everything except the file you just
wrote."*

* **Detect it:** compare the reported denominator against
  `git ls-files | grep -cE '<corpus prefix>'`. If they match exactly and your file
  is new, it was not scanned. Confirm with `git ls-files --error-unmatch <path>`.
* **Work around it** — you cannot `git add` here, since git-sync owns commit and
  push: import the lint's own detectors and run them directly on the path (for
  this corpus, `findStaleInsightCitations` / `findNormativeViolations` /
  `isInsightDoc` from `packages/operator-core/lib/content-lint/`), and
  mutation-test them so you know they bite rather than silently matching nothing.
* **Then re-run the real lint** once a git-sync tick lands and confirm the
  denominator **moved** (`630 → 631`). That run is the one that counts.

**The general rule: whenever a check reports a denominator, verify the
denominator contains your change.** A green over a population that excludes it is
a vacuous pass — the same one Probe 2 is about, pointed at your own verification
step.

## Checklist

When you add a field to a registry, a shared type, or any state plane:

1. **Name the producer** — the concrete act that writes it. A field whose
   producer nobody can name is a field nobody owns, which is the condition that
   produced WI-6465. Make `producer` and `why` **required** on any census row.
2. **Run the 3-line grep** for a non-test writer and a non-test reader *in a
   different module*.
3. **If you promote it to a gate**, close all four vacuous passes above, plus the
   renamed-target verdict.
4. **If it counts anything**, give it a third verdict for "no data" and never let
   an empty input render as a clean zero.
5. **Grep for your own guard's name** before calling it done.
6. **Check the denominator** of whatever green you are about to trust — including
   the one you just ran on your own change.

## See also

* `agent-insights/federation-zero-rows-check-write-side-workspace-first` — the
  runtime cousin of Probe 2: *"0 rows is a WRITE-side symptom until proven
  otherwise"*, and *"silence is evidence"* when a healthy consumer logs nothing.
* `agent-insights/zero-tripwires-means-unarmed-not-broken` — the *other*
  direction, and the reason Probe 2 needs three verdicts rather than an inverted
  two: there, a zero is correct-by-design (dormant, not broken). Distinguishing
  "correct zero", "no producer", and "no data" is the whole job.
* Plan `agent-state-plane-verification-2026-07-27` — D-076 (the *vacuous null*: a
  control that suppresses a surface the agent never uses yields zero delta by
  construction, and that zero reads as "no value"), and D-074 (a
  projection-truncated array read as authoritative — the same silent-loss failure,
  committed by the audit itself).
* WI-6527 — a sibling trap in the same family, awaiting its own doc:
  `--disallowedTools` cannot withhold an MCP tool, because `tools:invoke`
  dispatches by name server-side. Its second finding is Probe 2's shape in
  another register: **the observable signature of a deny is byte-identical to
  "never seeded"**, so any test of a deny needs a same-server, same-tier control.
* `agent-insights/pretooluse-updatedinput-evades-deny-patterns` — a different
  mechanism for a related conclusion: a client-side deny pattern is not a
  capability boundary.
