/**
 * docs:search — context-aware keyword search.
 *
 * Same routing as docs:outline: harness-context callers get their
 * harness's docs; everyone else gets Papercusp engineering reference.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import {
  genericFsAdapter,
  searchDocs,
  harnessFsAdapter,
  type DocSource,
  type SearchHit,
  type SearchResult as DocsSearchResult,
} from '@papercusp/docs-engine';
import { getOrgPg } from '@papercusp/db-org';
import { runHybridSearch, isVectorOnly, type SearchSource, type Listing, type PgHandle } from '@papercusp/search';
import { loadHarnessRegistry, resolveHarnessContentPath } from '../../harness-registry';
import { engineeringAdapter } from './_engineering-adapter';
import { assessDocsCoverage, docsCoverageNote } from './semantic-coverage';
import {
  HARNESS_REQUIRED_DETAIL,
  isEngineeringDocsSentinel,
  resolveHarnessScope,
  type HarnessScope,
} from '../_harness-scope';
import { resolveDocsEmbedder, docSectionsRanker, type DocSemanticHit } from './semantic-leg';
import { interactiveEmbedAcquireBudgetMs } from '../search/embedder';
import { resolveAgentIdentity } from '../coordination/identity';
// Installs papercusp's engine-level ranking policy (P-017) on import — the
// same side-effect import every other engine caller uses. Without it this
// surface would call the engine and inherit NO floor, which is the exact
// hand-propagation failure P-016 removes.
import '../../search/configure-search-defaults';

/**
 * WI-5690: over-fetch the LEXICAL leg past `limit` so RRF fusion has real
 * headroom to promote a semantic-only hit above the cut. The engine already
 * over-fetches `limit*3` per source; this floor preserves the prior
 * `Math.max(limit*3, 30)` depth for small limits (the default 8 would
 * otherwise drop from 30 candidates to 24). searchDocs's internal
 * `hitCount`/full `scored` list is unaffected by the limit param — only how
 * much of it gets sliced into `hits` — so this is purely more fusion
 * candidates, never a change to the underlying ranker.
 */
const MIN_CANDIDATES = 30;

/**
 * P-004: how many hits the cross-surface probe returns when the semantic leg found nothing on the
 * caller's own surface. Small on purpose — the probe exists to NAME the right corpus, not to rank it;
 * the caller gets an explicit `harness:'engineering'` re-run for the full hybrid ranking.
 */
const CROSS_SURFACE_PROBE_LIMIT = 5;

export const RETIREMENT_AUTHORITY_SLUG = 'agent-insights/mug-kettle-cup-tier-is-retired';

type CurrentnessFields = {
  historical?: true;
  authority?: 'current';
  surface?: 'engineering';
};

export type CurrentnessSearchHit = SearchHit & CurrentnessFields;

/** Retirement/current-mechanism questions need authority, not lexical density. */
export function isRetirementAuthorityQuery(query: string): boolean {
  const tierTerms = [...query.matchAll(/\b(?:queen|mug|kettle|cup|bee)\b/gi)].map((match) => match[0].toLowerCase());
  if (tierTerms.length === 0) return false;
  if (!/\b(?:current(?:ly)?|retir(?:e[sd]?|ing|ement)|replacement|replaced|supported|now)\b/i.test(query)) {
    return false;
  }
  // `mug`/`cup`/`kettle` are ordinary nouns too. Currentness alone ("current mug price") is
  // insufficient unless the query also names retirement, an execution mechanism, or multiple tier
  // roles. This keeps the authority route narrow without requiring one exact incident sentence.
  return (
    /\b(?:retir(?:e[sd]?|ing|ement)|replacement|replaced)\b/i.test(query) ||
    /\b(?:agent|role|work|assign(?:ment)?|wake|dispatch|plan|fleet|executor|runtime|spawn|orchestrat\w*|supported)\b/i.test(
      query,
    ) ||
    new Set(tierTerms).size > 1
  );
}

/** Plan exports are historical records, even when their plan status was once active. */
export function isHistoricalDocsHit(hit: Pick<SearchHit, 'slug' | 'trust'>): boolean {
  return hit.trust?.superseded === true || /(?:^|\/)docs\/plans\//.test(hit.slug) || /^plans\//.test(hit.slug);
}

