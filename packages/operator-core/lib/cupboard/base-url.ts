/**
 * Cupboard server base-URL resolution (relocated from the retired
 * per-harness publish route — comb-retire-per-harness-sharing-2026-06-11 P-006).
 *
 *   - PAPERCUSP_CUPBOARD_URL env var if set (override / self-host)
 *   - else DEFAULT_CUPBOARD_URL — the origin the worker actually serves
 *
 * ⚠⚠ DO NOT "FIX" A LOCAL TIMEOUT HERE BY POINTING THE DEFAULT BACK AT A
 * workers.dev ORIGIN. From this dev box, every papercusp-family hostname is
 * silently blackholed at the TLS ClientHello — see the normative insight
 * agent-insights/su-box-sni-tls-blackhole-not-outage (EI-16742). A local probe
 * therefore CANNOT distinguish "the Cupboard is down" from "this box blocks the
 * name", and it fails in the direction that looks like a real outage. That
 * confusion has now produced three separate wrong conclusions about this very
 * constant, so verify from OUTSIDE this box or not at all.
 *
 * The discriminator, if you need to re-establish it (same IP, same second, only
 * the SNI differs):
 *   openssl s_client -connect 104.21.73.140:443 -servername cloudflare.com
 *       → CONNECTION ESTABLISHED
 *   openssl s_client -connect 104.21.73.140:443 -servername cupboard.papercusp.com
 *       → silent drop, no handshake, no reset
 * Port 80 completes TCP in ~50ms and then hangs on the `Host:` header, which is
 * the same filter seen from the other side. `curl` reports `conn=0.000000`,
 * which reads like "cannot connect" but is really "the handshake was eaten".
 *
 * WHAT IS ACTUALLY TRUE OF THE BRANDED HOST (verified 2026-09-05, WI-38321):
 *   - The papercusp.com zone is on Cloudflare NS (itzel/john.ns.cloudflare.com);
 *     `cupboard`, the apex and `www` resolve ONLY to 104.21.73.140 /
 *     172.67.145.145 via Cloudflare-DoH and Google-DoH alike. The 18.204.152.241
 *     "dead apex" cited by earlier revisions of this comment is in NO record of
 *     the real zone — it is what this box's port-53 path returns, not the zone.
 *   - Fetched from an EXTERNAL vantage, https://cupboard.papercusp.com/listings
 *     returns a body byte-for-byte the size of the worker's own origin response,
 *     so the custom domain is genuinely bound to THIS worker.
 *   - EI-12991 closed on the same finding: "both the safe default and branded
 *     endpoint are reachable".
 *
 * WORKING ON THIS BOX: the Cupboard will not answer here, by design of the local
 * filter and nothing else. Set PAPERCUSP_CUPBOARD_URL to the worker's own
 * origin in gitignored local config (.env.local) — local config is the right
 * home for a local network exception. It must NOT come back into this file: the
 * worker origin embeds the Cloudflare account subdomain, and that is the
 * identity string this default exists to keep out of shipped bundles (WI-38233,
 * WI-38321). Anything hardcoded here ships to every user.
 */

/**
 * The canonical branded hostname for the Cupboard worker.
 *
 * ⚠ The binding is currently OUT-OF-BAND, not declarative: the `[[routes]]
 * custom_domain` block in apps/operator-public/wrangler.toml is still COMMENTED
 * (uncommenting it hard-fails `wrangler deploy` unless the papercusp.com zone is
 * in the same Cloudflare account, which cannot be checked from the dev box). The
 * route was created through the dashboard/API, so nothing in this repo recreates
 * it — see that file's "Domain setup" note before assuming the binding is
 * reproducible from config.
 *
 * It carries no account identity, which is the whole point: the worker's own
 * *.workers.dev origin embeds the Cloudflare account subdomain, so defaulting to
 * that origin compiled the owner's GitHub handle into serve.mjs and
 * spa/assets/base-url-*.js in every desktop bundle (WI-38233 accepted this as a
 * disclosed mitigation; WI-38321 is the fix).
 */
export const BRANDED_CUPBOARD_URL = 'https://cupboard.papercusp.com';

/**
 * What an unconfigured process talks to. Deliberately the branded host — see the
 * header note before changing it, and in particular before "fixing" a hang you
 * observed from this dev box.
 */
export const DEFAULT_CUPBOARD_URL = BRANDED_CUPBOARD_URL;

export function resolveCupboardBaseUrl(): string {
  const env = process.env.PAPERCUSP_CUPBOARD_URL;
  return env && env.trim() ? env.trim().replace(/\/+$/, '') : DEFAULT_CUPBOARD_URL;
}
