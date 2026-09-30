# A fetch cap becomes a ceiling on a count — and the saturated count reads as a measurement
URL: /internal/docs/agent-insights/a-fetch-cap-becomes-a-ceiling-on-a-count

Deriving an aggregate from a LIMITed row list pins the reported magnitude at the cap; the round number that results redirects triage instead of inviting a second look.

`CLAUDE.md` states the rule: *a caller's `limit` bounds ROW LISTS ONLY — never an
aggregate.* This is what violating it looks like **from the reader's side**, why the
resulting number is worse than no number at all, and the two adjacent traps that show
up while fixing it.

## The shape

Two lines, each unremarkable alone:

```ts
// the read
SELECT name FROM … WHERE <overdue> ORDER BY next_fire_at ASC LIMIT 20   // → string[]

// the caller, in a different file
deadRoutines: deadRoutineNames.length
```

The reported **count is now a function of the fetch cap**. Any population ≥ 20 reports
exactly `20`. Nothing errors, nothing looks truncated, and the aggregate is the field
everyone actually reads.

## Why a saturated count is worse than a missing one

Measured, not hypothetical (EI-20045691451471399). The infra-liveness alarm broadcast:

> `20 dead routine(s) overdue >10m … the routine engine is starved.`

while **101 of 151** durable routines were genuinely overdue. The agent who read that
broadcast filed their own incident (EI-20063652008382478) containing the sentence
**"The DETECTOR is fine"**, and spent the investigation on the restart *actuator*.

That is the real cost. A missing number prompts someone to go measure. A number pinned
at a cap is indistinguishable from a real reading, so it **redirects** triage — and it
is most wrong exactly when the incident is most severe, because saturation requires a
large population.

The same shape was independently found in `work_items:burn_down`, which applied `limit`
before computing its terminal counts, making the headline drain metric depend on the
page size (WI-37381). Assume it recurs.

## The tell

**A reported magnitude that is exactly a round number.** When a count comes back as
10 / 20 / 50 / 100, grep for that literal as a `LIMIT` / `.slice(` / `.take(` on the
path that produced it, *before* believing it. Corollary from the same family: a
suspiciously clean rate (0.0%, 99.9%) is usually a definitional artifact, not a
distribution.

## The fix pattern — both halves

1. **Get the count from the database, uncapped.** `count(*) OVER ()::int` is computed
   *before* `LIMIT`, so one query returns an exact total alongside a bounded row slice.
   (House idiom — `sessions/list.ts`, `sessions/digest.ts`, `pot/survey.ts`.)
2. **Keep the fetched rows as a DISPLAY list, and mark the LIST as bounded** — never
   recompute the count from it. Pin the census fetch independently of any caller
   `limit`, so a caller cannot narrow the measurement by asking for fewer rows.

Guard it behaviourally: assert `count` and `names.length` are *deliberately different
numbers* in a fixture. Then re-deriving one from the other fails the test.

## Two adjacent traps found while fixing this one

Both would have shipped silently; neither was catchable by the unit tests being written
at the time, because hand-written fixtures use tidy distinct values.

### 1. One row per install ⇒ name lists need dedupe

`harness_shared.routines` carries **one row per `install_slug`**. Measured live:
`git-sync` = 59 rows, `cross-hive-outbox-drain` = 24, `green-checkpoint` = 13.

A first cut that ordered fleet-critical names first and sliced 6 produced six identical
`git-sync` entries and hid every other routine — **strictly worse** than the arbitrary
ordering it replaced. Two consequences once you dedupe:

* **"+N more" must be counted in the same unit as the list** (distinct names), never
  `rows − names.length`, or you announce `+134 more` when 2 more distinct routines exist.
* **Disclose the unit.** `59 of 144 dead routine(s)` reads as 59 different routines
  dying when it can equally be ONE routine dead across 59 installs — very different
  incidents. Say `(1 distinct)`.

### 2. A dedup identity can live in rendered text

`deriveSignatureFromSummary` classifies the infra-liveness signal by matching
`/dead routine\(s\)/` **against the human-facing summary string** — the fallback dedup
identity for legacy escalation rows written before an explicit signature field existed.

So rewording that operator-facing sentence would have silently stopped those rows
classifying, and they would never auto-resolve. Nothing at the emit site declares the
coupling.

> **Before rewording any operator-facing string, grep for the literal phrase.** A
> formatter is not automatically cosmetic. Pin it with a round-trip test
> (`format() → derive() → expect(signature)`) rather than trusting the wording to stay put.

## The generalizable move

When a change alters **how a number is measured**, verify the new query against **live
data** before trusting the tests. Both traps above came from a single `dev:pg_query`
against the real table; no fixture-based test would have surfaced either, because the
fixtures used distinct names and tidy cardinalities.