/** Stable current-authority ordering; ordinary queries remain byte-for-byte ordered. */
export function rankRetirementAuthorityHits<T extends SearchHit>(
  query: string,
  hits: readonly T[],
): Array<T & CurrentnessFields> {
  const retirementQuery = isRetirementAuthorityQuery(query);
  const labelled: Array<T & CurrentnessFields> = hits.map((hit) => ({
    ...hit,
    ...(isHistoricalDocsHit(hit) ? { historical: true as const } : {}),
    ...(retirementQuery && hit.slug === RETIREMENT_AUTHORITY_SLUG ? { authority: 'current' as const } : {}),
  }));
  if (!retirementQuery) return labelled;
  return labelled
    .map((hit, index) => ({ hit, index }))
    .sort((a, b) => {
      const authorityA = a.hit.slug === RETIREMENT_AUTHORITY_SLUG ? 0 : 1;
      const authorityB = b.hit.slug === RETIREMENT_AUTHORITY_SLUG ? 0 : 1;
      if (authorityA !== authorityB) return authorityA - authorityB;
      const historyA = a.hit.historical ? 1 : 0;
      const historyB = b.hit.historical ? 1 : 0;
      return historyA - historyB || a.index - b.index;
    })
    .map(({ hit }) => hit);
}

/**
 * P-004: should this response probe the sibling 'engineering' surface on the caller's behalf?
 *
 * Exported and PURE so the discrimination that makes the probe safe is directly testable — the
 * handler around it is just plumbing, and the property worth guarding is which `legs.semantic.status`
 * values earn a second corpus read.
 *
 * TRUE only when the semantic leg RAN and matched nothing. That is evidence about the CORPUS: not one
 * section cleared the similarity floor, so the ranking degraded to lexical noise and the answer, if it
 * exists, is somewhere else. A 'blocked'/'not-run' leg is evidence about the EMBEDDER instead — it
 * degrades every query identically, so probing a second corpus with the same broken leg would double
 * every docs:search on this box while buying nothing.
 */
export function shouldProbeSiblingSurface(input: {
  surface: 'harness' | 'engineering' | 'project';
  isSuperuser: boolean;
  semanticLeg: { status?: string; candidates?: number } | undefined;
  query?: string;
  hasHistoricalHits?: boolean;
}): boolean {
  // The engineering surface IS the sibling — probing it from itself is a self-query.
  if (input.surface === 'engineering') return false;
  // resolveAdapter gates the engineering corpus to papercusp-su (D-005 / P-016); the probe must not
  // become a side door around that gate.
  if (!input.isSuperuser) return false;
  // Currentness questions about the retired tier have one canonical answer on the engineering
  // surface. Route them there even if the caller's scoped corpus produced plausible semantic hits:
  // those hits can be historical plans, which is the measured P-005 failure mode.
  if (input.query && isRetirementAuthorityQuery(input.query)) return true;
  if (input.semanticLeg?.status !== 'ran') return false;
  return (input.semanticLeg.candidates ?? 0) === 0;
}

/**
 * The engine takes a PG handle and threads it to every source — but NEITHER of
 * this surface's legs consumes it: the lexical leg reads a filesystem adapter,
 * and the semantic leg resolves its own handle inside `querySections` (the
 * doc_sections read, where its injectable seam lives).
 *
 * So resolve it LAZILY. `getOrgPg()` calls `adminUrl()` unconditionally, and
 * calling it up front would newly couple a lexical-only docs search — which
 * has never needed a database — to PG discovery being healthy. A future source
 * that genuinely wants the handle still gets the real one on first touch.
 */
const lazyOrgSql = new Proxy((() => {}) as unknown as PgHandle, {
  apply: (_t, _self, argv: unknown[]) => (getOrgPg().sql as unknown as (...a: unknown[]) => unknown)(...argv),
  get: (_t, prop) => (getOrgPg().sql as unknown as Record<string | symbol, unknown>)[prop],
});

/** A pack-doc read never holds a docs:search open for longer than this. */
const PACKAGE_DOC_BUDGET_MS = 2_000;

type PackageDocSearchHit = SearchHit & {
  identityPackage: { partKey: string; harnessSlug: string; section: string | null };
};

/**
 * P-009 / D-022: the caller's own identity-installed pack docs matching the query. Fail
 * closed and quiet — no wearer, no workspace, a read error or a slow read all yield [], so
 * a caller with no applied doc keys gets today's result. The DB is touched only once a
 * wearer and workspace resolve, keeping a lexical-only docs search off PG otherwise.
 */
