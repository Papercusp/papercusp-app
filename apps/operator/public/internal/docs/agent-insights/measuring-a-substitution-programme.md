# Measuring a substitution programme — the instrument lies before the agents do
URL: /internal/docs/agent-insights/measuring-a-substitution-programme

Before reporting any adoption or compliance rate: six ways the measurement apparatus produces a confident near-zero that says nothing about the population it appears to indict. Drawn from the bash-substitution plan, where every headline number turned out to be about the instrument.

A substitution programme is any intervention of the form *"stop doing X, do Y instead"* — a tool routing table, a lint rule, a deprecation, an advisory. They are unusually easy to measure **wrongly**, because the obvious metric (how many agents did Y?) has a dozen ways of returning a confident, round, damning-looking near-zero that is a statement about your apparatus rather than about anyone's behaviour.

This is the accumulated post-mortem of `bash-substitution-reachable-ceiling-2026-08-01`, where a compliance figure of **0.007%** was reported, believed, escalated, and turned out to measure four separate instrument defects stacked on top of each other. Read it before you publish an adoption number.

## The one-line rule

> When a rate comes back near-zero (or suspiciously round) across tens of thousands of samples, **the instrument is the suspect, not the population** — and fixing *one* instrument defect does not license believing the next number the same instrument produces.

That second clause is the part that actually costs time. Each fix below improved the number by roughly an order of magnitude, which makes it *feel* like the explanation has been found. Three times in a row, it had not been.

## Trap 1 — the contaminated denominator

The programme opened by measuring "what share of bash could be a tool?" against a corpus that included commands nobody could ever substitute. A denominator assembled from *everything observed* rather than *everything eligible* makes the intervention look like it is failing at a job it was never scoped to do.

**The tell:** you cannot state, in one sentence, what a row has to be to enter the denominator.

**The correction:** `echo`/`cd`/`export` measured **100% irreducible** and were excluded permanently (D-071). Note the shape — the exclusion had to be *measured*, not asserted. The same decision found the item's own stated share and rationale were both wrong, which is the usual outcome when a denominator finally gets defined.

## Trap 2 — a coverage ceiling mistaken for a compliance problem

The plan's title said "\~100%". Measurement said the **reachable ceiling is 55.6%** (D-051, D-053): only that share of the bash population has a tool that could serve it at all. Every point between 55.6% and 100% was irreducible work, not defiance — but for weeks the gap read as agents ignoring guidance.

**The tell:** your target is a round number somebody chose, rather than a measured ceiling.

**The rule:** state success against the *reachable* population, never against raw share. A programme reported against an unreachable target is guaranteed to look like it is failing, and the people it appears to indict cannot do anything about it.

## Trap 3 — the un-attributable metric with no control group

Raw event counts confound the intervention with fleet size. In this corpus, fires/day ranged **35 to 6,527** — so any per-day movement was mostly a headcount signal. This is genuinely fatal to a raw count, and it was initially ruled to make the control uncomputable.

**That ruling was wrong, and the retraction is the lesson (D-077).** A *within-corpus ratio* needs no activity denominator at all, because fleet size cancels on both sides. Measured across 15 days, bash share of the Bash+Read pair held a **78–93 band** while raw bash volume swung **10×** (1,748 → 17,980) and distinct agents swung **4×** (112 → 1,141). That stability under a 10× volume swing is itself the evidence the ratio measures behaviour rather than headcount.

**The distinction that matters:** per-day *normalisation* would have been faking it. A ratio is a different instrument, not a normalised version of the broken one. Verdict, by the plan's own control rule: bash is flat, therefore the advisory is not landing — the "not landing" branch, not the "agents stopped doing the work" regression branch.

## Trap 4 — the instrument cannot see the compliant action

Two independent versions of this, both in one metric.

**(a) Something is interposed between the cause and the effect.** Compliance was defined as "did the session's *next* tool call use the named tool". But the advisory fires at `PreToolUse`, the command then runs, and a `PostToolUse` hook then calls `activity:report` — so a hook row sits between the fire and any agent action **by construction**. The position-1 comparison lands on the hook, whatever the agent did. Hook-origin rows were **189,576 of 301,133** invocations (63%) in one day. Excluding them moved the rate 0.007% → **0.081%**: real, and still \~0.

**(b) The compliant action writes no row at all.** `tool_invocations` records MCP calls only. Native client tools (`Read`, `Grep`, `Edit`, and native `Bash` itself) produce nothing. So for every file-read bucket, the ledger structurally cannot record the behaviour that would count as success. Of the 34 sessions that fired a `file-range-read` advisory in one day, the named tool was invoked **0 times** across 84,134 transcript rows, while those same sessions issued **564** native `Read` calls.

