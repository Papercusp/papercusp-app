# @papercusp/overlap-clusters

Domain-free near-duplicate detection over embedded units. Finds pairs of units
from **different sources** that say the same thing, groups them into clusters,
and reports what it actually measured.

Nothing here knows what a "unit" is — a doc section, a prompt, a rule, a recipe.
The neighbour source is injected at the `configureOverlapScan()` seam.

```ts
import {
  bruteForceNeighbours,
  configureOverlapScan,
  describeOverlapReport,
  scanOverlap,
} from '@papercusp/overlap-clusters';

const units = [
  { id: 'doc-a#intro', group: 'a.md', vector: [/* … */] },
  { id: 'doc-b#setup', group: 'b.md', vector: [/* … */] },
];

const report = await scanOverlap(
  units,
  configureOverlapScan({ threshold: 0.92, neighbours: bruteForceNeighbours(units) }),
);

console.log(describeOverlapReport(report));
// "1 overlapping pair(s) in 1 cluster(s). Measured: 2 comparable unit(s) across 2 source(s); …"
```

## Why a neighbour provider, not a similarity matrix

All-pairs comparison is O(n²) over full embeddings: a 6,500-unit corpus of
384-dimensional vectors is ~21M pairs and ~8 billion multiply-adds — not
something to run in a scheduled sweep. Any host that stores embeddings already
has an ANN index that answers "the k units most like this one" in log time, so
the scan asks the host for candidates and keeps only the generic parts:
thresholding, the cross-source rule, symmetric de-duplication, union-find
clustering, and the census.

`bruteForceNeighbours()` exists for small corpora and tests. It is the only path
that reads `vector`; an ANN-backed provider ignores that field entirely.

## The load-bearing property: an empty result is not evidence

This kind of scan fails in one specific, expensive direction. If the threshold
is too high, the vectors were never populated, every unit landed in one group,
or the provider silently returns nothing, the scan reports **zero overlapping
pairs** — exactly what a genuinely clean corpus reports. The failure is
indistinguishable from success and it is *reassuring*, which is worse than an
error.

So there is no bare list. Every report carries:

- **`census`** — units in, units comparable, distinct groups, candidate hits,
  candidate pairs, pairs surviving the cross-source rule, pairs above threshold,
  pairs dropped by the cap, and dimension mismatches.
- **`inconclusive`** — `null` when the run measured a population that *could*
  have produced a finding; otherwise a sentence naming why the result is not
  evidence about the corpus.

> **A caller may treat `pairs: []` as "no overlap" only when `inconclusive === null`.**

`describeOverlapReport()` renders that rule as one sentence, so a result cannot
be quoted without its denominator.

Two related refusals follow from the same principle:

- `cosineSimilarity` returns **`null`**, not `0`, for mismatched vector
  dimensions. `0` would be indistinguishable from a genuinely unrelated pair, so
  a half-finished embedding backfill would read as a clean corpus.
- `configureOverlapScan` has **no default `threshold`**. The right value is a
  property of the corpus and the embedding model, not of this algorithm, and a
  silently-defaulted threshold is the likeliest cause of a confidently empty
  report. Calibrate it against the real corpus; a value carried over from
  fixtures will be wrong.

## API

| Export | Purpose |
| --- | --- |
| `configureOverlapScan(overrides)` | Resolve a config. `threshold` + `neighbours` required. |
| `scanOverlap(units, config)` | Run the scan → `OverlapScanReport`. Deterministic. |
| `clusterPairs(pairs)` | Union-find clustering, exposed for reuse. |
| `cosineSimilarity(a, b)` | Cosine, `null` on dimension mismatch. |
| `bruteForceNeighbours(units, onDimensionMismatch?)` | In-memory provider for small corpora/tests. |
| `judgeInconclusive(census, config)` | The blindness verdict, exposed for host-side reuse. |
| `describeOverlapReport(report)` | One sentence including the denominator. |

## What this deliberately does not do

- **No judgement of *why* two units overlap.** Overlap is a similarity fact.
  Deciding whether two passages *contradict* each other is a separate,
  model-dependent question and belongs to the caller.
- **No resolution.** It reports; it does not edit, retire, or file anything.
- **No embedding.** Vectors arrive already computed.
