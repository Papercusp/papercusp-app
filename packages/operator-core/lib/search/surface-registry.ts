/**
 * surface-registry — every search surface, and what it is DECLARED to do
 * (P-021 of semantic-search-fingerprint-coverage-2026-08-03).
 *
 * ─── WHY A REGISTRY AT ALL ─────────────────────────────────────────────────
 * The audit behind this plan found eight surfaces with no embedding floor and
 * six discarding the engine's leg report — not because anyone decided against
 * them, but because every ranking feature landed as an optional per-call field
 * that had to be hand-propagated, and hand-propagation never happens. P-017
 * fixed the propagation (a surface inherits the policy by importing the seam).
 * This fixes the ENUMERATION: a new `*:search` tool that quietly ships
 * keyword-only is now a build failure rather than a discovery someone makes
 * months later.
 *
 * ─── DECLARED vs DERIVED — the part that makes this not-ceremony ───────────
 * Entries below are DECLARATIONS of intent. `search-surface-conformance.test.ts`
 * DERIVES the same facts from each surface's transitive runtime import graph
 * and fails on any disagreement. A registry nobody can contradict is a comment;
 * the value is entirely in the cross-check.
 *
 * The rule that actually bites: **`engine: true` obliges the graph to reach
 * `configure-search-defaults`.** An engine caller without the policy seam runs
 * an unfloored vector leg, where RRF weights rank-1 noise exactly like a rank-1
 * real hit. That is the original bug, and it is still live in one surface.
 *
 * ─── WHAT THIS CANNOT SEE (state it, do not paper over it) ─────────────────
 * Discovery matches tools NAMED `*:search` / `search:*`. A search-shaped
 * surface under another name is invisible to it and must be added here BY
 * HAND. P-030 ran that hand-audit once (2026-08-08) and folded in six such
 * surfaces — the `coord:feed` `q=` filter, both `/adv/sessions/*` routes,
 * `/user/search`, the P-008 corpus-recall leg, and the boot warmup. So the
 * registry is AUTOMATICALLY complete for the naming class, and MANUALLY
 * complete as of that audit. A non-tool surface added later is still
 * invisible until someone adds it: this is a floor, never a self-maintaining
 * census.
 *
 * Two derivation limits, both of which bit during that audit and both of
 * which the entries below are written around:
 *
 *  1. **The derivation is per-MODULE, and a module can host more than one
 *     surface.** `endpoint-route/routes/adv/sessions.ts` serves BOTH
 *     `/adv/sessions/search` (a synchronous JSONL file scan) and
 *     `/adv/sessions/search-transcripts` (the hybrid engine). The file
 *     derives `hybrid` because of the second, which says nothing about the
 *     first. An entry must therefore point at the module that IMPLEMENTS its
 *     mechanism — `omp-sessions.ts` for the grep route — not at the HTTP
 *     wrapper both routes happen to share.
 *  2. **The walker follows STATIC relative imports only.** A surface reaching
 *     the engine through `await import()` (or a bare package specifier)
 *     resolves to a 0-module graph, where `hasFloor: false` is TRIVIALLY true
 *     rather than measured. `transcript-search-warmup` is exactly that shape,
 *     which is why its exemption is declared and reasoned rather than
 *     inferred from a derivation that cannot see its imports.
 *  3. **A runtime import graph is not a call graph.** Cross-cutting modules can
 *     load a module that contains an engine call in an unrelated exported
 *     function. The three current non-engine surfaces all reach
 *     `work-items.ts` through event/fleet infrastructure without calling its
 *     search function. Those exact false-positive modules are declared per
 *     surface below; the conformance test proves each edge is still present,
 *     contains the call being ignored, and that no other engine caller remains.
 *     This is deliberately exact and capped rather than a global ignore for
 *     `work-items.ts`, because `work_items:search` legitimately delegates there.
 *     (Until 2026-09-05 this cited `/harness/search`, a second surface over the
 *     same call; that route was deleted as uncalled — zero requests across the
 *     full 7d `route_invocations` retention window, never mounted on the hosted
 *     control plane, and no consumer in any sibling checkout. `work_items:search`
 *     is now the sole registered surface entering `work-items.ts`.)
 */

