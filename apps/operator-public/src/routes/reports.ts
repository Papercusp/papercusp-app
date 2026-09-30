/**
 * POST /reports — file an abuse report against a Cupboard listing.
 *
 * v5 §10.3 + addendum 1: GitHub-authed; reporter identity recorded.
 * Per-user rate limit 10/hr. Stores hashed reporter IP for dedupe.
 *
 * Operator review/resolution is the /admin moderation surface
 * (routes/admin.ts): GET /admin/reports + POST /admin/reports/:id/resolve.
 * This endpoint just lands pending rows; an operator triages them there.
 * (A desktop-operator moderation UI on top of /admin is the remaining piece.)
 */

import { Hono } from 'hono';
import type { Env } from '../env.ts';
import { AuthError, resolveGithubBearer } from '../auth.ts';
import {
  audit,
  clientIp,
  getHarnessById,
  insertReport,
  ipHash,
} from '../db.ts';
import { checkUserReportHourly, RateLimitError } from '../ratelimit.ts';

interface ReportBody {
  harness_id: string;
  reason: string;
}

function uuidv4(): string {
  return (crypto as { randomUUID: () => string }).randomUUID();
}

export function reportsRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.post('/reports', async (c) => {
    let user;
    try {
      user = await resolveGithubBearer(c.req.raw);
    } catch (e) {
      if (e instanceof AuthError) return c.json({ error: 'auth', reason: e.reason }, 401);
      throw e;
    }

    let body: ReportBody;
    try {
      body = (await c.req.json()) as ReportBody;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    if (typeof body.harness_id !== 'string' || !body.harness_id) {
      return c.json({ error: 'invalid_field', field: 'harness_id' }, 400);
    }
    if (typeof body.reason !== 'string' || !body.reason.trim()) {
      return c.json({ error: 'invalid_field', field: 'reason' }, 400);
    }
    if (body.reason.length > 1000) {
      return c.json({ error: 'reason_too_long', max: 1000 }, 400);
    }

    try {
      await checkUserReportHourly(c.env, user.id);
    } catch (e) {
      if (e instanceof RateLimitError) return c.json({ error: 'rate_limited' }, 429);
      throw e;
    }

    const harness = await getHarnessById(c.env.DB, body.harness_id);
    if (!harness) return c.json({ error: 'harness_not_found' }, 404);

    const now = Date.now();
    const ip = clientIp(c.req.raw);
    const ip_hash_value = ip ? await ipHash(ip, c.env.IP_HASH_PEPPER) : '';
    const id = uuidv4();

    await insertReport(c.env.DB, {
      id,
      harness_id: body.harness_id,
      reporter_github_user_id: user.id,
      reporter_github_login: user.login,
      reason: body.reason.trim(),
      ip_hash: ip_hash_value || null,
      created_at: now,
    });
    await audit(c.env.DB, now, 'reported', {
      id,
      harness_id: body.harness_id,
      reporter_user_id: user.id,
    });
    return c.json({ ok: true, id });
  });

  return app;
}
