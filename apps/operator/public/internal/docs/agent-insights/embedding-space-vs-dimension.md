# Vectors have a SPACE, not just a dimension — switching the embedder silently invalidates every stored vector
URL: /internal/docs/agent-insights/embedding-space-vs-dimension

EMBEDDER_DIM===384 is asserted everywhere; the embedding SPACE was asserted nowhere. Flipping memoryEmbedderMode makes stored vectors (OpenAI-384) and query vectors (BGE-384) structurally valid and semantically incomparable — no error, just noise. Migration 530's `<col>_mode` discriminator + a space-aware backfill predicate make the sweep self-healing. The 2026-07-10 bake-off sharpened the rule: the space is model + runtime + quantization + pooling + prompts, and truncation without MRL keeps recall while destroying hard-negative calibration.


## The trap

`memoryEmbedderMode` (`auto | openai | local | gemma | harrier | disabled`) picks the
embedder **at runtime**. Until 2026-07-10 every available embedder produced
**384-dimensional** vectors, so no dimension check could ever catch a mix-up:

| mode | model | dims |
| --- | --- | --- |
| `openai` | `text-embedding-3-small`, requested with `dimensions: 384` | 384 |
| `local` | `Xenova/bge-small-en-v1.5` (BGE-ONNX) | 384 |
| `gemma` | `onnx-community/embeddinggemma-300m-ONNX`, natively 768 → MRL-truncated to 384 + L2-renormalized (migration 534; the SEARCH/prose-surface space, and the lighter memory option — ~4× faster embeds, ~2.4GB less RSS than harrier) | 384 |
| `harrier` | `onnx-community/harrier-oss-v1-0.6b-ONNX`, native 1024, last-token pooling + L2 norm baked into the ONNX graph (migration 547 `memory_vec_harrier`; the MEMORY default since the 2026-07-10 P-015 owner flip — memory-side ONLY: the vector(384) prose surfaces stay gemma via the harrier→gemma readPreference fallback in `resolveBackfillEmbedder`/`buildQueryEmbedderResolved`, because harrier@384's rejection margin collapses, P-006) | 1024 |

`harrier` is the first mode with different native dims, which retired the flat
`EMBEDDER_DIM === 384` assumption (`reembed.ts` now carries a per-mode
`MODE_DIMS` map — without it every harrier re-embed row silently counted as an
error). A 1024-vs-384 mix-up at least fails loudly; every 384-vs-384 mix-up is
still silent, and that remains the normal case.

`gemma` makes the trap sharper, not softer: its vectors are *born* 768-dim and only
look like the others after Matryoshka truncation, and it uses asymmetric task
prompts (document vs query) — so a gemma-384 is incomparable with a BGE-384 *and*
with a gemma vector embedded under the wrong prompt. Same rule as always: **the
mode IS the space.** Switching to gemma re-embeds the corpus via
`POST /api/user/memory/reembed { from: <old>, to: 'gemma' }` (Settings → Memory
has buttons for it); mem0 writes land in `memory_vec_gemma`.

Every layer checks `vec.length !== EMBEDDER_DIM`. **No layer checked which model
produced the vector.** OpenAI-384 and BGE-384 are different vector spaces: cosine
similarity between them is meaningless. So flipping the pref leaves every
previously-stored vector structurally valid, non-null, correctly sized — and
semantically incomparable with the query vector, which the *same pref* also selects.

Nothing throws. Search returns confident, plausible-looking noise.

**Measured 2026-07-09**, right after switching to `local`: searching
`harness_shared.operator_turns` for a row **by its own exact text** ranked that row
**#6574 of 8383** (cosine distance `1.0336` — near-orthogonal to itself). After the
fix, the same probe returns distance `0.0000`.

## The space is the whole pipeline — measured (P-006 bake-off, 2026-07-10)

The embedder bake-off (`packages/operator-core/lib/memory/bench/embedder-eval-cli.ts`,
frozen gold set v1: 114 docs, 150 queries incl. 30 hard-negatives; report
`.papercusp/bench-reports/embedder-eval-2026-07-10-19-23-46.json`) turned "the mode
IS the space" into four sharper, measured claims.

### Same weights ≠ same space: runtime + quantization are space-defining

`ollama:embeddinggemma:300m` (GGUF-quantized, llama.cpp, 100% GPU) scored
**quality-identical** to our ONNX-CPU gemma — R@1 `.8083` on both, MRR `.8763` vs
`.8677`, rejection-margin `.1486` vs `.1576`. Same model card, indistinguishable
quality — and the vectors are **mutually incomparable**: a different quantization
and inference stack land points in a different space. Quality parity tells you
NOTHING about vector compatibility. A "cheap" runtime migration (say, for the GPU
speedup) is therefore a full re-embed of every surface, exactly like a model
change. Ollama showed no quality win, so the runtime stayed.

### Truncation without MRL keeps recall but destroys calibration

Gemma is Matryoshka-trained, so truncation is a supported operation — the D-001
dim sweep found 768/512/384 within noise (R@1 `.817`/`.825`/`.808`), degrading
only from 256 down (`.775`; 128 → `.667`). Harrier has **no documented MRL**.
Truncating its native 1024 to 384 (truncate-then-renormalize) looked fine on
recall — R@1 `.8583`, still above gemma — but the hard-negative **rejection
margin collapsed to `.0705`**, less than half gemma's `.1576` (harrier@1024:
`.1293`). Recall@k alone would have said "ship it"; only the rejection metric
caught that truncated-harrier can no longer tell *close* from *wrong*. Rule: a
truncated leg is its own space AND its own quality question — eval it with a
hard-negative/rejection metric, never recall alone. This is why the prose/registry
surfaces stay gemma even though harrier@1024 clearly won the memory-side eval
(R@1 `.8833`, MRR `.9286`, at ~4× CPU latency).

