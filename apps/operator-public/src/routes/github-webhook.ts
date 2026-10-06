/**
 * `POST /github/webhook` — the "Papercusp Cupboard" GitHub App's push receiver
 * (cupboard-release-pipeline-content-trust-2026-09-16 P-006, SPEC-P-006 / -006b).
 *
 * What a push means here: a listed repo's default branch moved. The reviewed
 * identity of every listing it holds is `pinned_commit_sha` (P-001/P-008), and
 * install serves THAT — so a push can never change what users receive. The only
 * thing this route does to a listing is raise `drift` (browse shows "newer
 * unverified version available"); the pin moves only through the admin approve
 * path. It also scans the pushed tree with the same gate publish uses and posts
 * the verdict as a Check Run, so the publisher sees a refusal in their own repo
 * before a reviewer ever does.
 *
 * Fail-closed order, deliberately: unconfigured → 503 BEFORE the body is read;
 * unauthenticated → 401 BEFORE any listing is read or written. A delivery this
 * Worker cannot authenticate is never acted on.
 */

import { Hono } from 'hono';
import type { Env } from '../env.ts';
import { listActiveListingsByGithubRepoId, setListingDrift } from '../db.ts';
import { COMMIT_SHA_RE, SELF_DESCRIBING_KINDS, pinListingContent, type ContentPinRefusal } from '../content-pin.ts';
import { mintInstallationToken, postCheckRun, verifyWebhookSignature } from '../github-app.ts';

/** GitHub sends `0000…` as `after` when a ref is deleted. */
const ZERO_SHA_RE = /^0+$/;

interface PushPayload {
  ref?: unknown;
  after?: unknown;
  deleted?: unknown;
  repository?: { id?: unknown; default_branch?: unknown } | null;
  installation?: { id?: unknown } | null;
}

type CheckConclusion = 'success' | 'failure' | 'neutral';

interface Verdict {
  conclusion: CheckConclusion;
  /** `pass` or the refusal code — never a matched value. */
  verdict: string;
  title: string;
  summary: string;
}

/** Codes where GitHub, not the package, is why we could not verify. A check that
 *  FAILS the publisher for our inability to read their repo would be a lie. */
const UNVERIFIABLE_CODES = new Set<ContentPinRefusal['code']>(['github_tree_unreachable', 'github_blob_unreachable']);

function describeRefusal(refusal: ContentPinRefusal): Verdict {
  const conclusion: CheckConclusion = UNVERIFIABLE_CODES.has(refusal.code) ? 'neutral' : 'failure';
  let summary: string;
  switch (refusal.code) {
    case 'identity_leak':
      // Path, pattern kind, and count only — the matched text is the secret.
      summary =
        'Publishing this package would leak workspace identity. Files:\n' +
        refusal.hits.map((hit) => `- \`${hit.path}\` — ${hit.pattern} ×${hit.occurrences}`).join('\n');
      break;
    case 'listing_ref_missing':
      summary = 'The listing path no longer exists at this commit, so there is nothing to pin.';
      break;
    case 'tree_truncated':
      summary = 'GitHub truncated the repository tree, so the package directory cannot be fully verified.';
      break;
    case 'listing_ref_too_large':
      summary = `The package has ${refusal.fileCount} files / ${refusal.byteCount} bytes, over the ${refusal.fileBudget} file / ${refusal.byteBudget} byte budget.`;
      break;
    case 'github_tree_unreachable':
    case 'github_blob_unreachable':
      summary = `GitHub did not return the package contents (HTTP ${refusal.status}); it could not be verified.`;
      break;
  }
  return { conclusion, verdict: refusal.code, title: `Not verified: ${refusal.code}`, summary };
}

export interface GithubWebhookRouteOptions {
  fetchImpl?: typeof fetch;
  /** Injected clock (seconds) for the App JWT; defaults to wall time. */
  nowSec?: () => number;
}

