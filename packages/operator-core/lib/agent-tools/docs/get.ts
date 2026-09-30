/**
 * docs:get — context-aware doc page fetch.
 *
 * Same routing as docs:outline: harness-context callers get their
 * harness's docs; everyone else gets Papercusp engineering reference.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { genericFsAdapter, getDocs, harnessFsAdapter, withPreamble, type DocSource } from '@papercusp/docs-engine';
import { loadHarnessRegistry, resolveHarnessContentPath } from '../../harness-registry';
import { resolveDocsRoot } from '../../endpoint-route/routes/harness/project-docs';
import { engineeringAdapter as engineeringBase, engineeringAdapterForSlugs } from './_engineering-adapter';
import {
  HARNESS_REQUIRED_DETAIL,
  isEngineeringDocsSentinel,
  resolveHarnessScope,
  type HarnessScope,
} from '../_harness-scope';
import { coerceDocsGetSlugs, normalizeDocsGetRef, normalizeEngineeringDocsGetRef } from './get-coerce';

/**
 * Prefix every rendered body with the agent-readable `# title` + `URL:` header.
 *
 * The spread is load-bearing: it carries `getSource` through untouched, so a
 * `source: true` read gets the canonical bytes WITHOUT this header (the header is
 * a read-surface annotation — writing it back injects it into the document). If a
 * future refactor drops it, `getDocs` answers `source_unavailable`, which is a
 * visible refusal rather than a silently preamble-prefixed "source".
 */
function wrapWithPreamble(base: DocSource): DocSource {
  return {
    ...base,
    async getContent(page) {
      const body = await base.getContent(page);
      return withPreamble(body, {
        title: page.title,
        url: page.url,
        ...(page.description ? { description: page.description } : {}),
      });
    },
  };
}

export async function resolveAdapter(
  harnessSlug: string | undefined,
  opts: { isSuperuser?: boolean; slugs?: readonly string[] } = {},
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
        adapter: wrapWithPreamble(genericFsAdapter(projectDocsRoot, { name: 'project' })),
        surface: 'project',
      };
    }
    // D-005 / P-016: engineering branch is for papercusp-su (SU/engineer) only.
    if (opts.isSuperuser) {
      const adapter = opts.slugs?.length
        ? engineeringAdapterForSlugs(opts.slugs.map(normalizeEngineeringDocsGetRef))
        : engineeringBase;
      return { adapter: wrapWithPreamble(adapter), surface: 'engineering' };
    }
    return {
      adapter: wrapWithPreamble(engineeringBase),
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
      adapter: wrapWithPreamble(engineeringBase),
      surface: 'engineering',
      error: { code: 'harness_not_registered', slug: harnessSlug },
    };
  }
  const projectRoot = resolveHarnessContentPath(reg, harnessSlug) ?? project.path;
  return {
    adapter: wrapWithPreamble(
      harnessFsAdapter(projectRoot, {
        name: `harness:${harnessSlug}`,
        // Keep the read adapter aligned with docs:author and the project-docs
        // route: a harness may declare its canonical docs corpus outside the
        // legacy <repo>/docs directory. State files still resolve from the
        // project root inside harnessFsAdapter.
        docsRoot: await resolveDocsRoot(projectRoot),
      }),
    ),
    surface: 'harness',
  };
}

const argsSchema = z.preprocess(
  // WI-1985: be liberal — salvage a singular `slug` / string `slugs` into the
  // array the schema wants (35% of calls 400ed on "slugs: expected array,
  // received undefined"). Identity on a well-formed array, so the published
  // tools/list schema (z.toJSONSchema of the OUTPUT object) is unchanged.
  coerceDocsGetSlugs,
  z
    .object({
      slugs: z
        .array(z.string().min(1))
        .min(1)
        .max(10)
        .describe('1–10 slugs from docs:outline.pages[].slug (e.g. ["endpoint-system/overview"]).'),
      heading: z
        .string()
        .optional()
        .describe(
          'Heading anchor id or visible heading text (from docs:outline.pages[].headings[].id/text). Only honored when slugs.length === 1.',
        ),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          'Resume a clipped read here. A page over the 50KB cap comes back TRUNCATED with found:true and a `nextOffset` — pass it back to read the next window, and repeat until no nextOffset is returned. Only honored when slugs.length === 1. Composes with `source`, which is what a docs:author overwrite body must be sourced from.',
        ),
      source: z
        .boolean()
        .optional()
        .describe(
          'Return the doc CANONICAL SOURCE — the exact bytes an author edits: frontmatter included, MDX unrendered, no `# title` / `URL:` preamble. The ONLY read that survives a round trip back through docs:author { overwrite:true }. The default read is a lossy projection: it strips frontmatter, prepends a header, and rewrites every JSX component (a self-closing one is dropped entirely) — 163 of 956 papercusp docs carry one. Composes with `offset`/`nextOffset`, so page a large doc to its end before rewriting it. Refused with `heading` (a slice is not the document), and refused as `source_unavailable` when the docs source has no canonical text — never quietly downgraded to the rendered body.',
        ),
      harness: z
        .string()
        .optional()
        .describe(
          "Harness slug whose docs to read. Pass 'all' for Papercusp's own framework docs / your project docs (operator scope) — " +
            "but only on an UNSCOPED (--all-workspaces) session; a workspace-scoped su session gets harness_forbidden for 'all'/'*'. " +
            "To reach the SAME framework/agent-insights corpus from a workspace-scoped session, pass 'engineering' instead — a " +
            'distinct literal the workspace clamp does not intercept (EI-18894866320087268). Omit only when the session is ' +
            "already scoped to a harness — otherwise you'll get harness_required.",
        ),
    })
    .refine((v) => !v.heading || v.slugs.length === 1, {
      message: 'heading is only valid when slugs has exactly one entry',
      path: ['heading'],
    })
    // Refuse rather than silently ignore: an offset that quietly does nothing
    // returns window 1 again, which reads as "the document ends here".
    .refine((v) => !v.offset || v.slugs.length === 1, {
      message: 'offset addresses ONE document — it is only valid when slugs has exactly one entry',
      path: ['offset'],
    })
    // A section slice IS NOT THE DOCUMENT. Serving one under `source` would hand
    // back a partial body that reads as whole — the exact shape of the bug this
    // mode closes — so the combination is refused rather than silently narrowed.
    .refine((v) => !(v.source && v.heading), {
      message:
        'source and heading are mutually exclusive — a heading slice is not the document. Drop `heading` to read the whole source, or drop `source` to read that section rendered.',
      path: ['source'],
    }),
);

