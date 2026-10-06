/**
 * Plan 2B+C — semantic recall + hybrid (BM25 + embeddings via RRF).
 *
 * `search:semantic` queries the same prose surfaces as `search:fulltext`
 * but adds cosine similarity on pre-computed embeddings; `mode='hybrid'`
 * fuses both via Reciprocal Rank Fusion. The query engine + per-source
 * SQL + embedder cascade now live in `@papercusp/search` + `./sources` +
 * `./embedder` (extracted per papercusp-systems-abstraction-2026-05-29,
 * P-013/P-020); this file is just the `defineTool` projection.
 *
 * If pgvector isn't installed OR backfill hasn't populated embeddings,
 * mode='embeddings' returns empty and mode='hybrid' falls back to BM25-only.
 *
 * P-009 (semantic-search-fingerprint-coverage-2026-08-03): that fallback used
 * to be SILENT — logged via ctx.log inside the engine and nowhere else — so a
 * caller could not distinguish "no good match exists" from "the index is only
 * 72% populated and the good match was never embedded". The response now
 * carries a `coverage` block derived from the same samples the coverage alarm
 * persists; see ../../search/coverage-gate. Absence of a sample reports as
 * `unknown`, never as healthy.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { runHybridSearch } from '@papercusp/search';
import { describeSearchLegs } from './describe-leg';
import { SEARCH_SOURCES } from './sources';
import { scopeResidue } from './scope-residue';
import { buildQueryEmbedderResolved, interactiveEmbedAcquireBudgetMs } from './embedder';
import {
  loadCoverageSnapshotCached,
  assessSearchCoverage,
} from '../../search/coverage-gate';
import { rerankCandidateCount, rerankPageHead } from './rerank';
import { searchFilterArgs, resolveSearchFilters } from './filters';
import { scopeArg, DEFAULT_SCOPE } from './scope';
import { resolveAgentIdentity } from '../coordination/identity';

const MODE_CHOICES = ['embeddings', 'hybrid'] as const;

// + overwatch (overwatch-role-2026-06-15 B-01): the supervisor searches to ground nudges.
const ALL_ROLES = [...SU_ROLES, 'papercup', 'papercup-deep', 'kettle'] as const;

export default defineTool({
  name: 'search:semantic',
  needsWorkspaceTx: true,
  // P-062 Phase 4: same as search:fulltext — reads the non-workspace-scoped
  // operator_turns source and scopes by the explicit workspaceId arg, so it
  // runs on the admin (rolbypassrls) handle, not a workspace-scoped RLS tx.
  crossWorkspace: true,
  capability: 'search:read',
  description:
    'Semantic recall over workspace prose using embedding similarity. mode=hybrid combines with BM25 (search:fulltext) via Reciprocal Rank Fusion for best of both keyword and meaning. Falls back to BM25 if embeddings unavailable.',
  guidance: {
    when:
      'User asks about a concept by paraphrase rather than the exact keyword used in the recorded text. Examples: "when did we talk about authentication strategy" (could match "login flow", "auth approach", "JWT decision"). Prefer mode=hybrid for best recall.',
    notWhen:
      'When the user knows the exact keyword they want. `search:fulltext` is faster + cheaper there (no embedding API call). For structured queries (tasks/goals/projects rows by title), use `search:query`.',
    chaining:
      'Pair with `harness:escalation` or `harness:plan_reviews` to fetch the full row of a hit.',
    seeAlso: [
      'search:fulltext (faster + cheaper keyword recall)',
      'search:query (structured rows by title)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  rolesQuota: { worker: { perChunk: 8 }, operator: { perRun: 50 } },
  args: z.object({
    query: z.string().min(1).max(500),
    scope: scopeArg(),
    harness_slug: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional().describe('Max results (default 5; maximum 50).'),
    mode: z.enum(MODE_CHOICES).optional(),
    ...searchFilterArgs,
  }),
  async handler(args, ctx) {
    const limit = args.limit ?? 5;
    const mode = args.mode ?? 'hybrid';
    // Historic no-scope default stays the 4 original surfaces; an EXPLICIT
    // scope:['all'] expands to every registered source (EI-6984 precedent).
    const scope =
      args.scope?.includes('all')
        ? SEARCH_SOURCES.map((s) => s.name)
        : !args.scope?.length
          ? DEFAULT_SCOPE
          : args.scope;
    const sources = SEARCH_SOURCES.filter((s) => scope.includes(s.name));

    // P-002 filter bag: resolve 'self'/fleet sugars server-side (session:'self'
    // also live-tails the caller's own transcript — compaction recovery).
    // Identity is resolved LAZILY: only a 'self' sugar needs the caller's
    // ownerId (an unattributable caller asking for 'self' SHOULD error loudly);
    // every other path must keep working for surfaces with no agent identity.
    const needsSelf = args.owner === 'self' || args.session === 'self';
    const { filters } = await resolveSearchFilters(
      ctx.tx,
      args,
      needsSelf ? (resolveAgentIdentity(ctx).ownerId ?? '') : '',
      { workspaceId: ctx.workspaceId ?? '' },
    );

    // Resolved (not bare) because the minScore floor below is only valid in
    // the units of the model that produced the query vector — see
    // ../../search/prose-min-score. A floor tuned on gemma applied to an
    // OpenAI vector would delete nearly every result while looking correct.
    const resolvedEmbedder = await buildQueryEmbedderResolved({
      acquireBudgetMs: interactiveEmbedAcquireBudgetMs(),
    });
    const embedder = resolvedEmbedder?.embed ?? null;

    // P-009 runtime honesty: start the coverage read NOW so it overlaps the
    // search instead of adding serial latency. It is a single indexed
    // DISTINCT ON over already-persisted samples (never a live COUNT scan),
    // TTL-memoised, and fail-open — a read error resolves to `unknown`, which
    // is reported as unknown and never as healthy.
    const coveragePromise = loadCoverageSnapshotCached(ctx.tx, ctx.workspaceId ?? '');
    // WI-3929 (same class as EI-9312): bound the ACTUAL per-query embed call
    // inside runHybridSearch, not just the embedder ACQUISITION above — a
    // resolved-but-slow embedder (warm local ONNX under load, or the OpenAI
    // fetch which has no client-side timeout) could otherwise run unbounded
    // and blow this tool's own budget. Reuses the same interactive default.
    const { results, totalHits, embedderAvailable, legs } = await runHybridSearch(sources, {
      caller: 'search:semantic',
      sql: ctx.tx,
      query: args.query,
      workspaceId: ctx.workspaceId ?? '',
      scopeFilter: args.harness_slug ?? null,
      // Stage B over-fetch: retrieve a larger pool than we return so the
      // reranker can pull a buried hit INTO the page. `rerankPageHead` slices
      // back to `limit`, so the caller-visible page size is unchanged — and it
      // still slices correctly when reranking is unavailable (passthrough).
      limit: rerankCandidateCount(limit),
      mode,
      embedder,
      embedTimeoutMs: interactiveEmbedAcquireBudgetMs(),
      filters,
      // P-001 floors are INHERITED now, not hand-passed (P-017): the engine
      // resolves them from the embedder instance via the policy installed by
      // lib/search/configure-search-defaults. This surface used to be the only
      // one of eight that floored, precisely because the floor lived here.
      log: ctx.log,
    });

    // Stage B: cross-encoder rerank the fused page. Fail-safe — no ZeroEntropy
    // key → the RRF order unchanged (see ./rerank).
    //
    // `rerankPageHead`, not `rerankProseHits`: above `limit` 24 the over-fetch
    // degenerates to the page itself, so the whole page would be scored against
    // a budget MEASURED at 24 pairs. rerankPageHead reranks the head and keeps
    // the tail in RRF order, holding worst-case cost flat in page size.
    const reranked = await rerankPageHead(args.query, results, limit);

    // P-009: report WHAT THE INDEX ACTUALLY CONTAINS alongside the hits. Only
    // non-healthy sources are itemised, so a healthy search stays compact.
    const coverage = assessSearchCoverage(scope, await coveragePromise);
    const notable = coverage.perSource.filter(
      (a) => a.verdict === 'degraded' || a.verdict === 'unknown',
    );
    // A degraded index matters more in pure-embeddings mode: with no lexical
    // leg, an unembedded row is not merely ranked lower, it is UNREACHABLE.
    const modeAggravated = mode === 'embeddings' && notable.length > 0;
    const coverageWarning = coverage.warning
      ? modeAggravated
        ? `${coverage.warning}. mode='embeddings' has no lexical fallback, so rows ` +
          `missing from the index are UNREACHABLE here — re-run with mode='hybrid' ` +
          `to recover them via BM25.`
        : coverage.warning
      : null;

    // EI-21538636815409820: the detailed diagnostics below are necessary, but
    // they are not a primary verdict. A caller scanning `results` can miss a
    // nested `legs.degraded` and treat a plausible lexical fallback as full
    // semantic recall. Put the verdict FIRST in the payload so prefix-bounded
    // renderers and human readers both see it before the hits.
    const embedderWarning =
      !embedderAvailable && !legs.semantic.blocked
        ? 'query embedding unavailable — semantic recall was not measured; any returned hybrid-mode results are lexical-only'
        : null;
    const primaryWarnings = [embedderWarning, legs.warning, coverageWarning].filter(
      (warning): warning is string => warning !== null,
    );
    const searchDegraded = !embedderAvailable || legs.degraded || coverage.degraded;
    const searchWarning = searchDegraded
      ? `SEARCH DEGRADED — ${primaryWarnings.join('; ') || 'semantic or corpus retrieval did not run at full strength'}`
      : null;

    // EI-20838436704308881: a FOURTH honesty axis, distinct from all three
    // above — they all describe how well the corpora IN SCOPE were searched,
    // and none of them says which corpora were never in scope at all. A zero
    // from a correctly-working, fully-embedded source still reads as "this does
    // not exist" when the content simply lives in a corpus the caller did not
    // name. Zero-hit only, and derived from SEARCH_SOURCES; see ./scope-residue.
    const residue = totalHits === 0 ? scopeResidue(scope) : null;

    // A zero from a real search with no query embedder is not an observed
    // absence. In hybrid mode the lexical fallback may still produce a valid
    // count; only suppress the count when there are no hits to report and the
    // semantic leg could not measure the query at all. Keep invalid/empty
    // scopes distinguishable from a degraded search that never ran.
    const zeroHitEmbedderUnavailable = sources.length > 0 && totalHits === 0 && !embedderAvailable;
    const zeroHitCaveat = zeroHitEmbedderUnavailable
      ? 'total_hits is unavailable: the query embedder was unavailable, so semantic recall was not measured. ' +
        'THIS ZERO-RESULT PAGE IS NOT AN ABSENCE CLAIM — retry when the embedder is available, or use search:fulltext for exact terms.'
      : null;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: searchDegraded ? 'degraded' : 'ok',
          warning: searchWarning,
          query: args.query,
          mode,
          embedder_available: embedderAvailable,
          scope,
          total_hits: zeroHitEmbedderUnavailable ? null : totalHits,
          ...(zeroHitCaveat ? { zeroHitCaveat } : {}),
          // P-020: WHICH LEG ACTUALLY RAN AND CONTRIBUTED. This is a DIFFERENT
          // question from `coverage` below and from `embedder_available` above,
          // and it is the one that was unanswerable at every layer:
          //   - coverage           = how much of the CORPUS is embedded
          //   - embedder_available = was a QUERY VECTOR produced
          //   - legs               = did each ranker actually put rows into fusion
          // A prose query whose lexical leg AND-collapses to zero rows
          // (EI-19447237774252790) leaves the first two reporting perfect health
          // while the search is silently semantic-only, so this reports the
          // candidate counts rather than an execution flag.
          legs: describeSearchLegs(legs),
          coverage: {
            degraded: coverage.degraded,
            warning: coverageWarning,
            sources: notable.map((a) => ({
              source: a.source,
              verdict: a.verdict,
              coverage: a.coverage === null ? null : Number(a.coverage.toFixed(4)),
              recent_coverage: a.recentCoverage === null ? null : Number(a.recentCoverage.toFixed(4)),
              note: a.note,
            })),
          },
          ...(residue ? { scope_residue: residue } : {}),
          // Map @papercusp/search's generic `scope` hit field back to the
          // operator's domain `harness_slug` for the agent-facing output.
          results: reranked.map(({ scope: hitScope, ...rest }) =>
            hitScope ? { ...rest, harness_slug: hitScope } : rest,
          ),
        }),
      }],
    };
  },
});
