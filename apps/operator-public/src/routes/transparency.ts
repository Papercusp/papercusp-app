/**
 * Public transparency report (agent-economy-flywheel-2026-08-30 P-044, D-028).
 *
 * Operator pushes, HMAC-signed with the reconciliation secret:
 *   PUT TRANSPARENCY_LIVE_PATH       the hourly live report (open month, provisional)
 *   PUT TRANSPARENCY_STATEMENT_PATH  a signed monthly statement; the Worker checks its
 *                                    digest and EIP-191 signature, then stores it
 *                                    IMMUTABLY (first publication wins, 409 on drift)
 *   PUT TRANSPARENCY_ATTESTATION_PATH an outside accountant's attestation record of a
 *                                    published statement (P-047, D-031), with its
 *                                    anchored inclusion proof once one exists. The
 *                                    record must name the published statement's
 *                                    digest; the proof is checked offline. Both are
 *                                    kept as first stored (record 409 on drift).
 * Public reads, no auth:
 *   GET /transparency/:workspaceId                     live report + statement index,
 *                                                      each month with its attestation status
 *   GET /transparency/:workspaceId/statements/:month   one signed statement
 *   GET /transparency/:workspaceId/attestations/:month/:documentSha256/proof
 *                                                      one attestation's inclusion proof
 */
import { Hono } from 'hono';
import {
  RECONCILIATION_SIGNATURE_HEADER,
  RECONCILIATION_SIGNATURE_TOLERANCE_MS,
  TRANSPARENCY_ATTESTATION_PATH,
  TRANSPARENCY_LIVE_PATH,
  TRANSPARENCY_STATEMENT_PATH,
  verifyReconciliationRequest,
} from '@papercusp/operator-core/lib/cupboard/reconciliation-hmac.ts';
import {
  parseStatementAttestationPush,
  publicAttestationSummary,
  statementAttestationProofProblem,
  type PublicAttestationStatus,
} from '@papercusp/operator-core/lib/cupboard/statement-attestation-push.ts';
import {
  parseLiveTransparencyPush,
  parseSignedStatement,
  verifySignedStatement,
} from '@papercusp/operator-core/lib/cupboard/transparency-statement.ts';
import type { Env } from '../env.ts';
import {
  listAttestations,
  listStatements,
  publishStatement,
  publishedStatementDigest,
  readAttestationProof,
  readLiveReport,
  readStatement,
  recordAttestation,
  recordLiveReport,
  type StoredAttestation,
} from '../transparency-store.ts';

const MONTH = /^\d{4}-\d{2}$/;
const HEX64 = /^[0-9a-f]{64}$/;

const NOT_ATTESTED: PublicAttestationStatus = { status: 'not-attested' };

function attestationStatus(stored: readonly StoredAttestation[] | undefined, statementDigest: string): PublicAttestationStatus {
  // Only records of the statement readers see count; the PUT route refuses any other.
  const mine = (stored ?? []).filter((s) => s.record.statementDigest === statementDigest);
  return mine.length === 0 ? NOT_ATTESTED : { status: 'attested', attestations: mine.map((s) => publicAttestationSummary(s.record, s.hasProof)) };
}

