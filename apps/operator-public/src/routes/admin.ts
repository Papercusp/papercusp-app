/**
 * /admin/* — Cupboard operator moderation surface (P-051a-3 + D-023 "moderation v1").
 *
 * The public surface lets anyone FILE a report (`POST /reports`), but until
 * now nothing could review or act on them — reports landed in D1 and sat there.
 * This closes that loop:
 *
 *   GET  /admin/reports[?status=pending|resolved_unlist|resolved_dismiss|all]
 *        — list reports (joined with the reported harness), newest-pending-first.
 *   POST /admin/reports/:id/resolve   { action: 'unlist' | 'dismiss', note? }
 *        — resolve a pending report. 'unlist' also takes the harness down
 *          (unlisted_reason = the report id, for traceability).
 *   POST /admin/harnesses/:id/unlist  { reason? }
 *        — proactive operator takedown, independent of any report.
 *
 * Auth: a normal GitHub bearer (validated via `resolveGithubBearer`) whose
 * resolved user id is in the `CUPBOARD_OPERATOR_GITHUB_IDS` allowlist. Empty
 * allowlist ⇒ no operators ⇒ every endpoint 403s. Every action writes an audit
 * row attributed to the operator's GitHub id.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../env.ts';
import { AuthError, isCupboardOperator, resolveGithubBearer } from '../auth.ts';
import { isSelfDescribingKind } from '../content-pin.ts';
import {
  audit,
  banPublisherPubkey,
  getHarnessById,
  getReportById,
  listBannedPubkeys,
  listPendingReview,
  listReports,
  markHarnessUnlisted,
  resolveReport,
  setReviewStatus,
  unbanPublisherPubkey,
} from '../db.ts';

interface ResolveBody {
  action: 'unlist' | 'dismiss';
  note?: string;
}

interface UnlistBody {
  reason?: string;
}

/**
 * Resolve the caller to an operator, or return a Response to short-circuit
 * with (401 unauthenticated / 403 not-an-operator). On success returns the
 * operator's GitHub identity.
 */
export async function requireOperator(
  c: Context<{ Bindings: Env }>,
): Promise<{ id: number; login: string } | Response> {
  let user: { id: number; login: string };
  try {
    user = await resolveGithubBearer(c.req.raw);
  } catch (e) {
    if (e instanceof AuthError) return c.json({ error: 'auth', reason: e.reason }, 401);
    throw e;
  }
  if (!isCupboardOperator(user.id, c.env)) {
    return c.json({ error: 'forbidden', reason: 'not_an_operator' }, 403);
  }
  return user;
}