async function wearerPackageDocHits(ctx: unknown, query: string, limit: number): Promise<PackageDocSearchHit[]> {
  let ownerId: string | null = null;
  try { ownerId = resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]).ownerId ?? null; } catch { ownerId = null; }
  const workspaceId = (ctx as { principal?: { workspaceId?: string } | null }).principal?.workspaceId ?? '';
  if (!ownerId || !workspaceId.trim()) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { searchWearerPackageDocs } = await import('../../blueprint/package-doc-resources');
    const hits = await Promise.race([
      searchWearerPackageDocs(getOrgPg().sql, { workspaceId, ownerId, query, limit }),
      new Promise<[]>((resolve) => { timer = setTimeout(() => resolve([]), PACKAGE_DOC_BUDGET_MS); }),
    ]);
    return hits.map((hit) => ({
      slug: `package-doc/${hit.partKey}`,
      url: `harness_doc_parts:${hit.harnessSlug}/claude-md#${hit.partKey}`,
      title: hit.title,
      score: hit.score,
      excerpt: hit.excerpt,
      identityPackage: { partKey: hit.partKey, harnessSlug: hit.harnessSlug, section: hit.section },
    }));
  } catch {
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function resolveAdapter(
  harnessSlug: string | undefined,
  opts: { isSuperuser?: boolean } = {},
): Promise<{
  adapter: DocSource;
  surface: 'harness' | 'engineering' | 'project';
  error?: { code: string; slug?: string; detail?: string };
}> {
  // SU mode passes harnessSlug='*' as a wildcard sentinel (set by
  // http-projection.ts when an admin calls with ?superuser=1 and no harness).
  // Treat it the same as "no harness" so the project/engineering branch is
  // reached — matching plans/source.ts, plans/_ctx-opts.ts, projects/list.ts.
  // Without this, '*' falls through to the registry lookup and returns a
  // bogus harness_not_registered{slug:'*'} for every SU/engineer caller.
  if (!harnessSlug || harnessSlug === '*') {
    // D-001 / P-004: project-docs branch via env var (set by omp-su wrapper).
    const projectDocsRoot = process.env.PAPERCUSP_PROJECT_DOCS_ROOT?.trim();
    if (projectDocsRoot) {
      return {
        adapter: genericFsAdapter(projectDocsRoot, { name: 'project' }),
        surface: 'project',
      };
    }
    // D-005 / P-016: engineering branch is for papercusp-su (SU/engineer) only.
    if (opts.isSuperuser) {
      return { adapter: engineeringAdapter, surface: 'engineering' };
    }
    return {
      adapter: engineeringAdapter,
      surface: 'engineering',
      error: {
        code: 'no_docs_source',
        detail:
          'No harness in context, PAPERCUSP_PROJECT_DOCS_ROOT not set, and caller is not papercusp-su. Set PAPERCUSP_PROJECT_DOCS_ROOT to point at your project docs.',
      },
    };
  }
  const reg = await loadHarnessRegistry();
  const project = reg.projects.find((p) => p.slug === harnessSlug);
  if (!project) {
    return {
      adapter: engineeringAdapter,
      surface: 'engineering',
      error: { code: 'harness_not_registered', slug: harnessSlug },
    };
  }
  return {
    adapter: harnessFsAdapter(resolveHarnessContentPath(reg, harnessSlug) ?? project.path, {
      name: `harness:${harnessSlug}`,
    }),
    surface: 'harness',
  };
}

/**
 * Normalize the legacy `q` spelling before the strict args schema runs.
 *
 * `docs:search` has always consumed `query`, but several callers learned the
 * shorter `q` spelling from other search tools. Keep the canonical output
 * shape (and its published JSON schema) while accepting that legacy input.
 * When both spellings are supplied, the explicit canonical `query` wins and
 * the alias is discarded rather than becoming an unknown strict arg.
 */
export function normalizeDocsSearchArgs(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const args = raw as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(args, 'q')) return raw;

  const { q, ...rest } = args;
  return rest.query !== undefined ? rest : { ...rest, query: q };
}

const argsSchema = z.preprocess(
  normalizeDocsSearchArgs,
  z.object({
    query: z
      .string()
      .min(2)
      .max(200)
      .describe('Keyword query. Legacy alias: `q`. Whitespace-separated tokens; tokens <2 chars dropped.'),
    limit: z.number().int().min(1).max(20).default(8).describe('Max hits returned. Default 8.'),
    harness: z
      .string()
      .optional()
      .describe(
        "Harness slug whose docs to search. Pass 'all' for Papercusp's own framework docs / your project docs (operator scope) — " +
          "but only on an UNSCOPED (--all-workspaces) session; a workspace-scoped su session gets harness_forbidden for 'all'/'*' " +
          "(EI-12898). To reach the SAME framework/agent-insights corpus from a workspace-scoped session, pass 'engineering' " +
          'instead — a distinct literal the workspace clamp does not intercept (EI-18894866320087268). Omit only when the ' +
          "session is already scoped to a harness — otherwise you'll get harness_required.",
      ),
    semantic: z
      .boolean()
      .optional()
      .describe(
        'Fuse an embedding-cosine leg with the keyword leg (RRF), so a topically-exact page whose words ' +
          'never appear verbatim still ranks. Hits found ONLY that way are marked semantic:true. ' +
          'Default on (off under vitest); false = lexical-only. Read `legs` on the response for whether ' +
          'it actually ran: legs.degraded=true means the ranking is NOT the one this promises.',
      ),
  }),
);