export default defineTool({
  name: 'docs:get',
  description:
    "Fetch documentation pages by slug — your harness's docs (in a harness), your project's docs (PAPERCUSP_PROJECT_DOCS_ROOT env var), or the Papercusp framework reference (papercusp-su callers only). Batch up to 10; pass a heading anchor id or visible heading text (single-slug only) for a section slice. Per-slug error envelope.",
  guidance: {
    when:
      'You have slugs from docs:outline and need page contents. Use `heading` with either headings[].id or headings[].text (single-slug) when only one section of a long page is relevant.',
    notWhen:
      "You do not yet know the slug — call docs:outline first. To fetch another harness's docs from outside, use cross_harness:docs_get.",
    chaining:
      "docs:outline → docs:get { slugs } (batch up to 10) → optionally re-fetch with { slugs: [picked], heading } for surgical reads. ABOUT TO REWRITE the page? Read it with { source: true } instead — the default body is a rendered, preamble-prefixed projection, so writing it back through docs:author flattens JSX/imports and injects the header; page to the end with `offset`/`nextOffset` first. A result carrying `trust` (OKF v0.2) reports the page's reliability: `stale:true` means it is past its author-set stale_after and (on a rendered read only) its content is prefixed with a ⚠ STALE banner — re-check those claims against the code before acting on them. No `trust` field = unverified and not stale, which is nearly every doc today.",
    seeAlso: [
      'docs:outline (find slugs to read)',
      'docs:search (locate the right page by term first)',
      'docs:author { overwrite:true } (rewrite a doc — source its body from { source:true }, never from a default read)',
    ],
  },
  capability: 'docs:read',
  requirePrincipal: false,
  // EI-20248604619263256: docs:get spends its handler in registry/filesystem reads
  // and never consumes ctx.tx. Holding the ambient workspace transaction while
  // loadHarnessRegistry waits on the org-app pool lets saturated callers queue for
  // the same pool slot they are needlessly retaining. Match docs:search and release
  // that slot before the handler starts its own lazy reads.
  skipWorkspaceTx: true,
  agentRoles: [...SU_ROLES, 'papercup-deep', 'release-fixer'],
  modality: ['text'],
  rolesQuota: {
    worker: { perChunk: 10 },
    operator: { perRun: 15 },
  },
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as {
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
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: 'harness_required', detail: HARNESS_REQUIRED_DETAIL }),
          },
        ],
        isError: true,
      };
    }
    // Keep routing-only fields out of the source-agnostic engine call, and make
    // the direct handler boundary as strict as the zod-preprocessed dispatch
    // path. Tests and internal callers invoke handlers directly as well.
    const inputSlugs = args.slugs.map(normalizeDocsGetRef);
    const effectiveSlug = scope.kind === 'all' ? '*' : scope.slug;
    const resolved = await resolveAdapter(effectiveSlug, {
      isSuperuser: ctxAny.isSuperuser,
      slugs: inputSlugs,
    });
    if (resolved.error) {
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ error: resolved.error.code, slug: resolved.error.slug }) },
        ],
        isError: true,
      };
    }
    ctxAny.metadata?.({ surface: resolved.surface, ...(scope.kind === 'harness' ? { harness_slug: scope.slug } : {}) });

    const getArgs = {
      slugs: resolved.surface === 'engineering' ? inputSlugs.map(normalizeEngineeringDocsGetRef) : inputSlugs,
      ...(args.heading ? { heading: args.heading } : {}),
      ...(args.offset ? { offset: args.offset } : {}),
      ...(args.source ? { source: true as const } : {}),
    };

    const response = await getDocs(resolved.adapter, getArgs, {
      ...(ctxAny.signal && { signal: ctxAny.signal }),
      ...(ctxAny.metadata && { metadata: ctxAny.metadata }),
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ...response, surface: resolved.surface }) }] };
  },
});
