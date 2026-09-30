/**
 * cross_harness:plans_search — keyword search across any harness's plans.
 *
 * P-013 of per-harness-plans-and-docs-2026-05-23. Mirrors plans:search
 * but takes an explicit harnessSlug arg.
 *
 * Scoring + snippet logic mirrors plans:search inline. P-012 will
 * extract these to a shared helper when the 25 plans:* tools migrate
 * to per-harness opts.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { readAllPlans, resolveHarnessPlansDir } from '../plans/source';

const SCOPES = ['slug', 'title', 'now', 'items', 'decisions', 'prose'] as const;
type Scope = (typeof SCOPES)[number];

const argsSchema = z.object({
  harnessSlug: z.string().min(1).describe('Slug of the harness whose plans to search.'),
  workspaceId: z
    .string()
    .optional()
    .describe("Optional workspace id when the target harness lives in a workspace other than the caller's active one."),
  query: z.string().min(1).describe('Search query (case-insensitive, whitespace-tokenized).'),
  scope: z
    .array(z.enum(SCOPES as unknown as [Scope, ...Scope[]]))
    .optional()
    .describe('Scopes to search. Default: all.'),
  limit: z.number().int().min(1).max(50).optional().describe('Max results. Default 20.'),
  includeArchived: z.boolean().optional().describe('Search archived plans too. Default true.'),
  includeLegacy: z.boolean().optional().describe('Search legacy plans (prose only). Default true.'),
});

interface Hit {
  plan: string;
  score: number;
  matches: Array<{ scope: Scope; snippet: string }>;
}

function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9_-]+/g) ?? [];
}

function scoreScope(text: string, queryTokens: string[]): number {
  if (!text) return 0;
  const docTokens = tokenize(text);
  if (docTokens.length === 0) return 0;
  const tf = new Map<string, number>();
  for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  let hits = 0;
  for (const q of queryTokens) hits += tf.get(q) ?? 0;
  return hits;
}

/** Slug scope: SUBSTRING match (mirrors plans:search) — the tokenizer keeps
 *  hyphens, so a one-token slug query never token-equals a multi-segment slug,
 *  and the PG slug isn't in the scored content. Counts query tokens present. */
function scoreSlug(slug: string, queryTokens: string[]): number {
  if (!slug) return 0;
  const lower = slug.toLowerCase();
  let hits = 0;
  for (const q of queryTokens) {
    // Skip bare-numeric tokens (`2026`, `06`) — date stamps in slugs would flood
    // the results; a hyphenated date stays (one token). See plans:search.
    if (/^\d+$/.test(q)) continue;
    if (lower.includes(q)) hits += 1;
  }
  return hits;
}

function snippet(text: string, queryTokens: string[], maxLen = 160): string {
  if (!text) return '';
  const lower = text.toLowerCase();
  for (const q of queryTokens) {
    const idx = lower.indexOf(q);
    if (idx !== -1) {
      const start = Math.max(0, idx - 40);
      const end = Math.min(text.length, idx + q.length + maxLen - 40);
      return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
    }
  }
  return text.slice(0, maxLen);
}

