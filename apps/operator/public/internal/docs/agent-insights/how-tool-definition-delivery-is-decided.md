# How tool-definition delivery is decided (derived, not hand-maintained)
URL: /internal/docs/agent-insights/how-tool-definition-delivery-is-decided

Which tools an agent is advertised, and how much schema each one ships, is DERIVED from measured distinct-callers x measured bytes against a stated budget - not from a hand-edited seed list. How to read the generated artifact, how to refresh the demand snapshot, and the two corrections this encodes.

## The problem this replaced

A psu agent pays, on EVERY turn, the full JSON schema of every tool its MCP seed
advertises. Denying `ToolSearch` (one call measured at +67,045 tokens bypassing the
result door) also removes Claude's native schema DEFERRAL, because deferral is
implemented BY that tool. So the advertised surface stopped being a discovery
convenience and became a per-turn context bill.

Measured 2026-09-15 (EI-23319364088969722): a 64-name seed cost **432,714 B** on the
wire, roughly 157K tokens — essentially the whole reported first-turn regression.

Nobody caught it for four days, and the reason is the important part: **every one of
those 64 names was added individually, each with real demand evidence, and nothing ever
measured the AGGREGATE.** A per-item justification process with no total is not a
budget, and it drifts in one direction only.

## The rule

> Which tools are advertised, and how much of each tool's definition ships, is a
> DERIVED value — computed from measured demand x measured bytes against a stated
> byte budget. There is no hand-maintained seed list at runtime.

This is the [derived-truth ladder](/internal/docs/agent-insights/derived-truth-ladder)
applied to the tool surface: the advertised set DESCRIBES the catalog and the fleet's
measured usage, so a second hand-written copy of it will drift.

## The two corrections this encodes

Both were wrong in the obvious first design, and both are cheap to get wrong again.

### 1. Rank by distinct CALLERS, not by CALLS

Demand is measured as the number of **distinct callers** that used a tool in the
window, not the raw invocation count. Call volume measures one agent's habit: a single
session in a loop can hammer one verb thousands of times and manufacture demand that no
other agent shares. Distinct callers measures BREADTH of need, which is the thing a
shared per-turn budget should buy.

The policy ranks on **callers per KB** — value per byte — so a cheap tool that several
agents reach for beats an expensive one that one agent loves. Raw `calls` is still
recorded in the snapshot and printed in the report, but only as a tiebreaker and as
context for a human reading the diff.

### 2. Three tiers, not two

The pre-plan model was binary: a tool was either advertised at full weight or not
advertised at all. That framing is what made the budget feel impossible, because the
only way to afford another tool was to drop one. The real model has **three** tiers:

| tier       | what ships                                            | what it costs        |
| ---------- | ----------------------------------------------------- | -------------------- |
| `full`     | description + full guidance + full argSchema          | the whole definition |
| `compact`  | a capped SUMMARY of the prose + the projected schema  | a fraction           |
| `deferred` | nothing — reachable via `tools:find` / `tools:invoke` | 0                    |

COMPACT is the tier that changes the arithmetic. Measured against the live catalog of
899 tools:

```
WIRE_BYTES       full=1,599,477  compact=649,761  savedByCompact=949,716   (-59.4%)
GUIDANCE_BYTES   full=334,797    summary=81,030   savedBySummary=253,767   (-75.8%)
```

### ⚠ Those are BYTES. The context you actually save is smaller.

A byte ratio is not a context saving. The provider bills **tokens**, and a tokenizer does
not compress English prose and JSON punctuation at the same rate — compacting a definition
strips proportionally more bytes than it strips tokens. So a byte percentage is always the
more flattering number, and it is only ever an **UPPER BOUND** on what is actually saved.

Measured on the 63 definitions that actually ship (`buildShippingSeedCatalog`), counted
with the provider's own tokenizer:

```
DEFINITION_BYTES  full=369,616  compact=100,418  savedByCompact=269,198   (-72.8%)
DEFINITION_TOKENS full=109,945  compact=38,329   savedByCompact=71,616    (-65.1%) provenance=measured
```

**65.1%, not 72.8%, is the realised saving on this subject** — and an independent
tokenizer (cl100k) put it at 70.3%, also below the byte figure. Quote the byte number as a
ceiling or not at all.

