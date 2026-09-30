/**
 * harness.* — fast queries about harness state.
 *
 * Reflects what voice / Oracle / Pi all need to read fast: status, list,
 * features, last-scan, recent-suggestions. Pi (omp) hits the same
 * projected-tool dispatcher at /api/[transport]/route.ts as everyone
 * else — the old @papercusp/papercusp-mcp-server stdio shim was deleted
 * 2026-05-09 and is fully superseded by this registry + the projected
 * tool catalog.
 *
 * All queries are server-runnable (browser:'none' implicit since they're
 * QueryDef). Browser-side reflexive queries fetch through `/api/...`
 * endpoints that this registry def then calls server-side via a relative
 * URL — avoiding workspace-state coupling.
 *
 * Workspace scoping: every query receives ctx.workspace and includes it
 * in the underlying HTTP call where the endpoint is workspace-scoped.
 */
import { z } from 'zod';
import { register } from '../registry';
import type { QueryDef } from '../types';

// Resolve the operator app's own base URL — works both in-page (relative)
// and server-side (loopback to localhost on the dev port).
function baseUrl(): string {
  if (typeof window !== 'undefined') return '';
  const port = process.env.PORT ?? process.env.NEXT_PUBLIC_PORT ?? '3155';
  return `http://127.0.0.1:${port}`;
}

const StatusArgs = z.object({
  slug: z.string().min(1).describe('Harness slug.'),
});

const harnessStatus: QueryDef<z.infer<typeof StatusArgs>> = {
  id: 'harness.status',
  kind: 'query',
  description: 'Get current state of a harness: alive/paused, last decision, feature counts.',
  promptDescription:
    'Returns harness status — alive/paused flag, current iteration, last decision, ' +
    'and a feature-status breakdown (passed/in-progress/failed/blocked). Use to answer ' +
    'questions like "is the harness running?" or "what\'s the harness working on?"',
  schema: StatusArgs,
  agents: ['oracle', 'operator', 'pi'],
  audit: 'sample',
  tier: 'fast-query',
  handler: async ({ slug }) => {
    const [statusR, summaryR] = await Promise.all([
      fetch(`${baseUrl()}/api/harness/${encodeURIComponent(slug)}/status?phase=staging`),
      fetch(`${baseUrl()}/api/harness/${encodeURIComponent(slug)}/summary`).catch(() => null),
    ]);
    if (!statusR.ok) throw new Error(`status fetch failed: HTTP ${statusR.status}`);
    const status = await statusR.json();
    const summary = summaryR && summaryR.ok ? await summaryR.json().catch(() => null) : null;
    const features = Array.isArray(status?.features) ? status.features : [];
    const counts: Record<string, number> = {};
    for (const f of features) {
      const s = f?.status ?? 'unknown';
      counts[s] = (counts[s] ?? 0) + 1;
    }
    return {
      slug,
      path: status?.project?.path,
      alive: !!status?.alive,
      paused: !!status?.paused,
      iteration: status?.iteration,
      feature_counts: counts,
      feature_total: features.length,
      recent_features: features.slice(-5).map((f: any) => ({
        id: f.id,
        status: f.status,
        title: f.title,
      })),
      summary_excerpt: typeof summary?.summary === 'string'
        ? summary.summary.slice(0, 1200)
        : null,
    };
  },
};

const ListArgs = z.object({}).describe('No args.');

const harnessList: QueryDef<z.infer<typeof ListArgs>> = {
  id: 'harness.list',
  kind: 'query',
  description: 'List harnesses registered for the active workspace.',
  promptDescription:
    'Returns each harness as { slug, path, harness_kind, hasState, hasSpec }. ' +
    'Use to answer "what harnesses do I have?" or to find a slug before navigating.',
  schema: ListArgs,
  agents: ['oracle', 'operator', 'pi'],
  audit: 'sample',
  tier: 'fast-query',
  handler: async () => {
    const r = await fetch(`${baseUrl()}/api/harness/projects/lite`);
    if (!r.ok) throw new Error(`harness.list failed: HTTP ${r.status}`);
    const d = await r.json();
    return { harnesses: d?.projects ?? [] };
  },
};