export function adminRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // GET /admin/reports — list reports for moderation.
  app.get('/admin/reports', async (c) => {
    const op = await requireOperator(c);
    if (op instanceof Response) return op;
    const raw = new URL(c.req.url).searchParams.get('status') ?? 'pending';
    const status =
      raw === 'pending' || raw === 'resolved_unlist' || raw === 'resolved_dismiss' || raw === 'all'
        ? raw
        : 'pending';
    const reports = await listReports(c.env.DB, { status });
    return c.json({ reports, status });
  });

  // POST /admin/reports/:id/resolve — resolve a pending report.
  app.post('/admin/reports/:id/resolve', async (c) => {
    const op = await requireOperator(c);
    if (op instanceof Response) return op;
    const id = c.req.param('id');

    let body: ResolveBody;
    try {
      body = (await c.req.json()) as ResolveBody;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    if (body.action !== 'unlist' && body.action !== 'dismiss') {
      return c.json({ error: 'invalid_field', field: 'action' }, 400);
    }
    if (body.note != null && (typeof body.note !== 'string' || body.note.length > 1000)) {
      return c.json({ error: 'invalid_field', field: 'note' }, 400);
    }

    const report = await getReportById(c.env.DB, id);
    if (!report) return c.json({ error: 'not_found' }, 404);
    if (report.status !== 'pending') {
      return c.json({ error: 'already_resolved', status: report.status }, 409);
    }

    const now = Date.now();
    const resolvedStatus = body.action === 'unlist' ? 'resolved_unlist' : 'resolved_dismiss';
    const changes = await resolveReport(c.env.DB, id, {
      status: resolvedStatus,
      note: body.note?.trim() || null,
      now_ms: now,
    });
    // A concurrent resolve won the race (status flipped between our read and
    // the guarded UPDATE) — treat as already-resolved rather than double-acting.
    if (changes === 0) return c.json({ error: 'already_resolved' }, 409);

    let harness_unlisted = false;
    if (body.action === 'unlist') {
      const harness = await getHarnessById(c.env.DB, report.harness_id);
      if (harness && !harness.unlisted_at) {
        await markHarnessUnlisted(c.env.DB, report.harness_id, `report:${id}`, now);
        harness_unlisted = true;
      }
    }
    await audit(c.env.DB, now, 'report_resolved', {
      report_id: id,
      harness_id: report.harness_id,
      action: body.action,
      operator_github_user_id: op.id,
      harness_unlisted,
    });
    return c.json({ ok: true, status: resolvedStatus, harness_unlisted });
  });

  // GET /admin/pending — the pre-publication review queue
  // (learning-packs-2026-06-11 P-019/P-020, D-007): policy-kind listings
  // (knowledge-pack, blueprint) awaiting an operator decision, oldest first.
  app.get('/admin/pending', async (c) => {
    const op = await requireOperator(c);
    if (op instanceof Response) return op;
    const pending = await listPendingReview(c.env.DB);
    return c.json({ pending });
  });

  // POST /admin/listings/:id/review — approve or reject a pending listing.
  // The decision (+ reason) lands on the row; the submitter reads it from
  // their own GET /:id view; approval makes the listing publicly visible.
  app.post('/admin/listings/:id/review', async (c) => {
    const op = await requireOperator(c);
    if (op instanceof Response) return op;
    const id = c.req.param('id');

    let body: { decision?: string; reason?: string } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    if (body.decision !== 'approve' && body.decision !== 'reject') {
      return c.json({ error: 'invalid_field', field: 'decision' }, 400);
    }
    if (body.reason != null && (typeof body.reason !== 'string' || body.reason.length > 1000)) {
      return c.json({ error: 'invalid_field', field: 'reason' }, 400);
    }

    const row = await getHarnessById(c.env.DB, id);
    if (!row || row.unlisted_at) return c.json({ error: 'not_found' }, 404);
    if (row.review_status !== 'pending') {
      return c.json({ error: 'not_pending', review_status: row.review_status }, 409);
    }
    // P-001/D-005: a self-describing listing must have an immutable content
    // pin before moderation can make it public.  Rows created before migration
    // 028 legitimately have NULL pins, but approving one would bypass the
    // trust gate; the publisher must re-publish it so the Worker can pin the
    // exact bytes that moderation will expose.
    if (
      body.decision === 'approve' &&
      isSelfDescribingKind(row.listing_kind) &&
      (row.pinned_commit_sha == null || row.pinned_tree_digest == null)
    ) {
      return c.json({
        error: 'content_pin_required',
        listing_kind: row.listing_kind,
        reason: 'republish_required_before_approval',
      }, 409);
    }

    const now = Date.now();
    const status = body.decision === 'approve' ? ('approved' as const) : ('rejected' as const);
    await setReviewStatus(c.env.DB, id, status, body.reason?.trim() || null, now);
    await audit(c.env.DB, now, 'review_decided', {
      id,
      listing_kind: row.listing_kind,
      decision: status,
      operator_github_user_id: op.id,
      publisher_github_user_id: row.publisher_github_user_id,
    });
    return c.json({ ok: true, id, review_status: status });
  });

  // POST /admin/harnesses/:id/unlist — proactive operator takedown.
  app.post('/admin/harnesses/:id/unlist', async (c) => {
    const op = await requireOperator(c);
    if (op instanceof Response) return op;
    const id = c.req.param('id');

    let body: UnlistBody = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as UnlistBody;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    if (body.reason != null && (typeof body.reason !== 'string' || body.reason.length > 1000)) {
      return c.json({ error: 'invalid_field', field: 'reason' }, 400);
    }

    const harness = await getHarnessById(c.env.DB, id);
    if (!harness) return c.json({ error: 'not_found' }, 404);
    if (harness.unlisted_at) return c.json({ ok: true, already_unlisted: true });

    const now = Date.now();
    await markHarnessUnlisted(c.env.DB, id, 'by_operator', now);
    await audit(c.env.DB, now, 'operator_unlisted', {
      harness_id: id,
      operator_github_user_id: op.id,
      reason: body.reason?.trim() || null,
    });
    return c.json({ ok: true });
  });

  // GET /admin/banned-pubkeys — list operator-banned publisher device pubkeys
  // (channel-2 ban-list, item 1).
  app.get('/admin/banned-pubkeys', async (c) => {
    const op = await requireOperator(c);
    if (op instanceof Response) return op;
    const banned = await listBannedPubkeys(c.env.DB);
    return c.json({ banned });
  });

  // POST /admin/banned-pubkeys { pubkey, reason } — ban a publisher device
  // pubkey. Idempotent upsert. Listings with this pubkey are then filtered
  // from public reads. (pubkey is in the body, not the path, because base64
  // contains '/' and '+'.)
  app.post('/admin/banned-pubkeys', async (c) => {
    const op = await requireOperator(c);
    if (op instanceof Response) return op;
    let body: { pubkey?: string; reason?: string };
    try {
      body = (await c.req.json()) as { pubkey?: string; reason?: string };
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    if (typeof body.pubkey !== 'string' || !body.pubkey || body.pubkey.length > 200) {
      return c.json({ error: 'invalid_field', field: 'pubkey' }, 400);
    }
    if (body.reason != null && (typeof body.reason !== 'string' || body.reason.length > 1000)) {
      return c.json({ error: 'invalid_field', field: 'reason' }, 400);
    }
    const now = Date.now();
    await banPublisherPubkey(c.env.DB, body.pubkey, body.reason?.trim() || 'unspecified', op.id, now);
    await audit(c.env.DB, now, 'publisher_pubkey_banned', {
      pubkey: body.pubkey,
      operator_github_user_id: op.id,
      reason: body.reason?.trim() || null,
    });
    return c.json({ ok: true });
  });

  // POST /admin/banned-pubkeys/remove { pubkey } — lift a ban.
  app.post('/admin/banned-pubkeys/remove', async (c) => {
    const op = await requireOperator(c);
    if (op instanceof Response) return op;
    let body: { pubkey?: string };
    try {
      body = (await c.req.json()) as { pubkey?: string };
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    if (typeof body.pubkey !== 'string' || !body.pubkey) {
      return c.json({ error: 'invalid_field', field: 'pubkey' }, 400);
    }
    const now = Date.now();
    await unbanPublisherPubkey(c.env.DB, body.pubkey);
    await audit(c.env.DB, now, 'publisher_pubkey_unbanned', {
      pubkey: body.pubkey,
      operator_github_user_id: op.id,
    });
    return c.json({ ok: true });
  });

  return app;
}
