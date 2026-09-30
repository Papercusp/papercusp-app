/**
 * Boot-time pre-warm of the interactive transcript-search and turn-start
 * corpus paths (WI-4734, EI-21304382115507204).
 *
 * WHY: the agents-pill "search anything" endpoint
 * (`/api/adv/sessions/search-transcripts`) is human-interactive, but every
 * `:3070` deploy restart re-colds the whole stack a first search pays —
 * module-graph imports (~1.1s), query-embedder acquisition (up to seconds;
 * WI-3860 measured 15–30s on a local-ONNX cold start), first PG pool
 * connections + prepared statements (~2.6s measured cold), per request
 * worker. On 2026-07-13 the owner's first search after an auto-deploy took
 * ~20s. The fix class: the FIRST search after a boot must be a background
 * warmup this module fires, never a human keystroke.
 *
 * WHAT it warms (per process — each cluster request-worker runs its own):
 *   1. the exact module set the route dynamically imports,
 *   2. the query embedder (acquisition + one real embed → the process-memoized
 *      pipeline AND the query-embed LRU are hot),
 *   3. one tiny hybrid search over the `session_turn` source (PG pool
 *      connections, prepared statements, engine code paths),
 *   4. the roster merge the endpoint runs per query (presence/assignment
 *      stores), with per-entry "thinking" resolution fully skipped,
 *   5. the turn-start corpus query embedder, which otherwise warms lazily on
 *      the first context-injection request and can miss its 1200ms query
 *      budget on every cold worker.
 *
 * Best-effort by design: every failure is swallowed (one warn line) — a
 * warmup must never affect boot health. Deps are injectable for unit tests.
 */

export interface TranscriptSearchWarmupResult {
  ok: boolean;
  ms: number;
  /** Which legs completed (search implies embed-acquire was attempted too). */
  legs: { search: boolean; roster: boolean; corpus: boolean; workItems: boolean };
  error?: string;
}

export interface TranscriptSearchWarmupDeps {
  loadEngine: () => Promise<{
    runHybridSearch: (
      sources: unknown[],
      ctx: Record<string, unknown>,
    ) => Promise<unknown>;
  }>;
  loadSources: () => Promise<{ SEARCH_SOURCES: Array<{ name: string }> }>;
  loadEmbedder: () => Promise<{
    buildQueryEmbedder: (opts?: { acquireBudgetMs?: number }) => Promise<unknown>;
  }>;
  loadWorkspace: () => Promise<{ activeWorkspaceId: () => string }>;
  loadPg: () => Promise<{ getOrgPg: () => { sql: unknown } }>;
  loadRoster: () => Promise<{
    mergeRosterWithAssignments: (opts: Record<string, unknown>) => Promise<unknown>;
  }>;
  loadCorpusWarmup: () => Promise<{
    warmCorpusEmbedder: (opts?: { acquireBudgetMs?: number }) => Promise<boolean>;
  }>;
  loadWorkItemWarmup: () => Promise<{
    warmWorkItemQueryEmbedder: () => Promise<boolean>;
  }>;
}

const realDeps: TranscriptSearchWarmupDeps = {
  loadEngine: () => import('@papercusp/search') as never,
  loadSources: () => import('./agent-tools/search/sources') as never,
  loadEmbedder: () => import('./agent-tools/search/embedder') as never,
  loadWorkspace: () => import('./workspace-registry') as never,
  loadPg: () => import('@papercusp/db-org') as never,
  loadRoster: () => import('./adv-roster') as never,
  // Keep the corpus leg dynamic: corpus-recall-io imports the full search
  // stack, and boot should only pay that graph after the listener is ready.
  loadCorpusWarmup: () => import('./memory/corpus-recall-io') as never,
  // Work-item search has its own process-local single-flight latch. Warming
  // only the generic query embedder leaves the first semantic dedup request
  // cold, so keep this exact hook dynamic and invoke it as an independent,
  // fail-soft leg below.
  loadWorkItemWarmup: () => import('./work-items') as never,
};

/** Warm query: embeds fine, matches little (cheap BM25), exercises every code
 *  path. NOT a stopword-only phrase — that would parse to an empty tsquery and
 *  skip the ranker entirely. */
const WARM_QUERY = 'operator warmup readiness probe';