const ListFeaturesArgs = z.object({
  slug: z.string().min(1).describe('Harness slug.'),
  status: z.string().nullable().optional().describe('Optional status filter (passed/in-progress/failed/blocked).'),
  limit: z.number().int().min(1).max(200).default(50).describe('Max rows to return (default 50, cap 200).'),
});

const harnessListFeatures: QueryDef<z.infer<typeof ListFeaturesArgs>> = {
  id: 'harness.list-features',
  kind: 'query',
  description: 'List features in the harness queue (filterable by status).',
  promptDescription:
    'Returns features as [{id, title, status, claims, attempts}]. Filter by status if ' +
    'the user asked specifically (e.g. "what failed?"). Default returns 50, cap 200.',
  schema: ListFeaturesArgs,
  agents: ['oracle', 'operator', 'pi'],
  audit: 'sample',
  tier: 'fast-query',
  handler: async ({ slug, status, limit }) => {
    const r = await fetch(`${baseUrl()}/api/harness/${encodeURIComponent(slug)}/status?phase=staging`);
    if (!r.ok) throw new Error(`harness.list-features failed: HTTP ${r.status}`);
    const d = await r.json();
    let features: any[] = Array.isArray(d?.features) ? d.features : [];
    if (status) features = features.filter((f) => f.status === status);
    features = features.slice(0, limit);
    return { slug, count: features.length, features: features.map((f) => ({
      id: f.id,
      title: f.title,
      status: f.status,
      claims: f.claims,
      attempts: f.attempts,
    })) };
  },
};

// (`harness.last-scan` / `harness.recent-suggestions` were removed with the
// scanner card stream — unify-agent-launches D-005. "What did the operator
// find?" now reads the self-improvement backlog: improvements:digest.)

// ─── New voice tools (audit unlock 2026-05-07) ─────────────────────

const IssuesListArgs = z.object({
  slug: z.string().optional()
    .describe('Optional harness slug. Omit for cross-harness needs-human-review list.'),
  limit: z.number().int().min(1).max(50).default(20).optional()
    .describe('Max issues to return (default 20).'),
});

const issuesList: QueryDef<z.infer<typeof IssuesListArgs>> = {
  id: 'issues.list',
  kind: 'query',
  description: 'List open issues / features needing human review.',
  promptDescription:
    'Two modes: pass slug to list pending issues for that harness; omit slug to list ' +
    'cross-harness features that need human review. Returns ' +
    '{ count, issues: [{id, title, severity, harness_slug?, status}, ...] }. ' +
    'Use to answer "any open issues?", "issues on sheets?", or "what needs my approval?".',
  schema: IssuesListArgs,
  agents: ['oracle', 'operator'],
  audit: 'sample',
  tier: 'fast-query',
  handler: async ({ slug, limit }) => {
    if (slug) {
      const r = await fetch(`${baseUrl()}/api/harness/${encodeURIComponent(slug)}/issues-list`);
      if (!r.ok) throw new Error(`issues.list failed: HTTP ${r.status}`);
      const d = await r.json();
      const issues = (d?.pending ?? []).concat(d?.issues ?? []).slice(0, limit ?? 20);
      return { count: issues.length, issues };
    }
    const r = await fetch(`${baseUrl()}/api/harness/needs-human-review`);
    if (!r.ok) throw new Error(`issues.list failed: HTTP ${r.status}`);
    const d = await r.json();
    const features = (d?.features ?? []).slice(0, limit ?? 20).map((f: any) => ({
      id: f.id,
      title: f.title,
      harness_slug: f.harness_slug,
      status: f.status ?? 'needs-review',
    }));
    return { count: features.length, issues: features };
  },
};

const EscalationsArgs = z.object({
  slug: z.string().min(1).describe('Harness slug.'),
});