export interface SearchSurface {
  /** Registered tool name, or a stable id for a non-tool surface. */
  id: string;
  /** Entry module, relative to `packages/operator-core/lib`. */
  entry: string;
  /**
   * Which engine entrypoint this surface runs. DERIVED and cross-checked — a
   * wrong value here fails the conformance test rather than being believed.
   *
   * The three-way split exists because the first run of the conformance test
   * refuted a boolean: `search:fulltext` was declared engine-backed and is not
   * a `runHybridSearch` caller — it runs `runFullTextSearch`, the engine's
   * lexical entrypoint, deliberately. A boolean forces that surface into the
   * same bucket as one that never reached the engine at all, which erases the
   * only distinction this registry exists to make: **keyword-only by CONTRACT
   * versus keyword-only by ACCIDENT.**
   */
  engine: 'hybrid' | 'fulltext' | 'none';
  /**
   * Required when `engine: 'none'`. Not a formality: every one of these was a
   * candidate for "why isn't this on the engine?", and writing the answer down
   * once is what stops it being re-litigated every audit.
   */
  whyNotEngine?: string;
  /**
   * Exact modules whose `runHybridSearch` calls are runtime-reachable but not
   * on THIS surface's call path. A static import graph sees loaded functions,
   * not which exported function the handler invokes, so these are explicit,
   * falsifiable false-positive edges rather than a global module exclusion.
   *
   * The conformance test requires every named module to be reached and to
   * contain the ignored call, then re-derives the surface after removing only
   * those modules. Any additional engine caller still fails the declaration.
   */
  unrelatedEngineModules?: { modules: readonly string[]; reason: string };
  /**
   * An engine-backed surface that does NOT inherit the P-017 floor. This is a
   * TRACKED DEFECT, never an option — the conformance test caps the set and
   * verifies each entry is still real, so it can only shrink.
   */
  floorGap?: { reason: string; trackedBy: string };
  /**
   * An engine-backed surface that REACHES the policy seam but hands the engine
   * a WRAPPED embedder, so the floor silently resolves to nothing (D-024).
   *
   * A TRACKED DEFECT like `floorGap`, and deliberately NOT the same field. The
   * two are different failures with different detections and different fixes:
   *
   *   · `floorGap`      — the policy was never installed. `hasFloor` is FALSE.
   *                       Fix: import the seam (after measuring the corpus).
   *   · `embedderWrap`  — the policy IS installed and RAN, and returned
   *                       `undefined` because `embedderModeOf` is a WeakMap
   *                       lookup on the exact function OBJECT and an
   *                       intermediary handed over a different one. `hasFloor`
   *                       is TRUE, which is precisely why the `floorGap` checks
   *                       cannot see this and why it needs its own entry.
   *
   * Filing this as a `floorGap` would fail that set's own "still REAL" check
   * (it asserts `hasFloor === false`) — the type system's way of saying these
   * are not the same defect. Filing it as `resultsDiscarded` would be the
   * category-corruption D-027 names.
   */
  embedderWrap?: { reason: string; trackedBy: string };
  /**
   * An engine-backed surface that runs UNFLOORED and is CORRECT to — because
   * it has no result set for a floor to protect. It discards what the engine
   * returns; the call exists for its side effects (warming a pool, an
   * embedder, a prepared statement).
   *
   * This is deliberately NOT a second `floorGap`. A gap is a tracked defect
   * that must shrink; this is a permanent, correct state. Filing one as the
   * other corrupts both — the ceiling stops measuring outstanding defects,
   * and a genuine gap can hide behind a category that never has to shrink.
   * That is the `KNOWN_DARK_FLAGS` failure D-027 names, one level over.
   *
   * The claim is DERIVED, not trusted: the conformance test checks that every
   * `runHybridSearch` call in the entry module is a bare statement whose value
   * is discarded, so an entry that starts consuming results fails here instead
   * of keeping an exemption it no longer earns.
   */
  resultsDiscarded?: string;
}

