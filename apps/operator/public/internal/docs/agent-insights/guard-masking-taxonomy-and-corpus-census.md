# Guard masking: the four-option taxonomy, and measuring a guard's corpus behaviourally
URL: /internal/docs/agent-insights/guard-masking-taxonomy-and-corpus-census

Lint guards contain their own detection tokens in prose and strings, so they mint phantom offenders. How to choose among the four masking strategies (including the mask-as-oracle option), why a phantom probe needs a positive control, and why a guard's file corpus must be measured behaviourally with a CJS preload rather than pattern-matched.

A lint guard in `scripts/` finds violations by text-matching a call-shaped token. That makes
guards the code *most* likely to contain their own detection tokens — inside their own error
messages, their own detection regexes, their own test fixtures and their own prose. A guard that
scans raw source therefore mints **phantom offenders**: violations at file:line positions where
no such call exists. This has red-pinned the fleet gate on files that do not even import the
symbol in question, while agents triaged a call site that was never there.

The fix always belongs in the **scanner**, never in a reword of the quoting file. This doc is how
to pick the right scanner shape, and how to establish which guards are even in scope — both of
which have well-measured wrong answers.

## The choice is four options, not two

`scripts/lib/strip-comments-and-strings.mjs` is the one canonical implementation. The mistake is
treating it as a single switch to flip. It exposes **four** strategies, and picking per *guard* is
wrong — the unit of choice is the **call site**, because a single guard can need two of them.

### 1. `stripCommentsAndStrings(text, fileName)` — the default

Blanks comments, string/template literal *contents*, and regex literal bodies, keeping
delimiters, in one AST pass. Use when the token you detect is **code**: a call, an identifier, an
import statement.

Length-preserving by construction — every removal is blanked with spaces rather than deleted — so
offsets and line numbers in the masked text address the raw text identically. Any consumer that
reports a line number depends on this.

### 2. `stripCommentsOnly(text, fileName)` — when the token legitimately lives in a string

Some guards detect things that are *supposed* to be string-resident: SQL inside template
literals, a `harness_slug = ${installSlug}` interpolation, a wire header value. Masking strings
there trades a false positive for a false **negative**, which is the worse direction for a guard.

### 3. Raw text — when the corpus is not TypeScript at all

The shared stripper is a TS parse. A guard whose corpus is `.sql`, `.md` or systemd `.ini` units
cannot use it. Masking there must be **extension-gated**, never applied blanket.

### 4. `firstLiveMatch(raw, masked, re)` / `isLiveCodeAt(raw, masked, index)` — the mask as an *oracle*

The option that is usually missed, and the one that resolves the cases where **no** stripper
works because the pattern spans code *and* string content.

`check-no-wire-compression` is the sharp example: its own rules disagree with each other.
`createGzip(` is pure code and wants strings masked; `'content-encoding': 'gzip'` lives *entirely*
inside string literals and masking deletes it. There is no single mask that serves both.

So stop choosing a mask and use it as an oracle: exec the pattern on the **raw** text, then ask
whether the match's *anchor* — its first non-whitespace character, which for these patterns is
always the code-shaped part — is real program text. Blanked ⇒ the whole match was string or
comment content ⇒ phantom. Live ⇒ a real hit, and its specifier being a string is expected.

Two properties of `firstLiveMatch` are load-bearing and easy to reimplement wrongly at a call site:

* **It scans past phantoms rather than stopping at the leftmost match.** A single `re.exec`
  returns the leftmost match; if that one sits inside a string while a real occurrence follows it
  on the same line, testing only the leftmost rejects the line and silently loses the real hit —
  a false negative created by a fix aimed at false positives.
* **It tests the first non-whitespace character, not `m.index`.** Blanking replaces a character
  *with a space*, so a blanked character and a real space are indistinguishable. Every
  line-anchored rule opens with `^\s*`, which puts exactly that ambiguous character at `m.index`;
  testing it directly reports a match inside a template literal as live code and lets the phantom
  straight through.

A guard needing **both** #1 and #4 is normal, not a smell. `check-no-unenrolled-detached-spawn`
detects on masked source but must apply its enrolment *exemption* against raw text — otherwise
every file reads as unenrolled.

## Masking is monotonic — which is what licenses the fast path

An unconditional AST mask timed a whole-tree guard out past 120s and took one detector from 0.26s
to 21.99s. The invariant that makes the fix safe: **masking can only ever remove a match, never
create one.** So the raw match is a sound cheap *superset* pre-filter — mask only files whose raw
text already matches.