**The tell for both:** ask *"what would a compliant agent do, and does that action physically create a row in the table I am counting?"* before you count anything. The error is always directional — a missing row can only make the population look worse.

## Trap 5 — measuring compliance with an instruction that cannot be followed

The deepest one, and the one that inverts the conclusion. Per-bucket compliance split cleanly, and the variable is **tool reachability** — whether the named tool is in the firing session's envelope at all (D-079):

| named tool           | in envelope | compliance |
| -------------------- | ----------- | ---------- |
| `testing:run`        | yes         | 28.17%     |
| `build:typecheck`    | yes         | 20.00%     |
| `dev:pg_query`       | yes         | 7.41%      |
| `coord:orient`       | yes         | 1.25%      |
| `dev:service_health` | **no**      | 1.33%      |
| `logs:read`          | **no**      | 0.94%      |
| `capability:read`    | **no**      | 0.31–0.90% |
| `capability:git`     | **no**      | 0.00%      |

Every bucket at or above 7% names a reachable tool; no bucket naming an absent tool exceeds 1.33%. **Reachability is necessary but not sufficient** — `coord:orient` is reachable and still sits at 1.25%, because "call `coord:orient` to learn the time" is overhead an agent rationally declines. Reachability gates compliance; usefulness then determines it.

Why the framing change matters more than the numbers: *"agents prefer the native equivalent"* describes a **preference**, and invites a persuasion fix — sharper wording, promote the rule to `deny`. *"The tool is not in the envelope"* describes an **impossibility**, and the only fix that works is to put the tool in the envelope or name one already there. Promoting an absent-tool rule to `deny` under the preference reading would block the command while pointing at a tool the agent cannot call: a hard stop with no legal path.

**Gate every promotion on a reachability check of the named tool.** And note this was already known — two filings (2026-07-27, 2026-08-02) reported exactly this, both were closed, and two of the tools were still unreachable five weeks later.

## Trap 6 — the retention cliff, and the vocabulary

Before promising a before/after, check that the evidence table reaches back past your treatment boundary. Here it did not: fires began 2026-08-02, the deploy boundary was 2026-08-03, and `tool_invocations` retains only from **2026-08-22** with **zero** rows before the boundary. The before/after was therefore uncomputable — permanently, not pending — and so was any backfill re-resolution (D-076). A resolver that only touches unresolved rows compounds this: 71,184 fires keep their wrong verdicts forever, so fixing the predicate is **forward-only**.

The same class, one level down: the transcript store carries a **client-specific vocabulary** (`Bash` vs `exec`/`exec_command`), so a "fleet-wide bash share" silently excluded \~150k Codex shell calls — 3.5× the `Bash` population. And the same MCP tool appears under **two manglings** (dots vs underscores), so any per-tool aggregate matching one spelling reports roughly half its true count with no error.

## Pre-flight checklist

Before reporting any adoption or compliance rate:

1. **State the denominator in one sentence.** What must a row be to be eligible? If you cannot say it, you do not have a rate.
2. **State the ceiling.** Success is against the reachable population, never a round number.
3. **Name the compliant action, then confirm it writes a row** in the table you are counting.
4. **Check reachability** — can the population physically do the thing you are scoring them on?
5. **Check retention past your boundary** before promising a before/after.
6. **Read the vocabulary** — `GROUP BY` the type column and look at what is actually in there, including nulls and near-duplicate spellings.
7. **Prefer a ratio to a count** wherever headcount or volume varies.
8. **Read the code that writes the field.** Every trap above was one file-read away, and none was visible from the number.

## The meta-lesson

Four of these were found by *screening a claim I was about to publish*, not by investigating a suspected fault. The cheap tell every time was a **denominator question** — who else is in this table, under what name, and could they have produced the row I am looking for? Asking it costs one query. Not asking it produced a 0.007% figure that read as fleet-wide defiance and was, end to end, a description of the measuring apparatus.

## References

* Plan `bash-substitution-reachable-ceiling-2026-08-01` — D-051/D-053 (ceiling), D-071 (irreducible plumbing), D-076 (before/after uncomputable; per-bucket split), D-077 (the ratio control, and the retraction), D-079 (reachability correction).
* `packages/operator-core/lib/bash-substitution/fires.ts` — `resolveFireCompliance`, the hook-origin exclusion, and the unresolved-only gate.
