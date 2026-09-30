/**
 * ask-knowledge-tier.ts — the knowledge-FIRST tier (D-001), enforced in the
 * coord:ask tool SHAPE (not just prompting — prompts drift, affordances do not).
 * Before any peer is interrupted, the ask runs existing knowledge:
 *   1. search:semantic — hybrid BM25 + embeddings over escalations / brainstorm
 *      / turns / harness_decisions (the operator's indexed prose surfaces).
 *   2. mem0 — the user's persistent memories, fanned over the same pseudo-user
 *      keys answer-capture writes to (user / workspace:<id> / harness:<slug>), so
 *      a previously-CAPTURED answer (D-004) is found here.
 * A hit returns the answer inline (no peer interrupted); a miss opens a
 * conversation. Each candidate CITES its source so the asker can judge a hit
 * (D-001) — the tier returns candidates, the asker decides.
 *
 * Pure-ish: all IO is try/caught and degrades to "this surface returned nothing"
 * (a missing embedder / pgvector / mem0 must not make the ask fail) — same
 * posture as runHybridSearch's per-source degradation.
 */

import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { runHybridSearch } from '@papercusp/search';
import { SEARCH_SOURCES } from '../search/sources';
import { buildQueryEmbedder, interactiveEmbedAcquireBudgetMs } from '../search/embedder';
import { getMemoryBackend, type MemoryBackend } from '../../memory/backend';
import { activeWorkspaceId } from '../../workspace-registry';

/** Injectable IO for the tier — defaults to the prod org handle + the
 *  configured MemoryBackend (generalize-memory-backend-swappable D-003).
 *  The tests inject a throwaway sql + a stub backend. */
export interface KnowledgeTierDeps {
  sql?: Sql;
  backend?: MemoryBackend;
  /** Test/host seam for the bounded embedder acquisition. The real search
   *  engine still runs when this returns null, using its BM25 fallback. */
  buildEmbedder?: typeof buildQueryEmbedder;
}

export interface KnowledgeCandidate {
  /** Which surface produced it (for the asker to judge — D-001). */
  source: 'search:semantic' | 'mem0';
  /** A stable reference for dedup + provenance. */
  ref: string;
  /** Finer label: the search source name (escalations/decisions/…) or 'mem0'. */
  label: string;
  /** The matched text (first ~200 chars / the memory body). */
  excerpt: string;
  /** Ranker-native or fused score (NOT comparable across sources — for ordering only). */
  score: number;
}

export interface KnowledgeTierResult {
  candidates: KnowledgeCandidate[];
  /** Which surfaces were actually queried (the rest degraded/were absent). */
  searched: string[];
  embedder_available: boolean;
}

export interface KnowledgeTierInput {
  query: string;
  workspaceId?: string | null;
  /** The asker's owner id — included as a mem0 read key (their own memories). */
  asker_id?: string;
  /** Restrict search:semantic to one harness + read that harness's mem0 scope. */
  harness_slug?: string | null;
  limit?: number;
}

export async function runKnowledgeTier(
  input: KnowledgeTierInput,
  deps: KnowledgeTierDeps = {},
): Promise<KnowledgeTierResult> {
  const limit = input.limit ?? 5;
  const sql = deps.sql ?? getOrgPg().sql;
  const backend = deps.backend ?? getMemoryBackend();
  const buildEmbedder = deps.buildEmbedder ?? buildQueryEmbedder;
  const candidates: KnowledgeCandidate[] = [];
  const searched: string[] = [];
  let embedderAvailable = false;

  // 1. search:semantic (hybrid) over the indexed prose surfaces.
  try {
    // WI-3929 (same class as EI-9312): bound both the embedder ACQUISITION
    // (previously fully unbounded here — worse than the other 3 call sites
    // this WI fixes, which at least bounded acquisition via WI-3922) and the
    // ACTUAL per-query embed call inside runHybridSearch.
    const embedder = await buildEmbedder({ acquireBudgetMs: interactiveEmbedAcquireBudgetMs() });
    const { results, embedderAvailable: ea } = await runHybridSearch(SEARCH_SOURCES, {
      caller: 'ask-knowledge-tier',
      sql,
      query: input.query,
      workspaceId: input.workspaceId ?? '',
      scopeFilter: input.harness_slug ?? null,
      limit,
      mode: 'hybrid',
      embedder,
      embedTimeoutMs: interactiveEmbedAcquireBudgetMs(),
    });
    embedderAvailable = ea;
    searched.push('search:semantic');
    for (const h of results) {
      candidates.push({
        source: 'search:semantic',
        ref: `${h.source}:${h.source_id}`,
        label: h.source,
        excerpt: (h.excerpt || h.highlight || '').slice(0, 240),
        score: h.score,
      });
    }
  } catch {
    /* search surface degraded — proceed with whatever mem0 returns */
  }

  // 2. the persistent memory store — fan over the same scope keys
  // answer-capture writes under. (The `mem0` source label is a stable
  // wire literal; the store behind it is the swappable MemoryBackend.)
  try {
    if ((await backend.available()).ok) {
      searched.push('mem0');
      const keys = new Set<string>();
      if (input.asker_id) keys.add(input.asker_id);
      // The operator-scope key resolves the REAL workspace (never a silent 'default'),
      // matching the key answer-capture writes under — both fall back to activeWorkspaceId()
      // so a captured answer is found in the right workspace, not a mixed 'default' bucket (D-003).
      keys.add(`workspace:${(input.workspaceId ?? '').trim() || activeWorkspaceId()}`);
      if (input.harness_slug) keys.add(`harness:${input.harness_slug}`);
      const hits = await backend.search(input.query, { scope: [...keys], limit });
      for (const m of hits) {
        candidates.push({
          source: 'mem0',
          ref: `mem0:${m.id}`,
          label: 'mem0',
          excerpt: m.text.slice(0, 240),
          score: m.score ?? 0,
        });
      }
    }
  } catch {
    /* memory store unavailable — proceed with search:semantic candidates */
  }

  // Dedupe by ref, keep highest score, top-N.
  const byRef = new Map<string, KnowledgeCandidate>();
  for (const c of candidates.sort((a, b) => b.score - a.score)) {
    if (!byRef.has(c.ref)) byRef.set(c.ref, c);
  }
  return { candidates: [...byRef.values()].slice(0, limit), searched, embedder_available: embedderAvailable };
}
