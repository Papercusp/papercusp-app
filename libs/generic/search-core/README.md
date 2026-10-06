# @papercusp/search-core

Engine-agnostic **search-relevance core**, shared across Papercusp and Restart.
Builds on [`@papercusp/rerank`](../rerank) (the cross-encoder primitive) and adds
the valuable two-stage relevance logic that used to live inside Restart's
`catalog.service.ts`:

- **`DEFAULT_RERANK_INSTRUCTION`** — the §1d instruction-following template
  (head-noun item-type rule: rank the product above its parts/accessories,
  defer to part-queries, prefer brand/model match).
- **`buildRerankDoc(fields, mode)`** — the rerank "document" text
  (`title` / `title_category` / `title_desc`).
- **`rewriteQuery(raw, opts)`** — brand-aware spell/typo + intent rewrite
  ("del laptop" → "dell laptop"), cached + fail-safe.
- **`llmRerank(query, rows, opts)`** — §1e live LLM category-match pass
  (infers the wanted item type and demotes accessories), fail-safe.
- **`shouldEscalate(scores, opts)`** — §5 tiered-escalation gate.
- **`rankWithReranker(query, docs, opts)`** — the two-stage orchestrator tying
  it all together (instruction rerank → bucket + quality tiebreak → escalate →
  LLM pass → slice).
- **Metrics** — `dcg`, `ndcg`, `ndcgAtK`, `precisionAtK`, `accessoryAtK`: the
  shared eval-harness contract so both repos measure relevance identically.
- **`runChunkingBench(input)` / `decideChunking(result, rule)`** — the chunking
  retrieval bench. Does splitting long rows into separately embedded chunks make
  text past the embedder's window findable, and does best-match pooling demote
  the short rows that were never chunked? Rank-based (MRR, recall@1/@5 of the
  true parent among the other rows of its fold), with the corpus, the splitters
  and the embedder injected. See [the chunking bench](#the-chunking-bench).

## The chunking bench

```ts
import { runChunkingBench, decideChunking, drawTailProbe, drawShortProbe } from '@papercusp/search-core';

const result = await runChunkingBench({
  folds: [{ rows, probes }],            // rows: { key, text, header?, parentDoc }
  splitters: { window: (row, max) => splitWindows(row.text, { size: 1500, overlap: 250, maxChunks: max }) },
  maxChunks: [8, 16, 32],               // embedded once at 32; smaller caps scored as prefixes
  minChunkTextChars: 2000,              // the parent vector's window
  embed: (kind, texts) => myEmbedder(kind, texts),  // 'document' | 'query', production's space
});
const decision = decideChunking(result, {
  minTailProbes: 20, minShortProbes: 20, minTailMrrGain: 0.05, maxShortMrrDrop: 0, mrrTolerance: 0.02,
});
```

- `parentDoc` is the exact text the host's parent vector embeds; `drawTailProbe`
  only returns a window that does not occur in it, and `drawShortProbe` only one
  that does.
- A splitter's cap must truncate (`split(row, k)` is the first k of
  `split(row, K)`), because smaller caps are scored as prefixes.
- Ties rank AGAINST the true parent, and a probe whose text also occurs in
  another row of its fold is dropped and counted, never scored.
- Papercusp's CLI over its own collections:
  `packages/operator-core/lib/memory/bench/chunking-bench-cli.ts`.

## The width sweep: how much of each document should one vector embed?

`runWidthSweep` measures how far into a document a single embedded prefix still
finds it. Each usable document gives one probe (`probeLength` characters cut at
`probeStart`); the probe is then ranked against every document embedded at each
width, and the sweep reports the rank-based MRR and recall@1 of the probe's true
parent. The embedder is the only seam: pass your own, in your production space.

```ts
import { runWidthSweep } from '@papercusp/search-core';

const sweep = await runWidthSweep({
  docs,                                  // { key, text }[], most preferred first
  widths: [500, 1000, 2000, 4000],       // embedded prefix lengths; the first is the baseline
  probeStart: 3000,                      // probes come from beyond the narrow widths
  sample: 200,                           // at most this many documents take part
  embed: (kind, texts) => myEmbedder(kind, texts),  // 'document' | 'query'
  chunkArm: { label: 'chunk1800', split: (text) => mySplitter(text) },  // optional
});
for (const arm of sweep.arms) console.log(arm.label, arm.mrr, arm.recallAt1);
```

- A document is used only if it is long enough to hold the probe and its probe
  is distinctive (`isDistinctiveProbe`); the sweep refuses to report on fewer
  than `minDocs` (default 10) usable documents.
- `identicalToFirst` counts documents whose vector at that width is identical
  (cosine above 0.9999) to the first width's, which shows where longer prefixes
  stop changing anything.
- The optional chunk arm embeds every chunk and scores a document by its best
  chunk, so one run compares wider single vectors with chunking.
- Papercusp's CLI: `packages/operator-core/lib/memory/bench/turn-truncation-width-cli.ts`.

## Design

**No project dependencies.** Typesense, Postgres, the catalog schema, and the
brand vocabulary are NOT imported here — they're injected as config/callbacks:

| Project-specific input | Injected as |
|---|---|
| brand vocabulary (skip rewriting exact brand queries) | `rewriteQuery({ isKnownBrand })` |
| per-row title for the LLM pass | `llmRerank({ getTitle })` |
| completeness tiebreak | `rankWithReranker({ qualityScore })` |
| env gates (`QUERY_REWRITE`, `LLM_RERANK`, …) | `enabled` / `escalation.tiered` flags |
| API keys | `apiKey` opts (fall back to `OPENAI_API_KEY` / `ZEROENTROPY_API_KEY`) |

The contract mirrors `@papercusp/rerank`: `{ query, docs: [{ id, text, row }], opts }`
→ ordered rows — just with more stages. **Fail-safe throughout**: a rerank or
LLM outage degrades to retrieval order, never an error.

## Consuming it

`@papercusp/*` libs here are **src-as-entry** workspaces (`main: src/index.ts`),
resolved via a direct `node_modules/@papercusp/<name>` symlink + the
`tsconfig.base.json` path map — no build step, no stale-dist hazard. Runtimes
that transpile TS (tsx — shop-api, scout-service, the eval scripts) load the
source directly.

```ts
import {
  rankWithReranker, buildRerankDoc, DEFAULT_RERANK_INSTRUCTION,
} from '@papercusp/search-core';

const docs = items.map((it) => ({
  id: it.groupId ?? it.id,
  text: buildRerankDoc({ title: it.title, description: it.desc, productType: it.type },
                       process.env.RERANK_DOC_MODE as any),
  row: it,
}));

const ordered = await rankWithReranker(query, docs, {
  limit,
  instruction: process.env.RERANK_INSTRUCTION === '1' ? DEFAULT_RERANK_INSTRUCTION : undefined,
  qualityScore: (row) => completenessScore(row),
  escalation: { tiered: process.env.LLM_RERANK_TIER === '1' },
  llm: { enabled: process.env.LLM_RERANK === '1', getTitle: (row) => row.title ?? '' },
});
```

## Status / portability

Restart is the **first consumer** (`apps/shop-api/.../catalog.service.ts`).
Papercusp's search migrates onto this next. The lib is `private` — promotion to a
`github.com/Papercusp/search-core` git submodule (the established `@papercusp/*`
mechanism) is packaging hygiene deferred to an explicit go-ahead; nothing about
the API changes when it moves.
