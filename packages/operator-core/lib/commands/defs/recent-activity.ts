/**
 * recent-activity.* — voice-accessible read tools over user_actions
 * and toast_log. Lets the agent answer "what just happened?" or
 * "any errors recently?" without burning a Claude call.
 *
 * Both tables are already populated by the rest of the app (see
 * lib/user-actions.ts and lib/toast-history.ts). These tools are
 * read-only.
 */
import { z } from 'zod';
import { register } from '../registry';
import type { QueryDef } from '../types';

function baseUrl(): string {
  if (typeof window !== 'undefined') return '';
  const port = process.env.PORT ?? process.env.NEXT_PUBLIC_PORT ?? '3155';
  return `http://127.0.0.1:${port}`;
}

const ActionsArgs = z.object({
  slug: z.string().min(1).describe('Harness slug.'),
  limit: z.number().int().min(1).max(50).default(20).optional()
    .describe('Max actions (default 20).'),
});

const actionsRecent: QueryDef<z.infer<typeof ActionsArgs>> = {
  id: 'actions.recent',
  kind: 'query',
  description: 'List recent long-running user-initiated actions for a harness (replan, cleanup, snapshot).',
  promptDescription:
    'Returns { actions: [{id, kind, status, summary, started_at, ...}, ...] }. ' +
    'Use to answer "what was that long action?" or "did the cleanup finish?". ' +
    'Don\'t recite ids; paraphrase by kind+status ("replan finished about 4 min ago").',
  schema: ActionsArgs,
  agents: ['oracle', 'operator'],
  audit: 'sample',
  tier: 'fast-query',
  handler: async ({ slug, limit }) => {
    const params = new URLSearchParams();
    if (limit) params.set('limit', String(limit));
    const r = await fetch(`${baseUrl()}/api/user-actions/${encodeURIComponent(slug)}?${params}`);
    if (!r.ok) {
      if (r.status === 404) return { count: 0, actions: [] };
      throw new Error(`actions.recent failed: HTTP ${r.status}`);
    }
    const d = await r.json();
    const actions = (d?.actions ?? []).slice(0, limit ?? 20);
    return { count: actions.length, actions };
  },
};

const NotificationsArgs = z.object({
  level: z.enum(['error', 'warning', 'info', 'success', 'all']).default('all').optional()
    .describe('Filter by level. Default all.'),
  limit: z.number().int().min(1).max(50).default(20).optional()
    .describe('Max notifications (default 20).'),
});

const notificationsRecent: QueryDef<z.infer<typeof NotificationsArgs>> = {
  id: 'notifications.recent',
  kind: 'query',
  description: 'List recent toast notifications shown anywhere in the app (errors, warnings, info).',
  promptDescription:
    'Returns { count, notifications: [{level, message, description?, harness_slug?, created_at}, ...] }. ' +
    'Use to answer "any errors recently?" / "what just popped up?" / "what\'s the bell showing?". ' +
    "Always pair the level word with the message so the user gets context " +
    "(\"warning: forms harness restarted\", not just \"forms harness restarted\").",
  schema: NotificationsArgs,
  agents: ['oracle', 'operator'],
  audit: 'sample',
  tier: 'fast-query',
  handler: async ({ level, limit }) => {
    const params = new URLSearchParams();
    if (limit) params.set('limit', String(limit));
    const r = await fetch(`${baseUrl()}/api/toast-log?${params}`);
    if (!r.ok) throw new Error(`notifications.recent failed: HTTP ${r.status}`);
    const d = await r.json();
    let toasts: any[] = d?.toasts ?? [];
    if (level && level !== 'all') {
      toasts = toasts.filter((t) => t.level === level);
    }
    toasts = toasts.slice(0, limit ?? 20);
    return { count: toasts.length, notifications: toasts };
  },
};

register(actionsRecent);
register(notificationsRecent);