const escalationsGet: QueryDef<z.infer<typeof EscalationsArgs>> = {
  id: 'escalations.get',
  kind: 'query',
  description: 'Get escalation + supervisor notes (if any) for a harness.',
  promptDescription:
    'Returns { hasEscalation, escalation, supervisorNotes, mtimeMs }. ' +
    "If hasEscalation is false, the harness has no active escalation — say so plainly. " +
    'Otherwise paraphrase the escalation headline; do NOT read the full text aloud — ' +
    'the panel renders it. Use to answer "any escalations?" or "what\'s wrong with sheets?".',
  schema: EscalationsArgs,
  agents: ['oracle', 'operator'],
  audit: 'sample',
  tier: 'fast-query',
  handler: async ({ slug }) => {
    const r = await fetch(`${baseUrl()}/api/harness/${encodeURIComponent(slug)}/escalation`);
    if (!r.ok) {
      if (r.status === 404) return { hasEscalation: false, escalation: null, supervisorNotes: null, mtimeMs: null };
      throw new Error(`escalations.get failed: HTTP ${r.status}`);
    }
    const d = await r.json();
    const hasEscalation = !!(d?.escalation && String(d.escalation).trim());
    return {
      hasEscalation,
      escalation: hasEscalation ? d.escalation : null,
      supervisorNotes: d?.supervisorNotes ?? null,
      mtimeMs: d?.mtimeMs ?? null,
    };
  },
};

const PendingReviewsArgs = z.object({
  slug: z.string().min(1).describe('Harness slug.'),
  limit: z.number().int().min(1).max(50).default(20).optional(),
});

const pendingReviewsList: QueryDef<z.infer<typeof PendingReviewsArgs>> = {
  id: 'pending-reviews.list',
  kind: 'query',
  description: 'List pending reviews (capability approvals, plan reviews, etc.) for a harness.',
  promptDescription:
    'Returns { count, reviews: [{id, kind, title, ts, ...}, ...] }. ' +
    'Use to answer "what\'s pending review?" or "anything waiting on me?". ' +
    'Pair with operator_approve_pending when the user says "approve it" — ' +
    'find the id in this list, then call operator_approve_pending with the slug+capability.',
  schema: PendingReviewsArgs,
  agents: ['oracle', 'operator'],
  audit: 'sample',
  tier: 'fast-query',
  handler: async ({ slug, limit }) => {
    const r = await fetch(`${baseUrl()}/api/harness/${encodeURIComponent(slug)}/reviews`);
    if (!r.ok) throw new Error(`pending-reviews.list failed: HTTP ${r.status}`);
    const d = await r.json();
    const reviews = (d?.reviews ?? []).slice(0, limit ?? 20);
    return { count: reviews.length, reviews };
  },
};

const HealthArgs = z.object({
  slug: z.string().min(1).describe('Harness slug.'),
});

const harnessHealth: QueryDef<z.infer<typeof HealthArgs>> = {
  id: 'harness.health',
  kind: 'query',
  description: 'Get a fast health snapshot for a harness — alive, escalated, feature-status counts.',
  promptDescription:
    'Returns { slug, alive, escalated, feature_counts: {passed, failing, in_progress, blocked}, ' +
    'lastRunMs }. Use for "is sheets healthy?" / "is the harness running?" — single fast call ' +
    "instead of harness_status + escalations_get separately. If escalated is true, mention it; " +
    "if failing > 0, mention the count.",
  schema: HealthArgs,
  agents: ['oracle', 'operator'],
  audit: 'sample',
  tier: 'fast-query',
  handler: async ({ slug }) => {
    const r = await fetch(`${baseUrl()}/api/harness/${encodeURIComponent(slug)}/health`);
    if (!r.ok) throw new Error(`harness.health failed: HTTP ${r.status}`);
    return await r.json();
  },
};

register(harnessStatus);
register(harnessList);
register(harnessListFeatures);
register(issuesList);
register(escalationsGet);
register(pendingReviewsList);
register(harnessHealth);