export const SEARCH_SURFACES: readonly SearchSurface[] = [
  // ─── Engine-backed, floor inherited ──────────────────────────────────────
  { id: 'work_items:search', entry: 'agent-tools/work_items/search.ts', engine: 'hybrid' },
  { id: 'docs:search', entry: 'agent-tools/docs/search.ts', engine: 'hybrid' },
  { id: 'plans:search', entry: 'agent-tools/plans/search.ts', engine: 'hybrid' },
  { id: 'sessions:search', entry: 'agent-tools/sessions/search.ts', engine: 'hybrid' },
  { id: 'search:semantic', entry: 'agent-tools/search/semantic.ts', engine: 'hybrid' },
  {
    id: 'coordination:ask-knowledge-tier',
    entry: 'agent-tools/coordination/ask-knowledge-tier.ts',
    engine: 'hybrid',
  },

  // ─── On the engine's LEXICAL entrypoint, by contract ─────────────────────
  {
    id: 'search:fulltext',
    entry: 'agent-tools/search/fulltext.ts',
    engine: 'fulltext',
    whyNotEngine:
      'Runs `runFullTextSearch`, not `runHybridSearch` — lexical BY CONTRACT: the tool exists so a ' +
      'caller can ask for exact-term matching with no embedder in the path (and so a search still ' +
      'works when the embedder is down). It shares the engine and reaches the policy seam, whose ' +
      'minScore early-outs on `mode: "fulltext"` because there is no vector leg to floor. This is ' +
      'the case a boolean `engine` field got wrong on the first conformance run.',
  },

  // ─── Engine-backed, floor inherited ──────────────────────────────────────
  { id: 'recipes:search', entry: 'agent-tools/recipes/search.ts', engine: 'hybrid' },
  // orchestrate:search is a typed facade over recipes:search. Point at the
  // mechanism module, as the HTTP entries below do, so the declaration proves
  // that the delegated search keeps the canonical hybrid engine + floor.
  { id: 'orchestrate:search', entry: 'agent-tools/recipes/search.ts', engine: 'hybrid' },

  // ─── Deliberately NOT on the engine ──────────────────────────────────────
  {
    id: 'memory:search',
    entry: 'agent-tools/memory/search.ts',
    engine: 'none',
    unrelatedEngineModules: {
      modules: ['work-items.ts'],
      reason:
        'memory:search imports the improvements watchdog for benchmark scoping; that path reaches ' +
        'events/await → fleet reconciliation → work-items.ts. The loaded work-items module contains ' +
        'searchWorkItems, but this handler calls its independent MemoryBackend and never that export.',
    },
    whyNotEngine:
      'AUDITED 2026-08-08 (P-030). The previous note here — "mem0 owns its own store and ranking" — ' +
      'was right in its conclusion and wrong about the mechanism, which matters because it implied an ' +
      'opaque third-party store nobody could reason about. What actually serves this tool is a SECOND ' +
      'FIRST-PARTY HYBRID ENGINE: backend `hybrid-pg` (configure.ts:679) = `HybridBackend(' +
      'LexicalLegBackend(mem0), mem0)` from `@papercusp/memory`, with its own RRF fusion ' +
      '(hybrid-fusion.ts), its own diversity re-rank, and its own score-floor primitive ' +
      '(`applyScoreFloor`). So it is NOT keyword-only and NOT unfloorable — it is a parallel ' +
      'implementation of the same design as `@papercusp/search`, which is why migrating it would be a ' +
      'consolidation project, not a floor fix.\n\n' +
      'The one asymmetry worth knowing, since it looks like a floor gap and is not: this PULL path ' +
      'passes no `minScore`/`minLexScore`/`fusionMode` (search.ts:233), so it runs `floored-union` ' +
      'with an unfloored cosine leg, while the PUSH path (memory/injection.ts) passes a cosine floor, ' +
      'minLexScore 0.40 and `cosine-gated`. That split is DELIBERATE and recorded at ' +
      'injection.ts:298-303 (context-injection-audit-2026-07-28 D-010): "A human running memory:search ' +
      'wants recall and can discard a bad hit; auto-injection has no LLM filter downstream, so it ' +
      'wants precision." Do not "fix" the pull path to match the push path — that is a recall ' +
      'regression against an explicit decision.',
  },
  {
    id: 'rubrics:search',
    entry: 'agent-tools/rubrics/search.ts',
    engine: 'none',
    unrelatedEngineModules: {
      modules: ['work-items.ts'],
      reason:
        'rubrics:search delegates to searchRubrics in rubrics.ts; plan-lock and fleet-drained event ' +
        'infrastructure below that module loads work-items.ts. Its searchWorkItems engine call is an ' +
        'unrelated export and is never invoked by the rubric search handler.',
    },
    whyNotEngine:
      'Delegates to searchRubrics() over a small, bounded rubric set where lexical matching is ' +
      'adequate and a vector leg would add an embedder dependency to a read that must work when the ' +
      'embedder is down. Revisit if the rubric corpus grows past a few hundred rows.',
  },
  {
    id: 'cupboard:search',
    entry: 'agent-tools/cupboard/search.ts',
    engine: 'none',
    whyNotEngine:
      'Searches a catalog of installable listings by kind/name, not prose. The useful ranking signal ' +
      'is structural (kind, install state), not semantic similarity over a body.',
  },
  {
    id: 'personal:search',
    entry: 'agent-tools/personal/search.ts',
    engine: 'none',
    whyNotEngine:
      'Runs the Personal Vault\'s authorization-gated hybrid reader, which fuses local ' +
      'EmbeddingGemma similarity with its own lexical document query over an owner-private corpus. ' +
      'It deliberately does not route through the workspace @papercusp/search engine: that engine ' +
      'has neither the vault grant boundary nor its scope/participant/time filters.',
  },
  {
    id: 'documents:search',
    entry: 'agent-tools/documents/search.ts',
    engine: 'none',
    whyNotEngine:
      'Federates the Personal Vault, source-ACL organization corpus, presence-scoped pot corpus ' +
      'and live provider queries through their existing authorized readers. Each leg enforces ' +
      'its own grants, identity mapping and disclosure labels before returning documents. ' +
      'The workspace search engine does not implement those per-corpus authorization boundaries ' +
      'or provider live-query contracts; the handler deliberately delegates to those readers.',
  },
  {
    id: 'social:search',
    entry: 'agent-tools/social/search.ts',
    engine: 'none',
    whyNotEngine:
      'Delegates to searchSocialPosts → searchPersonalDocuments, the Personal Vault\'s ' +
      'authorization-gated first-party lexical + EmbeddingGemma RRF query. It deliberately stays ' +
      'off the workspace @papercusp/search engine for the same reason as personal:search: that ' +
      'engine has neither the owner-private grant boundary nor the social scope, participant and ' +
      'time filters. This is hybrid retrieval by contract, but through the private-vault engine.',
  },
  {
    id: 'reports:search',
    entry: 'agent-tools/reports/search.ts',
    engine: 'none',
    whyNotEngine:
      'The LEXICAL half of the Reports library, by design rather than by omission. Ranking rides the ' +
      'STORED generated `search_tsv` column (migration 1166), whose weights already encode the ' +
      'domain rule that a title match outranks summary/subject_label, which outranks body — an ' +
      'ordering a generic relevance fusion would flatten rather than improve. It is also the read ' +
      'that has to keep working when the embedder is down: a report id is cited from plans, ' +
      'work-items and other reports, so "find it by its words" must not acquire a vector dependency ' +
      '(the same reason recorded for rubrics:search). The semantic half is NOT missing — P-005 ' +
      'registers `report` as a source in the unified search stack, and this verb stays the direct, ' +
      'dependency-free lexical path beside it.',
  },

  // ─── NOT in the `*:search` naming class — added by hand (P-030) ───────────
  // Discovery cannot see any of these. Each was traced with the same import
  // walk the conformance test runs, on 2026-08-08.
  {
    id: 'GET /adv/sessions/search',
    entry: 'omp-sessions.ts',
    engine: 'none',
    whyNotEngine:
      'THE TRAP THIS ENTRY EXISTS TO DEFUSE: two routes in one file whose paths differ by a suffix and ' +
      'whose mechanisms have nothing in common. `/adv/sessions/search` (adv/sessions.ts:569) calls ' +
      '`searchOmpSessions` (omp-sessions.ts:818) — a SYNCHRONOUS scan of Claude session JSONL files on ' +
      'disk, matching with `queryMatches` (:311), an AND of case-folded substrings. No database, no ' +
      'embedding, no ranking: hits come back in file/entry order and are truncated at `limit`, so the ' +
      'result set is arbitrary rather than best-first. Its sibling ' +
      '`/adv/sessions/search-transcripts` (:669) runs the hybrid engine over `session_turn` instead. ' +
      'Both are correct for their own job — the grep reads live local files the ingest may not have ' +
      'reached, the engine ranks the indexed corpus — but a caller who picks by name gets a completely ' +
      'different retrieval model than they expect.\n\n' +
      'NOTE the `entry` points at the MECHANISM module, not the route file. Pointing it at ' +
      'adv/sessions.ts would derive `hybrid` from the SIBLING route and silently certify this one as ' +
      'engine-backed — the per-module derivation limit called out in the header.',
  },
  {
    id: 'GET /adv/sessions/search-transcripts',
    entry: 'endpoint-route/routes/adv/sessions.ts',
    engine: 'hybrid',
  },
  {
    id: 'GET /user/search',
    entry: 'endpoint-route/routes/user/search.ts',
    engine: 'hybrid',
  },
  {
    id: 'memory:corpus-recall',
    entry: 'memory/corpus-recall-io.ts',
    engine: 'hybrid',
  },
  {
    id: 'coord:feed (q= filter)',
    entry: 'agent-tools/coordination/feed.ts',
    engine: 'none',
    unrelatedEngineModules: {
      modules: ['work-items.ts'],
      reason:
        'coord:feed reaches event wake infrastructure through messages.ts, which reaches fleet ' +
        'reconciliation and loads work-items.ts. The q= path remains the local matchesText filter; ' +
        'it never calls the unrelated searchWorkItems export in that loaded module.',
    },
    whyNotEngine:
      'Not a search surface at all — a FILTER, and registered here so nobody mistakes it for one. `q=` ' +
      'resolves to `matchesText` (feed.ts:188): a raw case-folded `String.includes` over ' +
      'summary/body/from/to/plan_slug/event/detail joined with newlines. Not tokenized, not stemmed, ' +
      'not ranked — a two-word `q` matches only where those exact characters are adjacent.\n\n' +
      'The property that actually misleads: it is a POST-FILTER over an already-bounded page, not a ' +
      'query over the corpus. The feed pages each surface from a cursor (RAW_SURFACE_FETCH_CAP 1000 ' +
      'per surface per round, MAX_CURSOR_ROUNDS 10) and applies the predicate in memory to whatever ' +
      'that window contained. So an empty result means "no match in the window this call reached", ' +
      'NEVER "no such message exists" — and it degrades exactly when the stream is busiest. Use ' +
      '`sessions:search` / `search:fulltext` to ask a corpus-wide question.',
  },
  {
    id: 'transcript-search-warmup',
    entry: 'transcript-search-warmup.ts',
    engine: 'hybrid',
    resultsDiscarded:
      'Boot-time pre-warm (WI-4734), live from hono-host.ts:34. It runs one `limit: 1` hybrid search ' +
      'over `session_turn` purely for the side effects — PG pool connections, prepared statements, ' +
      'the query embedder, the module graph the route imports dynamically — so that the first HUMAN ' +
      'search after a deploy is not the one paying a ~20s cold start. The call at :95 assigns its ' +
      'result to nothing; only `legs.search = true` is recorded. A relevance floor filters a result ' +
      'set, and this surface has no result set: flooring it could only make the warmup warm less.\n\n' +
      'Its derivation is BLIND, which is the other reason this is declared rather than inferred: the ' +
      'engine is reached through `await import()` (:75), so the walker resolves 0 modules and reports ' +
      '`hasFloor: false` trivially — the same reading it would give a surface that genuinely lost its ' +
      'floor. Do not read this entry as a measurement that a floor is absent; read it as a statement ' +
      'that a floor is irrelevant here.',
  },
];

