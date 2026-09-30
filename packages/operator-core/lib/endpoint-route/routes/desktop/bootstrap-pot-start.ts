/**
 * POST /api/desktop/bootstrap-pot/start
 *
 * Trigger the `papercusp` dogfood clone-on-first-boot RIGHT NOW (don't wait for
 * the next operator boot). The setup wizard fires this once the GitHub step
 * completes — the boot-time trigger no-ops when `gh` isn't signed in yet, so on
 * a fresh install the clone would otherwise not start until a later restart.
 *
 * Single-flight + idempotent (startBootstrapPapercuspHive): a boot trigger + a
 * wizard trigger share ONE run; a re-POST while it's cloning is a no-op. Returns
 * the well-known `progressId` IMMEDIATELY (fire-and-forget) so the wizard can
 * subscribe to `hiveFromRepo.progress` and render the banner / gate; it does NOT
 * block on the multi-GB clone.
 *
 * SECURITY (CSRF). This kicks off a side effect, and `auth: 'loopback'` is
 * SOURCE-IP based (requireLoopbackOr403) — a browser on the user's own machine
 * passes it, so loopback alone does NOT stop a malicious web page from POSTing
 * here. So this route, unlike its sibling desktop/install routes:
 *   - serves NO CORS — the only legitimate caller is the SAME-ORIGIN setup wizard
 *     (a relative-URL `fetch('/api/desktop/bootstrap-pot/start')`), which needs
 *     no `Access-Control-Allow-Origin`; advertising `*` only helped an attacker.
 *   - REJECTS any request whose `Sec-Fetch-Site` is `cross-site` (every modern
 *     browser, incl. the Tauri webview, stamps it), so a forged cross-origin POST
 *     is refused. Non-browser / loopback callers (no Sec-Fetch-Site) and the
 *     same-origin wizard (`same-origin`) are allowed; loopback IP gating still applies.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import {
  startBootstrapPapercuspHive,
  BOOTSTRAP_PROGRESS_ID,
} from '../../../harness/bootstrap-papercusp-hive';

const JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json' };

export default [
  defineTool({
    method: 'POST',
    path: '/desktop/bootstrap-pot/start',
    auth: 'loopback',
    async handler(req) {
      // CSRF guard: refuse a cross-site browser request before any side effect.
      const site = req?.headers?.get?.('sec-fetch-site');
      if (site === 'cross-site') {
        return new Response(
          JSON.stringify({ ok: false, error: 'cross_site_forbidden' }),
          { status: 403, headers: JSON_HEADERS },
        );
      }
      try {
        if (!(await getFlag(FLAGS.DOGFOOD_PAPERCUSP_POT, 'system'))) {
          return new Response(
            JSON.stringify({ ok: true, started: false, reason: 'flag_off', progressId: BOOTSTRAP_PROGRESS_ID }),
            { status: 200, headers: JSON_HEADERS },
          );
        }
        // Fire-and-forget: kick the single-flight, return the progressId now.
        // The promise rejects only on an unforeseen error — swallow so a wedged
        // clone never crashes the host; the banner surfaces a clone error step.
        const { progressId, done } = startBootstrapPapercuspHive();
        void done.catch(() => {});
        return new Response(
          JSON.stringify({ ok: true, started: true, progressId }),
          { status: 200, headers: JSON_HEADERS },
        );
      } catch (err) {
        return new Response(
          JSON.stringify({ ok: false, error: String((err as Error).message ?? err) }),
          { status: 500, headers: JSON_HEADERS },
        );
      }
    },
  }),
];
