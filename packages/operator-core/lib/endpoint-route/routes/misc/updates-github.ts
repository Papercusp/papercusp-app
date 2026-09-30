/**
 * updates-github — shared GitHub plumbing for the desktop auto-update
 * routes (`/updates/manifest` + `/updates/download`).
 *
 * The desktop release repo (Papercusp/papercusp-desktop) is PRIVATE, so
 * BOTH the release listing and every asset download are token-gated
 * (public `browser_download_url` fetches 404). Token resolution order
 * mirrors what an onboarded install actually has:
 *
 *   1. `gh auth token` (identity/gh-token.ts) — onboarding's GitHub
 *      sign-in leaves gh CLI auth behind; ~55ms cold, cached in-process.
 *   2. The operator credentials store `github_pat` (setup wizard key).
 *   3. `GITHUB_TOKEN` env (dev / CI).
 *
 * Oversized artifacts (Linux .AppImage/.deb are ~3-3.5 GB, over GitHub's
 * 2 GiB asset cap) can't live on the release at all; those are served
 * from a configurable static release host instead (PAPERCUSP_RELEASE_HOST),
 * with their minisign signatures inlined via the release's
 * `papercusp-latest-<tag>.json` manifest asset.
 */
import { getGhAuthToken } from '../../../identity/gh-token';
import { readCredentials } from '../../../credentials';

export const GITHUB_DESKTOP_REPO =
  process.env.GITHUB_DESKTOP_REPO ?? 'Papercusp/papercusp-desktop';

export async function resolveGithubToken(): Promise<string | null> {
  try {
    const r = await getGhAuthToken();
    if (r.kind === 'ok' && r.token) return r.token;
  } catch {
    /* gh CLI missing — fall through */
  }
  try {
    const c = await readCredentials();
    if (c.github_pat) return c.github_pat;
  } catch {
    /* PG not up yet — fall through */
  }
  return process.env.GITHUB_TOKEN ?? null;
}

/**
 * Static host for artifacts too large for GitHub's 2 GiB asset cap
 * (e.g. `https://releases.papercuspai.com` or a LAN host on the test
 * rig). No trailing slash. Null = not configured.
 */
export function releaseHostBase(): string | null {
  const raw = process.env.PAPERCUSP_RELEASE_HOST;
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

export function githubApiHeaders(token: string | null): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * Fetch a (small, text) release asset's CONTENT through the GitHub API —
 * works on private repos where `browser_download_url` does not. Handles
 * the API's 302-to-CDN redirect manually so the Authorization header is
 * never forwarded cross-origin (S3 rejects requests carrying both its
 * query signature and an Authorization header).
 */
export async function fetchAssetText(
  assetId: number | string,
  token: string | null,
): Promise<string | null> {
  const res = await fetchAssetResponse(assetId, token);
  if (!res || !res.ok) return null;
  return res.text();
}

/**
 * Open a streaming Response for a release asset via the GitHub API
 * (Accept: octet-stream), following the CDN redirect without leaking
 * the token. Returns null when the asset is unreachable.
 */
export async function fetchAssetResponse(
  assetId: number | string,
  token: string | null,
): Promise<Response | null> {
  const url = `https://api.github.com/repos/${GITHUB_DESKTOP_REPO}/releases/assets/${assetId}`;
  const first = await fetch(url, {
    headers: {
      ...githubApiHeaders(token),
      Accept: 'application/octet-stream',
    },
    redirect: 'manual',
  });
  if (first.status >= 300 && first.status < 400) {
    const loc = first.headers.get('location');
    if (!loc) return null;
    // WI-2144851. `fetch(loc)` took this Location verbatim, which broke this
    // function's own documented contract in two directions:
    //
    //  - A RELATIVE Location is legal HTTP (RFC 9110 §10.2.2) and `fetch()`
    //    cannot parse one — measured on node v25: `TypeError: Failed to parse
    //    URL from /x`. That REJECTION, not a null, is what reached the three
    //    call sites, and none of them wraps the call (updates-manifest.ts:546,
    //    updates-rollback.ts:335, updates-download.ts:59) — so an anomalous
    //    redirect surfaced to the user as a 500 instead of the honest
    //    "asset unreachable" this function promises.
    //  - A non-https Location was fetched anyway: an http: downgrade for bytes
    //    we are about to stake a signature check on, or a file:/data: target
    //    pointed at the operator's own disk.
    //
    // The only Location worth following here is an absolute https URL — that
    // is the shape GitHub's asset API actually returns. Anything else is an
    // unreachable asset, which is precisely what null means.
    let target: URL;
    try {
      target = new URL(loc);
    } catch {
      // Never log `loc` itself: the legitimate value is a pre-signed CDN URL
      // whose query string IS a credential.
      console.warn(
        `[updates-github] asset ${assetId}: redirect Location is not an absolute URL — refusing`,
      );
      return null;
    }
    if (target.protocol !== 'https:') {
      console.warn(
        `[updates-github] asset ${assetId}: refusing a ${target.protocol} redirect — release assets are https-only`,
      );
      return null;
    }
    // Redirect target is a pre-signed CDN URL — deliberately NO auth header.
    // S3 rejects a request carrying both its query signature and an
    // Authorization header, and forwarding the token off api.github.com would
    // hand our GitHub credential to the CDN.
    return fetch(target);
  }
  if (!first.ok) return null;
  return first;
}