/**
 * The number of engine-backed surfaces allowed to lack the P-017 floor.
 *
 * SHRINK-ONLY. Fixing a gap removes its entry and this number comes down with
 * it. Raising it requires an explicit decision recorded on the plan — the
 * `KNOWN_DARK_FLAGS` lesson: a ceiling that is quietly bumped each time the
 * same bug class recurs stops being a ceiling.
 */
export const FLOOR_GAP_CEILING = 1;

/**
 * The number of engine-backed surfaces allowed to hand the engine a WRAPPED
 * embedder, and so run unfloored despite having the policy installed (D-024).
 *
 * SHRINK-ONLY, on the `FLOOR_GAP_CEILING` terms. The pressure to keep it at
 * zero is sharper than for a plain floor gap, because this defect is INVISIBLE
 * at runtime — both legs report `status:'ran'`, `legs.degraded` stays false,
 * and every fixture-driven test passes identically with and without it (a
 * MOCKED embedder is never stamped either, so only reference identity
 * discriminates). The conformance test re-derives each entry from the AST, so
 * an entry whose wrapper is gone fails instead of lingering.
 */
export const EMBEDDER_WRAP_CEILING = 1;

/**
 * The number of engine-backed surfaces allowed to be exempt from the floor
 * because they discard their results.
 *
 * Capped for the same reason as `FLOOR_GAP_CEILING`, and against a sharper
 * risk: a gap entry is embarrassing and someone eventually fixes it, whereas
 * `resultsDiscarded` describes a permanently-correct state and so has no
 * natural pressure to shrink. That makes it the more attractive place to file
 * an inconvenient surface. The cap means adding one is a decision with a
 * ceiling to argue against, not a quiet append — and the conformance test
 * independently re-derives that each exempt surface really does throw its
 * results away.
 */