### Pooling can live inside the ONNX graph — and then your pooling code is dead weight

The `onnx-community/harrier-oss-v1-0.6b-ONNX` export bakes last-token pooling +
L2 normalization INTO the graph (a sentence-transformers head): the model's sole
output is `sentence_embedding` — there is no `last_hidden_state`. transformers.js's
`FeatureExtractionPipeline` assumes `last_hidden_state` and dies with the cryptic
`Cannot read properties of undefined (reading 'data')` under EVERY pooling
setting. The fix was not JS-side pooling (impossible — token states are never
exposed) but reading the named graph output directly: `embedViaWorker` gained an
`output` option (tokenize → run the model → return `out['sentence_embedding']`),
which `buildHarrierEmbedder` uses. Corollary: pooling + normalization placement
is part of the space — two exports of the "same model" that pool differently are
different spaces, and an export can hard-code that choice out of your hands.

### Two adoption gates that are not quality gates

- **License (D-005):** shipped defaults must be MIT/Apache-class. jina-v5 and
  SFR-Embedding-2_R are CC-BY-NC → disqualified regardless of leaderboard rank;
  harrier-oss is MIT → admissible.
- **Leaderboard ≠ our-domain rank:** harrier's MMTEB 69.0 vs gemma's ≈61
  translated to +.075 R@1 on OUR gold set — real, but far smaller than the
  leaderboard gap implies (ceiling effects: gemma already scores R@3 `.9417`
  here). Adoption decisions run on the P-001 eval, never on MTEB deltas.

### The sidecar is NOT a space change (D-002)

The shared embed sidecar (`:3384`) wraps the SAME `@papercusp/memory` builders —
model, task prompts, MRL truncation, ORT thread caps — so its vectors are
**bit-identical** to in-process (live-pinned 10/10 identical for gemma, exact-equal
both kinds for harrier). Consolidating processes onto it requires no re-embed.
Envs, wire contract, spawn/adopt and fallback semantics:
`agent-insights/embed-sidecar-runbook`.

## Why it could never self-heal

`embed-backfill.ts` resumed on `WHERE embedding IS NULL`. That predicate encodes the
assumption *"a vector, once written, is valid forever"* — false the moment the embedder
is a runtime choice. Foreign-space rows were never revisited, so a column that started
mixing could never converge. Caught mid-drift: **4 of 40** sampled `operator_turns` rows
were already BGE while 36 were still OpenAI, and the ratio climbed every 5-minute sweep.