export function githubWebhookRoute(options: GithubWebhookRouteOptions = {}): Hono<{ Bindings: Env }> {
  const route = new Hono<{ Bindings: Env }>();

  route.post('/github/webhook', async (c) => {
    const { GITHUB_APP_ID: appId, GITHUB_APP_PRIVATE_KEY: privateKeyPem, GITHUB_APP_WEBHOOK_SECRET: secret } = c.env;
    if (!appId || !privateKeyPem || !secret) return c.json({ error: 'app_not_configured' }, 503);

    // The signature is over the RAW bytes — verify before parsing anything.
    const raw = await c.req.text();
    if (!(await verifyWebhookSignature(secret, raw, c.req.header('x-hub-signature-256') ?? null))) {
      return c.json({ error: 'bad_signature' }, 401);
    }

    const event = c.req.header('x-github-event');
    if (event === 'ping') return c.json({ ok: true, event: 'ping' });
    if (event !== 'push') return c.json({ ok: true, ignored: 'event_not_handled', event: event ?? null }, 202);

    let payload: PushPayload;
    try {
      payload = JSON.parse(raw) as PushPayload;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    const repoId = payload.repository?.id;
    const defaultBranch = payload.repository?.default_branch;
    if (typeof repoId !== 'number' || !Number.isSafeInteger(repoId) || typeof defaultBranch !== 'string' || defaultBranch === '') {
      return c.json({ error: 'invalid_payload' }, 400);
    }
    // Only the default branch is what a listing is published from.
    if (payload.ref !== `refs/heads/${defaultBranch}`) return c.json({ ok: true, ignored: 'not_default_branch' }, 202);

    const after = payload.after;
    if (payload.deleted === true || (typeof after === 'string' && ZERO_SHA_RE.test(after))) {
      return c.json({ ok: true, ignored: 'ref_deleted' }, 202);
    }
    if (typeof after !== 'string' || !COMMIT_SHA_RE.test(after)) return c.json({ error: 'invalid_commit_sha' }, 400);

    // A self-describing listing always has a ref; a row without one has nothing
    // to pin, so it is not a candidate (and the filter narrows the type).
    const listings = (await listActiveListingsByGithubRepoId(c.env.DB, repoId, SELF_DESCRIBING_KINDS)).filter(
      (row): row is typeof row & { listing_ref: string } => typeof row.listing_ref === 'string',
    );
    if (listings.length === 0) return c.json({ ok: true, ignored: 'no_active_listing' }, 202);

    // Drift is a pure comparison of two SHAs — it needs no GitHub call, so record
    // it BEFORE anything that can fail. GitHub does not redeliver on a 5xx, and a
    // flag that depended on minting a token would be lost with the delivery.
    // It is monotone on purpose: a push to the pinned commit never CLEARS drift
    // (deliveries can arrive out of order, so a late "old" push must not hide a
    // newer one); only the admin approve path resets it.
    const drifted = listings.filter((row) => row.pinned_commit_sha !== after);
    for (const row of drifted) await setListingDrift(c.env.DB, row.id, true);
    const driftedIds = new Set(drifted.map((row) => row.id));

    const installationId = payload.installation?.id;
    if (typeof installationId !== 'number' || !Number.isSafeInteger(installationId)) {
      return c.json({ error: 'missing_installation', drifted: drifted.length }, 400);
    }
    const nowSec = options.nowSec ?? (() => Math.floor(Date.now() / 1000));
    let token: string;
    try {
      const minted = await mintInstallationToken({
        appId,
        privateKeyPem,
        installationId,
        nowSec: nowSec(),
        fetchImpl: options.fetchImpl,
      });
      if (!minted.ok) return c.json({ error: 'installation_token_unavailable', status: minted.status, drifted: drifted.length }, 502);
      token = minted.token;
    } catch {
      // A malformed GITHUB_APP_PRIVATE_KEY lands here; say so without echoing it.
      return c.json({ error: 'installation_token_unavailable', drifted: drifted.length }, 502);
    }

    const results: Array<Record<string, unknown>> = [];
    for (const row of listings) {
      let outcome: Verdict;
      try {
        const pinned = await pinListingContent({
          token,
          owner: row.github_owner,
          name: row.github_name,
          defaultBranch,
          listingRef: row.listing_ref,
          commitSha: after,
          fetchImpl: options.fetchImpl,
        });
        outcome = pinned.ok
          ? {
              conclusion: 'success',
              verdict: 'pass',
              title: 'Verified',
              summary: `${pinned.fileCount} files (${pinned.byteCount} bytes) at ${after.slice(0, 12)} pass the Cupboard content gate. This is a newer version than the one reviewed; it is not served until it is approved.`,
            }
          : describeRefusal(pinned);
      } catch {
        outcome = {
          conclusion: 'neutral',
          verdict: 'scan_error',
          title: 'Not verified: scan_error',
          summary: 'The content scan could not complete; it will be retried on the next push.',
        };
      }
      const check = await postCheckRun({
        token,
        owner: row.github_owner,
        name: row.github_name,
        headSha: after,
        checkName: `Papercusp Cupboard: ${row.listing_kind}/${row.listing_ref}`,
        conclusion: outcome.conclusion,
        title: outcome.title,
        summary: outcome.summary,
        fetchImpl: options.fetchImpl,
      }).catch(() => ({ ok: false, status: 0 }));
      results.push({
        listing_id: row.id,
        listing_kind: row.listing_kind,
        listing_ref: row.listing_ref,
        verdict: outcome.verdict,
        drift: driftedIds.has(row.id),
        check_run: { ok: check.ok, status: check.status },
      });
    }
    return c.json({ ok: true, commit_sha: after, results });
  });

  return route;
}
