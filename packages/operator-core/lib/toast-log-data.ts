/**
 * Toast log read API. Function-of-truth for both:
 *   - GET /api/toast-log (HTTP route)
 *   - notifications:recent MCP tool
 *
 * Keep transport concerns (NextRequest, ctx.json) in the callers.
 */

import { getOrgPg, generated } from '@papercusp/db-org';
import { and, desc, eq, gte } from 'drizzle-orm';

const t = generated.toastLogInHarnessShared;

export interface ToastRow {
  id: number;
  level: string;
  message: string;
  description: string | null;
  harnessSlug: string | null;
  createdAt: number;
  actionLabel: string | null;
  actionHref: string | null;
}

export interface ListToastsInput {
  limit?: number;
  since?: number;
  slug?: string | null;
}

interface DbRow {
  id: string;
  level: string;
  message: string;
  description: string | null;
  harness_slug: string | null;
  created_at: string;
  action_label: string | null;
  action_href: string | null;
}

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export async function listToasts(input: ListToastsInput = {}): Promise<{ toasts: ToastRow[] }> {
  const limit = Math.min(500, Math.max(1, Number(input.limit ?? 50) || 50));
  const since = Number(input.since ?? 0) || 0;
  const slugClause = input.slug && SLUG_RE.test(input.slug) ? input.slug : null;

  const { db } = getOrgPg();
  const where = slugClause
    ? and(gte(t.createdAt, since), eq(t.harnessSlug, slugClause))
    : gte(t.createdAt, since);
  const rows = (await db
    .select({
      id: t.id,
      level: t.level,
      message: t.message,
      description: t.description,
      harness_slug: t.harnessSlug,
      created_at: t.createdAt,
      action_label: t.actionLabel,
      action_href: t.actionHref,
    })
    .from(t)
    .where(where)
    .orderBy(desc(t.createdAt))
    .limit(limit)) as unknown as DbRow[];

  return {
    toasts: rows.map((r) => ({
      id: Number(r.id),
      level: r.level,
      message: r.message,
      description: r.description,
      harnessSlug: r.harness_slug,
      createdAt: Number(r.created_at),
      actionLabel: r.action_label,
      actionHref: r.action_href,
    })),
  };
}
