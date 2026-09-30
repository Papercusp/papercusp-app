# A skip whose premise is assumed is a silent coverage hole — declare the premise, then verify the declaration
URL: /internal/docs/agent-insights/a-skip-whose-premise-is-assumed-is-a-silent-coverage-hole

affected-tests.mjs skipped a repo-wide invariant guard whenever its host workspace was otherwise affected, justified as "that suite already contains the guard". The premise held for 5 of 12 guards, and a dependency-graph edit three files away silently disabled one. How the class works, why the trigger is always unrelated to the guard, and why replacing an assumed premise with a DECLARED one only helps if the declaration is itself checked.

## The shape

`REPO_WIDE_INVARIANT_GUARDS` exists because a lint whose SCAN spans the repo but whose
enforcement point is a vitest file in ONE workspace is enforced only for that workspace
(D-034; instances: EI-19388389386110890, WI-9434, WI-9573, WI-37605). The registry fixes
that by attaching a narrow guard task when the host workspace is not otherwise affected.

The attachment loop also carried the inverse rule, in one comparison:

```js
// the old form — two different rules sharing one condition
if (tasks.some((t) => t.ws.name === ws.name && (t.script === 'test' || t.script === guard.script))) continue;
```

`t.script === guard.script` is a self-dedupe and is always right. `t.script === 'test'` is
something else entirely: a claim that **the host workspace's suite already re-runs this
invariant**, so attaching the narrow task would merely duplicate it. That claim was applied
uniformly to every guard and was true for 5 of 12.

## Why it is silent, and why the trigger looks unrelated

For the 7 guards with no in-suite ratchet, the skip did not save a duplicate scan — it ran
*nothing*. And the condition that fires it is not a property of the guard at all: it is
whether some *other* change pulled the host workspace into the affected set.

Measured 2026-08-10 (EI-20026978310669562): declaring `@papercusp/db-org` and friends on
`operator-core` — a dependency-graph correction with nothing to do with linting — made every
`libs/papercusp/**` path reach operator-core. From that moment a migration `.sql` change
stopped running `lint:migration-forward-compat`, reopening precisely the class WI-9573 wired
the registry to prevent. Nothing failed. The only visible symptom was three sibling guard
tests going red, which read as "the test file is wrong", not "a guard stopped firing".

**The general form: widening a dependency graph does not only ADD things to the affected
set — it can SUPPRESS behaviour that keyed on something NOT being in it.** Whenever you make
X reachable, ask what was guarded by "X is not affected". A before/after routing probe
pointed at the BENEFIT will not show you this; you have to point it at the regression too.

## The fix, and the trap inside the fix

The premise is now DECLARED per guard rather than assumed globally:

```js
if (tasks.some((t) => t.ws.name === ws.name && t.script === guard.script)) continue;      // always right
if (guard.hostSuiteRatchet && tasks.some((t) => t.ws.name === ws.name && t.script === 'test')) continue;
```

A guard may defer to the host suite only if it NAMES the in-suite ratchet that re-runs it.
A guard that names none attaches unconditionally — the fail-safe direction, and cheap, since
these tasks are sub-second by design.

⚠ **That is only half a fix.** A declaration is a new place to write an unverified claim, and
a phantom ratchet — a path that does not exist, or a real file that never runs the invariant —
buys back the identical hole while *looking* rigorous. So the declaration is checked: the named
file must exist, live inside the host workspace, and actually reference the detector it vouches
for. Falsifiability was proven by mutating a COPY outside the tree (`PROBE_AFFECTED_TESTS`),
which is why the test reads its registry source through an overridable path.

## Two measurement lessons this cost

**A probe's negative covers only the shapes it reproduced.** The first pass at "which guards
have a ratchet?" grepped for `execFileSync` and returned all-NONE — including for guards
verified by hand to have one, because `green-checkpoint-tag-guard.test.ts` scans via an
IMPORTED function. The second pass false-POSITIVED by matching the registry test itself, which
names every detector and uses the word "ratchet" in prose. Only the third (exclude that file;
require the phrase inside a test TITLE) agreed with all five hand-verified guards. **A uniform
answer — all-NONE, all-RATCHET — is a tell that the probe is broken, not that the tree is.**

**A test can assert a MECHANISM while meaning a COVERAGE.** `expect(out).toContain(PI_TASK)`
meant "a schema change must reach the partial-index ratchet", but pinned the one route that
happened to deliver it at the time. When the host suite began covering that path, the property
still held and the assertion broke. The sibling case one screen up already had the right shape
(`includes(TASK) || includes(HOST :: test)`) — worth copying whenever a test names a route to a
guarantee rather than the guarantee.

## If you are here because guard tests went red

1. Ask whether the host workspace newly became affected for the probed path
   (`node scripts/affected-tests.mjs --changed-paths <path> --dry`).
2. Check whether the guard declares `hostSuiteRatchet`, and whether that ratchet is real.
3. Do not "make the guard attach again" as a blanket fix — for a guard with a genuine ratchet
   the skip is correct, and forcing attachment just double-runs it.
