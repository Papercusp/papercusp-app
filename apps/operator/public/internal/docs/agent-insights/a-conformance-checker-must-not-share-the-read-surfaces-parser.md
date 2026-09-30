# A conformance checker must not be built on the read surface's parser
URL: /internal/docs/agent-insights/a-conformance-checker-must-not-share-the-read-surfaces-parser

A reader's parser is deliberately lossy — it drops the fields it cannot make sense of, because inventing a verdict from an unreadable field is the worse failure. That is exactly inverted for a lint, whose whole job is to FIND those fields. Reuse the parser and the checker reports a clean corpus precisely for the defect class it exists to catch. Measured on OKF frontmatter, with the falsifiability controls that keep it fixed.

## The one-line version

**Reuse-first is right, and it has one specific exception: a conformance checker must
read the RAW input, never the normalised view its read surface produces.** Sharing that
parser does not merely weaken the checker — it inverts its meaning, and it does so
silently, in the one direction that looks like success.

## Why a reader's parser is the wrong substrate

A read surface's parser is lossy **on purpose**. Given a malformed field it drops the
field rather than guessing, because a reader that invents a verdict from input it cannot
understand is worse than a reader that reports nothing. That is a correct and deliberate
design choice.

A conformance checker's job is the exact opposite: those dropped fields *are* its
findings. Point it at the normalised view and every violation has already been swept out
of the input before the rules run. The checker then reports a clean corpus — confidently,
with a real denominator and a real 0 — **precisely for the defect class it was built to
catch**.

Note the failure direction. It never errors, never returns empty, never looks broken. It
returns the most reassuring possible result, so nothing prompts you to look again.

## The measurement (OKF frontmatter, 2026-08-08)

`parseOkfFrontmatter` in `packages/docs-engine/src/okf.ts` normalises OKF v0.2
trust/staleness frontmatter for `docs:get` / `docs:search`. Two of its lossy behaviours
are the ones a conformance lint must see:

* a `verified` entry with no `by` is **dropped from the list**;
* a `stale_after` the normaliser refuses **never reaches the date parser at all**.

Measured in the detector's own tests: a two-entry `verified` list whose second entry
lacks `by` normalises to **length 1** — structurally indistinguishable downstream from a
conformant single-entry doc. So a lint built on the normalised view would pass that doc,
and the doc would keep rendering to every agent as legitimately human-verified. The
missing attribution — the entire point of requiring `by` — is invisible at exactly the
layer meant to police it.

## What to do instead

**Read the raw structure, and reuse the shared parser only where its judgement IS the
property under test.**

For OKF that meant extracting and exporting `parseFrontmatterBlock()` from `okf.ts` — the
raw YAML mapping, one regex for the whole module — and having
`packages/docs-engine/src/okf-conformance.ts` read *that*. `evaluateOkfTrust` is still
reused, but only for the one rule where the question genuinely is "does the real
evaluator accept this date?".

That is the discriminator worth carrying: **reuse where reuse is HONEST.** Ask whether
the shared component's judgement is the thing you are testing, or merely upstream of it.
Upstream is where the silence gets introduced.

## Pin it, or it will be simplified back

This is an attractive nuisance for a future cleanup: two parsers over the same bytes reads
as duplication, and collapsing them is a natural-looking refactor whose only symptom is a
lint that stops finding things.

Three test cases in `okf-conformance.test.ts` exist solely to fail if the rules are
re-routed through the normaliser — each constructs input the raw reader sees and the
normalised view does not. A comment saying "don't use the normaliser here" would not have
survived; a red test does.

Pair them with a **calibration case** the real subject must pass. Controls that only ever
assert failure can all pass while the property itself is broken.

## The sibling trap: a standalone-script guard and the router's skip

Worth knowing at the same time, because it bit the same work item.

`REPO_WIDE_INVARIANT_GUARDS` in `scripts/affected-tests.mjs` attaches a narrow guard task
when a matching path changes anywhere — and deliberately **SKIPS** it when the guard's
host workspace is independently affected, on the assumption that workspace's suite
already contains the check.

That assumption holds for a guard that IS a vitest file (`lint:chunk-safe`). It is
**false for a standalone script**: nothing in the suite runs it. So a script-shaped guard
needs BOTH the router entry and an in-suite ratchet, or it silently stops covering
precisely the changes that touch its host workspace.

For OKF that uncovered half would have been the knowledge-pack corpus, which is written
by CODE — the half that can regress with no author involved and therefore the half least
likely to be noticed.

## The general shape

Both halves are one class: **a check that has quietly stopped checking still reports
green.** Absence of findings is evidence only once you have established the check can
still produce one.

Two habits close most of it:

* **Report the denominator, not just the offender count.** `0 offenders` and
  `0 offenders / 659 judged` look alike and mean different things. A denominator that
  moves when you add a file is a live check; one that does not is a stopped one.
* **Prove falsifiability without dirtying the shared tree.** Keep a deliberately-wrong
  implementation as a permanent control in the test file, or mutate a COPY outside the
  tree — never mutate a tracked file in place, because git-sync sweeps the whole tree
  every few minutes and will commit your mutant while the probe is still running.

## Related

* `okf-frontmatter-adoption-2026-08-08` D-005 (the raw-vs-normalised ruling) and D-006
  (the two-way wiring), WI-35930.
* [schedule:inventory is PER-PROCESS](/internal/docs/agent-insights/schedule-inventory-is-per-process)
  — the same reading error one layer out: absence from an inventory is evidence only when
  there is exactly one inventory.
* A live instance of it, hit while verifying this very work:
  `check-lint-guard-reachability.mjs --census` prints only the NOT-ENFORCED and
  PARTIALLY-COVERED groups, so grepping the census for a healthy guard's name returns
  NOTHING. Read as "my guard is not registered", which is the opposite of the truth —
  `--json` reported it `blocking: true`, coverage `full`. Absence from a SUMMARY is not
  absence from the REGISTRY.