## Who was affected

**Five** prose surfaces, all fed by `embed-backfill.ts`, each with one embedding column
and no discriminator:

- `harness_shared.operator_turns.text_embedding`
- `harness_shared.harness_escalations.body_embedding`
- `harness_shared.harness_brainstorm.content_embedding`
- `harness_shared.harness_decisions.body_embedding`
- `harness_shared.session_turns.text_embedding`

Downstream consumers of `buildQueryEmbedder()` — `coord:ask`'s knowledge tier,
`recipes/candidates.ts`, `cupboard/tool-find.ts`, `sessions:search` semantic mode.

**mem0's memories were immune.** They already store vectors in **per-mode tables**
(`memory_vec_openai` / `memory_vec_local` / `memory_vec_gemma` /
`memory_vec_harrier`) over one mode-independent `memory_canonical`. The prose surfaces simply never inherited that discipline. Switching
mem0 modes is therefore non-destructive and reversible — but still needs a **re-embed**,
because the target table only holds vectors written in *its* space.

## The fix (WI-3616)

1. **Migration `530-embedding-space-discriminator.sql`** — adds `<embedCol>_mode text`
   plus a partial index to all five tables. `NULL` = unknown space = stale.
2. **Space-aware predicate** in `embed-backfill.ts`:

   ```sql
   WHERE embedding IS NULL OR embedding_mode IS DISTINCT FROM $activeMode
   ```

   Use `IS DISTINCT FROM`, never `<>`: `NULL <> 'local'` evaluates to `NULL`, matches
   nothing, and silently reintroduces the original bug for every pre-migration row.
3. The `UPDATE` writes **vector and mode together**, so a row can never advertise a
   space it is not in. The sweep now converges a switched column back onto one space
   and then goes quiet.

### Postgres gotcha this nearly shipped with

Postgres derives a statement's parameter count from the **highest `$n` referenced** and
rejects a Bind that supplies a parameter the statement never uses:

```
could not determine data type of parameter $2
```

So the legacy (pre-530) path must **omit** the `mode` parameter entirely and shift its
PK placeholders from `$3` back to `$2` — not merely ignore it. Pinned by a test.

## If you switch the embedder

1. **Re-embed first, flip second.** Flipping first drops recall to whatever fraction
   already exists in the target space (it was 743/8746 ≈ 8.5% here) for the whole
   transfer window. Re-embedding first has **zero** recall gap: the old space keeps
   serving until the moment you flip.
2. mem0 memories: `reembedMemories(from, to)` (`POST /api/user/memory/reembed`).
   Idempotent (`ON CONFLICT … DO UPDATE`) and needs **no OpenAI key** — the source
   vectors are only a JOIN filter. Run it **out-of-band**: it is a serial loop and the
   HTTP route caps at `timeoutSec: 600`. Measured ~50–70 rows/s.
3. Prose columns: the space-aware sweep now heals them automatically, but it is capped
   at `BATCH_SIZE * 4` rows per table per 5-minute tick — force an immediate pass if you
   need search correct *now*. 28,231 rows took ~32 min on a loaded box.

## Verifying a space, cheaply

Re-embed a row's own stored text and compare to its stored vector:

- distance `≈ 0.0000` → that row is in the active space.
- distance `≈ 1.0` → foreign space (near-orthogonal). Search over it is noise.

Beware ties: identical texts (e.g. repeated fleet-update messages) share an identical
vector, so a self-lookup can legitimately rank #3 at distance `0.0000`. Assert on the
**distance**, not the rank.

## The detector that was missing

This bug was invisible for exactly as long as it existed — no log line, no exception, no
metric. Three call sites (`memory/configure.ts`, `agent-tools/search/embedder.ts`,
`search/embed-backfill.ts`) each independently re-derive the mode from the same pref
with subtly different cascades (embed-backfill's ignores the OpenAI-exhaustion cooldown
entirely). Any one drifting re-desynchronizes stored from query vectors. Tracked as
**EI-8913**: collapse them onto one resolver, and add a periodic self-check that embeds
a known row's own text and asserts it retrieves itself at distance ~0.
