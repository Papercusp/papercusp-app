# A negative assertion pinned to a literal rots silently — and rewording the string is what kills it
URL: /internal/docs/agent-insights/negative-assertions-rot-silently

A POSITIVE assertion pinning a literal fails loudly when the string is reworded, forcing you to look at it. A NEGATIVE one starts passing — permanently, invisibly, and as a direct consequence of doing the rename correctly — so the suite keeps reporting a guard it no longer has. `npm run lint:vacuous-negatives` gates the decisive case (prose that exists nowhere emittable while a long fragment of it IS in the source). Includes the four false-positive classes that are NOT this bug, why prose must be excluded from the corpus, and why a checker that quotes its own example poisons its own evidence.

import { Aside } from '@astrojs/starlight/components';

## Symptom

A test with a truthful-looking name is green. The guard it describes does not exist.

```ts
// checkpoint-run.test.ts, for an unknown length of time
expect(String(b.note)).not.toMatch(/⚠ quiet-cut EXCLUDED/);
```

The banner had already been reworded in `checkpoint-run.ts`. The regex could no longer
match anything the tool was *capable* of emitting, so it passed unconditionally — no
matter what the code did. Nothing in CI would ever have surfaced it; it was found by hand,
only because someone happened to be rewriting that exact string.

## Why this class is worse than a merely weak test

A **positive** assertion pinning a literal (`toMatch(/foo/)`) is *self-healing*: reword the
string and the test fails loudly, so the rename drags you to the assertion.

A **negative** assertion is the exact inverse. Rewording makes it *more* likely to pass.
The failure is silent, permanent, and **created by the act of doing the rename correctly**.

And negative guards are not evenly distributed — they cluster on warning/prompt/advice
strings, written *because a bad phrasing already caused an incident once*. So this class
specifically disarms the guards we wrote after getting burned.

The assertion above existed to keep settled-fact grammar out of the reply. While it was
dead, that grammar drifted back into the same file in a new form — filed separately as
EI-18759622667757826. The guard was disarmed exactly when it was needed.

## The guard

```bash
npm run lint:vacuous-negatives          # GATING in CI, ~45s
npm run lint:vacuous-negatives:report   # + the non-gating bucket
```

A negative assertion on a static literal is vacuous when the literal appears **nowhere the
system could emit it** — not in any tracked non-test file, and not anywhere in its own test
file (where a fixture would put it). Two verdicts:

| verdict      | meaning                                                                                                                                                                           | gates?  |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **DRIFTED**  | A long contiguous fragment of the literal **is** in the source. The guarded string still exists; the guard is pinned to its OLD wording. Dead guard, live emitter.                | **yes** |
| **ORPHANED** | Nothing resembling the literal exists anywhere. Usually a deliberate "this phrasing is gone for good" ratchet — legitimate and stable, since the historical string never changes. | no      |

Deliberate exception? `// vacuous-negative-ok: <reason>` on the line or in the comment
block above it. That is an improvement in itself: it turns an invisible always-passes into
a documented intentional ratchet.

## What is NOT this bug

Each of these was a live false positive on the first sweep, and each is now a pinned test.
A negative assertion is **not** flagged when the string is producible:

* **The source has it.** The guard can still fail. Fine.
* **The test builds it as a fixture** — `not.toContain('old state line')` next to a fixture
  containing `old state line`, asserting the mutation replaced it.
* **A "no extra suffix/prefix" guard** whose literal *contains* a literal the same file
  asserts positively — `toContain('a → b')` beside `not.toContain('a → b →')`.
* **Runtime-composed output**: the template is in the source and the *value* comes from the
  test (`--workspace=` + `null`; `plan:` + `plan-started`). The residue being supplied by
  the test file is the signature of composition.

The gate is further narrowed to **prose** — multi-word wording with no embedded digits.
Value pins (`SKIP_FROMREPO="${SKIP_FROMREPO:-0}"` — the default must not be 0), shape
guards (`kill "$PORT_LOCK_KEEPER_PID"` — stop.sh must not force-kill the keeper) and
single tokens are all *good* assertions; they report, they never gate.

## Two traps worth knowing (both nearly made the detector useless)

**Prose is not an emitter, so it is not corpus.** A doc or prompt that *describes* a banner
cannot produce it. Judging against `.md` made the motivating instance undetectable:
`⚠ quiet-cut EXCLUDED` survived in exactly one place — `blueprints/base/prompts/release-fixer.md`,
which still told release-fixer agents to look for a warning the tool had stopped emitting.
Prose scored the dead string "still exists", **and** the stale prompt (a second, live
defect on the release-gate path) stayed invisible. Measured over the whole repo, dropping
prose from the corpus changes exactly **one** assertion's verdict.

**A checker that cites its own example poisons its own evidence.** This lint's header quotes
the banner verbatim, and it is a `.mjs` — so it was in its own corpus, and the one assertion
it was written to catch scored "the string exists". It is excluded by path now. This was
caught only by *replaying the real pre-fix commit through the judge* and getting zero
findings — never by reading the code and reasoning about it.

Replay the real historical defect through it. The pre-fix commit is in git; feed that file
to the judge against the live corpus and check it flags that assertion **and only that
one**. A detector for a class that cannot demonstrate it catches the instance the class was
named for is exactly the vacuous guard it exists to prevent.

## Related

* `agent-insights/a-check-that-never-ran-must-not-read-as-passed` — the sibling rule for
  probes, and `npm run lint:assert-integrity`, its mechanical guard for shell scenarios.
* EI-18765867705399052 (this class), EI-18759622667757826 (the regression the dead guard
  failed to stop), EI-18773280958875269 (the same rot in prompts, still unguarded).
