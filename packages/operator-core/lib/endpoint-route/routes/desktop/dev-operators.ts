/**
 * /api/desktop/dev-operators  — the env switcher's data + control plane.
 *
 *   GET  /api/desktop/dev-operators            list envs (dev/prod/staging/local +
 *                                              release) with server-side reachability,
 *                                              which is active (self), and `enabled`.
 *   POST /api/desktop/dev-operators/set-enabled { id, enabled } — toggle whether an env
 *                                              is provisioned/started (D-007). 'release'
 *                                              can never be disabled.
 *
 * (dogfood-silent-canonical-hive-join P-013/P-014/P-017, D-006/D-007/D-008.)
 *
 * Reachability is probed server-side (operator → localhost) because a webview on one
 * origin can't cross-origin fetch a sibling operator's /version (CORS); the switch
 * itself is a top-level window.location navigation (not CORS-bound).
 *
 * AGENT-LEGIBILITY: the enabled-state lives in a known file (env-switcher-prefs), is
 * reported here per-op (`enabled`), and is toggled by this POST — so an agent can read
 * which envs are off and re-enable them via the same loopback API the UI uses. See
 * agent-insights/env-switcher-and-local-env-provisioning.
 *
 * The SOURCE-TREE axis is legible the same way (EI-19421499550693822). dev/local are
 * omitted from `operators` entirely where no runnable tree exists (the WI-3284 grey-button
 * fix — deliberate, and unchanged here), which used to make an absent `dev` ambiguous
 * between "no source shipped (expected)" and "a shipped archive failed to extract (a
 * bug)". `sourceTree` and `omitted` report that axis explicitly, using the launcher's own
 * `SkipReason` vocabulary, so a packaged-build acceptance check is one curl instead of an
 * SSH plus a `[dev-source]` log grep. Neither field is rendered by the switcher bar.
 *
 * auth: GET {} (the cookie-less desktop-webview read posture, like setup-wizard-state).
 * POST 'loopback' + a cross-site CSRF guard (it mutates a preference) — mirrors
 * git-remote-main / bootstrap-pot-start.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { resolveDevOperators } from '../../../harness/dev-operators';
import { readEnvSwitcherPrefs, setEnvEnabled } from '../../../harness/env-switcher-prefs';
import { isVmReleaseDistribution } from '../../../vm-release-runtime-policy';

const JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json' };
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export default [
  defineTool({
    method: 'GET',
    path: '/desktop/dev-operators',
    auth: {},
    async handler() {
      const { disabled } = readEnvSwitcherPrefs();
      const { operators, selfPort, sourceTree, omitted } = await resolveDevOperators({
        disabledIds: disabled,
      });
      // `sourceTree` + `omitted` are DIAGNOSTIC — the switcher bar renders neither; they
      // exist so a machine reader can tell an expected omission from a broken one
      // (EI-19421499550693822). See the AGENT-LEGIBILITY note above.
      return new Response(JSON.stringify({ ok: true, operators, selfPort, sourceTree, omitted }), {
        headers: { ...JSON_HEADERS, ...CORS_HEADERS },
      });
    },
  }),
  defineTool({
    method: 'OPTIONS',
    path: '/desktop/dev-operators',
    auth: {},
    handler() {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    },
  }),
  defineTool({
    method: 'POST',
    path: '/desktop/dev-operators/set-enabled',
    auth: 'loopback',
    async handler(req) {
      if (isVmReleaseDistribution()) {
        return new Response(JSON.stringify({ ok: false, error: 'vm_release_immutable' }), {
          status: 403,
          headers: JSON_HEADERS,
        });
      }
      // CSRF guard: refuse a cross-site browser request before any write.
      const site = req?.headers?.get?.('sec-fetch-site');
      if (site === 'cross-site') {
        return new Response(JSON.stringify({ ok: false, error: 'cross_site_forbidden' }), {
          status: 403,
          headers: JSON_HEADERS,
        });
      }
      let body: { id?: unknown; enabled?: unknown } = {};
      try {
        body = (await req?.json?.()) ?? {};
      } catch {
        body = {};
      }
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      if (!id) {
        return new Response(JSON.stringify({ ok: false, error: 'missing_id' }), {
          status: 400,
          headers: JSON_HEADERS,
        });
      }
      if (typeof body.enabled !== 'boolean') {
        return new Response(JSON.stringify({ ok: false, error: 'missing_enabled' }), {
          status: 400,
          headers: JSON_HEADERS,
        });
      }
      const prefs = setEnvEnabled(id, body.enabled);
      return new Response(JSON.stringify({ ok: true, disabled: prefs.disabled }), {
        headers: JSON_HEADERS,
      });
    },
  }),
];
