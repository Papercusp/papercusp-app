# @papercusp/rrf

Reciprocal Rank Fusion — combine multiple ranked result lists into one,
without requiring score normalization between rankers.

```ts
import { rrfCombine, RRF_K_DEFAULT } from '@papercusp/rrf';

const fused = rrfCombine([
  { name: 'bm25',       list: [{ key: 'a', score: 9, row: rowA }, …] }, // best first
  { name: 'embeddings', list: [{ key: 'c', score: 0.8, row: rowC }, …] },
], RRF_K_DEFAULT); // k=60, classic value (Cormack et al. 2009)
// → [{ row, score, rankers: string[] }, …] sorted best-first.
```

`score(d) = Σ 1/(k + rank_i(d))` over each ranker `i` that returned `d`.
An item's `row` payload is taken from its first occurrence; `rankers`
lists each ranker that surfaced it (deduped by name).

Pure: no DB, no embeddings, no I/O, zero runtime dependencies. The
canonical use is fusing a BM25 ranking with a vector-similarity ranking
into one hybrid result, but it is domain-agnostic — any set of ranked
lists with stable `key`s works.
