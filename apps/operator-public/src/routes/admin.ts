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
import { AuthError, extractBearer, isCupboardOperator, resolveGithubBearer } from '../auth.ts';
import {
  COMMIT_SHA_RE,
  diffListingContent,
  isSelfDescribingKind,
  pinListingContent,
  pinRefusalToHttp,
} from '../content-pin.ts';
import {
  approveListingVersion,
  audit,
  banPublisherPubkey,
  getActiveListingByRefs,
  getHarnessById,
  getPreviouslyApprovedVersion,
  listVersionsSupersededByApproval,
  getReportById,
  listBannedPubkeys,
  listPendingReview,
  listReports,
  markHarnessUnlisted,
  resolveReport,
  setReviewStatus,
  unbanPublisherPubkey,
} from '../db.ts';
import {
  LEDGER_STREAM_IDS,
  exportLedgerStream,
  isLedgerStreamId,
  verifyLedgerStream,
  witnessLedgerStream,
} from '../ledger-chain-store.ts';

const HEX64 = /^[0-9a-f]{64}$/;

/** Parse the optional `?headSeq=&headHash=` pin a verifier saved from an earlier export. */
function parseExpectedHead(url: URL): { seq: number; entryHash: string } | null | 'invalid' {
  const seqRaw = url.searchParams.get('headSeq');
  const hash = url.searchParams.get('headHash');
  if (seqRaw == null && hash == null) return null;
  const seq = Number(seqRaw);
  if (seqRaw == null || hash == null || !Number.isSafeInteger(seq) || seq < 0 || !HEX64.test(hash)) return 'invalid';
  return { seq, entryHash: hash };
}

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

    let body: { decision?: string; reason?: string; reviewed_commit_sha?: string } = {};
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
    // P-008: the commit the operator actually reviewed. Absent ⇒ the row's own
    // pin (what the review-diff showed). Present and different ⇒ the row had
    // DRIFTED and is re-pinned to this SHA before it is approved.
    if (
      body.reviewed_commit_sha != null &&
      (typeof body.reviewed_commit_sha !== 'string' || !COMMIT_SHA_RE.test(body.reviewed_commit_sha))
    ) {
      return c.json({ error: 'invalid_field', field: 'reviewed_commit_sha' }, 400);
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
    const reason = body.reason?.trim() || null;
    if (body.decision === 'reject') {
      await setReviewStatus(c.env.DB, id, 'rejected', reason, now);
      await audit(c.env.DB, now, 'review_decided', {
        id,
        listing_kind: row.listing_kind,
        decision: 'rejected',
        operator_github_user_id: op.id,
        publisher_github_user_id: row.publisher_github_user_id,
      });
      return c.json({ ok: true, id, review_status: 'rejected' });
    }

    // Approve (P-008): record WHICH commit was reviewed, re-pin a drifted row to
    // it, and make this the single served version of its identity.
    let approved: { commitSha: string; treeDigest: string } | null = null;
    let repinned = false;
    let repinAuthority: { unresolved: boolean; cause: string | null } | null = null;
    if (isSelfDescribingKind(row.listing_kind)) {
      // Non-null: the content_pin_required guard above refused a NULL pin.
      approved = { commitSha: row.pinned_commit_sha as string, treeDigest: row.pinned_tree_digest as string };
      const reviewed = body.reviewed_commit_sha;
      if (reviewed != null && reviewed !== row.pinned_commit_sha) {
        // The reviewer read a different commit than the row's pin: re-fetch +
        // re-scan `<ref>/` AT THAT SHA (never the default-branch head — the point
        // is to serve exactly what was reviewed), then pin it.
        const clash = await getActiveListingByRefs(
          c.env.DB,
          row.github_repository_id,
          row.listing_kind,
          row.listing_ref as string,
          reviewed,
        );
        if (clash && clash.id !== id) {
          return c.json({ error: 'version_exists', existing_id: clash.id, commit_sha: reviewed }, 409);
        }
        const repin = await pinListingContent({
          token: extractBearer(c.req.raw),
          owner: row.github_owner,
          name: row.github_name,
          defaultBranch: '',
          listingRef: row.listing_ref as string,
          commitSha: reviewed,
          kind: row.listing_kind,
        });
        if (!repin.ok) {
          const refusal = pinRefusalToHttp(repin);
          return c.json(refusal.body, refusal.status);
        }
        approved = { commitSha: repin.commitSha, treeDigest: repin.treeDigest };
        // P-007: a re-pin replaces the pinned bytes, so the Worker's authority verdict must be
        // the one computed from THOSE bytes, not the superseded commit's.
        repinAuthority = repin.recipeAuthority ?? null;
        repinned = true;
      }
    }
    const superseded = approved ? await listVersionsSupersededByApproval(c.env.DB, row) : [];
    await approveListingVersion(c.env.DB, {
      id,
      reason,
      now,
      approved,
      repinned,
      authority: repinAuthority,
      retire: approved ? row : null,
      // WI-10004643: the audit row rides in the approval's own atomic batch (D1 has no
      // transaction across two calls), so a Worker failure can't leave an approval unaudited.
      audit: {
        kind: 'review_decided',
        detail: {
          id,
          listing_kind: row.listing_kind,
          decision: 'approved',
          operator_github_user_id: op.id,
          publisher_github_user_id: row.publisher_github_user_id,
          approved_commit_sha: approved?.commitSha ?? null,
          repinned,
          from_pinned_commit_sha: repinned ? row.pinned_commit_sha : null,
          retired_ids: superseded.map((v) => v.id),
        },
      },
    });
    return c.json({
      ok: true,
      id,
      review_status: 'approved',
      approved_commit_sha: approved?.commitSha ?? null,
      repinned,
      retired_ids: superseded.map((v) => v.id),
    });
  });

  // GET /admin/listings/:id/review-diff — what an approval would change (P-008).
  // File-level diff of `<listing_ref>/` between the previously approved commit of
  // this (repo, kind, ref) and the pending row's pin. Blob shas are content
  // addresses, so added / removed / modified is exact without moving any bytes.
  // The first-ever version diffs against nothing (every file `added`).
  app.get('/admin/listings/:id/review-diff', async (c) => {
    const op = await requireOperator(c);
    if (op instanceof Response) return op;
    const id = c.req.param('id');
    const row = await getHarnessById(c.env.DB, id);
    if (!row || row.unlisted_at) return c.json({ error: 'not_found' }, 404);
    if (row.review_status !== 'pending') {
      return c.json({ error: 'not_pending', review_status: row.review_status }, 409);
    }
    if (!isSelfDescribingKind(row.listing_kind) || row.listing_ref == null) {
      return c.json({ error: 'not_self_describing', listing_kind: row.listing_kind }, 409);
    }
    if (row.pinned_commit_sha == null) {
      return c.json({ error: 'content_pin_required', reason: 'republish_required_before_review' }, 409);
    }
    const previous = await getPreviouslyApprovedVersion(
      c.env.DB,
      {
        github_repository_id: row.github_repository_id,
        listing_kind: row.listing_kind,
        listing_ref: row.listing_ref,
      },
      id,
    );
    const diff = await diffListingContent({
      token: extractBearer(c.req.raw),
      owner: row.github_owner,
      name: row.github_name,
      listingRef: row.listing_ref,
      toCommitSha: row.pinned_commit_sha,
      fromCommitSha: previous?.approved_commit_sha ?? previous?.pinned_commit_sha ?? null,
    });
    if (!diff.ok) {
      const refusal = pinRefusalToHttp(diff);
      return c.json(refusal.body, refusal.status);
    }
    return c.json({
      id,
      listing_kind: row.listing_kind,
      listing_ref: row.listing_ref,
      first_version: diff.fromCommitSha == null,
      from_commit_sha: diff.fromCommitSha,
      from_listing_id: previous?.id ?? null,
      to_commit_sha: diff.toCommitSha,
      files: diff.files,
      unchanged_count: diff.unchangedCount,
    });
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

  // ── Hash-chained ledgers (agent-economy-flywheel P-040) ──────────────────
  // GET  /admin/ledger-chain                       — verify every stream.
  // GET  /admin/ledger-chain/:stream/verify        — recompute one chain and
  //      report the first break; `?headSeq=&headHash=` additionally checks the
  //      chain still ends at a head the caller saved earlier (truncation).
  // GET  /admin/ledger-chain/:stream/export        — the stable JSONL export
  //      (@papercusp/hash-chain format), verifiable offline.
  // POST /admin/ledger-chain/:stream/witness       — chain rows a failed
  //      after-append witness pass left unchained.
  app.get('/admin/ledger-chain', async (c) => {
    const op = await requireOperator(c);
    if (op instanceof Response) return op;
    const streams = [];
    for (const streamId of LEDGER_STREAM_IDS) streams.push(await verifyLedgerStream(c.env.DB, streamId));
    return c.json({ ok: streams.every((s) => s.ok), streams });
  });

  app.get('/admin/ledger-chain/:stream/verify', async (c) => {
    const op = await requireOperator(c);
    if (op instanceof Response) return op;
    const streamId = c.req.param('stream');
    if (!isLedgerStreamId(streamId)) return c.json({ error: 'unknown_stream', streams: LEDGER_STREAM_IDS }, 404);
    const expectedHead = parseExpectedHead(new URL(c.req.url));
    if (expectedHead === 'invalid') return c.json({ error: 'invalid_field', field: 'headSeq/headHash' }, 400);
    const report = await verifyLedgerStream(c.env.DB, streamId, { expectedHead });
    return c.json(report);
  });

  app.get('/admin/ledger-chain/:stream/export', async (c) => {
    const op = await requireOperator(c);
    if (op instanceof Response) return op;
    const streamId = c.req.param('stream');
    if (!isLedgerStreamId(streamId)) return c.json({ error: 'unknown_stream', streams: LEDGER_STREAM_IDS }, 404);
    const body = await exportLedgerStream(c.env.DB, streamId);
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'content-disposition': `attachment; filename="${streamId}.chain.jsonl"`,
      },
    });
  });

  app.post('/admin/ledger-chain/:stream/witness', async (c) => {
    const op = await requireOperator(c);
    if (op instanceof Response) return op;
    const streamId = c.req.param('stream');
    if (!isLedgerStreamId(streamId)) return c.json({ error: 'unknown_stream', streams: LEDGER_STREAM_IDS }, 404);
    const now = Date.now();
    const result = await witnessLedgerStream(c.env.DB, streamId, now);
    await audit(c.env.DB, now, 'ledger_chain_witnessed', {
      stream_id: streamId,
      appended: result.appended,
      operator_github_user_id: op.id,
    });
    return c.json({ ok: true, ...result });
  });

  return app;
}
