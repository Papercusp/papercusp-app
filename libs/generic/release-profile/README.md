# @papercusp/release-profile

A generic, **pure** composite release-profile evaluator. Aggregates named
**components** — a rubric verdict, a hard operational gate, or any other
pass/fail/unknown check — into ONE go/no-go verdict, enforcing staleness and
lineage-match policy *uniformly* so no individual checker has to reimplement them.

## Why

A release decision usually reads several signals (a set of ratified rubric
scorecards, a deploy-staleness gate, a test-suite gate, …) and has to combine them
into one call. Left to ad-hoc glue code, each signal's freshness and "is this
evidence about the SAME candidate" checks get reinvented slightly differently every
time — and the first one that's skipped is a silent hole a stale or
mismatched-generation verdict can walk straight through. This module is the single
composition point: components report a raw measurement, the evaluator applies the
freshness/lineage policy identically to all of them, and GO requires every
*mandatory* component to still read `'pass'` after that policy is applied.

## What's in it

| Export | What |
|---|---|
| `evaluateReleaseProfile(spec, opts?)` | Run every component's `check()` (concurrently), apply staleness + lineage policy, and return the composite `ReleaseProfileVerdict`. |
| `lineageMismatches(actual, expected)` | Pure field-by-field lineage compare — a field missing on either side is never judged a mismatch. |
| `ComponentSpec` | One component's declaration: `key`, `title`, `mandatory`, optional `maxAgeMs`, and its `check()`. |
| `ComponentCheckResult` | What a checker reports: raw `verdict` (`pass`\|`fail`\|`unknown`), `reason`, `measuredAt`, `evidence[]`, optional `lineage`. |
| `ReleaseProfileVerdict` | `{ go, reason, components[] }` — the composite outcome, with every component's policy-applied verdict and evidence kept for audit. |

## The seam — inject `check()`, the evaluator only combines

The lib names no rubric store, no gate, no HTTP/DB client. Each component is just an
async function that returns a `ComponentCheckResult`:

```ts
import { evaluateReleaseProfile, type ComponentSpec } from '@papercusp/release-profile';

const rubricComponent: ComponentSpec = {
  key: 'pot-coordination-health',
  title: 'Pot coordination health rubric',
  mandatory: true,
  maxAgeMs: 6 * 60 * 60_000, // 6h freshness window
  async check() {
    const scorecard = await fetchLatestCompleteScorecard('pot-coordination-health');
    if (!scorecard) return { verdict: 'unknown', reason: 'no scorecard on record', measuredAt: new Date().toISOString(), evidence: [] };
    return {
      verdict: scorecard.worstRating === 'broken' ? 'fail' : 'pass',
      reason: `worst criterion rating: ${scorecard.worstRating}`,
      measuredAt: scorecard.createdAt,
      evidence: [{ ref: scorecard.issueId, kind: 'scorecard' }],
      lineage: { sha: scorecard.gradedGeneration?.sha ?? null },
    };
  },
};

const verdict = await evaluateReleaseProfile({
  profileRef: 'public-release-readiness',
  expectedLineage: { sha: currentCandidateSha },
  components: [rubricComponent, deployStalenessGate, /* … */],
});

if (!verdict.go) console.log(verdict.reason); // exactly which mandatory component(s) blocked, and why
```

## The refuse-GO contract

`evaluateReleaseProfile` returns `go: true` **only** when:

1. at least one component is declared (an empty profile refuses GO — nothing was checked);
2. at least one component is `mandatory` (an all-advisory profile refuses GO — nothing actually gates it);
3. every mandatory component's **policy-applied** verdict is `'pass'` — where policy-applied means:
   - **stale** overrides a raw `pass` when the evidence's `measuredAt` is older than the component's `maxAgeMs` (or unparseable);
   - **lineage-mismatch** overrides a raw `pass` when the profile declares an `expectedLineage`, the component stamped a `lineage`, and a field both sides declare disagrees;
   - a checker that **throws** is caught and downgraded to `'unknown'` — a broken checker refuses GO, it never crashes the evaluation or silently passes.

A non-mandatory (`mandatory: false`) component is always reported in `components[]`
but never blocks GO — use it for informational/advisory signals.

## Tests

```bash
npm run test:file -- libs/generic/release-profile/src/evaluate.test.ts
```

Deterministic, no I/O — every case fabricates its own checker and injects `now`.