Gate that pre-filter on the **actual regex**, not a coarse `includes`. 119 files mention
`_retired/`; a handful match the import shape. That distinction was the entire 22 seconds.

## The positive control is the whole probe

`probeStringLiteralBlindness(detector, tokenInProse)` feeds a guard's own exported detector a
source where its token appears **only** in prose. A phantom-minting guard reports a violation; a
correctly-masking guard reports nothing.

**A detector that never fires at all passes that probe perfectly.** It is indistinguishable from a
correct one, because both report nothing. So the probe is only meaningful alongside a bare-code
**positive control** proving the token fires when it *is* real code.

This is not theoretical: a guard returned a clean verdict and the only reason it was not recorded
as clean is that the control showed its token never fired. The tell was not a dramatic number — it
was a suspiciously *tidy* sweep result. Assert the control in the cases table itself, so a future
agent fixes the token rather than deleting the assertion.

### A probe has a domain of validity — outside it the answer is *vacuous*, not clean

`probeStringLiteralBlindness` plants **TypeScript** syntax. Pointed at a guard whose corpus is INI
unit files with no string literals at all, it declared that guard a phantom-minter — it was fed
input the guard can never receive. Neither "clean" nor "phantom" is the right reading there.
Record such a result as **inconclusive**; a verdict computed from input the subject cannot receive
is not a verdict.

## Establishing the corpus: measure behaviourally, never by pattern

**You cannot determine what files a script reads by pattern-matching its source.** Three
successive text-pattern rules were tried for "does this guard scan `.ts`", and each produced false
drops that the next one revealed:

1. match a quoted extension (`'.ts'`) — blind to the regex form;
2. also match the regex form — blind to a character class, `[jt]sx?`;
3. widen the window — a long alternation escapes it anyway.

Each fix uncovered a new shape. That is an **unsound method, not an under-tuned regex**: guards
are ordinary JavaScript, so the shapes are unbounded. Any classifier of this kind will keep
producing confident false drops, and a dropped guard silently leaves the population you are
policing.

Measure what the process actually opens instead:

```js
// preload.cjs — MUST be CJS, see the trap below
const fs = require('node:fs');
const orig = fs.readFileSync;
fs.readFileSync = function (p, ...rest) {
  try { orig.call(fs, '/dev/null'); fs.appendFileSync('/tmp/opened.log', String(p) + '\n'); } catch {}
  return orig.call(this, p, ...rest);
};
```

```bash
NODE_OPTIONS=--require=/tmp/preload.cjs node scripts/check-whatever.mjs
```

Then classify each guard by the extensions it actually opened. This settles every disputed guard
in one run, and — importantly — reports **inconclusive** rather than "clean" for guards that
delegate to child processes (`rg`, `grep`, `git ls-files`) instead of reading files themselves.
Those need their own treatment; counting them as clean is the same vacuity trap as above.

### ⚠ The preload must be CJS — an ESM preload silently under-counts

Measured on Node v25.9.0:

| preload             | `import { readFileSync } from 'node:fs'` | `import fs from 'node:fs'; fs.readFileSync(...)` |
| ------------------- | ---------------------------------------- | ------------------------------------------------ |
| CJS via `--require` | intercepted                              | intercepted                                      |
| ESM via `--import`  | **NOT intercepted**                      | intercepted                                      |

A CJS preload runs before ESM linking, so the builtin **named** import binds to the already-patched
function. An ESM preload runs too late for that binding: the named import still points at the
original, and only property-lookup-at-call-time (`fs.readFileSync`) picks the patch up.

The failure mode is what makes this worth knowing. A guard written with
`import { readFileSync } from 'node:fs'` — the common style here — records **zero opened files**
under an ESM preload. That does not read as an error; it reads as "this guard scans nothing", so
it silently drops out of the population. A census is exactly the tool you cannot afford a silent
under-count in.

## The corpus predicate is a population test — treat a change to it as a measurement

`SCANS_UNMASKED_SOURCE` in `guard-string-literal-blindness.test.ts` is shrink-only. Before
changing the predicate that decides membership, check the **drops** as well as the adds — twice,
a widening that looked like a pure improvement removed guards that genuinely scan TS.

And when a corrected predicate adds members: do **not** bulk-append them to the baseline. Each one
needs the fix-vs-declare judgment, because baselining a real defect converts it into declared debt
and it stops being visible as a bug.