export default defineTool({
  name: 'cross_harness:plans_search',
  profile: 'engineer',
  description:
    "Keyword search across plans of any registered harness by explicit slug. Scopes: slug, title, now, items, decisions, prose (a slug fragment finds the plan it names). Read-only.",
  guidance: {
    when: 'You\'re looking for prior work in another harness and don\'t have a slug. Pass harnessSlug + query.',
    notWhen:
      'You are inside the target harness — use plans:search, which auto-targets your harness.',
    chaining:
      'cross_harness:plans_search { harnessSlug, query } → cross_harness:plans_get { harnessSlug, slug } on the top hit.',
    seeAlso: [
      'cross_harness:plans_get (read a matched plan)',
      'cross_harness:plans_list (browse all plans in the harness)',
    ],
  },
  capability: 'plans:read',
  requirePrincipal: false,
  agentRoles: ['operator', 'oracle'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as {
      metadata?: (d: Record<string, unknown>) => void;
      workspaceId?: string;
    };
    const workspaceId = args.workspaceId ?? (ctxAny.workspaceId !== '*' ? ctxAny.workspaceId : undefined);
    // Validate the harness is registered (throws if not) + resolve its workspace.
    const dirs = await resolveHarnessPlansDir(args.harnessSlug, {
      ...(workspaceId ? { workspaceId } : {}),
    });
    const scopes: Scope[] = (args.scope as Scope[] | undefined) ?? [...SCOPES];
    const limit = args.limit ?? 20;
    const includeArchived = args.includeArchived !== false;
    const includeLegacy = args.includeLegacy !== false;
    const queryTokens = tokenize(args.query);
    if (queryTokens.length === 0) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ harnessSlug: args.harnessSlug, hits: [] }) }],
      };
    }

    const parsedPlans = await readAllPlans({
      includeArchived,
      harnessSlug: dirs.harnessSlug,
      workspaceId: dirs.workspaceId,
    });
    const hits: Hit[] = [];

    for (const { parsed, row } of parsedPlans) {
      if (parsed.isLegacy && !includeLegacy) continue;

      const matches: Hit['matches'] = [];
      let score = 0;

      // Slug scope first (highest-identity signal) — see plans:search; a slug
      // query must find the plan it names, not only plans that mention it.
      if (scopes.includes('slug')) {
        const s = scoreSlug(row.planSlug, queryTokens);
        if (s > 0) {
          score += s * 5;
          matches.push({ scope: 'slug', snippet: row.planSlug });
        }
      }

      if (parsed.isLegacy) {
        if (scopes.includes('prose')) {
          const s = scoreScope(parsed.prose, queryTokens);
          if (s > 0) {
            score += s;
            matches.push({ scope: 'prose', snippet: snippet(parsed.prose, queryTokens) });
          }
        }
      } else {
        if (scopes.includes('title') && parsed.frontmatter.title) {
          const s = scoreScope(parsed.frontmatter.title, queryTokens);
          if (s > 0) {
            score += s * 4;
            matches.push({ scope: 'title', snippet: parsed.frontmatter.title });
          }
        }
        if (scopes.includes('now') && parsed.now) {
          const text = parsed.now.raw;
          const s = scoreScope(text, queryTokens);
          if (s > 0) {
            score += s * 3;
            matches.push({ scope: 'now', snippet: snippet(text, queryTokens) });
          }
        }
        if (scopes.includes('items')) {
          for (const it of parsed.items) {
            const s = scoreScope(it.text, queryTokens);
            if (s > 0) {
              score += s * 2;
              matches.push({ scope: 'items', snippet: `${it.id}: ${snippet(it.text, queryTokens, 120)}` });
            }
          }
        }
        if (scopes.includes('decisions')) {
          for (const d of parsed.decisions) {
            const s = scoreScope(d.title + ' ' + d.body, queryTokens);
            if (s > 0) {
              score += s * 2;
              matches.push({
                scope: 'decisions',
                snippet: `${d.id} ${d.title}: ${snippet(d.body, queryTokens, 120)}`,
              });
            }
          }
        }
        if (scopes.includes('prose')) {
          const s = scoreScope(parsed.prose, queryTokens);
          if (s > 0) {
            score += s;
            matches.push({ scope: 'prose', snippet: snippet(parsed.prose, queryTokens) });
          }
        }
      }

      if (score > 0) {
        // WI-7259 (sibling of WI-7246): `row.planSlug` (already used for slug
        // scoring above) is the canonical identity — a snapshot's
        // frontmatter.slug reads its PARENT's slug, which would silently
        // misattribute every snapshot hit to its parent.
        hits.push({ plan: row.planSlug, score, matches });
      }
    }

    hits.sort((a, b) => b.score - a.score);
    const trimmed = hits.slice(0, limit);

    ctxAny.metadata?.({
      surface: 'cross_harness',
      harness_slug: args.harnessSlug,
      query: args.query,
      count: trimmed.length,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ harnessSlug: args.harnessSlug, hits: trimmed }),
        },
      ],
    };
  },
});
