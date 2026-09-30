/**
 * Federated search across workspace state.
 *
 * Uses Postgres full-text search (tsvector + GIN, set up by 013-fts-indexes.sql)
 * when the `_search` column is available on each table. Falls back to ILIKE
 * substring search if the columns don't exist yet (i.e. before 013 is applied).
 *
 * jsonb columns (audit_log.details) are not searched in v1; FTS over jsonb
 * requires a generated text-flattened column deferred to v1.5.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/tooldef';
import type { PapercuspToolContext } from '@papercusp/operator-core/lib/agent-tools/_tool-context';

const KINDS = ['tasks', 'goals', 'projects', 'audit'] as const;
type Kind = (typeof KINDS)[number];

interface SearchHit {
  kind: string;
  id: string;
  snippet: string;
  score: number;
}

type TaskSearchRow = { harness_slug: string; feature_id: string; title: string; summary: string; rank: number };
type TaskFallbackRow = { harness_slug: string; feature_id: string; title: string; summary: string };
type GoalSearchRow = { id: string; title: string; rank: number };
type GoalFallbackRow = { id: string; title: string; body: string };
type ProjectSearchRow = { id: string; slug: string; name: string; rank: number };
type ProjectFallbackRow = { id: string; slug: string; name: string };
type AuditSearchRow = { id: string; subject: string; action: string; rank: number };
type AuditFallbackRow = { id: string; subject: string; action: string };

/**
 * Run one kind's search: FTS first, ILIKE fallback on failure — and if
 * the fallback ALSO fails, record `<kind>_unavailable` instead of
 * erroring the whole search (audit P-048). One kind's outage (dropped
 * table, bad grant, aborted query) degrades that kind only; every
 * other kind still answers.
 */
async function searchKind(
  kind: Kind,
  hits: SearchHit[],
  degradedReasons: string[],
  fts: () => Promise<SearchHit[]>,
  ilike: () => Promise<SearchHit[]>,
): Promise<void> {
  try {
    hits.push(...(await fts()));
    return;
  } catch {
    // `_search` missing (pre-013) or any FTS failure — try ILIKE.
  }
  try {
    hits.push(...(await ilike()));
    degradedReasons.push(`${kind}_using_ilike_fallback`);
  } catch (e) {
    console.warn(
      `[search:query] ${kind} unavailable: ${e instanceof Error ? e.message : String(e)}`,
    );
    degradedReasons.push(`${kind}_unavailable`);
  }
}