⚠ **Measuring this is harder than it looks, and the obvious method is wrong.** The local
gateway's `count_tokens` silently collapses on large tool payloads — 148,346 B came back
as 1,166 tokens, HTTP 200 and well-formed — which inverts the sign of the very comparison
above (filed as WI-10002467). The figures here are counted **one tool per request**, with
the per-request tool overhead measured by regression (496.0 tokens/request) and
subtracted; that summation was then validated against a known-good whole count to 0.00%
error. If you re-measure, characterise the instrument before trusting it.

### ⚠ Part of that saving is a NET LOSS at N=1 — the limit travels with the figure

Some of the compact byte saving comes from `$defs`/`$ref` factoring: a sub-schema repeated
N times is sent ONCE and pointed at. **That trade only pays from `N>1`.** At `N=1` the
`$ref` buys nothing and the `$defs` wrapper is pure overhead, so factoring a sub-schema
used once is strictly WORSE than inlining it:

```
DEFS_N1_BYTES  refs=1  inlined=800   referenced=855  addedByFactoring=55
DEFS_N2_BYTES  refs=2  inlined=1526  referenced=941  savedByFactoring=585
```

At one reference that is **-6.9% of bytes and -2.8% of tokens — a net loss.** It turns
positive at two (+38.3% bytes, +16.2% tokens) and keeps climbing: +62.6% at four, +75.2%
at eight, +81.5% at sixteen. Measured 2026-09-22 over two semantically identical schemas in
`packages/operator-core/lib/agent-tools/provider-ref-expansion.test.ts`, which also
establishes that the provider does NOT re-expand the refs before the model sees them
(marginal cost 30.0 tokens/duplicate referenced against 207.0 inlined, ratio 0.145) — so
the saving is realised rather than merely advertised. The two byte lines above are
recomputable offline from that file's own builders; the token halves came from the same
sweep through the provider's tokenizer.

Quote the headline saving without this limit and the next reader factors a single-use
sub-schema and makes the artifact **bigger**. ⚠ The converse misreading costs just as much:
the 2026-09-22 budget repair that took the derived seed from 100,189 B (over) to 99,945 B
was itself a `$defs` factoring — of `specAdequacyCompletionSpec` in
`packages/operator-core/lib/agent-tools/work_items/complete.ts`, which was being inlined
TWICE. **That is the N=2 case, the paying side of this very curve, not an exception to it.**
The N=1 limit is what tells those two situations apart; it is not a blanket warning against
`$defs`.

⚠ **COMPACT does not ship zero prose.** A partial-guidance projection (keep `when`,
drop `notWhen`/`chaining`) was built and measured, and it saves **2,784 B — 0.8%**.
That negative result is recorded as D-011 so it is not re-proposed: the prose saving
lives almost entirely in the descriptions themselves, not in the guidance sections, so
COMPACT ships a capped SUMMARY rather than either full prose or silence.

## What the budget actually buys

All three agent kinds resolve from the same function and, per owner directive D-005,
the same budget — so their maps are identical:

```
TOOL_DELIVERY_REPORT kind=claude full=0 compact=63 deferred=836 spent=99996 budget=100000 overrun=0
TOOL_DELIVERY_REPORT kind=codex  full=0 compact=63 deferred=836 spent=99996 budget=100000 overrun=0
TOOL_DELIVERY_REPORT kind=omp    full=0 compact=63 deferred=836 spent=99996 budget=100000 overrun=0
```

`full=0` is the policy's CORRECT output, not a bug. D-004 holds a mandated floor at the
CHEAPER tier rather than dropping it, and at 100,000 B nothing can afford FULL once the
floors are seated. A guard asserting "some advertised tool always stays FULL" encodes
the pre-D-002 premise and reds the gate on a fully compliant seed.

Upgrading the delivered set to partial or full guidance is priced, and refused:

```
GUIDANCE_UPGRADE_PARTIAL deltaBytes=26163 wouldBe=126159 budget=100000 verdict=OVER
GUIDANCE_UPGRADE_FULL    deltaBytes=26163 wouldBe=126159 budget=100000 verdict=OVER
```

## Reading the generated artifact

