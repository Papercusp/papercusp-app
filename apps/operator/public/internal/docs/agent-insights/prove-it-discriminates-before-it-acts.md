# Prove it discriminates before you let it act: thresholds that cannot separate, selectors that cannot select
URL: /internal/docs/agent-insights/prove-it-discriminates-before-it-acts

Nine instances, four shapes: thresholds that cannot separate, a selector that cannot select, a metric that cannot be nonzero — and a verdict that is computed correctly and then read by nothing. One defect — a decision procedure allowed to ACT (or to stay silent) without anyone checking what it actually does on real data. Why the class is invisible (a decision is not an event; an absence is not a row), and why the proposed watchdog for it walked straight into the same trap.

## The rule

> **A decision procedure must be shown to DISCRIMINATE before it is allowed to ACT.**
>
> Not "does the code run." Not "is the value in range." **Compute what the procedure actually does
> on real data — the live distribution, the live match set — and look at it.** Every instance below
> shipped, and in each one that single check was never performed by anyone.

It has now been found **nine times in this tree, in four shapes** — plus once more in a *proposed fix
for it*, which is the subject of the second-to-last section.

Shapes 1-3 are all one accusation: *the decision procedure is broken.* **Shape 4 is the harder one —
the procedure is correct, and its verdict is read by nothing.** It passes every audit the first three
demand. Add step 8 to your checklist and it takes ten seconds to find: **grep for the caller.**

## Shape 1 — a THRESHOLD that cannot SEPARATE

See [a-score-is-not-a-similarity](/internal/docs/agent-insights/a-score-is-not-a-similarity) for the
full chain (EI-10372, EI-10544, EI-10562). Compressed:

| consumer                                           | the check nobody ran                                    | what it did                                                     |
| -------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------- |
| `orient.ts` floor 0.05 to ADMIT                    | ceiling of an RRF score is `2/61 ≈ 0.033`               | admitted **nothing** — every agent's recall fold silently empty |
| `write-journal.ts` / `remember.ts` 0.9 to SUPPRESS | same ceiling, \~27× below the threshold                 | suppressed **nothing** — dedup guard was unreachable dead code  |
| `declare.ts` 0.05 to REFUSE                        | `0.6·cosine ≥ 0.05` ⇒ `cosine ≥ 0.083`, the noise floor | refused **100%** of new datatype declarations                   |

The last one is the sharp one, because the quantity *was* a genuine metric — a real cosine on 0..1.
Being a metric was not enough. **It has to separate at the decision boundary**, and it didn't: the
one true near-duplicate (`bet`/`wager`, 0.752) sits 0.04 from a genuinely distinct pair
(`bet`/`forecast`, 0.710). The bands touch, so no constant exists, so **recalibrating would have
been the same mistake one rung up.** The decision *procedure* had to change, not the number.

## Shape 2 — a SELECTOR that cannot SELECT (EI-10593)

`checkpoint-harvest.ts` propagates refutations: an insight that reads as walking back a claim
(`refuted` / `ruled out` / `dead end` / …) flags every **prior observation carrying the same `ref`**
with a destructive `⚠ REFUTED — ` title prefix.

That is sound only if `ref` **identifies a claim**. But `ref` was overloaded, and nobody noticed the
two meanings are not interchangeable:

* `wi:WI-4070` — a **claim ref**. Two rows sharing it are two statements about the same subject.
* `loop:checkpoint` — a **source tag**. Every agent's every checkpoint carries it. It says where the
  insight came from and *nothing whatsoever about what it is about*.

Join on the source tag and the "same-ref" test is **vacuously true**. Measured live:

* 525 harvested observations, 69 authors. **393 carry `loop:checkpoint`.**
* **All 40 refutation flags ever applied went through it.** The `wi:<id>` path the feature was
  designed for had fired **zero** times.
* **All 40 were applied by an agent other than the author** — 11 victims, 2 flaggers.
* The 8 most recent all share ONE refutation note, stamped onto observations about the re-triage
  classifier, orient's monitor-mode scoping, the pnpm hijack, the green-checkpoint suite, a Rust
  change. None related to each other, let alone to the refutation.
* Two of the flagged rows read `⚠ REFUTED — [verified] …`. One read
  `⚠ REFUTED — No new insight this wake — confirms prior diagnosis holds.`

A join key with **no entropy** is not a filter. It is a `SELECT *` wearing a `WHERE` clause.

## The two rules that fall out

