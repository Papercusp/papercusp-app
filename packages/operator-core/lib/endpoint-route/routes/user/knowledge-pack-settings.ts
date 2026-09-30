/**
 * /api/user/knowledge-pack-settings — the "Fleet knowledge packs" section of
 * the memory settings page (knowledge-pack-settings-2026-07-19 P-004).
 *
 * GET returns the STORED settings (the user's overrides), the RESOLVED knobs
 * (stored → env → default, what the routines will actually use next tick),
 * the baked defaults (for placeholders), and the two routines' live cadence
 * (preset + cron + active + nextFireAt).
 *
 * POST accepts a partial settings patch (null clears a field back to
 * env/default). Cadence presets are additionally APPLIED to the
 * harness_shared.routines rows (same columns routines:set mutates —
 * trigger_config.cron + active + recomputed next_fire_at); 'paused' flips
 * active=false and keeps the cron. Everything else takes effect on the next
 * routine tick with no restart.
 *
 * Auth tier (auth-tier Wave 1, standing gate): GET is `auth: 'public'` — same
 * single-user-install semantics as the sibling /user/memory GET (the desktop
 * webview typically carries no session cookie; a strict 401 would blank the
 * settings section). POST is `auth: 'loopback'`, matching the sibling
 * /user/memory MUTATING routes (POST/PUT/DELETE) — a mutating route stays
 * loopback-or-better unless the owner has explicitly ratified it as a named
 * remote exception (apps/operator/docs/auth-tier-rollout-2026-06-10.md); this
 * route doesn't need remote-mutate reachability, so it takes the default.
 */
import { defineTool } from '@papercusp/agent-mcp';
import {
  DEFAULT_KNOWLEDGE_PACK_KNOBS,
  applyKnowledgePackCadence,
  knowledgePackSettingsPatchSchema,
  readKnowledgePackCadence,
  readKnowledgePackSettings,
  resolveKnowledgePackKnobs,
  writeKnowledgePackSettings,
} from '../../../knowledge-packs/config';

async function envelope(): Promise<Response> {
  const [settings, knobs, cadence] = await Promise.all([
    readKnowledgePackSettings(),
    resolveKnowledgePackKnobs(),
    readKnowledgePackCadence().catch(() => null),
  ]);
  return Response.json({
    settings,
    resolved: knobs,
    defaults: DEFAULT_KNOWLEDGE_PACK_KNOBS,
    cadence,
  });
}

const get = defineTool({
  method: 'GET',
  path: '/user/knowledge-pack-settings',
  auth: 'public',
  async handler() {
    return envelope();
  },
});

const set = defineTool({
  method: 'POST',
  path: '/user/knowledge-pack-settings',
  auth: 'loopback',
  async handler(req) {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
    }
    const parsed = knowledgePackSettingsPatchSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { ok: false, error: `invalid settings patch: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` },
        { status: 400 },
      );
    }
    const patch = parsed.data;
    await writeKnowledgePackSettings(patch);
    // Cadence presets ALSO drive the routine rows. A null (cleared) cadence
    // does not touch the rows — the current schedule simply stays as-is.
    await applyKnowledgePackCadence({
      ...(typeof patch.deliveryCadence === 'string' ? { deliveryCadence: patch.deliveryCadence } : {}),
      ...(typeof patch.hygieneCadence === 'string' ? { hygieneCadence: patch.hygieneCadence } : {}),
    });
    return envelope();
  },
});

export default [get, set];
