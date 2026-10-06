/**
 * Full-text BM25-style recall over unstructured prose.
 *
 * Plan 2A — Postgres tsvector + GIN. The query engine + the per-source
 * SQL now live in `@papercusp/search` + `./sources` (extracted per
 * papercusp-systems-abstraction-2026-05-29, P-013/P-020); this file is
 * just the `defineTool` projection.
 *
 * Different from `search:query`: that one searches structured rows
 * (tasks/goals/projects/audit) by title/summary. This one
 * targets free-text bodies for paraphrase recall.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { runFullTextSearch } from '@papercusp/search';
import { SEARCH_SOURCES } from './sources';
import { scopeResidue } from './scope-residue';
import { rerankCandidateCount, rerankPageHead } from './rerank';
import { searchFilterArgs, resolveSearchFilters } from './filters';
import { scopeArg, DEFAULT_SCOPE } from './scope';
import { resolveAgentIdentity } from '../coordination/identity';
import {
  createStageAttempt,
  traceStageAwait,
  withStageAttempt,
  type StageAttemptContext,
} from '../../sync/hyperbee/stage-stall-log';

// + overwatch (overwatch-role-2026-06-15 B-01): the supervisor searches to ground nudges.
// + judge (acceptance-rubric grading): the dedicated evaluator needs read-only
// prose recall to follow the rubric's evidence method without gaining the
// broader coordination/write surface.
const ALL_ROLES = [...SU_ROLES, 'papercup', 'papercup-deep', 'kettle', 'judge'] as const;

export default defineTool({
  name: 'search:fulltext',
  needsWorkspaceTx: true,
  // P-062 Phase 4: reads `operator_turns` (a non-workspace-scoped global table)
  // among its sources and scopes the ws-scoped sources by the explicit
  // workspaceId arg, not RLS. Must run on the admin (rolbypassrls) handle — a
  // workspace-scoped harness_app tx has no grant on operator_turns.
  crossWorkspace: true,
  capability: 'search:read',
  description:
    'Search workspace prose (escalations, brainstorm notes, older operator turns, and — with scope:["work_item"] — bug/change/task issue titles+bodies) by keyword match (BM25-style). Ranked by relevance. Returns excerpts.',
  guidance: {
    when: 'User references prose past the chat history budget ("remember when we decided pricing", "the X discussion from last week"), or asks about content in escalations/brainstorm where the right SQL filter is not obvious. Returns ranked snippets. Also: BEFORE filing a new bug/change work-item, pass scope:["work_item"] to dedup-check against existing EI-* issues by title/body keyword — cheaper and more scalable than work_items:list + grep past ~500 items.',
    notWhen:
      'For STRUCTURED queries on harness state, features, or tasks — use the dedicated tools (harness:status, tasks:list, etc), faster/more precise when the schema matches. For CODE recall, use repository source search; this tool indexes workspace prose, not source files. For tasks/goals/projects text, use `search:query`. `scope:["work_item"]` covers only the ISSUE family (bug/change/task) — not feature-family (F-NNN).',
    chaining:
      'Pair with `harness:escalation` or `harness:plan_reviews` to fetch the full row of a returned hit; pair `scope:["work_item"]` hits with `work_items:get { id }` for the full record. The result `excerpt` is just the first 200 chars for ranking display.',
    seeAlso: [
      'search:semantic (embedding-based recall)',
      'search:query (structured tasks / goals / projects rows)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  rolesQuota: { worker: { perChunk: 10 }, operator: { perRun: 100 } },
  args: z.object({
    query: z.string().min(1).max(500),
    scope: scopeArg(),
    harness_slug: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional().describe('Max results (default 5; maximum 50).'),
    ...searchFilterArgs,
  }),
  async handler(args, ctx) {
    const startedAt = performance.now();
    const stages: Array<{ name: string; elapsedMs: number; status: 'ok' | 'error' }> = [];
    const metadata = (ctx as { metadata?: (value: Record<string, unknown>) => void }).metadata;
    let queryAttempt: StageAttemptContext | undefined;
    // Reuse invocation metadata so a slow search distinguishes SQL retrieval
    // from the optional reranker; record a failed stage before propagating it.
    const measure = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
      const start = performance.now();
      let status: 'ok' | 'error' = 'error';
      try {
        const value = await action();
        status = 'ok';
        return value;
      } finally {
        stages.push({ name, elapsedMs: Math.max(0, performance.now() - start), status });
        metadata?.({ searchFulltextRead: {
          schemaVersion: 'fulltext-read-v1',
          unit: 'ms',
          timing: 'wall-time-sequential-stages',
          elapsedMs: Math.max(0, performance.now() - startedAt),
          stages: [...stages],
          ...(queryAttempt ? { queryDiagnostics: {
            ...queryAttempt,
            stage: 'scope-query',
            coverage: 'queries-created-during-retrieval',
            timing: 'query-build-to-terminal-not-acquisition',
          } } : {}),
        } });
      }
    };
    const limit = args.limit ?? 5;
    // EI-6984: 'work_item' (and now the session/coord corpora) are opt-in only,
    // kept OUT of the historic no-scope default (unscoped callers keep the same
    // 4-source result shape they've always gotten) — but an EXPLICIT
    // scope:['all'] means "every source", so it expands to all seven.
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
    const { filters } = await measure('filters', () => resolveSearchFilters(
      ctx.tx,
      args,
      needsSelf ? (resolveAgentIdentity(ctx).ownerId ?? '') : '',
      { workspaceId: ctx.workspaceId ?? '' },
    ));

    const { results, totalHits } = await measure('retrieval', async () => {
      // The existing query diagnostic ring captures context when a query is
      // created. Persist this local attempt identity in invocation metadata so
      // those records can be joined without guessing from timestamps/session ids.
      // The ledger invocation id does not exist yet; rowId stays explicitly unknown.
      const attempt = metadata ? createStageAttempt({ rowId: '', onEvent: () => {} }) : undefined;
      queryAttempt = attempt?.context;
      let outcome: 'fulfilled' | 'rejected' = 'rejected';
      try {
        const result = await withStageAttempt(attempt, () => traceStageAwait('scope-query', () =>
          runFullTextSearch(sources, {
            sql: ctx.tx,
            query: args.query,
            workspaceId: ctx.workspaceId ?? '',
            scopeFilter: args.harness_slug ?? null,
            // Stage B over-fetch — `rerankPageHead` slices back to limit.
            limit: rerankCandidateCount(limit),
            filters,
            log: ctx.log,
          }),
        ));
        outcome = 'fulfilled';
        return result;
      } finally {
        attempt?.finish(outcome);
      }
    });

    // Stage B: cross-encoder rerank. Fail-safe — no ZeroEntropy key → the
    // BM25 order unchanged (see ./rerank).
    //
    // `rerankPageHead`, not `rerankProseHits`: above `limit` 24 the over-fetch
    // degenerates to the page itself (rerankCandidateCount never under-fetches),
    // so handing the whole page to the cross-encoder would score up to 50 pairs
    // against a budget MEASURED at 24 (~45ms/pair, no parallelism escape) and
    // blow PROSE_RERANK_TIMEOUT_MS into a full degrade. rerankPageHead honours
    // the cap as a CANDIDATE budget: the head is reranked, the tail rides
    // through in BM25 order, and worst-case cost is flat in page size.
    const reranked = await measure('rerank', () => rerankPageHead(args.query, results, limit));

    // search:fulltext's output rows use `rank` (no score/rankers).
    const top = reranked.map((r) => ({
      source: r.source,
      source_id: r.source_id,
      ...(r.scope ? { harness_slug: r.scope } : {}),
      excerpt: r.excerpt,
      highlight: r.highlight,
      rank: r.score,
    }));

    // EI-18685793913963409: a ZERO/low hit count on the historic default scope
    // (which silently excludes 'work_item', EI-6984) reads to a caller as "no
    // existing bug/change/task matches this" when in fact that corpus was never
    // queried — the exact miss that let a dedup-search-first capture create a
    // duplicate of an already-landed fix. The guidance already says to pass
    // scope:['work_item'] before filing, but that relies on the caller
    // recalling it from prose; surface it as a structured, impossible-to-miss
    // field on every unscoped-of-work_item response instead (additive only —
    // never changes `results`/`total_hits` for existing callers).
    const workItemUnsearched = !scope.includes('work_item');

    // EI-20838436704308881: the hint above protects exactly ONE source, so the
    // next instance of the same false-absence class landed on a different one —
    // an agent read a correct zero from `turns` (the operator-chat corpus) as
    // proof the scope was dead, because the phrase lived in `session_turn`.
    // ./scope-residue derives the unsearched set from SEARCH_SOURCES, so it
    // cannot fall behind the registry the way a hand-typed name does. Emitted
    // only on a ZERO — that is the exact moment a caller is about to mistake
    // their own scoping for an absence, and it costs nothing on a hit.
    const residue = totalHits === 0 ? scopeResidue(scope) : null;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          query: args.query,
          scope,
          total_hits: totalHits,
          results: top,
          ...(workItemUnsearched
            ? {
                work_item_scope_hint:
                  "the bug/change/task issue corpus was NOT searched (scope:['work_item'] is opt-in, not part of this default) — " +
                  'a ZERO or low hit count above does NOT mean no matching bug/change exists. ' +
                  "Before filing (improvements:capture / work_items:create), re-run with scope including 'work_item' to dedup-check it.",
              }
            : {}),
          ...(residue ? { scope_residue: residue } : {}),
        }),
      }],
    };
  },
});