export const RESULTS_DISCARDED_CEILING = 1;

/**
 * Runtime-import/call-graph false positives are explicit and pressure-capped.
 * A fourth entry means the static derivation is losing discrimination and must
 * be improved rather than accumulating a generic allow-list.
 */
export const UNRELATED_ENGINE_MODULE_CEILING = 3;

/**
 * Modules the CENSUS finds and the registry deliberately does not carry.
 *
 * ─── WHY THIS EXISTS ───────────────────────────────────────────────────────
 * P-030's first pass audited a hand-collected LIST of candidates rather than
 * ENUMERATING the population, and missed `/api/harness/search` — at the time a
 * live, owner-facing, entirely unranked `ILIKE` scan (P-018 has since migrated
 * it). The audit was careful and the result was still a confident "complete"
 * that was not. That is the same
 * defect this repo has now recorded three times about the module-pin detector:
 * anchor the search to the PROPERTY that defines membership, never to the
 * handful of instances you happened to have in hand.
 *
 * So completeness is no longer a claim in a comment. The conformance test
 * enumerates the population directly — every module that calls the engine,
 * and every route whose path contains "search" — and requires each one to be
 * either REGISTERED above or listed here WITH A REASON. A new search surface
 * is a build failure whatever it is named and wherever it lives; the only way
 * to not carry one is to say, in writing, why.
 *
 * Keyed by path relative to `packages/operator-core/lib`.
 */
