/**
 * POST /api/user/memory/audit
 *
 * User-triggered Layer 1 anchor audit. Plan P-023.
 *
 * Default mode: smart-subset — runs the structural anchor check
 * against memories with anchors. Returns a report; writes flipped
 * `state` + per-anchor `last_check_ok` back to PG.
 *
 * `?full=1` is reserved for the Layer 3 LLM-validation path (deferred
 * to follow-up plan). The endpoint accepts the flag and returns a
 * token-cost estimate without running until that backend exists.
 *
 * Silent no-op when migration 085 hasn't been applied yet: returns
 * { ok: true, skipped: true, reason: 'migration_085_not_applied' }
 * so the UI can degrade gracefully.
 */
import * as path from 'node:path';
import { getSessionUserOrDefault } from '../../../auth';
import { defineTool } from '@papercusp/agent-mcp';
import { audit } from '../../../memory/audit-memory-anchors';
import { trackDetached } from '../../../detached-imports';

export default defineTool({
  method: 'POST',
  path: '/user/memory/audit',
  auth: 'loopback',
  timeoutSec: 120,
  async handler(req) {
    // Session is optional (single-user default fallback); the `loopback`
    // auth tier is the real gate. The audit itself is not per-user.
    await getSessionUserOrDefault(req.headers);

    let body: { full?: unknown; dryRun?: unknown } = {};
    try {
      body = (await req.json().catch(() => ({}))) as typeof body;
    } catch { /* empty body is fine */ }

    if (body.full === true) {
      // Layer 3 isn't wired yet. Return an estimate so the UI can
      // surface "≈X tokens, ~$Y" without running.
      return Response.json({
        ok: true,
        skipped: true,
        reason: 'full_audit_pending_layer_3',
        estimate: {
          // Rough order-of-magnitude. Real estimate plugs in once
          // Layer 3 ships.
          tokens: 10_000_000,
          dollars: 30,
          message: 'Layer 3 LLM validation is not yet wired. The smart-subset (Layer 1) audit runs without this flag.',
        },
      });
    }

    // Layer 1 audit. Reuse the CLI's audit() function — it handles
    // migration 085 absence by returning { skipped: true }.
    const dryRun = body.dryRun === true;
    // process.cwd() under `next dev` is apps/operator. Walk up two
    // levels (apps/operator → apps → repoRoot) to match what the CLI
    // computes via __dirname.
    const repoRoot = path.resolve(process.cwd(), '..', '..');
    let result: Awaited<ReturnType<typeof audit>>;
    try {
      result = await audit({ dryRun, repoRoot });
    } catch (err) {
      return Response.json(
        { error: 'audit_failed', message: (err as Error).message },
        { status: 500 },
      );
    }

    if (result.skipped) {
      return Response.json({
        ok: true,
        skipped: true,
        reason: 'migration_085_not_applied',
      });
    }
    // Audit flips canonical state/anchor rows the userMemory.list sync
    // query projects — refresh any open settings page (P-008).
    void trackDetached(import('../../../memory/invalidate-user-memory-views'))
      .then(({ invalidateUserMemoryViews }) => invalidateUserMemoryViews())
      .catch(() => { /* best-effort */ });
    return Response.json({
      ok: true,
      skipped: false,
      summary: result.summary,
    });
  },
});
