/**
 * POST /api/desktop/git/pot-green-cmd
 *
 * The /admin/git per-hive green-command EDIT (per-hive-git-and-release-gate-2026-06-29 P-014).
 * Sets (or clears) a hive's per-install green-command override — stored in hive_settings
 * (`release.greenCmd`, federated), which resolveHiveReleaseEnv reads at TOP precedence so the
 * gate actually runs the edited command (override > blueprint knob > detected testCommand >
 * build). A blank/absent greenCmd CLEARS the override (revert to the detected default).
 *
 * Body: { slug: string, greenCmd?: string }. Only a GATED, repo-backed, NON-operator-home
 * coding hive may be edited — the operator-home (papercusp) pipeline keeps its systemd-unit
 * env (regression-safe, D-007) and has no override. Status: 200 ok · 400 bad_request /
 * operator_home · 404 not_gated · 409 override_write_failed.
 *
 * SECURITY (CSRF): `auth:'loopback'` is source-IP based, so — like its destructive sibling
 * git/reset-to-remote-main — it also REJECTS cross-site browser requests (Sec-Fetch-Site:
 * cross-site) so a forged cross-origin POST cannot rewrite a hive's gate command.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { resolveHiveReleaseEnv } from '../../../harness/routines/hive-release-env';
import {
  setReleaseGreenCmdOverride,
  deleteReleaseGreenCmdOverride,
} from '../../../hive-settings-store';
import { activeWorkspaceId } from '../../../workspace-registry';

const JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json' };

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export default [
  defineTool({
    method: 'POST',
    path: '/desktop/git/pot-green-cmd',
    auth: 'loopback',
    async handler(req) {
      // CSRF guard: refuse a cross-site browser request before any side effect.
      if (req?.headers?.get?.('sec-fetch-site') === 'cross-site') {
        return json({ ok: false, error: 'cross_site_forbidden' }, 403);
      }
      let body: { slug?: string; greenCmd?: string } = {};
      try {
        body = (await req?.json?.()) ?? {};
      } catch {
        body = {};
      }
      const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
      if (!slug) return json({ ok: false, error: 'missing_slug' }, 400);

      // EI-14076: resolve the REQUEST's active workspace (x-papercusp-workspace header
      // -> ALS, per activeWorkspaceId()'s precedence) rather than hardcoding the
      // 'default' tenant — this route is called from the /admin/git UI inside a real
      // workspace session, and a hardcoded default silently reads/writes the WRONG
      // tenant's row on any box where the live pot is not literally workspace 'default'
      // (this box: 'papercusp-workspace'), while still returning a confident 200.
      const ws = activeWorkspaceId();
      // Only a gated, repo-backed, NON-home coding hive can carry an override.
      const env = await resolveHiveReleaseEnv(slug, ws);
      if (!env.enabled) return json({ ok: false, error: 'not_gated', reason: env.reason }, 404);
      if (env.isOperatorHome) return json({ ok: false, error: 'operator_home' }, 400);

      const raw = typeof body.greenCmd === 'string' ? body.greenCmd.trim() : '';
      try {
        if (raw.length > 0) await setReleaseGreenCmdOverride(ws, slug, raw);
        else await deleteReleaseGreenCmdOverride(ws, slug); // revert to the detected default
      } catch (e) {
        // e.g. the gated harness is a code MEMBER, not a hive home (P-017) — hive_settings
        // requires a hive. Surface it rather than 500 so the UI can explain.
        return json(
          { ok: false, error: 'override_write_failed', message: e instanceof Error ? e.message : String(e) },
          409,
        );
      }

      // Re-resolve so the response carries the effective command + override flag.
      const after = await resolveHiveReleaseEnv(slug, ws);
      return json(
        {
          ok: true,
          slug,
          greenCmd: after.greenCmd ?? null,
          greenCmdOverridden: after.greenCmdOverridden === true,
          cleared: raw.length === 0,
        },
        200,
      );
    },
  }),
];