export default defineTool({
  name: 'search:query',
  needsWorkspaceTx: true,
  capability: 'search:read',
  guidance: {
    when: 'User asks an open-ended question that could match anything in the workspace ("anything about auth?", "find references to budget guard"). Cross-resource full-text search over tasks, goals, projects, audit.',
    notWhen: 'For a SPECIFIC resource type, use the dedicated list/get tool — search is broader but ranked less precisely. For repository text, use `search:fulltext`.',
  },
  args: z.object({
    query: z.string().min(1),
    kinds: z.array(z.enum(KINDS)).optional(),
    limit: z.number().int().positive().max(100).default(25),
  }),
  async handler(args, ctx: PapercuspToolContext) {
    const tx = ctx.tx!;
    const wantKind = (k: Kind) => !args.kinds || args.kinds.includes(k);
    const hits: SearchHit[] = [];
    const degradedReasons: string[] = [];

    // FTS path: plainto_tsquery is forgiving (accepts user-supplied text).
    // We use ts_rank_cd for ordering. If the `_search` column is missing
    // (013 not applied), searchKind falls back to ILIKE — and a kind whose
    // fallback ALSO fails degrades alone (audit P-048).
    const q = `%${args.query}%`;

    if (wantKind('tasks')) {
      await searchKind(
        'tasks',
        hits,
        degradedReasons,
        async () => {
          const rows = await tx<Array<TaskSearchRow>>`
            SELECT harness_slug, feature_id, title, summary,
                   ts_rank_cd(_search, plainto_tsquery('english', ${args.query})) AS rank
              FROM harness_shared.harness_features_consolidated
             WHERE _search @@ plainto_tsquery('english', ${args.query})
             ORDER BY rank DESC
             LIMIT ${args.limit}
          `;
          return rows.map((r: TaskSearchRow) => ({
            kind: 'tasks',
            id: `${r.harness_slug}/${r.feature_id}`,
            snippet: r.title || (r.summary ?? '').slice(0, 100),
            score: Number(r.rank),
          }));
        },
        async () => {
          const rows = await tx<Array<TaskFallbackRow>>`
            SELECT harness_slug, feature_id, title, summary
              FROM harness_shared.harness_features_consolidated
             WHERE title ILIKE ${q} OR summary ILIKE ${q}
             LIMIT ${args.limit}
          `;
          return rows.map((r: TaskFallbackRow) => ({
            kind: 'tasks',
            id: `${r.harness_slug}/${r.feature_id}`,
            snippet: r.title || (r.summary ?? '').slice(0, 100),
            score: 1,
          }));
        },
      );
    }

    if (wantKind('goals')) {
      await searchKind(
        'goals',
        hits,
        degradedReasons,
        async () => {
          const rows = await tx<Array<{ id: string; title: string; rank: number }>>`
            SELECT id, title, ts_rank_cd(_search, plainto_tsquery('english', ${args.query})) AS rank
              FROM harness_shared.goals
             WHERE _search @@ plainto_tsquery('english', ${args.query})
             ORDER BY rank DESC
             LIMIT ${args.limit}
          `;
          return rows.map((r: GoalSearchRow) => ({ kind: 'goals', id: r.id, snippet: r.title, score: Number(r.rank) }));
        },
        async () => {
          const rows = await tx<Array<{ id: string; title: string; body: string }>>`
            SELECT id, title, body FROM harness_shared.goals
             WHERE title ILIKE ${q} OR body ILIKE ${q}
             LIMIT ${args.limit}
          `;
          return rows.map((r: GoalFallbackRow) => ({ kind: 'goals', id: r.id, snippet: r.title, score: 1 }));
        },
      );
    }

    if (wantKind('projects')) {
      await searchKind(
        'projects',
        hits,
        degradedReasons,
        async () => {
          const rows = await tx<Array<{ id: string; slug: string; name: string; rank: number }>>`
            SELECT id, slug, name, ts_rank_cd(_search, plainto_tsquery('english', ${args.query})) AS rank
              FROM harness_shared.projects
             WHERE _search @@ plainto_tsquery('english', ${args.query})
             ORDER BY rank DESC
             LIMIT ${args.limit}
          `;
          return rows.map((r: ProjectSearchRow) => ({ kind: 'projects', id: r.slug ?? r.id, snippet: r.name, score: Number(r.rank) }));
        },
        async () => {
          const rows = await tx<Array<{ id: string; slug: string; name: string }>>`
            SELECT id, slug, name FROM harness_shared.projects
             WHERE name ILIKE ${q} OR slug ILIKE ${q}
             LIMIT ${args.limit}
          `;
          return rows.map((r: ProjectFallbackRow) => ({ kind: 'projects', id: r.slug ?? r.id, snippet: r.name, score: 1 }));
        },
      );
    }

    if (wantKind('audit')) {
      await searchKind(
        'audit',
        hits,
        degradedReasons,
        async () => {
          const rows = await tx<Array<{ id: string; subject: string; action: string; rank: number }>>`
            SELECT id, subject, action,
                   ts_rank_cd(_search, plainto_tsquery('simple', ${args.query})) AS rank
              FROM harness_shared.audit_log
             WHERE _search @@ plainto_tsquery('simple', ${args.query})
             ORDER BY rank DESC
             LIMIT ${args.limit}
          `;
          return rows.map((r: AuditSearchRow) => ({ kind: 'audit', id: r.id, snippet: `${r.action}: ${r.subject}`, score: Number(r.rank) }));
        },
        async () => {
          const rows = await tx<Array<{ id: string; subject: string; action: string }>>`
            SELECT id, subject, action FROM harness_shared.audit_log
             WHERE subject ILIKE ${q} OR action ILIKE ${q}
             LIMIT ${args.limit}
          `;
          return rows.map((r: AuditFallbackRow) => ({ kind: 'audit', id: r.id, snippet: `${r.action}: ${r.subject}`, score: 0.5 }));
        },
      );
    }

    // 'messages' kind (over harness_shared.messages_consolidated) retired
    // here — see retire-work-item-mail-surface-2026-07-26 P-004 /
    // _retired/work-item-mail/RESTORE.md.

    // Sort across kinds by score descending so highest-confidence hits land first.
    hits.sort((a, b) => b.score - a.score);

    return {
      data: hits.slice(0, args.limit),
      ...(degradedReasons.length ? { degraded: true, degradedReasons } : {}),
    };
  },
});