export const CENSUS_EXCLUSIONS: Readonly<Record<string, string>> = {
  'endpoint-route/routes/github/search-repos.ts':
    'Proxies the GitHub Search API server-side (so the browser never holds the token). It searches ' +
    "GitHub's corpus, not ours — there is no local index to rank and no floor to inherit.",
  'endpoint-route/routes/credentials/search-providers.ts':
    'Named for what it configures, not what it does: CRUD over the API keys of search PROVIDERS ' +
    '(masked read, env-var write). It runs no query. Caught by the path census purely on the word.',
  'memory/bench/corpus-leg-lexical-acceptance-cli.ts':
    'A benchmark CLI, not a product surface — it calls the engine to MEASURE retrieval quality, so ' +
    'its results are the experiment rather than something a user sees. Never runs in the operator.',
  'memory/bench/corpus-rerank-reach-cli.ts':
    'Same class as the acceptance CLI above: a P-008 pre-design measurement instrument ' +
    '(context-injection-retrieval-reach-and-visibility-2026-08-03) run by hand via `npx tsx`, asking how much ' +
    'of the corpus leg an upstream reranker can actually control. It calls the engine to MEASURE, and is ' +
    'imported by no route, tool, or product path — only by its own unit test. Never runs in the operator.',
  'search/bench/rerank-decision-cli.ts':
    'Same class as the two memory/bench CLIs above: the WI-37653 reranker INTEGRATION benchmark, ' +
    'owner-directed 2026-08-10 to decide how to integrate the reranker. It calls the engine to MEASURE ' +
    'retrieval quality, so its results ARE the experiment rather than something a user sees. Measured ' +
    '2026-08-10: nothing imports it at all (not even a unit test) — it is run by hand via `npx tsx`.',
  'search/bench/labelled-relevance-cli.ts':
    "Same class as the bench CLIs above: P-038's labelled relevance pass (plan " +
    'semantic-search-fingerprint-coverage-2026-08-03, D-079 / WI-37638). It samples real queries from ' +
    '`tool_invocations` and runs them through the engine to MEASURE ranking quality against the frozen ' +
    'the content-versioned search-relevance rubric, so its output IS the experiment rather than something a user sees. ' +
    'Measured 2026-08-10: nothing imports it (not even a unit test) — it is run by hand via `npx tsx`, ' +
    'is read-only against PG, and costs money per run, so it can never sit on a product path.',
};
