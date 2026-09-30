/**
 * Single-user host detection.
 *
 *   GET  /api/provision/host-check — { decision, signals }, or a sandbox
 *     smoke test when `?smokeTest=1`.
 *   POST /api/provision/host-check — record the user's acknowledgement
 *     for the current host signature.
 *
 * Ported from app/api/provision/host-check/route.ts at `auth: 'public'`
 * (the route's original posture), then DELIBERATELY tightened to
 * `{trust:['verified','trusted']}` by the D3 auth-tightening pass
 * (621bdb713, 2026-05-20) along with the rest of `provision/*` — a
 * cookie-less/unverified caller (a malicious page via DNS-rebinding)
 * would otherwise be able to read `signals` (OS usernames on the box)
 * or POST an acknowledgement on the user's behalf. This is current,
 * correct, INTENTIONAL policy — not drift; do not revert to 'public'.
 *
 * A benign client-side race that can make a verified caller (the
 * desktop webview) transiently look unverified and 403 here — NOT an
 * auth-policy issue — is documented + fixed at the call site:
 * apps/operator/app/_components/HostCheckBanner.tsx.
 *
 * Spec: /docs/snapshots/build-scripts#single-user-host-detection.
 */
import { decideGate, detectSharedHost, writeAcknowledgement } from '../../../provision/single-user';
import { smokeTestSandbox } from '../../../provision/sandbox';
import { defineTool } from '@papercusp/agent-mcp';

const get = defineTool({
  method: 'GET',
  path: '/provision/host-check',
  auth: { trust: ['verified', 'trusted'] },
  async handler(req) {
    const url = new URL(req.url);
    if (url.searchParams.get('smokeTest') === '1') {
      const result = await smokeTestSandbox();
      return Response.json({ ok: true, smokeTest: result });
    }
    const r = await decideGate();
    return Response.json({ ok: true, ...r });
  },
});

const post = defineTool({
  method: 'POST',
  path: '/provision/host-check',
  auth: { trust: ['verified', 'trusted'] },
  async handler(req) {
    let body: { acknowledge?: boolean };
    try {
      body = (await req.json()) as { acknowledge?: boolean };
    } catch {
      return Response.json({ ok: false, error: 'invalid json' }, { status: 400 });
    }
    if (!body.acknowledge) {
      return Response.json({ ok: false, error: 'acknowledge: true required' }, { status: 400 });
    }
    const signals = await detectSharedHost();
    await writeAcknowledgement(signals);
    return Response.json({ ok: true });
  },
});

export default [get, post];