export async function warmTranscriptSearchPath(
  opts: { log?: (msg: string) => void; deps?: TranscriptSearchWarmupDeps } = {},
): Promise<TranscriptSearchWarmupResult> {
  const log = opts.log ?? ((m: string) => console.warn(m));
  const deps = opts.deps ?? realDeps;
  const t0 = Date.now();
  const legs = { search: false, roster: false, corpus: false, workItems: false };
  try {
    const [
      { runHybridSearch },
      { SEARCH_SOURCES },
      { buildQueryEmbedder },
      { activeWorkspaceId },
      { getOrgPg },
      { mergeRosterWithAssignments },
      { warmCorpusEmbedder },
    ] =
      await Promise.all([
        deps.loadEngine(),
        deps.loadSources(),
        deps.loadEmbedder(),
        deps.loadWorkspace(),
        deps.loadPg(),
        deps.loadRoster(),
        deps.loadCorpusWarmup(),
      ]);
    const sources = SEARCH_SOURCES.filter((s) => s.name === 'session_turn');
    const { sql } = getOrgPg();
    // The legs are independent — warm them concurrently, each fail-soft,
    // so one leg's failure (e.g. PG mid-boot) never blocks the other.
    await Promise.all([
      (async () => {
        // Generous acquire budget: this is background boot work and the whole
        // POINT is to actually finish warming a cold embedder (a short budget
        // would abandon the warm to the next human query — the exact failure
        // this module exists to prevent).
        const embedder = await buildQueryEmbedder({ acquireBudgetMs: 60_000 });
        await runHybridSearch(sources as never, {
          sql,
          query: WARM_QUERY,
          workspaceId: activeWorkspaceId(),
          scopeFilter: null,
          limit: 1,
          mode: 'hybrid',
          embedder,
          embedTimeoutMs: 30_000,
          deferHighlight: true,
        });
        legs.search = true;
      })().catch((err) => log(`[transcript-search-warmup] search leg failed (ignored): ${(err as Error).message}`)),
      (async () => {
        await mergeRosterWithAssignments({ workspaceId: null, thinkingFor: () => false });
        legs.roster = true;
      })().catch((err) => log(`[transcript-search-warmup] roster leg failed (ignored): ${(err as Error).message}`)),
      (async () => {
        // Boot work is deliberately allowed to outlive the turn-start budget:
        // its purpose is to pay cold acquisition before the first context
        // injection, not to abandon the warmup at the same 1200ms boundary it
        // exists to protect.
        legs.corpus = await warmCorpusEmbedder({ acquireBudgetMs: 60_000 });
        if (!legs.corpus) {
          log('[transcript-search-warmup] corpus leg did not become warm (ignored)');
        }
      })().catch((err) => log(`[transcript-search-warmup] corpus leg failed (ignored): ${(err as Error).message}`)),
      (async () => {
        // `searchWorkItems` keeps a separate warm latch so it can report an
        // honest retry receipt to interactive callers. Warm that exact latch;
        // resolving the generic transcript-search embedder alone is not enough.
        const { warmWorkItemQueryEmbedder } = await deps.loadWorkItemWarmup();
        legs.workItems = await warmWorkItemQueryEmbedder();
        if (!legs.workItems) {
          log('[transcript-search-warmup] work-item embedder leg did not become warm (ignored)');
        }
      })().catch((err) =>
        log(`[transcript-search-warmup] work-item embedder leg failed (ignored): ${(err as Error).message}`),
      ),
    ]);
    return { ok: legs.search || legs.roster || legs.corpus || legs.workItems, ms: Date.now() - t0, legs };
  } catch (err) {
    // Even the import phase is fail-soft: a warmup must never affect boot.
    return { ok: false, ms: Date.now() - t0, legs, error: (err as Error).message };
  }
}

/**
 * Fire-and-forget scheduling wrapper for the host boot path: waits a short
 * settle delay (boot's critical path first), then warms. One-shot (not
 * recurring — the scheduler-policy "no bare setInterval" rule targets
 * recurring timers), unref'd so it never holds the process open.
 * Opt-out: PAPERCUSP_DISABLE_SEARCH_WARMUP=1. Skipped under test runners.
 */
export function scheduleTranscriptSearchWarmup(
  opts: { delayMs?: number; log?: (msg: string) => void } = {},
): void {
  if (process.env.PAPERCUSP_DISABLE_SEARCH_WARMUP === '1') return;
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return;
  const delayMs = opts.delayMs ?? 2_500;
  const log = opts.log ?? ((m: string) => console.log(m));
  const t = setTimeout(() => {
    void warmTranscriptSearchPath({ log })
      .then((r) => {
        log(
          `[transcript-search-warmup] ${r.ok ? 'done' : 'failed'} in ${r.ms}ms ` +
            `(search=${r.legs.search} roster=${r.legs.roster} corpus=${r.legs.corpus} ` +
            `workItems=${r.legs.workItems}${r.error ? ` error=${r.error}` : ''})`,
        );
      })
      .catch(() => {});
  }, delayMs);
  t.unref?.();
}
