/**
 * The operator's reconciliation run talks to this Worker through two
 * machine-to-machine routes (agent-economy-flywheel-2026-08-30 P-043, D-025 §4):
 *
 *   PUT /commerce/treasury/transfer-gate         the run pushes its verdict
 *   GET /commerce/treasury/reconciliation-inputs the run reads credits + DAO transfers
 *
 * Both carry an HMAC over RECONCILIATION_GATE_SECRET instead of a GitHub bearer
 * (`reconciliation-hmac.ts`). The signature covers the method and the route
 * path, so a captured gate push cannot be replayed as an inputs read or the
 * reverse. Without the secret both routes answer 503 and no gate can be pushed,
 * which keeps the treasury door closed.
 */
import { Hono } from 'hono';
import {
  LEDGER_CHAIN_LINKS_PATH,
  RECONCILIATION_INPUTS_PATH,
  RECONCILIATION_SIGNATURE_HEADER,
  RECONCILIATION_SIGNATURE_TOLERANCE_MS,
  TRANSFER_GATE_PATH,
  parseTransferGatePush,
  verifyReconciliationRequest,
} from '@papercusp/operator-core/lib/cupboard/reconciliation-hmac.ts';
import type { Env } from '../env.ts';
import { CHAIN_LINK_PAGE_MAX, listChainLinksPage, parseChainLinkCursor } from '../ledger-chain-store.ts';
import { readReconciliationInputs, recordTransferGate, transferGateVerdict } from '../transfer-gate-store.ts';

export function reconciliationRoute(options: { now?: () => number } = {}): Hono<{ Bindings: Env }> {
  const route = new Hono<{ Bindings: Env }>();
  const now = options.now ?? Date.now;

  route.put(TRANSFER_GATE_PATH, async (c) => {
    const body = await c.req.text();
    const nowMs = now();
    const verdict = await verifyReconciliationRequest({
      secret: c.env.RECONCILIATION_GATE_SECRET,
      header: c.req.header(RECONCILIATION_SIGNATURE_HEADER),
      method: 'PUT',
      pathname: TRANSFER_GATE_PATH,
      body,
      nowMs,
    });
    if (!verdict.ok) {
      return verdict.reason === 'not-configured'
        ? c.json({ error: 'not_configured', detail: 'RECONCILIATION_GATE_SECRET is not configured' }, 503)
        : c.json({ error: 'unauthorized', reason: verdict.reason }, 401);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      return c.json({ error: 'invalid_request', detail: 'body is not JSON' }, 400);
    }
    const push = parseTransferGatePush(raw);
    if (!push) return c.json({ error: 'invalid_request', detail: 'not a transfer-gate push' }, 400);
    // A gate dated in the future would never go stale, and the monotonic upsert
    // would then refuse every later push: one skewed clock could pin the gate
    // open. Allow the same skew the signature tolerates, no more.
    if (push.atMs > nowMs + RECONCILIATION_SIGNATURE_TOLERANCE_MS) {
      return c.json({ error: 'invalid_request', detail: 'atMs is in the future' }, 400);
    }
    const written = await recordTransferGate(c.env.DB, push, nowMs);
    return c.json(
      {
        applied: written.applied,
        gate: written.gate,
        // What the treasury door would decide right now, for this Worker's governing workspace.
        transfers: (await transferGateVerdict(c.env.DB, c.env.RECONCILIATION_GATE_WORKSPACE, nowMs)).open ? 'open' : 'paused',
      },
      200,
    );
  });

  route.get(RECONCILIATION_INPUTS_PATH, async (c) => {
    const nowMs = now();
    const verdict = await verifyReconciliationRequest({
      secret: c.env.RECONCILIATION_GATE_SECRET,
      header: c.req.header(RECONCILIATION_SIGNATURE_HEADER),
      method: 'GET',
      pathname: RECONCILIATION_INPUTS_PATH,
      body: '',
      nowMs,
    });
    if (!verdict.ok) {
      return verdict.reason === 'not-configured'
        ? c.json({ error: 'not_configured', detail: 'RECONCILIATION_GATE_SECRET is not configured' }, 503)
        : c.json({ error: 'unauthorized', reason: verdict.reason }, 401);
    }
    return c.json(await readReconciliationInputs(c.env.DB, nowMs), 200);
  });

  // D-027: the chain links the operator anchors for the governing workspace.
  // The signed "pathname" is path + query, so a signature is bound to its page.
  route.get(LEDGER_CHAIN_LINKS_PATH, async (c) => {
    const url = new URL(c.req.url);
    const verdict = await verifyReconciliationRequest({
      secret: c.env.RECONCILIATION_GATE_SECRET,
      header: c.req.header(RECONCILIATION_SIGNATURE_HEADER),
      method: 'GET',
      pathname: `${url.pathname}${url.search}`,
      body: '',
      nowMs: now(),
    });
    if (!verdict.ok) {
      return verdict.reason === 'not-configured'
        ? c.json({ error: 'not_configured', detail: 'RECONCILIATION_GATE_SECRET is not configured' }, 503)
        : c.json({ error: 'unauthorized', reason: verdict.reason }, 401);
    }
    const workspaceId = c.env.RECONCILIATION_GATE_WORKSPACE?.trim() || null;
    // No governing workspace: the links belong to no operator log, so hand out none.
    if (!workspaceId) return c.json({ workspaceId: null, links: [], nextCursor: null }, 200);
    const afterRaw = url.searchParams.get('after');
    const after = afterRaw ? parseChainLinkCursor(afterRaw) : null;
    if (afterRaw && !after) return c.json({ error: 'invalid_request', detail: 'malformed cursor' }, 400);
    const limitRaw = url.searchParams.get('limit');
    const limit = limitRaw === null ? CHAIN_LINK_PAGE_MAX : Number(limitRaw);
    if (!Number.isSafeInteger(limit) || limit < 1) return c.json({ error: 'invalid_request', detail: 'limit must be a positive integer' }, 400);
    const page = await listChainLinksPage(c.env.DB, { after, limit });
    return c.json({ workspaceId, links: page.links, nextCursor: page.nextCursor }, 200);
  });

  return route;
}