export default defineTool({
  name: 'docs:search',
  description:
    "Keyword search over the current harness/project docs, or the Papercusp framework for su callers. `query` wins over legacy `q`; returns ranked slug/title/description/excerpt hits. Harness/project scope excludes agent-insights and framework docs, so weak results include `scopeNote`; do not read them as absence. Workspace sessions cannot use `harness:'all'`; use `harness:'engineering'` for that corpus.",
  guidance: {
    when: 'You have specific terminology in mind (a function name, concept, or component) and want to find which doc page covers it. Faster than scanning the outline when the section name is non-obvious.',
    notWhen:
      'You do not know what to search for — call docs:outline first. For PG-stored prose (chats, escalations) use search:fulltext. To search another harness from outside, use cross_harness:docs_search. No `section` filter here (docs:outline has one) — scope via docs:outline { section } then docs:get.',
    chaining:
      'docs:search → docs:get { slugs: [top-hit] } (or { slug, heading } if the hit excerpt names a specific heading). A hit carrying `trust` is telling you something about its RELIABILITY (OKF v0.2): `stale:true` = past its author-set stale_after, so re-check its claims against the code before acting; `tier` = unverified/machine-verified/human-verified. NO `trust` field means unverified and not stale — the state of nearly every doc today, not an error.',
    returns:
      "{ hits, hitCount, surface, legs, applied, scopeNote?, crossSurface?, embedCoverage? }. `embedCoverage` appears ONLY when the semantic leg ran but its corpus is under-embedded or unmeasured (verdict 'degraded'|'unknown'): hits may be missing pages that exist. Absent = nothing to report, not healthy-by-omission. READ `crossSurface` WHENEVER IT IS PRESENT: it means the semantic leg RAN against your surface and matched nothing above the similarity floor, so the `hits` above are lexical-only and may be entirely off-topic even when there are dozens of them. Rather than only advising a retry, the sibling 'engineering' surface (agent-insights/ + the Papercusp framework reference) was searched FOR you; `crossSurface.hits` are keyword hits from there. Re-run `docs:search { harness: 'engineering' }` for that corpus's full hybrid ranking. Absent when your surface matched something topical, on the engineering surface itself, for non-superusers, or when the embedder was blocked/not-run (a broken embedder says nothing about which corpus holds the answer).",
    seeAlso: ['docs:outline (browse the full section tree when the term is unknown)', 'docs:get (read a matched page)'],
  },
  capability: 'docs:read',
  requirePrincipal: false,
  // EI-20224875931864258: docs search spends most of its handler in filesystem and
  // semantic-ranking work, while its PG leg uses the admin pool lazily. Holding the
  // ambient workspace transaction across that work pins org-app pool slots and lets a
  // search burst starve unrelated workspace calls at the 45s acquisition deadline.
  skipWorkspaceTx: true,
  agentRoles: [...SU_ROLES, 'papercup-deep'],
  modality: ['text'],
  rolesQuota: {
    worker: { perChunk: 8 },
    operator: { perRun: 20 },
  },
  args: argsSchema,
  result: z
    .object({
      hits: z.unknown().optional(),
      hitCount: z.unknown().optional(),
      surface: z.unknown().optional(),
      legs: z.unknown().optional(),
      applied: z.unknown().optional(),
      scopeNote: z.unknown().optional(),
      crossSurface: z.unknown().optional(),
      embedCoverage: z.unknown().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const ctxAny = ctx as {
      harnessSlug?: string;
      isSuperuser?: boolean;
      signal?: AbortSignal;
      metadata?: (d: Record<string, unknown>) => void;
      progress?: (pct: number, msg: string) => void;
    };
    // EI-18894866320087268: 'engineering' is a distinct sentinel from 'all'/'*' that a
    // workspace-scoped session CAN use (see isEngineeringDocsSentinel's doc comment) —
    // handled before resolveHarnessScope so it never falls into the "concrete harness
    // slug" branch (which would otherwise 404 looking up a harness literally named
    // "engineering"). Resolves to the exact same scope as harness:'all'.
    const scope: HarnessScope = isEngineeringDocsSentinel(args.harness)
      ? { kind: 'all' }
      : resolveHarnessScope(args.harness, ctxAny);
    if (scope.kind === 'none') {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: 'harness_required', detail: HARNESS_REQUIRED_DETAIL }),
          },
        ],
        isError: true,
      };
    }
    const effectiveSlug = scope.kind === 'all' ? '*' : scope.slug;
    const resolved = await resolveAdapter(effectiveSlug, { isSuperuser: ctxAny.isSuperuser });
    if (resolved.error) {
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ error: resolved.error.code, slug: resolved.error.slug }) },
        ],
        isError: true,
      };
    }
    const limit = args.limit;
    const sourceKey = resolved.adapter.name;

    // P-016: docs:search runs on `@papercusp/search`'s `runHybridSearch`
    // instead of hand-rolling RRF over two legs it ran itself. What changes,
    // beyond deleting the duplicate fusion: the search now inherits the P-017
    // similarity FLOOR (the vector leg used to hand fusion its k nearest rows
    // whether or not any was a match) and reports P-020 `legs` — so a
    // lexical-only result caused by a dead embedder is legible as degraded
    // rather than looking like a healthy search that found less.
    //
    // ⚠ Unlike every other registered source, the lexical leg here is NOT SQL:
    // it wraps `searchDocs(adapter, …)` over a filesystem adapter and ignores
    // the `sql` handle the engine passes. That is deliberate and supported —
    // `SearchSource` requires a ranked list, not a query.
    //
    // The floor needs NO new calibration on this corpus: `EMBEDDING_FLOOR_GEMMA`
    // was measured ON doc_sections (in-domain top-1 min .5536 vs off-domain max
    // .5224 — see search/prose-min-score.ts). This is the corpus it was
    // calibrated against, not a corpus inheriting a threshold measured
    // somewhere else. (The value itself is deliberately not restated here — it
    // has moved once already, and a second copy of a constant is a drift site.)

    // searchDocs's own ctx.metadata call reports non_searchable_excluded
    // (not part of its return value) — capture it via a local sink instead of
    // forwarding ctxAny.metadata directly, so it can be merged into ONE final
    // metadata() call below that reflects the POST-fusion counts rather than
    // the over-fetched intermediate ones.
    let innerMeta: Record<string, unknown> = {};
    // The lexical leg's own envelope (query/tokenCount/hitCount), captured for
    // the payload. Undefined only if the leg FAILED — the engine catches a
    // source throw and degrades, so that now yields a semantic-only result
    // with `legs.lexical` carrying the failure, where it used to throw.
    let lexicalResponse: DocsSearchResult | undefined;
    // Both legs feed this: the engine's `SearchHit` is domain-free and carries
    // no url/title/description/anchor, so the rows are captured on the way
    // through and re-joined after fusion (no second read).
    const hydration = new Map<string, { hit: SearchHit; anchor?: string }>();

    const semanticOn = args.semantic ?? !process.env.VITEST;
    // Bound both sides of the semantic leg: resolver acquisition can wait on a
    // cold local sidecar/model, while a resolved embedder can still hang on a
    // warm ONNX/OpenAI query under load. Keep the query budget aligned with the
    // interactive acquisition default used by the embedder cascade.
    const embedTimeoutMs = semanticOn ? interactiveEmbedAcquireBudgetMs() : undefined;
    // `embedder: null` is reserved for "no semantic leg was ever wanted" —
    // the ONE case the engine's `not-run` correctly describes. When the leg IS
    // wanted, resolveDocsEmbedder returns a REJECTING embedder on every
    // degraded path, so a dead embedder reports `blocked` (D-023).
    const { embedder, embeddingMode } = semanticOn
      ? await resolveDocsEmbedder()
      : { embedder: null, embeddingMode: null };

    const source: SearchSource = {
      name: sourceKey,
      async lexical({ limit: candidateLimit }): Promise<Listing> {
        const response = await searchDocs(
          resolved.adapter,
          { ...args, limit: Math.max(candidateLimit, MIN_CANDIDATES) },
          {
            ...(ctxAny.signal && { signal: ctxAny.signal }),
            ...(ctxAny.progress && { progress: ctxAny.progress }),
            metadata: (d) => {
              innerMeta = d;
            },
          },
        );
        lexicalResponse = response;
        return response.hits.map((h) => {
          // The lexical row is authoritative for the display fields (it has
          // the real keyword excerpt + description); a page also found
          // semantically only gains an anchor.
          const prior = hydration.get(h.slug);
          hydration.set(h.slug, { hit: h, ...(prior?.anchor ? { anchor: prior.anchor } : {}) });
          return {
            key: h.slug,
            score: h.score,
            row: {
              source: sourceKey,
              source_id: h.slug,
              excerpt: h.excerpt,
              highlight: h.title,
              score: h.score,
              rankers: ['lexical'],
            },
          };
        });
      },
      // No resolved embedding space ⇒ no `embedding` method, so the engine
      // never issues a vector query it has no space for. The rejecting
      // embedder above is what still makes that state report as `blocked`:
      // the engine sets it when the query embed throws, before any source's
      // embedding method would have been consulted.
      ...(embeddingMode
        ? {
            embedding: docSectionsRanker(sourceKey, embeddingMode, (h: DocSemanticHit) => {
              const prior = hydration.get(h.slug);
              hydration.set(h.slug, {
                hit: prior?.hit ?? { slug: h.slug, url: h.url, title: h.title, score: 0, excerpt: h.excerpt },
                anchor: h.anchor,
              });
            }),
          }
        : {}),
    };

    const { results, legs, applied } = await runHybridSearch([source], {
      caller: 'docs:search',
      sql: lazyOrgSql,
      query: args.query,
      // The docs source resolves its own corpus from the adapter; neither of
      // the engine's scoping keys applies to a filesystem surface.
      workspaceId: '',
      scopeFilter: null,
      limit,
      mode: 'hybrid',
      embedder,
      ...(embedTimeoutMs !== undefined ? { embedTimeoutMs } : {}),
      // OPTED OUT because this source cannot honor the cascade's stage 2, not
      // because widening is unwanted. `lexicalWithCascade` re-queries the same
      // source with `lexicalMode: 'coverage-graded'` whenever stage 1
      // under-fills, and APPENDS only rows stage 1 did not return. That is a
      // real win for a source that implements the mode — the PG-backed
      // `agent-tools/search/sources.ts` branches on it — but this source's
      // `lexical()` above destructures ONLY `limit`, and `searchDocs` (the
      // docs-engine) has no `lexicalMode` concept at all. So stage 2 would
      // re-issue a request byte-identical to stage 1: same adapter, same args,
      // same `Math.max(candidateLimit, MIN_CANDIDATES)`. Every row it returned
      // would already be in the `seen` set, so `stage2Added` is 0 BY
      // CONSTRUCTION — a doubled filesystem search on every under-filled
      // docs:search, for provably zero rows.
      //
      // Regression, not a latent quirk: the leg rename bm25 -> lexical
      // (f9ed5eb4f3) correctly reconnected this source to the engine's lexical
      // leg and thereby opted it into a cascade written for hosts that
      // implement the mode. `handlers.test.ts`'s
      // `expect(searchDocs).toHaveBeenCalledTimes(1)` is what caught it.
      //
      // ⚠ DELETE THIS LINE if `lexical()` ever honors `lexicalMode` (thread it
      // into searchDocs and give the engine a genuinely different stage-2
      // query) — at that point the opt-out is the thing costing recall.
      lexicalCascade: false,
      ...(ctxAny.signal ? { signal: ctxAny.signal } : {}),
    });

    let semanticHitCount = 0;
    const fusedHits: Array<SearchHit & { semantic?: true; similarity?: number; anchor?: string }> = results.map((r) => {
      const entry = hydration.get(r.source_id);
      const base: SearchHit = entry?.hit ?? {
        slug: r.source_id,
        url: `/docs/${r.source_id}`,
        title: r.source_id,
        score: r.score,
        excerpt: r.excerpt,
      };
      const raw = r.rankerScores?.embeddings;
      const similarity = raw === undefined ? undefined : Math.round(raw * 1000) / 1000;
      // Only mark semantic:true (the "this wasn't a lexical match" signal
      // downstream callers key on) when the page has NO lexical hit of its
      // own — a page found by both legs keeps its real lexical excerpt and
      // just also carries the similarity that helped rank it.
      if (isVectorOnly(r)) {
        semanticHitCount += 1;
        return { ...base, semantic: true as const, similarity, ...(entry?.anchor ? { anchor: entry.anchor } : {}) };
      }
      return similarity !== undefined ? { ...base, similarity } : base;
    });
    const finalHits = rankRetirementAuthorityHits(args.query, fusedHits);

    // P-004 (knowledge-at-symptom-time-2026-08-09): ADVISING a retry is not the same as RUNNING one.
    // EI-18804433041289369 added the `scopeNote` below, and it was still not enough — measured
    // 2026-08-09, an su searching this surface for an agent-insights page got 37 confident, entirely
    // irrelevant hits, read the note as boilerplate, and re-derived from scratch a diagnosis that was
    // sitting in `agent-insights/inference-gateway-three-rate-signals-not-one` the whole time. The
    // response already CONTAINED the evidence that it had failed: `legs.semantic.status === 'ran'`
    // with `candidates: 0`, i.e. not one section in this corpus cleared the similarity floor, so the
    // ranking degraded to pure lexical noise. When a search knows it found nothing topical, it should
    // look where the answer actually lives rather than hand the caller a footnote.
    //
    // Deliberately narrow, because a broad version would double every docs:search:
    //   - `status === 'ran'` (NOT 'blocked'/'not-run') — a dead embedder degrades EVERY query the same
    //     way, and probing a second corpus with the same broken leg buys nothing. Only a leg that ran
    //     and genuinely matched nothing is evidence about the CORPUS rather than about the embedder.
    //   - superuser only — `resolveAdapter` gates the engineering surface to papercusp-su (D-005/P-016);
    //     probing it for a non-SU caller would leak a corpus they cannot otherwise reach.
    //   - retirement/currentness queries are the one explicit exception: they resolve the canonical
    //     authority by its exact slug, because a historical plan can be a strong semantic match and
    //     still be the wrong answer. Exact-slug lookup makes authority independent of lexical density.
    //   - otherwise LEXICAL-only and small — the point is to name the right corpus, not to rank it perfectly. A
    //     hybrid probe would need a second embed round-trip on a path taken precisely when the embedder
    //     just told us it had nothing to say. A lexical hit on the RIGHT corpus beats a hybrid hit on
    //     the wrong one; the caller gets the exact `harness:'engineering'` call for the full ranking.
    //   - fail-soft — any probe failure leaves the response byte-identical to before this change.
    const legsAny = legs as { semantic?: { status?: string; candidates?: number } } | undefined;
    const retirementAuthorityQuery = isRetirementAuthorityQuery(args.query);
    const historicalPrimaryHits = finalHits.some((hit) => hit.historical);
    let crossSurface: Record<string, unknown> | undefined;
    let authorityLookupAttempted = false;
    if (
      shouldProbeSiblingSurface({
        surface: resolved.surface,
        isSuperuser: Boolean(ctxAny.isSuperuser),
        semanticLeg: legsAny?.semantic,
        query: args.query,
        hasHistoricalHits: historicalPrimaryHits,
      })
    ) {
      try {
        authorityLookupAttempted = retirementAuthorityQuery;
        const probe = await searchDocs(
          engineeringAdapter,
          retirementAuthorityQuery
            ? { query: RETIREMENT_AUTHORITY_SLUG, limit: 1 }
            : { ...args, limit: Math.min(limit, CROSS_SURFACE_PROBE_LIMIT) },
          { ...(ctxAny.signal && { signal: ctxAny.signal }) },
        );
        if (probe.hits.length > 0) {
          const rankedProbeHits = rankRetirementAuthorityHits(args.query, probe.hits);
          crossSurface = {
            surface: 'engineering',
            mode: retirementAuthorityQuery ? 'authority-lookup' : 'lexical-only',
            why: retirementAuthorityQuery
              ? historicalPrimaryHits
                ? `This retirement/currentness query returned historical plan material on '${resolved.surface}', so the canonical current authority was resolved by exact slug from the 'engineering' surface.`
                : `Retirement/currentness questions resolve the canonical current authority by exact slug from the 'engineering' surface rather than treating lexical or semantic density as authority.`
              : `The semantic leg RAN against '${resolved.surface}' and matched nothing above the similarity floor, so the hits above are lexical-only and may be off-topic. These are keyword hits from the 'engineering' surface (agent-insights/ + the Papercusp framework reference), which this surface does not contain.`,
            rerunFor:
              "docs:search { harness: 'engineering', query: <same query> } — for the full hybrid ranking of this corpus.",
            hits: rankedProbeHits.map((h) => ({
              slug: h.slug,
              url: h.url,
              title: h.title,
              score: h.score,
              excerpt: h.excerpt,
              ...(h.trust ? { trust: h.trust } : {}),
              ...(h.historical ? { historical: true } : {}),
              ...(h.authority ? { authority: h.authority } : {}),
              ...(h.authority ? { surface: 'engineering' as const } : {}),
            })),
          };
        }
      } catch {
        /* fail-soft: a failed probe must never degrade the primary result */
      }
    }

    // EI-18804433041289369: `surface` alone is easy to skim past — a caller who names their OWN
    // harness (the natural, seemingly-correct thing to pass) gets a scoped project-docs/harness-docs
    // corpus that does NOT include agent-insights/ or the framework reference, and a plausible-looking
    // ranked result (even a NON-empty one — the reported incident had 37 hits, just from the wrong
    // corpus) reads as "no such page exists" rather than "wrong corpus". Say so explicitly on every
    // non-engineering-surface response, so a weak/absent-feeling result is legible as SCOPE, not absence.
    const scopeNote =
      resolved.surface === 'engineering'
        ? undefined
        : crossSurface
          ? retirementAuthorityQuery
            ? `This '${resolved.surface}' surface (${resolved.adapter.name}) does NOT include agent-insights/ or the Papercusp framework reference. This retirement/currentness query was routed to the canonical engineering authority — see \`currentAuthority\` and \`crossSurface\`; historical plan hits are labelled \`historical\`.`
            : `This '${resolved.surface}' surface (${resolved.adapter.name}) does NOT include agent-insights/ or the Papercusp framework reference. The semantic leg matched NOTHING here, so that retry was run FOR you — see \`crossSurface\` for keyword hits from the 'engineering' surface. Do not read the hits above as "no such page exists".`
          : `This '${resolved.surface}' surface (${resolved.adapter.name}) does NOT include agent-insights/ or the Papercusp framework reference — those live on the separate 'engineering' surface. A weak or zero-looking result here does not mean no such page exists; retry with harness:'engineering' before concluding that (harness:'all' reaches the same corpus but is REJECTED with harness_forbidden on a workspace-scoped session — EI-18894866320087268).`;

    let authorityHit = retirementAuthorityQuery
      ? ((crossSurface?.hits as CurrentnessSearchHit[] | undefined)?.find(
          (hit) => hit.slug === RETIREMENT_AUTHORITY_SLUG,
        ) ?? finalHits.find((hit) => hit.slug === RETIREMENT_AUTHORITY_SLUG))
      : undefined;
    // An engineering-surface primary search can still truncate the canonical page before the final
    // cut. Resolve the exact slug once in that case too; ordinary queries never pay this second read.
    if (retirementAuthorityQuery && !authorityHit && !authorityLookupAttempted) {
      try {
        authorityLookupAttempted = true;
        const exact = await searchDocs(
          engineeringAdapter,
          { query: RETIREMENT_AUTHORITY_SLUG, limit: 1 },
          { ...(ctxAny.signal && { signal: ctxAny.signal }) },
        );
        authorityHit = rankRetirementAuthorityHits(args.query, exact.hits).find(
          (hit) => hit.slug === RETIREMENT_AUTHORITY_SLUG,
        );
      } catch {
        /* fail-soft: the primary ranked result remains valid even if authority lookup is unavailable */
      }
    }
    const surfacedAuthority = authorityHit
      ? { ...authorityHit, authority: 'current' as const, surface: 'engineering' as const }
      : undefined;
    // P-009 / D-022: the wearer's identity-installed pack docs, read ONLY through its applied
    // doc keys (a non-wearer holds none and gets the unchanged result). They are the procedure
    // the caller's own identity pinned, so they rank ahead of the general corpus.
    const packageDocHits = await wearerPackageDocHits(ctx, args.query, limit);
    const reportedHits = surfacedAuthority
      ? [surfacedAuthority, ...packageDocHits, ...finalHits.filter((hit) => hit.slug !== surfacedAuthority.slug)].slice(0, limit)
      : packageDocHits.length > 0 ? [...packageDocHits, ...finalHits].slice(0, limit) : finalHits;
    const reportedSemanticHitCount = reportedHits.filter((hit) => 'semantic' in hit && hit.semantic === true).length;
    // EI-20031763618968912: `legs` answers "was this really a hybrid search"; it does NOT
    // answer "was the corpus underneath it complete". Those are different failures — a
    // dead embedder vs. a semantic leg that ran perfectly over a partially-embedded
    // corpus — and only the first was reported here. doc_sections is filled by a sync
    // sweep that inserts with `embedding NULL` plus a separate backfill, so the second is
    // real. Reuses the WI-9393 / D-018 coverage gate rather than measuring anything here;
    // stays absent on the healthy path and whenever the semantic leg did not run (see
    // semantic-coverage.ts for both suppression rules). Fail-soft: a null assessment
    // simply says nothing.
    const embedCoverage = docsCoverageNote(await assessDocsCoverage(), legsAny?.semantic);
    const payload: Record<string, unknown> = {
      ...(lexicalResponse ?? { query: args.query, tokenCount: 0, hitCount: 0 }),
      ...(surfacedAuthority ? { currentAuthority: surfacedAuthority } : {}),
      hits: reportedHits,
      hitCount: lexicalResponse?.hitCount ?? 0,
      surface: resolved.surface,
      ...(scope.kind === 'harness' ? { harness_slug: scope.slug } : {}),
      ...(reportedSemanticHitCount > 0 ? { semanticHitCount: reportedSemanticHitCount } : {}),
      ...(packageDocHits.length > 0 ? { packageDocHitCount: packageDocHits.length } : {}),
      // P-020 / EI-19478862482607876: inheriting the engine's leg report and
      // then DISCARDING it is half the migration. `legs.degraded` +
      // `legs.warning` are the ready-made verdict for "was this really a
      // hybrid search"; `applied` says which floors actually ran. Without
      // them a lexical-only result caused by a dead embedder is
      // indistinguishable from a healthy search that found less.
      legs,
      applied,
      ...(embedCoverage ? { embedCoverage } : {}),
      ...(crossSurface ? { crossSurface } : {}),
      ...(scopeNote ? { scopeNote } : {}),
    };
    ctxAny.metadata?.({
      ...innerMeta,
      surface: resolved.surface,
      ...(scope.kind === 'harness' ? { harness_slug: scope.slug } : {}),
      returned: reportedHits.length - reportedSemanticHitCount,
      ...(packageDocHits.length > 0 ? { packageDocHitCount: packageDocHits.length } : {}),
      ...(reportedSemanticHitCount > 0 ? { semanticHitCount: reportedSemanticHitCount } : {}),
      ...(legs.degraded ? { legsDegraded: true, legsWarning: legs.warning } : {}),
      // P-004: measurable adoption — how often the probe fires, and whether it found anything.
      ...(crossSurface
        ? { crossSurfaceProbed: 'engineering', crossSurfaceHits: (crossSurface.hits as unknown[]).length }
        : {}),
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
  },
});
