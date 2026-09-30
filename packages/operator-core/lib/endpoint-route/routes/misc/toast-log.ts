/**
 * /api/toast-log — POST record a toast, GET list recent, DELETE clear.
 * Ported from app/api/toast-log/route.ts. `auth: 'public'`.
 */
import { getOrgPg, generated } from '@papercusp/db-org';
import { desc, inArray } from 'drizzle-orm';
import { notifySyncInvalidate } from '../../../sync-sse';
import { listToasts } from '../../../toast-log-data';
import { defineTool } from '@papercusp/agent-mcp';

const tl = generated.toastLogInHarnessShared;

const MAX_MESSAGE_LEN = 2000;
const MAX_DESCRIPTION_LEN = 8000;
const RING_BUFFER_SIZE = 2000;
const VALID_LEVELS = new Set(['default', 'info', 'success', 'warning', 'error', 'loading']);

export default [
  defineTool({
    method: 'POST',
    path: '/toast-log',
    auth: 'loopback',
    async handler(req) {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: 'invalid json' }, { status: 400 });
      }
      if (!body || typeof body !== 'object') {
        return Response.json({ error: 'invalid body' }, { status: 400 });
      }
      const b = body as Record<string, unknown>;
      const level =
        typeof b.level === 'string' && VALID_LEVELS.has(b.level) ? b.level : 'default';
      const message =
        typeof b.message === 'string' ? b.message.slice(0, MAX_MESSAGE_LEN).trim() : '';
      if (!message) return Response.json({ error: 'message required' }, { status: 400 });
      const description =
        typeof b.description === 'string' && b.description.trim()
          ? b.description.slice(0, MAX_DESCRIPTION_LEN)
          : null;
      const harnessSlug =
        typeof b.harnessSlug === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(b.harnessSlug)
          ? b.harnessSlug
          : null;
      const actionLabel =
        typeof b.actionLabel === 'string' && b.actionLabel.trim()
          ? b.actionLabel.slice(0, 120).trim()
          : null;
      const rawHref = typeof b.actionHref === 'string' ? b.actionHref.trim() : '';
      const actionHref =
        rawHref && (rawHref.startsWith('/') || /^https?:\/\//i.test(rawHref))
          ? rawHref.slice(0, 2000)
          : null;
      const createdAt = Date.now();

      const { db } = getOrgPg();
      const [row] = await db
        .insert(tl)
        .values({ level, message, description, harnessSlug, createdAt, actionLabel, actionHref })
        .returning({ id: tl.id });

      void (async () => {
        const stale = await db
          .select({ id: tl.id })
          .from(tl)
          .orderBy(desc(tl.createdAt))
          .offset(RING_BUFFER_SIZE);
        if (stale.length > 0) {
          await db.delete(tl).where(inArray(tl.id, stale.map((r) => r.id)));
        }
      })().catch(() => {});
      void notifySyncInvalidate('toastLog.recent', undefined).catch(() => {});

      return Response.json({ id: Number(row.id), createdAt });
    },
  }),
  defineTool({
    method: 'GET',
    path: '/toast-log',
    auth: 'public',
    async handler(req) {
      const url = new URL(req.url);
      const limit = Number(url.searchParams.get('limit') ?? '50') || 50;
      const since = Number(url.searchParams.get('since') ?? '0') || 0;
      const slug = url.searchParams.get('slug');
      return Response.json(await listToasts({ limit, since, slug }));
    },
  }),
  defineTool({
    method: 'DELETE',
    path: '/toast-log',
    auth: 'loopback',
    async handler(req) {
      const all = new URL(req.url).searchParams.get('all') === '1';
      const { db } = getOrgPg();
      if (all) {
        await db.delete(tl);
        return Response.json({ ok: true, cleared: 'all' });
      }
      return Response.json({ error: 'pass ?all=1 to clear' }, { status: 400 });
    },
  }),
];