> **1. A mechanism that cannot be CERTAIN must ADVISE, not ACT.**
> Certainty gets a gate; uncertainty gets advice. `declare.ts` now refuses only on an exact
> canonical-slug collision (set membership — no threshold, no false positives) and demotes the
> fuzzy case to an advisory `related[]`. A false negative costs a nudge. A false positive costs the
> gate itself: `declare.ts`'s refusals taught every caller to pass `force: true`, so its realized
> value was *negative* — 7 legitimate declarations refused, 0 duplicates caught.

> **2. The more DESTRUCTIVE and further-REACHING the action, the more discrimination it must prove.**
> Refutation propagation is a destructive write (it rewrites a title), it is **cross-agent** (it
> rewrites *someone else's* record), and it is **unattended**. That is the maximum-stakes cell of the
> table, and it was authorized by an unvalidated string equality. The fix is an **allowlist**
> (`isClaimIdentifyingRef`): a ref shape we cannot read as a claim propagates nothing. An
> unrecognized ref must never authorize a destructive write just by being unrecognized.

## Mocking a selector cannot reveal a selector that does not select

The refutation path **had a test**, and the test asserted the bug was correct:

```ts
expect(deps.findByRef).toHaveBeenCalledWith('loop:checkpoint', 'papercusp');
```

It mocked `findByRef` to return one perfectly on-topic prior row. The mock handed the code a
*pre-filtered, topically relevant* target set — exactly what the real query can never do. So the
test proved the **plumbing** and was structurally blind to the **selection**. It passed for as long
as the bug existed, and it would have kept passing forever.

> Assert the **decision** ("does it propagate at all?"), never the call. If your test supplies the
> selector's output, your test has assumed away the only thing worth testing.

## Shape 3 — a METRIC that cannot be NONZERO (EI-10607)

Found by asking the obvious follow-up to Shape 2: *what else decides on a key nobody validated?*

The su IDEATE contract tells every agent to close each pass as a loop — GROUND on
`blender:ideation-feedback`, run the pass, FILE — and `observationsImpact` promises to show the
payoff: "which of YOUR observations became patterns → ideas → shipped."

The final link had **no writer**. `observation-impact-leg.ts` counts an idea as grounded iff its
`addresses_pattern_refs` overlaps a citing pattern's ref. But `improvements:capture` recorded the
ledger row without that field, `blender:route-idea` didn't accept it, and only Scout's *internal*
router ever set it. **No su-reachable verb could write the column the reader joins on.**

| origin      | routed ideas | grounded on a pattern |
| ----------- | ------------ | --------------------- |
| `scout`     | 24           | **24 (100%)**         |
| `su-ideate` | 122          | **0 (0%)**            |

So `ideasGrounded` and `shipped` were pinned at zero for every su agent, forever, regardless of how
good their observations were. And a pinned zero is indistinguishable from an honest one: it reads as
*"no impact yet"*, so nobody investigates.

> **Before you ship a metric, prove it CAN move.** A funnel stage no writer can populate is not a
> measurement, it is a decoration. The test that matters is not "does the metric compute" — it is
> "**construct the input that should make it nonzero, and check that it does.**"

The guard for this one therefore asserts the *outcome*, not the call: feed
`computeObservationsImpact` the ledger row that `capture` **actually writes** and assert
`ideasGrounded: 1`; feed it the pre-fix row and assert `0`. A test that only checked
"`recordRoutedIdea` was called with the field" would have pinned the plumbing and still told us
nothing about whether the funnel could ever report a nonzero — the same blindness as Shape 2's mock.

## Shape 4 — a VERDICT that nothing READS (EI-10625, EI-10660)

Shapes 1-3 are all the same accusation: *the decision procedure is broken.* Shape 4 is the one that
took longest to see, because the decision procedure is **perfect**.

The memory recall-blackout canary (EI-10047) was built to detect exactly one thing: the memory
system going dark. It **never ran — not once — in its entire life.** Zero routine rows, zero runs,
on a live store of 10,491 memories. Not because anything failed. Because adding a loop to
`LEARNING_SINGLETONS` **does not schedule it**: the materializer had exactly one caller, a one-shot
platform-mode enablement. Registering a loop *looked* complete — list entry, blueprint, feature
flag, database tables, health-panel line, all present and correct — and the one step that makes it
RUN was a CLI somebody had to remember to re-run. Its sibling `memory-precision` has a routine row
only because someone happened to re-run that CLI on 2026-06-30. The canary was added afterwards.
Nobody re-ran anything. It was **dead on arrival, silently.**

And here is the part that matters. **The system knew.** `computeLearningLoopHealth` classified the
canary as `absent` — correctly, on every single call, for its entire life. The verdict was right,
it was computed, and then:

```ts
(r.status === 'absent' && r.alwaysOn) ||   // ← the canary is a frontier loop: alwaysOn === false
```

...`summarizeLearningLoopHealth` dropped it from `needsAttention`, the only field anyone reads. **A
loop that was merely LATE demanded attention. A loop that DID NOT EXIST did not.** The classifier
never lied. Nobody asked it.

The same session turned up a third instance one level up: `validateActiveRoutines` (EI-10660) — the
recurrence guard for exactly this family of drift — was **dead code with zero callers**, and its own
docstring said *"Called by: the health-check loop (every 30-60s), the startup validation (on boot)."*
Both claims were false; `service-health.ts` is not even a loop, so the caller it named could not have
existed. It had never executed, with four green unit tests to its name. A guard that documents
callers it does not have is worse than no guard: **it retires the very suspicion that would find the
gap.** (Now wired into `host-bootstrap.ts` beside its two siblings, and the docstring's periodic
claim is deleted rather than retro-justified — do not describe a caller you have not grepped for.)

> **A CORRECT VERDICT THAT NOTHING READS IS NOT A CHECK. A CHECK THAT NOTHING CALLS IS NOT A CHECK.**

This shape is invisible to every audit in Shapes 1-3, because it passes all of them. The threshold
separates. The selector selects. The metric can move. The tests are green, and they are *right*. The
output just goes nowhere — and nothing anywhere reports an error, because **nothing went wrong.**

Two rules fall out, and they are cheap:

1. **`rg` for the caller before you trust the guard.** A detector's test proves the detector works;
   it says nothing about whether it runs. These are different questions and only one of them is
   usually asked. Do not trust a `Called by:` comment — comments are aspirations that were true when
   someone hoped them.
2. **Absence is the most severe state, not the most excusable.** Every one of these bugs hinges on
   the same inversion: a thing that *does not exist* is quieter than a thing that is *broken*. A
   never-ran monitor renders `n/a`. A dead pipeline computes a perfect `0%` (`zeroHit/recalls` with a
   `: 0` fallback — see the fix in `memoryStatus`). A missing routine row cannot be found by any
   check that iterates the rows it has. **You cannot find a missing row by looking at the rows you
   have** — the only way to see an absence is to diff against the DECLARATION.

### How you guard against Shape 4: test the CALL SITE, not just the check

The unit test is the wrong instrument here and no amount of it helps. Ask what a per-module suite can
actually see: it imports the function and asserts on what it returns. **A green unit test proves a
check WORKS. It can never prove the check RUNS** — those are different questions, and only the first
one is ever asked. `validateActiveRoutines` had four green tests and zero callers, and there is no
test you could have added *to that file* that would have noticed.

So the guard has to live where the wiring does. `host-bootstrap.startup-guards.test.ts` asserts the
boot file calls each of the three startup guards by name — crude, and it fails the instant a call
site is deleted, which is the regression that went unnoticed for months. Prove such a test
discriminates the same way you would any other: run it against the tree from *before* the fix. Ours
fails on the real 2026-07-06 `host-bootstrap.ts` for exactly the two guards that were unwired and
passes for the one that was. **A wiring test that passes on the broken tree is itself a Shape-4
defect** — a check whose verdict nobody can act on, which is where you came in.

## The audit — run this on anything that thresholds or joins before it acts

1. **What scale / what key?** Get it from the CODE, not the field name. `score` is a name, not a
   contract; `ref` is a name, not an identity.
2. **Compute the ceiling (thresholds) or the match count (selectors), on live data.** One query.
   `SELECT count(*) … WHERE <your selector>` — if it returns 393 rows and you expected 1, stop.
3. **Demand SEPARATION before a threshold may refuse.** Score the real positives and the real
   negatives. If the bands touch, no constant exists — the procedure must change, not the number.
4. **Demand ENTROPY before a selector may write.** If every row shares the key, the key is a
   source tag, not an identity. Allowlist what may act; fail closed on the unrecognized.
5. **Ask what the other side does when the branch never fires** — a threshold above the ceiling
   admits nothing *or* suppresses nothing depending only on the comparison direction, and both are
   invisible.
6. **Prove the metric CAN move.** If it is a funnel/join metric, construct the input that should
   make it nonzero and assert that it does. A stage with no writer reports a perfect, honest-looking
   zero forever (EI-10607).
7. **Then sweep every other consumer of the same field.** Each was written against the semantics
   that field had *when it was written*, and nothing stops the producer changing them underneath.
8. **Grep for the CALLER.** A green test proves the check works, never that it runs. `rg` the
   function name repo-wide: if the only hits are its own test file, it is decoration (EI-10660).
   Ignore `Called by:` comments — verify them.
9. **Ask what happens when the thing is ABSENT, not just wrong.** Absence is the state every one of
   these bugs hides in: no observations render as a passing `0%`, a never-ran monitor renders `n/a`,
   a missing row is invisible to any check that iterates rows. If your detector enumerates what
   exists, it is structurally blind to what does not — **diff against the declaration instead**
   (EI-10625).

## Why the whole class is invisible: a DECISION is not an EVENT

The obvious follow-up to six instances is *"why does nobody catch these?"* — and the obvious answer,
*"add a watchdog for degenerate gates,"* was filed as EI-10609: alert on any gate whose live
fire-rate is \~0% or \~100% in `tool_invocations`. It came with a pre-registered kill criterion, and
**the cheap experiment killed it.** Over 30d, n=208 tools with ≥20 calls:

| gate (known BROKEN)                                       | calls | refusals recorded | reads as       |
| --------------------------------------------------------- | ----- | ----------------- | -------------- |
| `meta:define-datatype` — refuses **100%** of declarations | 17    | **0**             | 0.0%, flawless |
| `coord:orient` — admits **nothing**                       | 3877  | 25                | 0.6%, healthy  |
| `memory:remember` — suppresses **nothing**                | 572   | 131               | normal         |
| `loop:checkpoint` — destroyed **40** records              | 4365  | 61                | 1.4%, healthy  |
| `improvements:capture` — metric pinned at **0**           | 2778  | 226               | normal         |

**Zero of five true positives.** The only gate at a 100% fire-rate was `chat:ask_choice` (85/85) — a
healthy ask-the-human tool — and \~0% turned out to be the *modal* value: 82 of 208 tools sit at
exactly zero. The detector had a 100% false-negative rate and its one hit was a false positive.

`meta:define-datatype` is the refutation in a single line: the gate we *proved* refuses 100% of
declarations records **zero refusals**, because its refusal is a **soft verdict inside an `ok`
payload**.

> **A gate's DECISION is not an event.** `tool_invocations` records what the tool *returned*, never
> what it *decided* on the way there. Every instance in this doc is an internal admit / suppress /
> refuse / propagate / count that leaves **no trace at all**. `error_code` is a *proxy* for the
> decision — and the proxy is uncorrelated with it.

That is the real reason this class is only ever found by hand: **there is nothing to look at.** The
fix is not to mine the existing telemetry harder, it is to **emit the decision** (`gate`, `verdict`,
the compared `value`, the `threshold`). Filed as EI-10619 under the constraint-removal lens, and
**shipped** — `harness_shared.gate_decisions`, with the memory recall gates wired to emit and a
`gates:degenerate-check` reader. But the detection rule took two wrong turns before it was sound, and
both are the class biting the fix again.

### The detector's rule is `expect`, not `max(value) < threshold` (EI-10619, shipped)

The filing said `max(value) < threshold` would be a *proof* of an unreachable branch. **It is not** —
it is Shape 1 one more rung up, and it fails identically to EI-10609. A *healthy* gate is routinely
one-sided:

| gate                                | verdicts    | threshold vs value range | healthy?    |
| ----------------------------------- | ----------- | ------------------------ | ----------- |
| orient's relevance floor (EI-10372) | 100% reject | above the whole range    | **BROKEN**  |
| a rate limiter under normal traffic | 100% pass   | above the whole range    | **HEALTHY** |
| an auth check every caller passes   | 100% pass   | —                        | **HEALTHY** |

A broken discriminator and a healthy limit-that-never-trips are **observationally identical** over
`(verdict, value, threshold)`. No statistic over those columns separates them, because the separating
fact is not in the data — it is *what the gate is for*. So the gate **declares** it: `expect:
'discriminates'` (one-sided ⇒ a defect) vs `expect: 'guards'` (never firing ⇒ the healthy case). The
detector applies its rule only to `discriminates`. `value`/`threshold` stop being the detection and
become the **explanation** — which direction, and by how far off-scale (the *margin* is the proof).

> **You cannot infer a gate's intent from its behaviour; a monitor that tries is guessing.** This is
> Rule (b) one level up — you cannot find a missing row by looking at the rows you have, and you
> cannot find a *mis-scaled* gate by looking at its outputs. Diff against the **declaration**: make
> the gate state what it is for, then check the behaviour against that. Unlike the docstring lie of
> EI-10660, the declaration is *checked* — a `guards` gate that fires constantly is surfaced as
> mis-declared — so it is a claim with a feedback loop, not a comment nobody tests.

And this was, once again, the same instinct: reaching for a *threshold* (`max(value) < threshold`)
where what was needed was a check that the decision **separates at all**. Fourth time in the same
three days — and this time the bug was inside the fix *for* the class, caught only because the
discrimination test carried a negative fixture (a healthy `guards` gate that never fires) and the
`expect`-is-load-bearing test asserted the detector goes blind when intent is stripped.

## The trap is recursive — the proposed fix walked into it

EI-10609 proposed to **ACT** (page a human) on a discriminator — fire-rate — that **nobody had shown
could SEPARATE.** That is Shape 1, exactly, one rung up: a threshold applied to a quantity whose
distribution on real data had never been computed.

It was filed by the same agent, in the same session, that wrote this document.

> **Knowing the rule does not exempt you from it.** The instinct that produces the bug — *"this
> quantity obviously separates, I don't need to check"* — is the same instinct whether you are
> writing the gate or writing the gate's watchdog. The only thing that saved EI-10609 from shipping
> as a false-positive generator was that it carried a **falsification criterion it could not wriggle
> out of**, and that the criterion was **run before any code was written**.
>
> Write the kill condition into the idea *at filing time*, when you are not yet invested in it. Then
> run it first.

### …and it was still lying in wait in the FIX (EI-10666)

The remedy for "a gate's decision is not an event" is **measure at the consumer**: the memory recall
canary was counting a zero-hit as *"the backend returned no rows"* (`top.length === 0`), which scores
a HIT whenever a healthy retrieval is discarded downstream — it would have reported GREEN straight
through EI-10372, where the backend returned 5 rows and orient's relevance floor dropped all 5. So
the canary now runs its results through the **same admission gates orient runs**, from one shared
module (`lib/memory/recall-admission.ts`), and alarms on what a consumer *received*.

The obvious way to write that is to apply the relevance floor to the canary's hits. **That would
re-create EI-10372 inside the canary.** The floor is `0.05`; a *healthy* hybrid response returns RRF
scores on the 0.01–0.03 band (rank-1 both-legs ≈ 0.0328 — a strong hit). An unconditional floor
discards every healthy hit, so the monitor built to detect the blackout would itself black out — and
alarm forever, on a system that was fine. The floor is only correct **inside the degraded regime it
was written for**, which is why it is regime-scoped in `orient` and why the canary has to carry the
same scoping (`degradedRegime`, defaulting to healthy — never invent a degradation).

> **A gate copied without its regime is a different gate.** When you instrument a decision, you have
> to model the *conditions* under which it fires, not just the comparison it makes. Half a gate in a
> monitor is not a monitor — it is the original bug with a pager attached.

The general rule this leaves behind: the probe must call **the same code the consumer calls**, not a
faithful-looking copy of it. A re-implemented pipeline drifts from the real one, and a canary that
drifts goes green while production goes dark — which is Shape 4 again, wearing the costume of a fix.

## The meta-lesson, now earned three separate ways

EI-10372 diagnosed the score-scale class **in its own bug body** and called for a follow-up. The
follow-up was never filed; two more live instances sat there. EI-10521 carried a comment diagnosing a
bug that then shipped twice more *five lines below the comment*.

> **A diagnosis is not a guard. Prose does not prevent recurrence — only an executable check does.**
> When you fix an instance and can name the class, **sweep the class in the same session**. The sweep
> is the deliverable, not the fix.

Both fixes in this doc were found *by running the sweep the previous one demanded* — EI-10562 by
grepping every score comparison, EI-10593 by asking what else decides-and-acts on an unvalidated
key. And in **both**, the new tests immediately caught a bug in the fix itself (`status` → `statu`
breaking plural collision; a dropped type narrowing). Write the guard, not the comment: the guard
finds *your* bug too.
