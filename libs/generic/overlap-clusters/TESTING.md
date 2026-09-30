# Testing — @papercusp/overlap-clusters

Run: `npx vitest run` (from this directory), or via the repo's
`npm run test:file -- libs/generic/overlap-clusters/src/index.test.ts`.

## What's covered

`src/index.test.ts` — 26 cases in five blocks:

- **`cosineSimilarity`** — parallel/orthogonal values, zero-norm and empty
  vectors returning `0`, and the load-bearing one: mismatched dimensions return
  **`null`**, not `0`.
- **`configureOverlapScan`** — refuses a missing `threshold` or `neighbours`,
  rejects a nonsense `neighbourLimit`/`maxPairs` rather than coercing, and
  defaults `crossGroupOnly` on.
- **finding real overlap** — a cross-source near-duplicate is reported; a
  same-source one is excluded; `crossGroupOnly: false` re-includes it; an
  asymmetric provider that disagrees with itself yields one canonical pair at the
  higher similarity; two runs over the same input are byte-identical.
- **`clusterPairs`** — transitive merging into one cluster spanning every source.
- **blindness + calibration** — see below.

## The part that matters: blindness vs. calibration

The blindness block enumerates every way the scan can return **zero while having
measured nothing** — the failure that reads exactly like a clean corpus: a
corpus too small to hold a pair, a single-source corpus, a provider returning
nothing, a provider returning ids outside the scanned set, an unembedded corpus,
inconsistent vector dimensions, and a truncating `maxPairs` cap.

⚠ **Those cases alone prove nothing.** An implementation that hardcoded
`inconclusive` to a non-null string would pass every one of them.

The **calibration control** block is what makes them mean something. It asserts
that a corpus which is genuinely clean *and* genuinely measurable returns
`inconclusive: null` with `pairs: []` — and that the *same* corpus with the
threshold dropped **does** find pairs, which falsifies "it finds nothing because
it never compares anything". Read the two blocks as one test: the blindness
cases pin the positive direction, the control pins the negative, and neither is
sufficient alone.

This mirrors the repo's guard-falsifiability rule (root `CLAUDE.md`,
"Proving a guard is falsifiable"): a permanent in-test control plus a
calibration case the real subject must pass, with no mutation of the shared tree.

## Not covered here

Threshold *calibration* against a real corpus is deliberately out of scope for
this package — it is a property of the host's corpus and embedding model, not of
this algorithm. See plan `guidance-overlap-contradiction-scan-2026-08-08` P-003.
