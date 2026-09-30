/**
 * POST /api/su-locks/foreign-guard — the worktree-guard's FOREIGN-WORKSPACE
 * policy verdict (p2p-work-distribution-2026-07-02 P-109 leg i, design §2).
 *
 * Called by the PreToolUse hook (pretooluse-locks-acquire.sh) in two modes:
 *   { roots_only: true }                    → just the live foreign roots
 *                                             (the hook's 30s host-direction
 *                                             cache refresh);
 *   { paths, offer_id?, session_id? }       → an authoritative allow/deny for
 *                                             one edit batch. offer_id/
 *                                             session_id are the P-104
 *                                             spawn-injected foreign-session
 *                                             env (PAPERCUSP_FOREIGN_OFFER_ID /
 *                                             PAPERCUSP_FOREIGN_SESSION_ID) —
 *                                             never trusted alone: verified
 *                                             against the registry row.
 *
 * The POLICY lives in lib/p2p/foreign-guard.ts (pure, unit-tested); this
 * route adds the P-004 counter bump on deny. FAIL POSTURE is the CALLER'S:
 * on an unreachable route the hook fails CLOSED for foreign-marked sessions
 * and OPEN for host sessions (matching its global posture — containment is
 * P-105's job, this is the honest-path policy).
 *
 * auth 'loopback' — the hook is always on-host (the p2p-settings-set
 * posture); the verdict is derived from local registry state and the only
 * write is a refusal counter.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { evaluateForeignGuard } from '../../../p2p/foreign-guard';
import { bumpRefusedOpCounter } from '../../../p2p/receipts';

interface Body {
  paths?: unknown;
  offer_id?: unknown;
  session_id?: unknown;
  roots_only?: unknown;
}

export default defineTool({
  method: 'POST',
  path: '/su-locks/foreign-guard',
  auth: 'loopback',
  async handler(req) {
    let b: Body;
    try {
      b = (await req.json()) as Body;
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }
    const paths = Array.isArray(b.paths) ? b.paths.filter((p): p is string => typeof p === 'string') : [];
    const offerId = typeof b.offer_id === 'string' && b.offer_id ? b.offer_id : null;
    const sessionId = typeof b.session_id === 'string' && b.session_id ? b.session_id : null;

    const verdict = await evaluateForeignGuard({
      paths: b.roots_only === true ? [] : paths,
      offerId,
      sessionId,
    });

    if (verdict.decision === 'deny') {
      // P-004 counter (M15: guard denials are counter-class, not per-event
      // receipts — the deny REASON is already loud in the hook's output).
      try {
        await bumpRefusedOpCounter({
          workspaceId: verdict.workspaceId ?? 'unknown',
          potSlug: verdict.fleetSlug ?? 'unknown',
          reason: verdict.refusalCode,
        });
      } catch {
        // Counter failure never changes the verdict.
      }
      return Response.json({
        ok: true,
        decision: 'deny',
        reason: verdict.reason,
        refusal_code: verdict.refusalCode,
        roots: verdict.roots,
      });
    }
    return Response.json({ ok: true, decision: 'allow', roots: verdict.roots });
  },
});
