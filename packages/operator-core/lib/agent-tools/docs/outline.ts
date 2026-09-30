/**
 * docs:outline — context-aware doc outline.
 *
 * Resolves the source by caller context:
 *   - ctx.harnessSlug set → that harness's docs (the harnessFsAdapter)
 *   - otherwise          → Papercusp engineering reference
 *                          (starlightContentAdapter against operator-docs/src/content/docs)
 *
 * Same tool, same shape — the agent doesn't need to learn two surfaces.
 * Workers/scopers in a harness get their harness's docs; SU and
 * operator/oracle/documenter agents working on Papercusp itself get
 * the framework engineering reference. Cross-harness lookups (an
 * engineer wanting harness X's docs from outside) use
 * cross_harness:docs_outline.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import {
  buildOutline,
  genericFsAdapter,
  harnessFsAdapter,
  RunCache,
  type DocSource,
  type OutlinePayload,
} from '@papercusp/docs-engine';
import { loadHarnessRegistry, resolveHarnessContentPath } from '../../harness-registry';
import { engineeringAdapter, getEngineeringAdapterRevision } from './_engineering-adapter';
import { HARNESS_REQUIRED_DETAIL, isEngineeringDocsSentinel, resolveHarnessScope, type HarnessScope } from '../_harness-scope';

const cache = new RunCache<OutlinePayload>();

/**
 * EI-400: the Papercusp engineering/project doc corpus (harness:'all') is
 * 700+ pages — a full outline (every page's headings) serializes to
 * ~800KB+, which always blew the MCP per-result budget and got silently
 * spilled to a scratch file every single call (never a usable outline). A
 * per-harness corpus is small enough that the full shape stays useful, so
 * only these two "whole corpus" surfaces get the brief-by-default +
 * section-drill-down treatment; `surface: 'harness'` is untouched.
 */
const BRIEF_BY_DEFAULT_SURFACES = new Set(['engineering', 'project']);

const DEFAULT_SECTION_PAGE_LIMIT = 200;
const MAX_SECTION_PAGE_LIMIT = 500;

/** Compact per-section view for the default (no `section` arg) listing on a
 *  brief-by-default surface — titles/counts only, no per-page headings. */
function summarizeSections(payload: OutlinePayload) {
  return payload.sections.map((s) => ({
    slug: s.slug,
    title: s.title,
    ...(s.description ? { description: s.description } : {}),
    pageCount: s.pages.length,
  }));
}

/**
 * Shape the response body for one docs:outline call given the full (cached
 * or freshly built) payload and the caller's `section`/`offset`/`limit`
 * args. Pure function of (payload, args, surface) so it's unit-testable
 * without touching the engine or the fs adapters.
 */
export function shapeOutlineResponse(
  payload: OutlinePayload,
  args: { section?: string; offset?: number; limit?: number },
  surface: 'harness' | 'engineering' | 'project',
): Record<string, unknown> {
  const base = {
    generatedAt: payload.generatedAt,
    sectionCount: payload.sectionCount,
    pageCount: payload.pageCount,
  };

  if (args.section) {
    const wanted = args.section.trim().toLowerCase();
    const match = payload.sections.find((s) => s.slug.toLowerCase() === wanted);
    if (!match) {
      return {
        ...base,
        error: 'section_not_found',
        section: args.section,
        availableSections: payload.sections.map((s) => s.slug),
      };
    }
    const offset = Math.max(0, args.offset ?? 0);
    const limit = Math.min(Math.max(1, args.limit ?? DEFAULT_SECTION_PAGE_LIMIT), MAX_SECTION_PAGE_LIMIT);
    const pagesTotal = match.pages.length;
    const pagesSlice = match.pages.slice(offset, offset + limit);
    return {
      ...base,
      section: {
        slug: match.slug,
        title: match.title,
        ...(match.description ? { description: match.description } : {}),
        pages: pagesSlice,
        pagesTotal,
        pagesOffset: offset,
        pagesReturned: pagesSlice.length,
        ...(offset + pagesSlice.length < pagesTotal ? { nextOffset: offset + pagesSlice.length } : {}),
      },
    };
  }

  if (BRIEF_BY_DEFAULT_SURFACES.has(surface)) {
    return {
      ...base,
      sections: summarizeSections(payload),
      brief: true,
      hint:
        "Per-page outline omitted — this corpus is too large for one result. " +
        "Pass { section: '<slug>' } (from the `sections` list above) to drill into " +
        'one section with its full page list + headings (paginate large sections with `offset`/`limit`).',
    };
  }

  return { ...payload };
}

export async function resolveAdapter(
  harnessSlug: string | undefined,
  opts: { isSuperuser?: boolean } = {},
): Promise<{
  adapter: DocSource;
  scope: string;
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
        scope: '_project',
        surface: 'project',
      };
    }
    // D-005 / P-016: engineering branch is for papercusp-su (SU/engineer) only.
    if (opts.isSuperuser) {
      return { adapter: engineeringAdapter, scope: '_engineering', surface: 'engineering' };
    }
    // Non-SU caller with no project docs — don't leak Papercusp's docs.
    return {
      adapter: engineeringAdapter, // placeholder; handler bails on `error`
      scope: '_none',
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
      scope: '_engineering',
      surface: 'engineering',
      error: { code: 'harness_not_registered', slug: harnessSlug },
    };
  }
  return {
    adapter: harnessFsAdapter(resolveHarnessContentPath(reg, harnessSlug) ?? project.path, {
      name: `harness:${harnessSlug}`,
    }),
    scope: harnessSlug,
    surface: 'harness',
  };
}

