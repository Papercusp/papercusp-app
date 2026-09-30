# Code intelligence: which backend answers which question, and how to operate them
URL: /internal/docs/agent-insights/code-intelligence-backends-runbook

The operator runbook for code-intelligence backends (rg, LSP, GitNexus, ast-grep, packers): the ratified routing contract, pinned versions, six high-risk failure modes (including the fail-closed raw query path), automatic GitNexus crash-residue recovery, and — new 2026-09-05 — the GitNexus embeddings leg: how the vector index is populated and refreshed by the hourly full rebuild, what a live tick costs (6,446 s vs 2,343 s isolated), and how it fails (WI-39394, gitnexus-embeddings-enablement-2026-09-05).

The operator runbook for the code-intelligence backends (rg, LSP, GitNexus, ast-grep, packers): the ratified routing contract, the exact pinned versions and where they live, the SIX failure modes that return a CONFIDENT WRONG ANSWER rather than an error, and the crash-residue mode that once killed GitNexus fleet-wide while it still advertised 17 working tools. Re-verified against source at HEAD 2026-09-03 under plan code-intelligence-routing-lsp-gitnexus-2026-08-20; the GitNexus embeddings leg (§8) was added 2026-09-05 under plan gitnexus-embeddings-enablement-2026-09-05.

> Authored as P-019 of `code-intelligence-routing-lsp-gitnexus-2026-08-20`. The
> routing contract is D-001; the exact backend/version record with every rejected
> alternative is **D-048** on that plan. This page is the operational half: how to
> call each backend, how to repair it, and how it lies to you.
>
> Re-verified against source 2026-09-03. Two things changed materially since the
> 2026-08-21 cut and are called out where they land: the call-graph question now
> routes to `graph:query` (D-058), and GitNexus crash residue is now recovered
> AUTOMATICALLY (§4) — the older "delete these two files by hand" instruction is
> superseded and should not be followed.
>
> Extended 2026-09-05 under `gitnexus-embeddings-enablement-2026-09-05` (its
> D-002; WI-39394): the GitNexus VECTOR leg is now populated and refreshed by the
> hourly reindex, which became a FULL rebuild per tick with an embedding-cache
> restore. The old §5 "unexplained `analyze` duration" caveat is retired — the
> incremental write set was the driver — and §8 is the operating guide for the
> embeddings leg, including the one failure mode that needed a vendored patch and
> the re-provision step (§2) that patch adds.

## 1. The routing contract — question class decides the backend

Each row is a *question class*, not a preference. Picking by habit rather than by
question is what the contract exists to stop.

| the question                                 | the authority                                                | not                                                                                |
| -------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| definition, references, type truth           | `lsp:query` — real compiler semantics                        | a grep for the declaration: it cannot resolve shadowing or re-exports              |
| who CALLS this symbol                        | `graph:query { op:'callers' }`                               | `gitnexus.impact { direction:'callers' }` — silently answers **callees**, see §3.6 |
| call chains, impact radius, topology         | `gitnexus.context` / `gitnexus.impact` (dot form, not colon) | `gitnexus.query` — see §3.1                                                        |
| structural code patterns (shape, not text)   | the ast-grep facade                                          | a regex that approximates an AST                                                   |
| an exact keyword or phrase                   | `search:fulltext`                                            | `ILIKE '%…%'`                                                                      |
| a paraphrased concept                        | `search:semantic`                                            | keyword search that misses the wording                                             |
| exhaustive exact-text sweep                  | plain `rg` / `grep` — still the right tool                   | a graph query, which is indexed and can lag                                        |
| packaging evidence for a reviewer or a model | `code:pack` — strictly POST-retrieval                        | a raw packer binary; it skips the pinned version and the secret rails              |

**Curated code-intelligence tools are namespaced by PLANE, never by vendor**
(D-058): the curated facade is `graph:query`, not `gitnexus:query`. The dotted
`gitnexus.*` names above are the raw *plugin* surface, which is a different thing
and carries the traps in §3. Prefer the curated `graph:query` where it covers the
question — it validates its arguments, where the raw plugin does not (§3.6).

The LSP surface registers as **one** tool with an `op` enum, not seven separate
tools (D-011) — so it is `lsp:query { op: … }`, and a missing `op` is the usual
first-call mistake.

## 2. What is installed, and where

Exact versions, read from the live install and recorded in full in D-048
(gitnexus re-confirmed at 1.6.9 on 2026-09-03):

| backend                                     | version                     | location                                                               |
| ------------------------------------------- | --------------------------- | ---------------------------------------------------------------------- |
| typescript-language-server                  | 6.0.0                       | `~/.papercusp/vendor/lsp`                                              |
| tsserver (via transitive `@typescript/old`) | stock typescript 6.0.3      | `~/.papercusp/vendor/lsp/node_modules/@typescript/old/lib/tsserver.js` |
| rust-analyzer                               | 1.97.1 (8bab26f 2026-07-14) | rustup component, `stable-x86_64-unknown-linux-gnu`                    |
| gitnexus                                    | 1.6.9                       | `~/.papercusp/vendor/gitnexus/node_modules/.bin/gitnexus`              |
| repomix                                     | 1.18.0                      | `~/.papercusp/vendor/repomix`                                          |
| code2prompt                                 | 4.2.0                       | `~/.papercusp/vendor/code2prompt`                                      |

Three things about this table bite people:

**The two TypeScript versions are both correct.** The vendored `typescript`
dependency is `@typescript/typescript6@6.0.2`, which ships **no** `tsserver.js`.
The language server is therefore pointed at the *transitive* `@typescript/old`
— stock typescript, resolved here to 6.0.3 — which does ship it (D-009). Seeing
6.0.2 and 6.0.3 side by side looks like drift and is not. `@typescript/old` is an
alias rather than a publishable package (`npm view` 404s it), so the adapter must
`require.resolve` it and fail loudly if absent; an npm rehoist can move it.

**Everything is vendored under `~/.papercusp/vendor`, never shared workspace
`node_modules`.** This is load-bearing on a shared tree, not tidiness: a bare
install into the workspace rewrites `node_modules/.bin` underneath every peer
agent's in-flight test run.

**The gitnexus bridge ships a GENERATED runtime artifact.**
`libs/papercusp/plugins/gitnexus-bridge/index.cjs` is built from `index.ts` — it
carries a `DO NOT EDIT` banner saying so. **Editing `index.ts` alone never reaches
the running bridge**; you must regenerate:

```bash
npm run gen:gitnexus-bridge          # rebuild index.cjs from index.ts
npm run gen:gitnexus-bridge:check    # verify the artifact matches its source
```

This is the single most common "I fixed the bridge and nothing changed" cause.
`runtime-artifact-parity.test.ts` in that directory guards the drift, so a stale
artifact fails there rather than silently serving old code.

Re-provision the vendored backends with the same isolation:

```bash
npm install --prefix ~/.papercusp/vendor/lsp \
  typescript-language-server@6.0.0 'typescript@npm:@typescript/typescript6@6.0.2'
npm install --prefix ~/.papercusp/vendor/gitnexus gitnexus@1.6.9
node scripts/vendor-gitnexus-patch.mjs          # REQUIRED after any gitnexus (re)install — §8.4
node scripts/vendor-gitnexus-patch.mjs --check  # VENDOR_GITNEXUS_PATCH status=present
```

**The gitnexus install is NOT complete until the vendor patch is applied.** Stock
1.6.9 aborts every post-bootstrap `--embeddings` run on a duplicated primary key
(§8.4). `scripts/vendor-gitnexus-patch.mjs` is idempotent (re-running on a patched
tree is a no-op), `--check` reports `present`/`absent` without writing, and
`packages/operator-core/lib/doc-claims/gitnexus-vendor-embedding-upsert.test.ts`
pins the marker on this box — a fresh install that skips the step goes red there
rather than at the first hourly tick after bootstrap.

## 3. Six high-risk failure modes: confident wrong answers or a hard-crashed evidence channel

This is the section worth reading before you trust a result. Five entries fail
*toward* a plausible answer, so nothing looks broken. The raw natural-language
query path is worse: current builds can crash the shared MCP child, so the bridge
now fails it closed before dispatch.

### 3.1 `gitnexus.query` is unavailable and fails closed before dispatch

This path has never had a stable trustworthy result contract. D-021 measured
\~20 unranked rows whose content ignored the query; WI-35557 later measured empty
results. At P-019 acceptance on 2026-09-04, two independent real-symbol probes
instead killed the shared GitNexus MCP process with SIGSEGV (D-065). That crash
also removes the sibling `context` / `impact` / `trace` evidence channel until the
child restarts.

The bridge therefore refuses `gitnexus.query` locally **before** spawning or
calling the child. Do not probe it to discover which historical outcome a runtime
has. Use `rg` for keywords, `gitnexus.context` for an exact symbol already known by
name/uid, and `graph:query` for callers/callees/topology. Guidance that puts
`gitnexus.query` in recommendation position is a lint failure (D-042); guidance
that asserts one absolute row outcome is stale (D-065).

### 3.2 A language server queried before project load returns the WRONG location

Not an error — a plausible wrong answer (D-010). Readiness must come from the
server's own progress signal, never from an idle heuristic: a server still
indexing answers "no references" indistinguishably from one that is genuinely
ready (WI-40224). rust-analyzer declares `requiresProgressSignal`.

### 3.3 GitNexus line numbers are ZERO-indexed

Every other surface here is 1-indexed. Normalize before citing, or every citation
lands one line off — close enough to look right in review (D-008).

### 3.4 `Unknown namespace(s): gitnexus` means the bridge has not deployed

It does **not** mean "no call chains exist". Fall back to `rg` + `lsp:query` for
that question class until the pinned-resolver fix deploys, and never read the
absence as evidence about the code.

> A related structural trap, fixed but worth knowing: widening the language union
> without adding a `LANGUAGE_SPECS` entry once resolved a new language to the
> *rust-analyzer* binary while labelling its documents `rust` (WI-40250). The
> `Record<LspLanguage, LanguageSpec>` is exhaustive by construction — do not relax
> it to `Partial<…>` or an index signature.

### 3.5 A STALE GitNexus index answers from the commit it last indexed

`gitnexus` answers happily against whatever it indexed last and does not warn at
query time, so a stale index is indistinguishable from a fresh one in the result.
Measured 2026-08-21: `Indexed commit: 1b6621f` against `Current commit: ce1545d`,
status `stale`, on a 5.3G index built \~50 minutes earlier. On a tree this active,
under a git-sync routine that commits continuously, the index goes stale within
the hour.

The consequence that costs you: any *correctness* measurement taken against a
stale index measures INDEX LAG and reports it as routing quality. Check with
`gitnexus status` (want `Indexed commit` == `Current commit`) and re-run
`gitnexus analyze` IMMEDIATELY before measuring — not at the start of a session
that will still be running an hour later.

### 3.6 `gitnexus.impact` silently INVERTS the answer on an unrecognized `direction`

