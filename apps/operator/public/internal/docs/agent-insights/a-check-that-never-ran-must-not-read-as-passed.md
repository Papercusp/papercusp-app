# A check that never ran must not read as PASSED — the release gate shipped five assumed legs
URL: /internal/docs/agent-insights/a-check-that-never-ran-must-not-read-as-passed

green-checkpoint could report GREEN and fast-forward `main` having never run its typecheck, three lint legs, or SPA build. Each leg was gated on the raw SUITE exit code while its `*Ok` flag defaulted to `true`, so a red suite SKIPPED them all and they still read as passed; flake-absorption then flipped the verdict green without re-running or re-checking any of them. Root cause is a shape, not a typo: a boolean meaning 'this check passed' that is initialized to true makes 'never ran' and 'ran and passed' the SAME value, so nothing downstream can tell them apart. The same shape bites at shell scale (`cmd | tail` reports tail's exit code) and at input scale (a bare `catch { return false }` turning a corrupt config into a benign opt-out). Fix: tri-state every leg, and run the checks wherever the success path is entered — not just where it was first written.

## The one-line version

`green-checkpoint` reported **GREEN** — and fast-forwarded `main` — on candidates whose
typecheck, three lint legs, and SPA build had **never executed**. Not failed-and-ignored:
never run, and recorded as passed.

If you are here because you are about to trust a green gate: a green verdict on this
system before 2026-07-26 does **not** prove those five legs ran. See *What to distrust*
at the bottom.

## How a check becomes an assumption

The gate ran its suite, then five post-suite legs. Each leg looked like this
(`green-checkpoint.ts`, pre-fix):

```ts
let typecheckOk = true;                                     // ← defaults to PASSED
if (r.code === 0 && hasNpmScript(treeDir, 'lint:tsc')) {    // ← only runs if the SUITE passed
  const typecheck = await exec('npm', ['run', 'lint:tsc'], { ... });
  typecheckOk = typecheck.code === 0;
}
```

and the verdict ANDed them together:

```ts
let green = r.code === 0 && typecheckOk && lintMigrationsOk && lintIdentityOk
         && lintDesignPrimitivesOk && buildOk;
```

Read on its own, that is fine: if the suite is red, `green` is false anyway, so who cares
what the skipped legs hold?

Then flake-absorption enters. The gate runs on an 8-fork box under fleet load, so a red
suite is often just box-weather. The absorber re-runs each failing file in isolation and,
on positive proof they all pass, flips the verdict:

```ts
if (r.code !== 0 && buildOk) {
  const outcome = await attemptFlakeAbsorption(...);
  if (outcome.absorbedToGreen) {
    green = true;                    // ← the five legs are still at their `true` defaults
    ...                              //   and were never executed
  }
}
```

That `green = true` is the whole bug. The sequence:

1. suite flakes red → **all five legs skip**, keeping their `true` defaults
2. absorber proves the failing files pass in isolation
3. `green = true`
4. `main` fast-forwards

Five checks were not evaluated. They were *assumed*, and the assumption was spelled the
same way as a pass.

**Confirmed instance.** `afdbda332b` made `AgentFact.confidence` a required field without
updating every construction site, putting 4 files above the operator-core tsc baseline.
`main` provably contains it; the checkpoint tree sat at that exact sha with the errors
present. The gate materialised the candidate correctly, and passed it anyway.

## Why it survived so long

Three things hid it, and each is worth recognizing on sight:

* **A skipped leg was byte-identical to a passed one.** Both are `true`. No log line, no
  verdict field, nothing downstream could report the difference — so the failure was
  invisible *in principle*, not merely unnoticed.
* **The absorber was locally correct.** It only ever flips on positive per-file proof and
  is carefully fail-safe. Its blind spot was an assumption about its *caller*: that "suite
  red" was the ONLY reason `green` was false. Reviewing it in isolation finds nothing.
* **It only fires on absorbed runs.** A natively-green candidate takes the correct path.
  The hole opens exactly when the box is loaded — the same condition that makes everyone
  least inclined to look closely at a gate that finally went green.

## The general shape (this is the transferable part)

> **Any boolean meaning "this check passed" must not be initialized to `true`.**
> Initialize to false/unknown, or make it tri-state, so "never ran" is loudly
> distinguishable from "ran and passed".

The corollary is about *where* checks are invoked:

> **When there are several ways to enter the success path, the checks must hang off the
> success path itself — not off the first branch that happened to reach it.**

Here the legs were wired to `r.code === 0` (one route to green) while absorption was a
second, later-added route. Any future third route would have inherited the same hole.

The same disease at two other scales, both encountered the same day:

* **Shell.** `npm run typecheck ... | tail -35` reports **tail's** exit code, not the
  command's — a wrapper reporting its own success as the result. A "COMPLETED exit 0"
  notification was a lie; the real result was `EXIT=1`. Prefer `cmd > log 2>&1` whenever
  you intend to *judge* an exit code.
* **Input.** `hasNpmScript` ends `catch { return false }`, so an unreadable/corrupt
  `package.json` is indistinguishable from a subject hive legitimately opting out of that
  leg — silently disabling every optional leg at once while still reporting green. Filed
  as its own item; the plumbing to name that reason now exists.
* **Empty input set** (2026-08-03, `scout/code-existence-probe.ts`). A prior-art probe
  returned `searched: true` when it could extract **zero** search terms from an idea's
  text — an early return on an empty input set, reporting the success value, having never
  called the backend. Note the direction of the harm: text with no greppable vocabulary
  is precisely where prior art is *hardest* to find, so those items collected the
  **cleanest "nothing found" in the whole backlog**. Now `searched: false` +
  `unavailableReason: '…never called'`.
  How it survived is the instructive part: the author *hit* the behaviour, wrote a
  test comment describing it exactly — *"the lexical leg short-circuits on 'no candidates'
  and returns searched:true having never called the (throwing) backend"* — and used it as
  a reason to reshape the **fixture** rather than the code. A second test asserted
  `called === false` and `searched === true` on consecutive lines. **A comment explaining
  why a fixture must be shaped a particular way to avoid a code path is describing a
  defect in that code path.**

### The observational dual: a probe that could not have seen it

Every case above is a *program* recording an unrun check as a pass. The same shape bites
the **investigator**, and it is the easier one to fall for because there is no code to
blame — you simply looked, saw nothing, and concluded nothing was there.

Same day, mine, and it cost two wrongly-filed work-items plus a false report to two peers.
I inventoried a log-bank directory to decide whether scenario logs were being persisted:

```bash
ls -la ~/.papercusp/live-fed-gate/triage/ | tail -20   # ← only serve-* files came back
```

I read that as absence and filed "scenario logs are never banked". They *were* banked —
had been for seven days. Alphabetically `load-` \< `scn.` \< `serve-`, so `tail -20`
returned the last twenty rows, which were **all** `serve-*`, and hid \~170 `scn.*` files.
The directory held 215 files; I had looked at 20 of them and generalized.

The trap is that a truncated listing and a genuinely empty one are the **same observation** —
exactly `typecheckOk = true` meaning both "passed" and "never ran". Cheap discriminators,
any one of which would have caught it:

* **Count before you conclude.** `ls -1 <dir> | wc -l` against how many rows you actually
  read. `215` vs `20` is the whole story.
* **Never conclude absence from a `head`/`tail`-truncated listing.** Use a prefix histogram
  (`ls -1 | sed 's/[0-9].*//' | sort | uniq -c`) or a targeted glob (`ls -la scn.*`) that
  names the thing whose absence you are claiming.
* **Grep the SOURCE for the feature, not the OUTPUT for its artifacts.** One
  `grep -n 'scn\.\*\.log' lib/*.sh` would have found the implementing block instantly and
  ended the question.
* **Give a negative result a positive control.** Prove the same probe finds something you
  *know* is present. An instrument that cannot find the known cannot testify about the unknown.

"I looked and it wasn't there" is a claim about your instrument as much as about the world.
State which instrument, and why it was capable of seeing the thing.

#### Recurrence, 2026-08-01: the same trap, with the verdict CACHED across a compaction

Identical shape, new instrument — `tsc` output instead of `ls` — and one extra twist that
made it considerably more dangerous. Verifying a change to `apps/operator/lib/mcp-proxy/proxy.ts`
(the connect path for every agent on the box), with `build:typecheck` timing out under fleet
load, I fell back to:

```bash
npx tsc -p apps/operator/tsconfig.json --noEmit | head -25
```

`apps/operator` carries a large pre-existing error backlog, and **tsc emits path-ordered**.
`__tests__/` and `app/_components/` consumed the entire 25-line budget; `lib/mcp-proxy/` sorts
*after* `app/_components/`, so my file could not physically have appeared. Whether the verdict
was trustworthy depended on **alphabetical position relative to an unrelated error backlog** —
which nobody reasons about.

The twist: that truncated observation was then written into a self-authored marker —

```
---TYPECHECK_DONE (no 'mcp-proxy/proxy' lines above = my files are clean)---
```

— which outlived the session that wrote it. A successor (me, post-carry-respawn) inherited
*four* independent "looks fine" signals: a completed run, a DONE marker, a non-empty log, and a
zero-hit grep. Every one of them was worthless, and none of them looked it. A cached bad
inference is worse than a bad observation, because the reasoning that would expose it is gone —
only the conclusion survives.

Note this is the **sibling** of the TS5057 zero-file case the repo already warns about: there,
tsc never ran; here it ran, genuinely checked the file, and genuinely said nothing about it.
The "refuses a zero-file run" guard cannot fire, because the run was not zero-file.

What actually settled it was this section's own last bullet — **give the negative a positive
control**. A scoped `tsc` over the file's own import graph, plus `--listFiles` to prove the
instrument saw the subject: *199 files loaded, `proxy.ts` among them, 67 `@types/node`
resolved*, exit 0. Only then does "no errors" mean anything. (A first attempt at that scoped
config produced 27 errors that were pure artifact — `@types` resolving relative to a config
placed in `/tmp` — a reminder that a *positive* result needs its instrument audited too.)

Tooling gap filed as EI-19297428004790873: `build:typecheck` failing under load is what forced
the hand-rolled pipeline in the first place, and a scoped `{ files: [...] }` mode with a
built-in `--listFiles` assertion would remove the temptation entirely.

## The fix

1. **One function, one trigger.** All five legs hoisted into `runPostSuiteLegs()`, invoked
   whenever the suite is *considered passing* — natively **or** after absorption. An
   absorbed-green candidate now clears exactly the same bar as a natively-green one.
2. **Tri-state.** `LegStatus = 'passed' | 'failed' | 'skipped'` plus a `skipReason`. A
   skipped leg is neither a pass nor a fail: it is the documented subject-hive opt-out, and
   it never contributes evidence of green. `legsNotRun(reason)` is the suite-red state —
   `ok: true` because nothing failed, but every individual status is `skipped`.
3. **`green` is assigned FROM the legs' verdict** post-absorption, never set to a bare
   `true`.

**A second hole, found while implementing.** `runGreen` returns `failingFiles`, which feeds
the stale-candidate re-triage: it re-runs those files at tip and, if they pass, declares the
red **STALE** and re-fires the gate green. On an absorbed suite those files pass *by
definition* — absorption just proved it. So attributing a post-absorption leg failure to the
absorbed test files would have handed a real typecheck/lint/build red a **second** false-green
path straight into `main`, quietly defeating fix #1. Post-absorption the red is now attributed
to the **leg** alone (`signatureOutput = suiteAbsorbed ? legs.output : fullOutput`).

Worth noting as a habit: the first fix was not done until the *downstream consumers* of the
now-changed verdict were checked. A verdict path has more exits than the one you edited.

## Two tests were asserting the bug

`green-checkpoint-real-deps.test.ts` contained, verbatim:

```ts
// exactly the suite + 2 isolation re-runs — no SPA build (the suite started red).
expect(calls).toHaveLength(3);
```

That comment *describes the defect approvingly*. The tests were right about what the code
did and wrong about what it should do — a passing suite is not evidence the behavior is
correct, only that it is unchanged.

They were updated (call counts +2 for the legs now paid, with a comment naming what the old
count meant). Their real contract — `r.green === true`, correct `flakeSuspects` — still passes
untouched, which is what distinguishes a legitimate update from weakening a test to make your
change pass. **If you must change an existing assertion to land a fix, say in the diff why the
old one was wrong.** Otherwise the next reader cannot tell your fix from a cover-up.

The six new tests were written **first** and watched fail: 5 of 6 red pre-fix, with the 6th
(a non-absorbed red must still short-circuit and run no legs — they cost real gate minutes)
green throughout, proving the change was surgical.

## What to distrust

* **"The gate is green" is not proof the typecheck/lint/build legs ran** on any pre-fix run.
  If you are auditing something that reached `main` before 2026-07-26, re-run the legs against
  that sha yourself.
* **Do not "fix" a red gate by disabling flake absorption.** It exists for real 8-fork load
  flakes; removing it trades a false-green for a permanently wedged pipeline.
* **Do not ratchet the tsc baseline to dodge a red.** The baseline is the ratchet; moving it
  is how a real regression becomes permanent.
* **A green gate is a periodic VERDICT, not a live reaction to your commit.** Landing a fix
  does not re-green it — commit, re-run the verdict, then ship. Three separate hops.
* **Distrust your own "I checked and it isn't there"** — including, especially, when it
  arrives as a satisfying discovery. Both times this shape bit me in one session, the false
  reading was the *flattering* one: it made a fix look needed, and made me the one who found
  it. Evidence that hands you a filing, a diagnosis, or credit is exactly the evidence to
  attack hardest, because nobody downstream is positioned to attack it for you.