export default defineTool({
  name: 'docs:outline',
  description:
    'Return the documentation table-of-contents for your context — your harness\'s docs (in a harness), your project\'s docs (PAPERCUSP_PROJECT_DOCS_ROOT env var), or the Papercusp framework engineering reference (papercusp-su callers only). Cached per run. Call this FIRST when you need design context; drill in via docs:get. The Papercusp engineering/project corpus (harness:\'all\') is large: without `section` you get a compact section index (slug/title/pageCount), not full pages+headings — pass `section` to drill into one section\'s full outline.',
  guidance: {
    when: 'You need design context, architectural rationale, or "how does X work" answers and have not yet called docs:outline this run.',
    notWhen:
      'You already called docs:outline this run — cached. For prose recall (chats, escalations, brainstorms) use search:fulltext. To explore another harness from outside, use cross_harness:docs_outline.',
    chaining:
      "docs:outline → (harness:'all'/'engineering' only) docs:outline { harness:'all', section } to drill into one section → docs:get { slugs: [...] }. Use { slug, heading } when only one section of a long page is relevant. A workspace-scoped session gets harness_forbidden for 'all' — pass 'engineering' instead (same corpus, EI-18894866320087268).",
    seeAlso: [
      'docs:search (find a page by specific term instead of browsing the tree)',
      'docs:get (read the slugs the outline lists)',
    ],
  },
  capability: 'docs:read',
  requirePrincipal: false,
  // The release-fixer follows the shared docs-first guidance before inspecting
  // a gate failure; keep its direct role-scoped surface paired with docs:read.
  agentRoles: [...SU_ROLES, 'release-fixer'],
  modality: ['text'],
  args: z.object({
    harness: z
      .string()
      .optional()
      .describe(
        "Harness slug whose docs outline to return. Pass 'all' for Papercusp's own framework docs / your project docs (operator scope) — " +
          "but only on an UNSCOPED (--all-workspaces) session; a workspace-scoped su session gets harness_forbidden for 'all'/'*'. " +
          "To reach the SAME framework/agent-insights corpus from a workspace-scoped session, pass 'engineering' instead — a distinct " +
          "literal the workspace clamp does not intercept (EI-18894866320087268). Omit only when the session is already scoped to a " +
          "harness — otherwise you'll get harness_required.",
      ),
    section: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Top-level section slug to drill into (e.g. "agent-insights") — from the `sections[].slug` list a section-less call returns. ' +
          "Only meaningful on the large harness:'all' corpus (a per-harness outline is already returned whole); ignored-equivalent (whole-outline) elsewhere.",
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Page offset within the selected `section` (only used together with `section`). Default 0.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_SECTION_PAGE_LIMIT)
      .optional()
      .describe(
        `Max pages to return within the selected \`section\` (only used together with \`section\`). Default ${DEFAULT_SECTION_PAGE_LIMIT}, max ${MAX_SECTION_PAGE_LIMIT}.`,
      ),
  }),
  async handler(args, ctx) {
    const ctxAny = ctx as {
      runId?: string;
      spawnId?: string;
      harnessSlug?: string;
      isSuperuser?: boolean;
      signal?: AbortSignal;
      metadata?: (d: Record<string, unknown>) => void;
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
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'harness_required', detail: HARNESS_REQUIRED_DETAIL }) }],
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
    ctxAny.metadata?.({ surface: resolved.surface, ...(scope.kind === 'harness' ? { harness_slug: scope.slug } : {}) });

    // docs:author invalidates the shared engineering adapter after a canonical PG
    // write. Include its revision in this per-run cache key so an outline fetched
    // earlier in the same run cannot hide the newly authored page.
    const cacheScope =
      resolved.surface === 'engineering' ? `${resolved.scope}:${getEngineeringAdapterRevision()}` : resolved.scope;
    const hit = cache.get(ctxAny, cacheScope);
    if (hit) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ...shapeOutlineResponse(hit, args, resolved.surface),
              cached: true,
              surface: resolved.surface,
            }),
          },
        ],
      };
    }
    const payload = await buildOutline(resolved.adapter, {
      ...(ctxAny.runId !== undefined && { runId: ctxAny.runId }),
      ...(ctxAny.spawnId !== undefined && { spawnId: ctxAny.spawnId }),
      ...(ctxAny.signal && { signal: ctxAny.signal }),
      ...(ctxAny.metadata && { metadata: ctxAny.metadata }),
    });
    cache.set(ctxAny, payload, cacheScope);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ...shapeOutlineResponse(payload, args, resolved.surface),
            cached: false,
            surface: resolved.surface,
          }),
        },
      ],
    };
  },
});