The raw plugin's `direction` accepts only `'upstream' | 'downstream' | 'both'`
(`gitnexus-facade.ts`), and an unrecognized value is not rejected — it falls
through to the `?? 'downstream'` default. So `direction:'callers'`, which reads
perfectly naturally, returns **callees**: the exact opposite of what was asked,
self-reported as `epistemic:"exact"`, byte-identical to what a nonsense direction
returns (measured, WI-2142910).

Use `graph:query { op:'callers' }` instead. `callers`/`callees` are first-class
ops there (`contracts.ts`), it returns call sites with `line1`, it excludes the
definition site, it reports index staleness — and, decisively, it **rejects** a
bad op rather than inverting the answer.

## 4. When GitNexus is dead fleet-wide: crash residue and automatic recovery

The operational failure you are most likely to actually hit, and the one whose
symptom tells you nothing useful.

**Symptom.** An opaque `gitnexus mcp process exited` on every call, or a native
SEGFAULT from the LadybugDB binding. Measured 2026-08-21 (D-016): the 20-minute
analyze timeout SIGKILLed the process group, and from that moment **both the CLI
and the MCP bridge died on every call — GitNexus was 100% dead fleet-wide while
still advertising 17 working tools.** Nothing reported itself as broken.

**Cause.** A SIGKILLed `gitnexus analyze` leaves the on-disk index in a
crash-inconsistent state. Every read-only open then replays a pending WAL and
segfaults. There are three distinct residue shapes, and the state space matters:

| residue kind      | on disk                                      | how it got there                                           |
| ----------------- | -------------------------------------------- | ---------------------------------------------------------- |
| `orphan-shadow`   | shadow present, **no** database              | killed BEFORE promoting the shadow                         |
| `orphan-wal`      | database + pending `lbug.wal`, **no** shadow | killed AFTER promoting                                     |
| `dead-shadow-wal` | database + an EMPTY, stale shadow            | killed mid-build (the 20-minute timeout does exactly this) |

**Recovery is now AUTOMATIC — do not hand-delete anything.** `cleanCrashResidue()`
runs as a preflight on every `gitnexus-reindex` tick *and* fires immediately after
a timeout kill, so reads stay answerable instead of segfaulting until the next
tick. Superseded guidance told operators to delete `lbug.shadow` and
`lbug.wal.checkpoint` by hand; that is no longer correct and risks racing the
recovery.

What you should know when you look at a live `.gitnexus/`:

* **`lbug.wal.missing-shadow.<timestamp>-<id>` files are QUARANTINED residue, not
  corruption.** Recovery moves WAL residue aside rather than destroying evidence.
  They are safe to leave; they are the audit trail of a recovered crash.
* **A WAL sitting ALONGSIDE a shadow is a build genuinely in progress and is never
  touched.** That is what keeps recovery from firing on a concurrent `analyze`.
* **A shadow a live writer still holds open is deliberately SPARED.** Recovery
  probes writer liveness via `/proc` and only cleans what is provably orphaned;
  when that probe is unavailable it falls back to a zero-byte size proxy and says
  so, because that proxy cannot see a mid-write orphan.
* ⛔ **Never delete `lbug` itself.** It is the database, not residue — 5.19 GB on
  this box, and a rebuild costs \~10–20 minutes fleet-wide.

**Why deleting a stray WAL is safe, precisely** — two measured facts, not
assumptions: (1) a healthy index carries no WAL at all, verified by repeated
successful reads, so a WAL is always a writer's residue rather than steady state;
and (2) the preflight runs immediately before a full `analyze` that rebuilds the
index wholesale, so discarding pending WAL data cannot lose anything the next step
would have used.