`apps/operator/scripts/tool-delivery.generated.mjs` is a plain `.mjs` data module
exporting frozen literals, because `psu-launcher.mjs` is dependency-free by design (bare
node, no build step), so the artifact it consumes must be importable as-is.

```bash
npm run gen:tool-delivery            # write the artifact
npm run gen:tool-delivery:check      # exit 1 if it is stale
npm run gen:tool-delivery -- --report  # print the resolution, write nothing
```

All inputs are frozen except the catalog, which is exactly what `--check` should catch:
**a tool whose schema grew silently changes which OTHER tools are advertised**, and
nothing else in the repo would notice. The artifact diff names who paid.

The report's per-name lines carry the justification:

* `TOOL_DELIVERY_KEPT <name> tier= callers= calls= fullB= compactB= callersPerKB= [floor=1]`
* `TOOL_DELIVERY_ADDED <name> ...` — same fields; this is the addition's evidence
* `TOOL_DELIVERY_DROPPED <name> reason=below-value-line ...` or `reason=absent-from-catalog`

The two drop reasons are deliberately distinct: conflating them makes an unavoidable
removal (the tool no longer exists) look like a judgement call, or the reverse.

### The Aug-20 baseline diff

The report diffs the resolved set against a committed measurement of the owner-directed
Aug-20 working set:

```
TOOL_DELIVERY_BASELINE commit=84829ccc date=2026-08-20T23:23:39Z baselineNames=61 kept=61 added=2 dropped=0
TOOL_DELIVERY_BASELINE_RESTORE_COST compactBytes=0 spentBytes=99996 budgetBytes=100000 wouldSpend=99996
```

Every one of the 61 baseline names survives, and the derivation adds 2 more inside the
same budget — which is the whole case for the COMPACT tier stated as a measurement.

⚠ **The baseline is 61, not the 26 the owner was originally told.** "19 OMP-core + 7
Claude extras = 26" came from a PRIOR SESSION'S OWN ANSWER and was never checked against
the code; the measured set at the last Aug-20 commit is 43 + 18 = 61 distinct names
(D-007). A derivation reporting "we grew from 26 to 90" would have carried that error
forward with the authority of a generated artifact — which is exactly how a wrong number
becomes load-bearing. The baseline is therefore a committed measurement file, recovered
from the commit, and a guard asserts it is still 43/18/61 at `84829ccc`.

## Refreshing the demand snapshot

Demand is a **committed snapshot file**, never a live database read at generation time.
The generator and every test read `tool-demand-snapshot.json`; nothing queries the DB.

```bash
npm run refresh:tool-demand         # re-measure; review the diff like any other change
```

That is the only sanctioned door, and it matters for three reasons:

1. **Reproducibility.** The file records `windowDays`, the window start/end, the exact
   SQL, its bound parameters and the workspace scope. Without those a reviewer cannot
   tell a 14-day fleet-wide read from a 1-day single-tenant one — and the two justify
   completely different seeds.
2. **Believability.** `judgeThinness` refuses a measurement that is thin in EITHER
   dimension. A wrong `--workspace` yields plenty of tools from very few callers; a
   pruned window yields the reverse. An empty snapshot would otherwise read as "almost
   nothing is in demand" rather than as a broken read, and committing one would drop the
   entire advertised seed on the next generator run.
3. **Reviewable diffs.** The file is sorted by name and the builder is deterministic
   under input reordering, so one tool moving shows up as one line, not a reshuffle.

## If you are about to edit a tool's description or schema

You are editing a shared budget, not just your tool. Growing one seeded tool's
`argSchema` evicts the lowest-value name(s) to pay for it.

* `npm run tool-weight -- <tool>` measures **description + guidance only** — it will look
  fine while the wire budget fails, because the cost here is dominated by `argSchema`.
* The wire-budget guards (`claude-seed-wire-budget.test.ts`, `omp-seed-wire-budget.test.ts`)
  are what actually fail. They assert against the DERIVED seed — imported directly from
  the launcher, so drift is structurally impossible rather than merely detected — and
  they assert floor COVERAGE.
* Cheapest fix first: re-run `gen:tool-delivery` and read the diff. Raising
  `TRIMMED_BUDGET_BYTES` is a deliberate per-turn cost decision, not a way to make a test
  pass.