export function transparencyRoute(options: { now?: () => number } = {}): Hono<{ Bindings: Env }> {
  const route = new Hono<{ Bindings: Env }>();
  const now = options.now ?? Date.now;

  /** Verify the operator's HMAC, then hand back the parsed JSON body (or a response to return). */
  async function signedJson(c: { env: Env; req: { text(): Promise<string>; header(name: string): string | undefined } }, pathname: string) {
    const body = await c.req.text();
    const verdict = await verifyReconciliationRequest({
      secret: c.env.RECONCILIATION_GATE_SECRET,
      header: c.req.header(RECONCILIATION_SIGNATURE_HEADER),
      method: 'PUT',
      pathname,
      body,
      nowMs: now(),
    });
    if (!verdict.ok) {
      return verdict.reason === 'not-configured'
        ? ({ error: { error: 'not_configured', detail: 'RECONCILIATION_GATE_SECRET is not configured' }, status: 503 } as const)
        : ({ error: { error: 'unauthorized', reason: verdict.reason }, status: 401 } as const);
    }
    try {
      return { json: JSON.parse(body) as unknown };
    } catch {
      return { error: { error: 'invalid_request', detail: 'body is not JSON' }, status: 400 } as const;
    }
  }

  route.put(TRANSPARENCY_LIVE_PATH, async (c) => {
    const r = await signedJson(c, TRANSPARENCY_LIVE_PATH);
    if ('error' in r) return c.json(r.error, r.status);
    const push = parseLiveTransparencyPush(r.json);
    if (!push) return c.json({ error: 'invalid_request', detail: 'not a live transparency push' }, 400);
    const nowMs = now();
    if (push.generatedAtMs > nowMs + RECONCILIATION_SIGNATURE_TOLERANCE_MS) {
      return c.json({ error: 'invalid_request', detail: 'generatedAtMs is in the future' }, 400);
    }
    const stored = await recordLiveReport(c.env.DB, push, nowMs);
    return c.json({ ok: true, stored });
  });

  route.put(TRANSPARENCY_STATEMENT_PATH, async (c) => {
    const r = await signedJson(c, TRANSPARENCY_STATEMENT_PATH);
    if ('error' in r) return c.json(r.error, r.status);
    const signed = parseSignedStatement(r.json);
    if (!signed) return c.json({ error: 'invalid_request', detail: 'not a signed monthly statement' }, 400);
    const check = await verifySignedStatement(signed);
    if (!check.ok) return c.json({ error: 'invalid_statement', detail: check.reason }, 400);
    const write = await publishStatement(c.env.DB, signed, now());
    if (typeof write === 'object') {
      return c.json({ error: 'statement_exists', detail: `month ${signed.statement.report.month} is already published with digest ${write.conflict}` }, 409);
    }
    return c.json({ ok: true, published: write, digest: signed.digest });
  });

  route.put(TRANSPARENCY_ATTESTATION_PATH, async (c) => {
    const r = await signedJson(c, TRANSPARENCY_ATTESTATION_PATH);
    if ('error' in r) return c.json(r.error, r.status);
    const push = parseStatementAttestationPush(r.json);
    if (!push) return c.json({ error: 'invalid_request', detail: 'not a statement attestation push' }, 400);
    const { attestation, proof } = push;
    const published = await publishedStatementDigest(c.env.DB, push.workspaceId, attestation.month);
    if (published === null) {
      return c.json({ error: 'statement_not_published', detail: `no statement is published for ${attestation.month}` }, 409);
    }
    if (published !== attestation.statementDigest) {
      return c.json(
        { error: 'statement_digest_mismatch', detail: `the record attests ${attestation.statementDigest}; the published ${attestation.month} statement is ${published}` },
        409,
      );
    }
    if (proof) {
      const problem = await statementAttestationProofProblem(attestation, proof);
      if (problem) return c.json({ error: 'invalid_proof', detail: problem }, 400);
    }
    const write = await recordAttestation(c.env.DB, attestation, proof, now());
    if (typeof write === 'object') return c.json({ error: 'attestation_exists', detail: write.conflict }, 409);
    return c.json({ ok: true, published: write });
  });

  route.get('/transparency/:workspaceId', async (c) => {
    const workspaceId = c.req.param('workspaceId');
    const [live, listed, attestations] = await Promise.all([
      readLiveReport(c.env.DB, workspaceId),
      listStatements(c.env.DB, workspaceId),
      listAttestations(c.env.DB, workspaceId),
    ]);
    if (!live && listed.length === 0) return c.json({ error: 'not_found', detail: `no transparency report for '${workspaceId}'` }, 404);
    // Beside each published month: whether an outside accountant attested it, who, against what, and the proof.
    const statements = listed.map((s) => ({ ...s, attestation: attestationStatus(attestations.get(s.month), s.digest) }));
    return c.json({ workspaceId, live, statements });
  });

  route.get('/transparency/:workspaceId/attestations/:month/:documentSha256/proof', async (c) => {
    const month = c.req.param('month');
    const documentSha256 = c.req.param('documentSha256');
    if (!MONTH.test(month) || !HEX64.test(documentSha256)) {
      return c.json({ error: 'invalid_request', detail: 'month is YYYY-MM and documentSha256 is 64 lowercase hex' }, 400);
    }
    const proof = await readAttestationProof(c.env.DB, c.req.param('workspaceId'), month, documentSha256);
    return proof ? c.json(proof) : c.json({ error: 'not_found', detail: `no anchored attestation proof for ${month} ${documentSha256}` }, 404);
  });

  route.get('/transparency/:workspaceId/statements/:month', async (c) => {
    const month = c.req.param('month');
    if (!MONTH.test(month)) return c.json({ error: 'invalid_request', detail: 'month is YYYY-MM' }, 400);
    const signed = await readStatement(c.env.DB, c.req.param('workspaceId'), month);
    return signed ? c.json(signed) : c.json({ error: 'not_found', detail: `no statement for ${month}` }, 404);
  });

  return route;
}