**Diagnosis is no longer opaque.** The bridge's close handler forwards `(code,
signal)` plus a bounded ring of the child's last stderr lines, and it states an
EMPTY stderr as a *finding* ("abrupt or native crash") rather than omitting the
section — an absent explanation and an absent section used to look identical.

## 5. Performance you should expect

Measured at HEAD, two runs:

|                  | TypeScript        | rust-analyzer       |
| ---------------- | ----------------- | ------------------- |
| cold start       | 3,917ms / 3,418ms | 10,760ms / 11,322ms |
| steady-state RSS | 66.7 MB           | 2,817 MB            |

The rust cold start exceeds the nominal budget. That is an **accounted, bounded**
exceedance rather than a regression, and it is deliberately not pinned in both
directions because it drifts \~562ms run to run (D-046).

**Warm-start latency is dominated by PROJECT LOAD, not by query cost.** A
definition on a warm server took 21,305ms — and the cause was established by a
discriminating experiment rather than inference: the same query, asked first on a
cold server with no references call anywhere before it, reproduced the timing
almost exactly, which made the rival explanation impossible by construction
(D-047). Loading `operator-core` costs \~21.7s against \~3.9s for a small package,
while adopting a *second* project on an already-warm server costs only 539ms.

The practical consequence: warm-up, if it is ever added, must be **per-project
and demand-driven**. An eager version is actively harmful — tsserver serialises,
so prewarming projects nobody asks about delays the queries someone is waiting on.

**`analyze` duration is a settled model now — the INCREMENTAL WRITE SET was the
driver, and backlog size never predicted it.** The caveat that used to sit here
recorded two runs straddling the 20-minute timeout in the wrong order (592s at 77
commits behind succeeded; 1,201s at 35 commits behind timed out) and called the
duration unexplained. It is explained: gitnexus 1.6.9 defaults to an INCREMENTAL
path whose cost is the changed-files + importer-BFS write set, which bears no
relation to commits-behind — and on this graph a large write set does not merely
run long. Measured 2026-09-05, twice, on a 296-changed / 91-added / +6,839-importer
set: the incremental writeback breached the 16 GiB LadybugDB ceiling \~35–45 min in
(`Maximum database size of 17179869184 bytes has been reached` → `manual WAL
checkpoint failed after retries` → SIGSEGV), after the same path had timed out the
hourly tick \~10× over the preceding three days. The routine therefore passes
`--force` on EVERY tick (D-002 of `gitnexus-embeddings-enablement-2026-09-05`), and
a full rebuild has a stable, measurable cost:

| pass (2026-09-05, 246,622 nodes, under fleet load)                                                 | wall             | peak RSS                                                                            | notes                                                                                    |
| -------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| full rebuild, no embedding work                                                                    | \~14.5–27.7 min  | \~15 GiB                                                                            | parse \~10 min + LadybugDB load; 27.7 min was the busy-box run                           |
| + COLD embedding of 217,120 nodes (the one-shot bootstrap, §8.3)                                   | 3,139s (52 min)  | 14.9 GiB (15,633,516 kB)                                                            | embedding phase 2,265s ≈96 nodes/s on cuda, 2.3–3.2 GiB RSS, 1.3 GiB GPU                 |
| + cache RESTORE + re-embed of changed nodes (every hourly tick)                                    | 2,343s (39 min)  | 15.7 GiB (17.3 GiB on run #3)                                                       | run #4, `/tmp/wi39394/run4-embed-run.log`; database file 5.3 GiB                         |
| the SAME tick as the routine runs it — LIVE root, pc-heavy nice 10 / ionice idle, \~75 live agents | 6,446s (107 min) | \~5.2 GB RSS observed (4.5→5.2 GB in the insert phase, 1.3 GiB GPU while embedding) | first live tick 2026-09-05 18:32:12Z→20:19:38Z (§8.2); 248,736 nodes, 201,473 embeddings |

`GITNEXUS_ANALYZE_TIMEOUT_MS` is sized from the LAST row — the LIVE tick — with
\~1.54× headroom (165 min, D-004). It was first cut from the isolated run #4 at 70 min
(D-002) and the very first live tick exceeded that by 37 minutes: the routine runs
analyze NICED on a LOADED box, and the isolated measurement under-predicts it 2.75×.
Do not size it from an isolated re-measurement, do not size it from the 309s cold
figure of the 2026-08 graph, and do not read the hourly cron as a ceiling on it: a
tick that fires while a slow run is still writing is skipped by the in-flight check
(§8.2), so the timeout only has to bound a genuinely wedged indexer. Two more
ceilings sit around it: the DBOS per-fire ceiling (`GITNEXUS_REINDEX_ROUTINE_TIMEOUT_MS`,
analyze budget + 15 min, registered as `routineTimeoutMs` — without it the fire runs
under the 2-hour default, which is BELOW the analyze budget, §8.2) and the child's own
scope deadline (`managedSpawn` `RuntimeMaxSec`, which is what bounds an orphan, §8.2).

**Index footprint.** `.gitnexus/` measured 6,558 MB on 2026-09-03 (`lbug` 4,946 MB

* `parsedfile-cache` 1,132 MB + `parse-cache` 475 MB) against a 2,048 MB nominal
  budget — an accounted, bounded exceedance recorded in `KNOWN_INDEX_DISK_EXCEEDANCES`
  rather than a live alert, so that a day-one-red gauge does not train everyone to
  ignore it. Separately, `GITNEXUS_LBUG_MAX_DB_BYTES` (16 GiB) is the LadybugDB mmap
  outage cliff — a different quantity from the selection budget, and not derivable
  from it.

## 6. Verifying a backend is genuinely answering

The recurring mistake is accepting a green suite that silently skipped.

* **Check the binaries resolve at the exact paths the specs use** — and pair the
  check with a positive control on a path you know exists. An `ls` of a missing
  path and an `ls` of a present one both print nothing useful once the exit code
  is discarded, so an absence claim without a control is not evidence.
* **Run the live suites:** the bakeoff (`code-intel-bench.integration.test.ts`)
  exercises both real servers; the facade and acceptance-corpus suites cover
  routing and fixtures. A bakeoff that reports success having *skipped* both
  servers looks identical to one that passed.
* **Check the GitNexus index is FRESH, not merely present** — `gitnexus status`
  must show `Indexed commit` == `Current commit`. A stale index answers without
  erroring (§3.5), so "gitnexus responded" is not evidence the answer is current.
* **After a reindex, check the CANARY, not just the exit code.** The reindex
  routine runs a post-analyze probe (file / symbol / call-edge / def-edge counts
  plus a name round-trip) and treats a clean exit with a failed canary as failure,
  because an `analyze` can exit 0 having produced an index that answers nothing.
* **Know what the corpus does not cover.** Interface implementations / type
  definitions and rename preview are UNEVALUATED. Do not claim coverage the
  corpus does not have.

## 7. Rejected alternatives, and the evidence that rejected them

Recorded so they are not re-proposed. Each was considered and measured, not
dismissed.

**Raising `GITNEXUS_ANALYZE_TIMEOUT_MS` to stop the crash-residue wedge.**
Rejected (D-016): it moves the cliff without removing it, and ANY SIGKILL —
timeout, OOM, reboot — reproduces the identical residue. Recovery has to be
unconditional at the kill site, which is what shipped.

**Guarding crash residue with the single `shadow && !db` predicate.** Rejected
after it failed in production: that predicate is one corner of a 2×2, and with the
shadow *absent* it no-ops — so the wedge it was written to end recurred verbatim in
the direction it did not test. The generalised lesson, recorded as D-016: a
crash-consistency guard must cover the whole state space of the artifacts it
protects, not the one corner that was observed failing.

**Deleting `lbug` to clear a wedged index.** Rejected: it is the database, not
residue. Deleting it converts a seconds-long residue cleanup into a \~10–20 minute
fleet-wide rebuild.

**Eager LSP project warm-up.** Rejected (D-047): tsserver serialises, so
prewarming projects nobody asked about delays the queries someone is waiting on.
Any warm-up must be per-project and demand-driven.

**Deriving the index-disk budget from `GITNEXUS_LBUG_MAX_DB_BYTES`.** Rejected:
the 2 GiB selection budget and the 16 GiB mmap outage cliff are different
quantities measuring different things; collapsing them loses both signals.

**Pinning the rust-analyzer cold start in both directions.** Rejected (D-046): it
drifts \~562ms run to run, so a two-sided pin produces flakes rather than signal.
The exceedance is accounted and bounded instead.

**Incremental `analyze` (gitnexus's default) for the hourly tick.** Rejected on
measurement (§5, D-002 of `gitnexus-embeddings-enablement-2026-09-05`): on a large
write set it breaches the 16 GiB LadybugDB ceiling and segfaults, and it had
timed out the tick \~10× in three days. Every tick passes `--force`.

**A bigger `GITNEXUS_LBUG_MAX_DB_BYTES` ceiling so the incremental path survives.**
Rejected (same D-002): the breach is a write set that scales with importers, not a
cap that is slightly too small; a bigger ceiling moves the cliff (the live root has
\~70 GB free, so it would take weeks to find again) while the full rebuild lands at
a stable 5.3 GiB database file.

**Upgrading to gitnexus 1.6.11 now instead of backporting its upsert fix.**
Rejected for this lane (§8.4): 1.6.11 bumps `@ladybugdb/core` to ^0.19 — a native
binding change — and reshapes the MCP surface mid-lane. The three-line backport is
reversible (`patch -R`), pinned by a doc-claim test, and leaves the upgrade as its
own lane with its own measurement.

**Running the cold embedding bootstrap inside the routine under a one-time extended
timeout.** Rejected: the cold pass is 52 minutes against an hourly cadence, and a
timeout kill mid-embedding leaves the D-016 residue. A supervised one-shot outside
the routine, with the routine paused, is cheaper and observable (§8.3).

**`--embeddings` with gitnexus's default node cap.** Rejected on measurement
(2026-09-04): the 50,000-node cap SKIPS embedding wholesale on this 246,622-node
graph and exits 0 with a one-line notice, which is exactly how the vector leg sat
empty for a month. Only `--embeddings 0` (uncapped) populates it.

## 8. The embeddings leg: how the vector index is populated, and how it fails

Added 2026-09-05 (plan `gitnexus-embeddings-enablement-2026-09-05`, D-002;
WI-39394). Until then the vector leg of the graph had been EMPTY since WI-35557 —
0 of \~246k nodes embedded — while every health count read green, because
nothing ever passed `--embeddings`.

### 8.1 `--embeddings` semantics (gitnexus 1.6.9) — four traps

* **Without the flag an analyze PRESERVES embeddings already in the index and
  never embeds a new node.** Dropping the flag does not turn embeddings off; it
  freezes the vector leg at bootstrap time while every count still reads healthy.
  The reindex canary therefore treats `embeddings == 0` after an
  embeddings-enabled run as DEGRADED (`vectorSearchProbe`, persisted as
  `gitnexus_health.vectorSearch { embeddings, expected, degraded }`).
* **The value is OPTIONAL in gitnexus's commander definition, so `--embeddings`
  must be the LAST argv token** — a positional after it is swallowed as the cap.
  `buildAnalyzeArgs` places it last and a test pins the order.
* **The default node cap is 50,000; this graph has 246,622 nodes.** Anything but
  `--embeddings 0` (uncapped) skips embedding wholesale and exits 0 (§7).
* **Device and threads come from env**, pinned in `analyzeEnv`:
  `GITNEXUS_EMBEDDING_DEVICE=cuda`, `GITNEXUS_EMBEDDING_THREADS=4`. gitnexus falls
  back to cpu internally when the CUDA provider cannot load, so the cuda pin is
  never a hard dependency on the GPU.

### 8.2 Every tick is a FULL rebuild that RESTORES the embedding cache

`--force --embeddings 0` loads the embedding cache from the existing index BEFORE
the wipe, restores it into the fresh database, and embeds only new and changed
nodes (`core/run-analyze.js`: "We *always* load the embedding cache when one is
requested"). So the hourly tick never re-pays the 52-minute cold pass; it pays the
full rebuild plus the restore and a re-embed of the changed nodes (§5 table).
gitnexus's incremental path is not used at all (§5, §7).

Two overlap facts, because a run can now outlast the hour: the routine row is
`concurrency: 'skip'` (`seed-gitnexus-reindex-routine.ts`), so a cron fire while the
previous action is still awaiting its analyze is skipped rather than double-spawned;
and the 45-minute `min_interval_sec` floor is measured from the previous run's END
(`indexedAt`), so a \~35-minute run yields an effective refresh every SECOND tick.
That two-hour cadence is accepted in D-002; lower the floor deliberately if
staleness ever bites, never by "fixing" the skip.

**`incrementalInProgress` in `.gitnexus/meta.json`.** A crashed analyze leaves this
marker set, and gitnexus then FORCES a full rebuild on the next analyze regardless
of argv. The routine deliberately REPORTS the marker rather than clearing it
(EI-22172147268902766). A set marker beside `stats.embeddings: 0` is the "bootstrap
died" signature — read it as that, not as corruption.

**A tick that outlives its bg-host is INVISIBLE to the successor host (WI-2146606).**
The analyze is a `managedSpawn` child in its own systemd scope (`pc-<taskId>.scope`),
so a bg-host restart does not kill it — it keeps writing the index — but
`concurrency: 'skip'` only sees the actions of the host that launched them. Before
the fix, the successor's preflight read the live run's `lbug.wal` as ORPHAN-WAL
residue, deleted it, and spawned a SECOND analyze against the same root. Measured
2026-09-05: bg-host was restarted at 19:16:35Z while the 18:32:12Z tick was mid-insert;
the successor deleted the WAL at 19:16:59Z, spawned the duplicate at 19:17:03Z, and
the duplicate was killed by hand at 19:21:31Z. The fix asks the KERNEL who holds the
index files open, and in what MODE: `detectLiveAnalyzeWriter(root)` scans `/proc/*/fd`

* `fdinfo` for a process holding `lbug` or `lbug.wal` `O_WRONLY`/`O_RDWR` — a reader
  (`gitnexus cypher`, the MCP bridge) never pins the tree, a writer always does — and the
  action then logs `[gitnexus-reindex] skip: an analyze writer is ALIVE on <root> — pid(s)
  … hold lbug + lbug.wal open for write; not cleaning residue, not spawning (WI-2146606)`
  and returns BEFORE residue cleanup and BEFORE the spawn. `cleanCrashResidue` runs the
  same probe: a WAL with a live writer is never touched, and an unheld fresh WAL is
  spared for `DEAD_SHADOW_STALE_MS` (5 min) unless the caller stands at the kill site
  (`writerKnownDead`). There is deliberately no lock file (it would record only the
  writer THIS host launched — the one that matters is the one it did not) and no kill
  (a routine-launched run is bounded by its own scope deadline; a manual run is not ours).

**The scope deadline is the only timeout an orphan has — and it fires as SIGKILL.**
`managedSpawn` puts `RuntimeMaxSec` on `pc-<taskId>.scope` from the action's timeout.
When the launching host dies, that deadline is the one thing still bounding the run,
and its expiry reproduces exactly the residue of §4. If an orphan is close to its
deadline and the index it is building is worth keeping, MOVE its pids into a fresh
scope with a longer deadline instead of letting it die: `systemd-run --user --scope --unit=<name> -p RuntimeMaxSec=<s> -p MemoryMax=<bytes> sleep infinity`, then write
every pid of the analyze tree into the new scope's `cgroup.procs` (the 2026-09-05
rescue of pid 1871544 at 19:31:50Z, ten minutes before its 70-min deadline). Stop the
keeper unit only after the analyze has exited — stopping it earlier kills the tree.

**Live tick timeline (2026-09-05, the first tick after the seeded resume).**
`analyze --force --embeddings 0` under pc-heavy (nice 10, ionice idle) on a box with
\~75 live agents: spawned 18:32:12Z; first WAL write 18:41:46Z
(`incrementalInProgress.startedAt`); DB-insert phase through \~20:10Z at 4.5–5.2 GB RSS
and \~90–130% of one core; GPU embedding phase (1.3 GiB GPU) by 20:16Z; `indexedAt`
20:19:38Z — 6,446 s (107 min) wall; result 248,736 nodes, 201,473 `CodeEmbedding`
rows, no `incrementalInProgress`, no `lbug.wal`/`lbug.shadow` left behind, cypher
count and a paraphrase query both answering in the live root. This — not the 39-minute
isolated run #4 — is what `GITNEXUS_ANALYZE_TIMEOUT_MS` is sized from (D-004): the
routine runs analyze NICED on a LOADED box, and the isolated measurement under-predicts
the live tick by 2.75×. Progress is visible ONLY through `lbug`/`lbug.wal` mtimes, the
scope's `cpu.stat` delta and `nvidia-smi` — the analyze's stdout goes to a pc-heavy
coalesce FIFO whose `.part` file stops after the banner.

**An orphaned run can finish its index and still leave the REGISTRY stale — and the
cadence floor used to read only the registry (D-005).** gitnexus writes freshness
twice at the tail of a run: `saveMeta` stamps `.gitnexus/meta.json` (`indexedAt`,
`lastCommit`, `stats`) the moment the index is complete, and `registerRepo` refreshes
the `~/.gitnexus/registry.json` row AFTER that and after the parse-cache save. The
orphaned 18:32Z tick above completed its meta.json at 20:19:38Z and never touched the
registry (row still at the seed's 17:07:51Z / lastCommit c2f48806 — the mechanism is
unproven; the parent's stdout pipe was gone after the restart). The next cron fire,
20:32Z, read the registry alone: "3.4h old, 196 commits behind", straight past the
45-minute floor, and a second 107-minute full pass started 13 minutes after the first
finished. The fix is `pickIndexFreshness`: the cadence gates take the FRESHER
`indexedAt` of the registry row and meta.json (with its own `lastCommit`), and refuse
a meta.json still carrying `incrementalInProgress` — gitnexus's mid-build writes spread
the PREVIOUS run's `indexedAt` forward under that marker, so only a completed run can
ever look fresh. `registered` stays a registry question (a repo the MCP cannot resolve
by name must be rebuilt regardless). When meta wins, the tick logs
`[gitnexus-reindex] freshness: meta.json (<ts>) is newer than the registry row (<ts>)`.
A stale `gitnexus list` row is the only remaining cost of a lost registry write.

**The DBOS per-fire ceiling must clear the analyze budget.** A system action with no
`routineTimeoutMs` on its registration fires under the 2-hour `ROUTINE_FIRE_TIMEOUT_MS`
default — below the 165-minute analyze budget. The 107:26 live tick was 12 minutes from
a silent cancellation: DBOS would have released the routine's dedup id (so the next cron
fire launches the action beside a live writer — only the WI-2146606 skip then prevents a
double spawn) and the health record for the tick completing minutes later would never
be written. `GITNEXUS_REINDEX_ROUTINE_TIMEOUT_MS` (= analyze budget + 15 min) is now
registered on the action; check `routineFireTimeoutMs` whenever an action's child
budget grows.

### 8.3 The first population is a ONE-SHOT supervised run outside the routine

The cold pass (217,120 nodes, 52 minutes on an idle box; 1 h 44 min on the live
root under fleet load) exceeds any sane tick timeout, so it runs once, as a
transient user unit against the live root, while the routine is PAUSED — two
analyzes on one `.gitnexus` race on the shadow.

**Prefer SEEDING over a cold pass when a sibling index of the same repo exists.**
The first live cold pass (2026-09-05, /tmp/wi39394/bootstrap-live2/run.log) died
rc=139 after 6,270 s with `Maximum database size of 17179869184 bytes has been
reached` → `manual WAL checkpoint failed after retries`, three seconds into the
embedding INSERT, while the database file sat at 5.27 GB (31% of the ceiling) —
the identical run on an isolated checkout had passed. The ceiling is a VIRTUAL
frame reservation that gitnexus's 5-second manual WAL-checkpoint cadence consumes
over a long run, not bytes on disk (D-003). Two consequences: the routine now pins
`GITNEXUS_LBUG_MAX_DB_SIZE` at 64 GiB (VA only), and the fast path is to copy an
already-embedded index of the same repo — node ids are repo-relative, only
`meta.json`/`gitnexus.json` carry `repoPath` —
(`npx tsx .papercusp/scratch/wi39394-seed-live-index.mts <src .gitnexus> <live root>`:
atomic `lbug` rename, repoPath rewrite, parse cache, registry entry). The routine's
next `--force --embeddings 0` tick then runs the restore path (§8.2), which is the
39-minute shape, not the cold one.

Recipe for a genuinely cold pass, with the SAME argv and env the routine uses:

```bash
# 1. routines:set { name:'gitnexus-reindex', installSlug:'papercusp', active:false, reason:'…' }
#    and wait for any in-flight tick to finish (no lbug.shadow in <root>/.gitnexus).
# 2. one supervised pass:
ROOT=$(git rev-parse --show-superproject-working-tree); ROOT=${ROOT:-$(git rev-parse --show-toplevel)}
systemd-run --user --unit="gitnexus-bootstrap-$(date +%s)" -p MemoryMax=24G bash -c "
  cd $ROOT && [ ! -e .gitnexus/lbug.shadow ] || exit 3
  export NODE_OPTIONS='--max-old-space-size=16384 --max-semi-space-size=128'
  export GITNEXUS_LBUG_MAX_DB_SIZE=68719476736 GITNEXUS_LBUG_BUFFER_POOL_SIZE=8589934592
  export GITNEXUS_EMBEDDING_DEVICE=cuda GITNEXUS_EMBEDDING_THREADS=4
  /usr/bin/time -v node --stack-size=4096 \
    ~/.papercusp/vendor/gitnexus/node_modules/gitnexus/dist/cli/index.js \
    analyze $ROOT --skip-agents-md --name papercusp --force --embeddings 0 \
    > /tmp/gitnexus-bootstrap.log 2>&1"
# 3. on exit: rc 0 AND .gitnexus/meta.json stats.embeddings > 0; then
#    dev:restart bg-host (if the routine code changed) and routines:set active:true.
```

Verify per §6, plus the two vector-leg probes: `gitnexus cypher 'MATCH (e:CodeEmbedding)
RETURN count(e)'` must be > 0, and the next tick must write
`gitnexus_health.vectorSearch` with `degraded:false`.

Three log-reading traps seen while doing this:

* `/usr/bin/time -v` prints `Exit status: 0` AFTER `Command terminated by signal
  11` — the exit-status line is boilerplate after a signal; read the signal line.
* gdb's post-exit `ABORT/CRASH` echo followed by `No stack.` is not a crash.
* If the bootstrap dies mid-write the live index is wedged until the routine's
  preflight next runs, and the routine is paused. Run that preflight out of band —
  `WRITER_KNOWN_DEAD=1 npx tsx .papercusp/scratch/wi39394-clean-residue.mts <root>`
  calls the routine's own `cleanCrashResidue` — do not hand-delete (§4).

### 8.4 The one failure that needed a vendored patch: `Found duplicated primary key value <nodeId>:0`

Stock 1.6.9's `batchInsertEmbeddings` CREATEs `CodeEmbedding` rows without first
deleting the row it just RESTORED from cache for the same node. So `--force --embeddings` on an index that ALREADY holds embeddings aborts on the first CHANGED
node — which is every hourly tick after bootstrap:

```
Analysis failed: Batch execution failed for rows 1-4: Runtime exception:
Found duplicated primary key value Function:apps/…/listings.ts:registerListingEndpoints:0
```

(run #3: rc=1 twenty seconds into the embedding phase, after restoring 217,124
cached embeddings; `/tmp/wi39394/run3-embed-run.log`). A COLD pass — zero existing
embeddings — never hits it, which is why the bootstrap succeeds and the first
steady-state tick fails, and why "the bootstrap worked" is not evidence the tick
will.

It was diagnosed in minutes with probes against the vendored LadybugDB adapter on
a scratch database (`/tmp/wi39394/pk-probe.mjs`: `await import('<vendor>/dist/core/
lbug/lbug-adapter.js')`, `initLbug(path)`) rather than by re-running 28-minute
analyzes: DELETE-then-CREATE of the same primary key works, an in-batch duplicate
leaves the first row, and the chunker yields unique chunk indices — so the CREATE
collided with a PRE-EXISTING row. Upstream fixed exactly this in 1.6.11 (DELETE by
embedding id before CREATE). That fix is BACKPORTED as a vendor patch, and the
patch is part of the install (§2):

* `patches/gitnexus-vendor+1.6.9-embedding-upsert.patch` — the three-line
  DELETE-by-id-before-CREATE, marker `papercusp-patch:gitnexus-1.6.9-embedding-upsert`
  (reversible: `patch -p1 -R --dry-run` was verified before it was applied).
* `scripts/vendor-gitnexus-patch.mjs` — idempotent apply; `--check` is read-only.
* `packages/operator-core/lib/doc-claims/gitnexus-vendor-embedding-upsert.test.ts`
  — pins the marker on this box (skips where there is no vendor install).

Verified on the restore + re-embed path with the patched vendor (run #4,
`/tmp/wi39394/run4-embed-run.log`): rc=0 after 2,343s; 216,843 embeddings over 247,540 nodes (217k restored from cache, the changed nodes re-embedded in a \~2-minute GPU phase); zero `duplicated primary key` lines in the log.

### 8.5 Reading the vector leg's health

`gitnexus_health.vectorSearch` rides beside the failure streak in the routine's
health record (visible in `/admin/schedules` and `routines:list`): `embeddings` is
`stats.embeddings` after the analyze (null when the registry did not report it),
`expected` is whether the argv asked for embeddings (`analyzeEmbeddingsExpected`),
and `degraded` is `expected && (embeddings == 0 || null)`. A degraded verdict never
flips the tick healthy — a graph that answers definitions but not a paraphrase is
a partial outage, and the summary carries `(DEGRADED: …)` so it is not read as
green.

**What the first live tick read (2026-09-05).** The seeded index carried 216,843
embeddings (run #4); the first live tick rebuilt the graph to 248,736 nodes and
finished with 201,473 `CodeEmbedding` rows — `embeddings > 0`, `expected: true`,
`degraded: false`, and both R-2 probes (cypher count, paraphrase `gitnexus query`)
answer. The 7% DROP against the seed is the number to watch across ticks, not the
absolute count: the cache restore keeps an embedding only for a node whose content
hash still matches, and on a tree that \~75 agents rewrite hourly a real share of
nodes churn between ticks and are re-embedded (or, for deleted symbols, dropped).
A count that falls tick over tick while the node count holds is the signature of a
restore that stopped matching (a model or chunking change, a cache path that moved)
and is worth a look before it reaches the `embeddings == 0` cliff this probe
catches. Read the record with `routines:list { name:'gitnexus-reindex',
installSlug:'papercusp' }` → `health.gitnexus_health.vectorSearch`; it is written
only by a tick that actually ran analyze — a cadence skip leaves the previous
record in place, so its `checkedAt` is the tick it describes.

### 8.6 The failure that is NOT gitnexus's: a full disk (2026-09-05, D-006)

A routine tick that runs its whole \~1h50 pass and then exits 1 with a stack frame at
the vendored `run-analyze.js:1035` (`runEmbeddingPipeline`), minutes before the
bg-host log fills with `database system is in recovery mode`, reads like a native
crash coincident with a Postgres outage. It was one event: the root filesystem hit
100% at \~22:24Z (an unrelated Operator Vite production build, EI-22462478663416972),
the analyze's stderr says `Cannot write to file … .gitnexus/lbug.wal … No space left
on device` → `Analysis failed: Batch execution failed for rows 5-8` inside
`batchInsertEmbeddings`, and Postgres — which shares `/` on this box — PANICked on
`pg_wal` in the same minute (WAL writer SIGABRT 22:29:36Z, recovery until 22:30:40Z),
so the tick's own health write failed too. **Read `df /` before reading gitnexus
code.** The incomplete-index marker (§8.2) then did its job: the next fire cleaned the
orphan WAL and ran a full rebuild.

What the routine does about it now: `decideReindex` has a LOW DISK step (after load
and memory pressure, before the cold-build override). A `--force` rebuild writes a
second database (`lbug.shadow`, 5.28 GB on this graph) plus a streamed WAL BESIDE the
live one and promotes only at the end, so it needs roughly one more database than it
holds. When the free space on the `.gitnexus` filesystem is below
`max(GITNEXUS_REINDEX_MIN_FREE_DISK_BYTES = 16 GiB, 2 × live lbug size)` the tick logs
`[gitnexus-reindex] skip: low disk (N GiB free on the index filesystem < M GiB a full
rebuild needs) — deferring to the next tick …` and leaves the complete old index
serving. The floor is per-install trigger config `min_free_disk_bytes`; an
unmeasurable reading (statfs failure) is fail-soft — unknown is not low. The gate
cannot rescue a run that is already in flight when the disk fills; that case is the
marker + full-rebuild-on-next-fire path above, and the fleet-wide signal is the
`[disk-space-alarm]` line in the same journal.

One restart trap sits next to this: a `dev:restart { target:'bg-host' }` does NOT
kill a routine-owned analyze (it runs in its own `pc-…` systemd scope and
`detectLiveAnalyzeWriter` makes the new host yield to it), but it DOES lose the
in-process await — no `ok in` line, no canary, no `vectorSearch` health record for
that tick, and the next fire skips on freshness. Restart between ticks, never during
one you need evidence from.
