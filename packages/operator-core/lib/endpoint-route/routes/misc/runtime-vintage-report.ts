/**
 * POST /api/internal/runtime-vintage — dependency-free boot self-report sink
 * (fleet-reliability-verification-2026-07-10 P-008).
 *
 * The watchdog scripts (inference-gateway/watchdog.mjs,
 * apps/operator/scripts/bghost-watchdog.mjs) run via plain `node` — no tsx,
 * no TS imports, deliberately dependency-free so they survive when the app/PG
 * is down (storage-policy's canonical "must be a file/process, not a TS
 * import" case). They cannot `import '../runtime-vintage'` directly, so this
 * route is the wiring seam: a plain fire-and-forget `fetch()` POST, mirroring
 * the self-poll they already do against their own `/stats` endpoint.
 *
 * `auth: 'loopback'` — no principal token (a watchdog holds none), but
 * rejects non-loopback hosts at the route-stack auth chokepoint. Never
 * blocks/affects the caller: always returns 200 even on a store failure
 * (best-effort ledger, not a critical path).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { reportRuntimeVintage } from '../../../runtime-vintage';

const bodySchema = z.object({
  unit: z.string().min(1).max(200),
  host: z.string().min(1).max(200).optional(),
  treeSha: z.string().min(1).max(200).nullable().optional(),
  buildTime: z.string().max(200).nullable().optional(),
  bundleVersion: z.string().max(200).nullable().optional(),
  pid: z.number().int().nullable().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
  workspaceId: z.string().max(200).optional(),
});

export default defineTool({
  method: 'POST',
  path: '/internal/runtime-vintage',
  auth: 'loopback',
  async handler(req) {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid json' }, { status: 400 });
    }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json({ ok: false, error: 'invalid body', issues: parsed.error.issues }, { status: 400 });
    }
    try {
      await reportRuntimeVintage(parsed.data);
      return Response.json({ ok: true });
    } catch (e) {
      // Best-effort ledger — a watchdog's self-report failing must never look
      // like an actionable error to the caller (it just fire-and-forgets).
      return Response.json({ ok: false, error: (e as Error)?.message ?? String(e) }, { status: 200 });
    }
  },
});
