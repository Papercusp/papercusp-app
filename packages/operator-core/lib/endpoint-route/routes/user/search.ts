/**
 * /api/user/search — user-facing search across personal memories
 * (mem0) AND workspace prose (escalations / brainstorm / turns /
 * decisions via BM25). BM25 only by default; hybrid (BM25 + embeddings
 * + RRF) available via `?mode=hybrid`.
 *
 * The prose half runs through `@papercusp/search` over the shared
 * `SEARCH_SOURCES` registry + the `buildQueryEmbedder` cascade — the
 * SAME engine the `search:fulltext` / `search:semantic` agent tools use,
 * so the per-surface SQL, RRF fusion, and embedder live in exactly one
 * place (migrated off a hand-rolled duplicate per P-020, 2026-05-30).
 *
 * Ported from app/api/user/search/route.ts. `auth: 'public'` —
 * session-cookie auth with the seeded-`default`-user fallback
 * (single-user installs: the desktop webview typically carries no
 * session cookie).
 */
import { getSessionUserOrDefault } from '../../../auth';
import { getMemoryBackend, type MemoryEntry } from '../../../memory/backend';
import { activeWorkspaceId } from '../../../workspace-registry';
import { getOrgPg } from '@papercusp/db-org';
import { defineTool } from '@papercusp/agent-mcp';
import { runFullTextSearch, runHybridSearch, type SearchHit } from '@papercusp/search';
import { SEARCH_SOURCES } from '../../../agent-tools/search/sources';
import { buildQueryEmbedder, interactiveEmbedAcquireBudgetMs } from '../../../agent-tools/search/embedder';
import { rerankCandidateCount, rerankProseHits } from '../../../agent-tools/search/rerank';

interface ProseHit {
  source: string;
  source_id: string;
  harness_slug?: string;
  excerpt: string;
  highlight: string;
  rank: number;
}

/** Engine hit → the route's prose-hit shape (`rank` is the engine `score`). */
function toProseHit(h: SearchHit): ProseHit {
  return {
    source: h.source,
    source_id: h.source_id,
    ...(h.scope ? { harness_slug: h.scope } : {}),
    excerpt: h.excerpt,
    highlight: h.highlight,
    rank: h.score,
  };
}

/**
 * Prose recall over all four surfaces via `@papercusp/search`. `bm25`
 * runs BM25 only; `hybrid` fuses BM25 + pgvector embeddings via RRF and
 * silently falls back to BM25 when no embedder is available.
 */
async function searchProse(q: string, mode: 'bm25' | 'hybrid', limit: number): Promise<ProseHit[]> {
  const ctx = {
    sql: getOrgPg().sql,
    query: q,
    workspaceId: activeWorkspaceId(),
    harnessFilter: null,
    scopeFilter: null,
    // Stage B over-fetch — see the note in agent-tools/search/semantic.ts.
    // This route's `limit` reaches 20, so the RERANK_MAX_CANDIDATES cap (not
    // the 4x multiplier) is what bounds it here.
    limit: rerankCandidateCount(limit),
  };
  let results: SearchHit[];
  if (mode === 'hybrid') {
    // Interactive user-facing search — bound the embedder acquisition so a cold
    // local pipeline (OpenAI embed exhausted) degrades to BM25 instead of hanging
    // the request (WI-3922, same class as WI-3860).
    const embedder = await buildQueryEmbedder({ acquireBudgetMs: interactiveEmbedAcquireBudgetMs() });
    // WI-3929 (same class as EI-9312): bound the ACTUAL per-query embed call
    // too, not just the acquisition above.
    ({ results } = await runHybridSearch(SEARCH_SOURCES, {
      ...ctx,
      caller: 'user:search',
      mode: 'hybrid',
      embedder,
      embedTimeoutMs: interactiveEmbedAcquireBudgetMs(),
    }));
  } else {
    ({ results } = await runFullTextSearch(SEARCH_SOURCES, ctx));
  }
  // Stage B: cross-encoder rerank. Fail-safe — no ZeroEntropy key → the RRF
  // order unchanged (see lib/agent-tools/search/rerank).
  const reranked = await rerankProseHits(q, results, limit);
  return reranked.map(toProseHit);
}

async function searchMemories(q: string, userId: string, limit: number) {
  // Neutral MemoryBackend seam (generalize-memory-backend-swappable
  // D-003): the user pool + the legacy workspace-shared pool (read-
  // through only — the write path no longer emits workspace entries).
  const backend = getMemoryBackend();
  try {
    if (!(await backend.available()).ok) return [];
    const ws = activeWorkspaceId();
    // Bound the mem0 recall leg. backend.search() runs its OWN query embed (the
    // cosine leg) — a SECOND unbounded embed NOT covered by the buildQueryEmbedder
    // acquisition bound on the prose leg (WI-3922, same hang class as WI-3860).
    // Under an exhausted OpenAI embed the local ONNX cold-start (15-30s) would
    // otherwise hang /api/user/search well past the interactive budget. Race the
    // whole recall against the same interactive deadline → degrade to no memories
    // (the prose half still returns) rather than block the response. budgetMs ≤ 0
    // keeps it unbounded (the codebase-wide "0 disables the bound" convention).
    const budgetMs = interactiveEmbedAcquireBudgetMs();
    const recall = backend.search(q, {
      scope: [userId, `workspace:${ws}`],
      limit,
    });
    const hits: MemoryEntry[] = budgetMs > 0
      ? await Promise.race([
          recall,
          new Promise<MemoryEntry[]>((resolve) => setTimeout(() => resolve([]), budgetMs)),
        ])
      : await recall;
    return hits.slice(0, limit).map((e) => ({
      id: e.id,
      text: e.text,
      kind: e.kind,
      metadata: e.metadata,
      score: e.score,
      scope: e.scope.startsWith('workspace:') ? ('workspace' as const) : ('user' as const),
    }));
  } catch {
    return [];
  }
}

export default defineTool({
  method: 'GET',
  path: '/user/search',
  auth: 'public',
  async handler(req) {
    const user = await getSessionUserOrDefault(req.headers);
    const url = new URL(req.url);
    const q = (url.searchParams.get('q') ?? '').trim();
    if (!q) return Response.json({ q: '', memories: [], prose: [] });
    const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit') ?? 10)));
    const mode = url.searchParams.get('mode') === 'hybrid' ? 'hybrid' : 'bm25';

    const [memories, prose] = await Promise.all([
      searchMemories(q, user.id, limit),
      searchProse(q, mode, limit),
    ]);
    return Response.json({ q, mode, memories, prose });
  },
});
